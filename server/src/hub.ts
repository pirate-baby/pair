import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ResolvedScript, ServerMessage, SharedPreview, VisibleContext } from "../../shared/protocol.js";
import type { Workspace } from "./files.js";
import { Kokoro } from "./kokoro.js";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export type Outcome =
  | { status: "completed" }
  | { status: "interrupted"; index: number; question: string; context: VisibleContext }
  | { status: "question"; question: string; context: VisibleContext; choice?: number }
  | { status: "return"; context: VisibleContext }
  | { status: "ended" }
  | { status: "idle" }
  | { status: "cancelled" }
  /** The user opened a shared walkthrough from a link while the agent was waiting on us. */
  | { status: "shared"; source: string };

/** Loading shared walkthroughs for the /play link, supplied by the MCP server. */
export interface SharedHandler {
  preview(source: string): Promise<SharedPreview>;
  /** Validates and returns the walkthrough, ready to play. Throws when it can't play here. */
  resolve(source: string): Promise<ResolvedScript>;
}

interface Waiter {
  /** Script id this waiter is playing, or null when waiting for a free-form question. */
  scriptId: string | null;
  resolve: (o: Outcome) => void;
  onSegment?: (index: number) => void;
}

const log = (...args: unknown[]) => console.error("[pair]", ...args);

/** How long "Thinking…" may show after the user answers before we assume the agent has gone quiet. */
const AGENT_SILENCE_MS = Number(process.env.PAIR_AGENT_SILENCE_MS) || 90_000;

/**
 * Owns the browser UI: serves it, tracks connected tabs, and turns the
 * asynchronous player events into the blocking outcomes MCP tools return.
 */
export class Hub {
  url = "";
  private clients = new Set<WebSocket>();
  private status: string | null = null;
  private current: { script: ResolvedScript; index: number } | null = null;
  private main: { script: ResolvedScript; index: number } | null = null;
  private awaitPrompt: { prompt: string | null; options?: string[] } | null = null;
  private waiter: Waiter | null = null;
  /** An answer that arrived while no tool call was waiting; handed to the next await_user. */
  private queued: Outcome | null = null;
  private connectWaiters: (() => void)[] = [];
  private kokoro = new Kokoro();
  private ended: { message: string | null } | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  shared: SharedHandler | null = null;

  constructor(private ws: Workspace) {
    this.kokoro.onStatus = (status) => this.broadcast({ type: "kokoro", status });
  }

