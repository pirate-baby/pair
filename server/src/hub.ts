import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ResolvedScript, ServerMessage, VisibleContext } from "../../shared/protocol.js";
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
  | { status: "question"; question: string; context: VisibleContext }
  | { status: "ended" }
  | { status: "idle" }
  | { status: "cancelled" };

interface Waiter {
  /** Script id this waiter is playing, or null when waiting for a free-form question. */
  scriptId: string | null;
  resolve: (o: Outcome) => void;
  onSegment?: (index: number) => void;
}

const log = (...args: unknown[]) => console.error("[pair]", ...args);

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
  private awaitPrompt: string | null = null;
  private waiter: Waiter | null = null;
  private queued: { question: string; context: VisibleContext } | null = null;
  private connectWaiters: (() => void)[] = [];
  private kokoro = new Kokoro();

  constructor(private ws: Workspace) {
    this.kokoro.onStatus = (status) => this.broadcast({ type: "kokoro", status });
  }

  async listen(preferredPort: number) {
    const server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      res.writeHead(500, { "content-type": "text/plain" }).end(String((e as Error).message));
    }));
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (req.url !== "/ws") return socket.destroy();
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

  /** Plays a script; resolves when it finishes, the user interjects, or ends the session. */
  play(script: ResolvedScript, startAt: number, signal?: AbortSignal, onSegment?: (i: number) => void): Promise<Outcome> {
    this.current = { script, index: startAt };
    if (!script.aside) this.main = this.current;
    this.awaitPrompt = null;
    this.status = null;
    this.queued = null;
    this.broadcast({ type: "play", script, startAt, autoplay: true });
    return this.wait({ scriptId: script.id, resolve: () => {}, onSegment }, signal);
  }

  mainScript() {
    return this.main;
  }

  /** Waits for a free-form question typed into the UI. */
  awaitQuestion(prompt: string | null, timeoutMs: number, signal?: AbortSignal): Promise<Outcome> {
    if (this.queued) {
      const q = this.queued;
      this.queued = null;
      return Promise.resolve({ status: "question", ...q });
    }
    this.awaitPrompt = prompt;
    this.broadcast({ type: "await", prompt });
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
          this.settle(w.scriptId ? { status: "interrupted", index: msg.index, question: msg.question, context: msg.context } : { status: "question", question: msg.question, context: msg.context });
          this.setStatus("Thinking…");
        } else {
          // Nobody is listening right now; hand it to the next await_user call.
          this.queued = { question: msg.question, context: msg.context };
          this.setStatus("Question queued — the agent will pick it up when it checks back in.");
        }
        break;
      case "end":
        this.current = this.main = null;
        this.awaitPrompt = null;
        this.settle({ status: "ended" });
        this.setStatus("Session ended.");
        break;
    }
  }

  private connect(sock: WebSocket) {
    this.clients.add(sock);
    const send = (m: ServerMessage) => sock.send(JSON.stringify(m));
    send({ type: "hello", root: this.ws.root, rootName: this.ws.name });
    send({ type: "status", text: this.status });
    send({ type: "kokoro", status: this.kokoro.status });
    if (this.current) send({ type: "play", script: this.current.script, startAt: this.current.index, autoplay: false });
    if (this.waiter && !this.waiter.scriptId) send({ type: "await", prompt: this.awaitPrompt });
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

    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
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