  async listen(preferredPort: number) {
    const server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      res.writeHead(500, { "content-type": "text/plain" }).end(String((e as Error).message));
    }));
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (req.url !== "/ws" || !fromLocalPage(req)) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (sock) => this.connect(sock));
    });
    for (let port = preferredPort; port < preferredPort + 20; port++) {
      const ok = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => resolve(true));
      });
      if (ok) {
        this.url = `http://localhost:${port}`;
        log(`UI at ${this.url} (root: ${this.ws.root})`);
        return;
      }
    }
    throw new Error(`No free port in ${preferredPort}-${preferredPort + 19}`);
  }

  /** Opens a browser tab if none is connected, and waits for it. */
  async ensureOpen(): Promise<boolean> {
    if (this.clients.size) return true;
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    if (!process.env.PAIR_NO_OPEN) spawn(cmd, [this.url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), process.env.PAIR_NO_OPEN ? 120_000 : 20_000);
      this.connectWaiters.push(() => (clearTimeout(t), resolve(true)));
    });
  }

  setStatus(text: string | null) {
    this.status = text;
    this.broadcast({ type: "status", text });
  }

  /** Called on every agent tool call: the agent is still engaged. */
  touch() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.ended = null;
  }

  /** After the user answers, the agent should do *something*. If it never does, don't spin forever. */
  private expectAgent() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.setStatus("No reply from the agent. It may have finished, so continue in its chat, or ask again here.");
    }, AGENT_SILENCE_MS);
    this.silenceTimer.unref();
  }

  /** Ends the session: the UI says goodbye (if given) and stops taking questions. */
  endSession(message: string | null) {
    this.touch();
    this.current = this.main = null;
    this.awaitPrompt = null;
    this.queued = null;
    this.status = null;
    this.ended = { message };
    this.settle({ status: "ended" });
    this.broadcast({ type: "ended", message });
    this.broadcastMain();
  }

  /** Plays a script; resolves when it finishes, the user interjects, or ends the session. */
  play(script: ResolvedScript, startAt: number, signal?: AbortSignal, onSegment?: (i: number) => void): Promise<Outcome> {
    this.current = { script, index: startAt };
    if (!script.aside && !script.transition) this.main = this.current;
    this.awaitPrompt = null;
    this.status = null;
    this.queued = null;
    this.broadcast({ type: "play", script, startAt, autoplay: true });
    this.broadcastMain();
    return this.wait({ scriptId: script.id, resolve: () => {}, onSegment }, signal);
  }

  /**
   * Plays a walkthrough opened from a link. If the agent is waiting on us, it's handed
   * the request so it owns playback (and answers questions). Otherwise we play it
   * ourselves, and a question waits for the agent's next await_user.
   */
  async playShared(source: string): Promise<"agent" | "direct"> {
    if (this.waiter) {
      this.broadcast({ type: "stop" });
      this.settle({ status: "shared", source });
      this.expectAgent();
      this.setStatus("Loading the shared walkthrough…");
      return "agent";
    }
    const script = await this.shared!.resolve(source);
    this.touch();
    void this.play(script, 0).then((o) => {
      if (o.status !== "interrupted") return;
      // play() only settles: nobody is listening, so keep the question for the agent.
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
      this.queued = { status: "question", question: o.question, context: o.context };
      this.setStatus("Your question is saved. To get an answer, tell your agent you asked something in pair.");
    });
    return "direct";
  }

  mainScript() {
    return this.main;
  }

  /** The main walkthrough, when the user has stepped away from it (an aside or transition is current). */
  pausedMain() {
    return this.main && this.current !== this.main ? this.main : null;
  }

  private mainMessage(): ServerMessage {
    const m = this.pausedMain();
    return { type: "main", paused: m ? { title: m.script.title, index: m.index, total: m.script.segments.length } : null };
  }

  private broadcastMain() {
    this.broadcast(this.mainMessage());
  }

  /** Waits for a free-form question typed into the UI. */
  awaitQuestion(prompt: string | null, options: string[] | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Outcome> {
    if (this.queued) {
      const q = this.queued;
      this.queued = null;
      return Promise.resolve(q);
    }
    this.awaitPrompt = { prompt, options };
    this.broadcast({ type: "await", prompt, options });
    const timer = setTimeout(() => this.settle({ status: "idle" }), timeoutMs);
    return this.wait({ scriptId: null, resolve: () => {} }, signal).finally(() => clearTimeout(timer));
  }

  private wait(w: Waiter, signal?: AbortSignal): Promise<Outcome> {
    this.settle({ status: "cancelled" });
    return new Promise<Outcome>((resolve) => {
      w.resolve = resolve;
      this.waiter = w;
      signal?.addEventListener("abort", () => {
        if (this.waiter === w) {
          this.settle({ status: "cancelled" });
          this.broadcast({ type: "stop" });
        }
      });
    });
  }

  private settle(o: Outcome) {
    const w = this.waiter;
    this.waiter = null;
    w?.resolve(o);
  }

  private onMessage(msg: ClientMessage) {
    const w = this.waiter;
    switch (msg.type) {
      case "segment":
        if (this.current?.script.id === msg.id) this.current.index = msg.index;
        if (w?.scriptId === msg.id) w.onSegment?.(msg.index);
        break;
      case "done":
        if (w?.scriptId === msg.id) this.settle({ status: "completed" });
        break;
      case "interrupt":
        if (this.current && this.current.script.id === msg.id) this.current.index = msg.index;
        if (w) {
          this.expectAgent();
          this.settle(
            w.scriptId
              ? { status: "interrupted", index: msg.index, question: msg.question, context: msg.context }
              : { status: "question", question: msg.question, context: msg.context, choice: msg.choice },
          );
          this.setStatus("Thinking…");
        } else {
          // Nobody is listening right now; hand it to the next await_user call.
          this.queued = { status: "question", question: msg.question, context: msg.context, choice: msg.choice };
          this.setStatus("Question queued — the agent will pick it up when it checks back in.");
        }
        break;
      case "return": {
        if (!this.pausedMain()) break;
        const o: Outcome = { status: "return", context: msg.context };
        if (w) {
          this.expectAgent();
          this.settle(o);
          this.setStatus("Heading back…");
        } else {
          this.queued = o;
          this.setStatus("Got it — the agent will head back when it checks in.");
        }
        break;
      }
      case "end":
        this.endSession(null);
        break;
    }
  }

  private connect(sock: WebSocket) {
    this.clients.add(sock);
    const send = (m: ServerMessage) => sock.send(JSON.stringify(m));
    send({ type: "hello", root: this.ws.root, rootName: this.ws.name });
    send({ type: "status", text: this.status });
    if (this.ended) send({ type: "ended", message: this.ended.message });
    send({ type: "kokoro", status: this.kokoro.status });
    send(this.mainMessage());
    if (this.current) send({ type: "play", script: this.current.script, startAt: this.current.index, autoplay: false });
    if (this.waiter && !this.waiter.scriptId) send({ type: "await", prompt: this.awaitPrompt?.prompt ?? null, options: this.awaitPrompt?.options });
    sock.on("message", (data) => {
      try {
        this.onMessage(JSON.parse(String(data)) as ClientMessage);
      } catch (e) {
        log("bad message", e);
      }
    });
    sock.on("close", () => this.clients.delete(sock));
    this.connectWaiters.splice(0).forEach((f) => f());
  }

  private broadcast(m: ServerMessage) {
    const data = JSON.stringify(m);
    for (const c of this.clients) c.send(data);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!fromLocalPage(req)) return res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

    if (url.pathname === "/api/tts/kokoro/enable" && req.method === "POST") {
      this.kokoro.enable();
      return json(this.kokoro.status);
    }
    if (url.pathname === "/api/tts/kokoro" && req.method === "POST") {
      try {
        const { text, voice, speed } = JSON.parse(await readBody(req));
        return json(await this.kokoro.speak(String(text), String(voice || "af_heart"), Number(speed) || 1));
      } catch (e) {
        return json({ error: (e as Error).message }, 503);
      }
    }
    if (url.pathname.startsWith("/api/shared/") && req.method === "POST") {
      if (!this.shared) return json({ error: "Shared walkthroughs aren't available." }, 503);
      try {
        const { src } = JSON.parse(await readBody(req));
        if (url.pathname === "/api/shared/preview") return json(await this.shared.preview(String(src)));
        if (url.pathname === "/api/shared/play") return json({ via: await this.playShared(String(src)) });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (url.pathname === "/api/list") {
      try {
        return json(await this.ws.list(url.searchParams.get("dir") ?? ""));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (url.pathname === "/api/file") {
      try {
        return json({ path: url.searchParams.get("path"), content: await this.ws.read(url.searchParams.get("path") ?? "") });
      } catch (e) {
        return json({ error: (e as Error).message }, 404);
      }
    }

    // "/play?src=…" is a link from a PR comment; the UI reads the query and asks before playing.
    const rel = url.pathname === "/" || url.pathname === "/play" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR) || !existsSync(file)) {
      if (!existsSync(path.join(WEB_DIR, "index.html"))) {
        return res.writeHead(500, { "content-type": "text/plain" }).end("UI not built. Run `npm run build` in the pair repo.");
      }
      return res.writeHead(404).end();
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 1_000_000) req.destroy(new Error("Request too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Only the Pair UI itself may talk to this server. The Host check defeats DNS
 * rebinding (a remote page reaching us through its own domain); the Origin check
 * stops other websites from opening the WebSocket (which would let them feed
 * "user questions" to the agent) or POSTing to the API. Browsers always send
 * Origin on WebSocket handshakes and cross-site POSTs; local tools like curl
 * send none and are allowed.
 */
function fromLocalPage(req: http.IncomingMessage): boolean {
  if (!LOCAL_HOST.test(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && LOCAL_HOST.test(u.host);
  } catch {
    return false;
  }
}
