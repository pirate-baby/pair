#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Script } from "../../shared/protocol.js";
import { Workspace } from "./files.js";
import { Hub, type Outcome } from "./hub.js";
import { resolveScript } from "./script.js";
import { outline, supportsSymbols } from "./symbols.js";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const explicitRoot = flag("root") ?? process.env.PAIR_ROOT;
const port = Number(flag("port") ?? process.env.PAIR_PORT ?? 7420);

const ws = new Workspace(path.resolve(explicitRoot ?? process.cwd()));
const hub = new Hub(ws);

const anchor = {
  path: z.string().optional().describe("Repo-relative file path. Defaults to the most recently opened file."),
  symbol: z.string().optional().describe('Qualified symbol, e.g. "ReplicationManager.syncLoop". Preferred for classes/functions.'),
  lines: z.tuple([z.number().int(), z.number().int()]).optional().describe("1-based inclusive [start, end]."),
  match: z.string().optional().describe("Exact code snippet copied from the file (whitespace-insensitive). Must be unique."),
};
const at = z.string().optional().describe("Marker id from the narration ({id}); the action fires as that word is spoken. Omit to fire at segment start.");
const action = z.discriminatedUnion("do", [
  z.object({ do: z.literal("open"), path: z.string(), at }),
  z.object({ do: z.literal("reveal"), at, ...anchor }),
  z.object({ do: z.literal("highlight"), at, keep: z.boolean().optional().describe("Keep earlier highlights instead of replacing them."), ...anchor }),
  z.object({ do: z.literal("clear"), at }),
]);
const segments = z
  .array(
    z.object({
      narration: z
        .string()
        .describe(
          "Spoken aloud by TTS, so write what you'd say, not what you'd type: no markdown, backticks, paths, or call syntax. Say identifiers as words ('the sync loop', \"this 'likes dash video ID' right here\") and let highlights show the code. Embed {id} markers right before the words that should trigger actions.",
        ),
      actions: z.array(action).optional(),
    }),
  )
  .min(1);

function describeOutcome(o: Outcome, mainSegments?: { text: string }[]): string {
  switch (o.status) {
    case "completed":
      return "Walkthrough finished playing. If the user is watching the UI, call await_user to take follow-up questions there.";
    case "interrupted":
      return [
        `The user paused at segment ${o.index} and asked: ${JSON.stringify(o.question)}`,
        mainSegments?.[o.index] ? `They were hearing: ${JSON.stringify(mainSegments[o.index].text)}` : "",
        `What they could see: ${JSON.stringify(o.context)}`,
        "",
        "Investigate if needed, answer with present_walkthrough (set aside_for to their question; keep it short and show the code you mention), then call resume_walkthrough to continue where they left off.",
      ].filter(Boolean).join("\n");
    case "question":
      return [
        `The user asked: ${JSON.stringify(o.question)}`,
        `What they could see: ${JSON.stringify(o.context)}`,
        "",
        "Investigate, answer with present_walkthrough (aside_for set to the question), then call await_user again.",
      ].join("\n");
    case "ended":
      return "The user ended the walkthrough session. Stop presenting.";
    case "idle":
      return "No question arrived before the timeout. The session is still open; call await_user again or end your turn.";
    case "cancelled":
      return "Playback was cancelled (superseded or the request was aborted).";
  }
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

const server = new McpServer({ name: "pair", version: "0.1.0" });

server.registerTool(
  "show_status",
  {
    description:
      "Open the walkthrough UI (if not already open) and show a status line while you investigate, e.g. 'Looking into how regional replication works…'. Call this first so the user knows you're working.",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => {
    const connected = await hub.ensureOpen();
    hub.setStatus(message);
    return text(connected ? `Status shown at ${hub.url}.` : `Status set, but no browser connected yet. Ask the user to open ${hub.url}.`);
  },
);

server.registerTool(
  "outline",
  {
    description: "List the symbols (classes, functions, methods) in a file with their line ranges, to pick valid symbol anchors.",
    inputSchema: { path: z.string() },
  },
  async ({ path: p }) => {
    try {
      const rel = ws.rel(p);
      if (!supportsSymbols(rel)) return text(`No symbol support for ${rel}; use match or lines anchors.`, true);
      const syms = await outline(rel, await ws.read(rel));
      return text(syms!.map((s) => `${s.qualified}  [${s.kind}]  L${s.start}-${s.end}`).join("\n") || "(no symbols found)");
    } catch (e) {
      return text((e as Error).message, true);
    }
  },
);

server.registerTool(
  "present_walkthrough",
  {
    description: [
      "Play a narrated, visual code walkthrough in the user's editor UI. Do your investigation first; this call performs a finished script.",
      "Every path, symbol, line range, and snippet is validated against the repo before anything plays; on errors nothing plays and you get the list to fix.",
      "Blocks until playback finishes, the user pauses to ask a question, or ends the session, and returns which.",
    ].join(" "),
    inputSchema: {
      title: z.string(),
      segments,
      aside_for: z.string().optional().describe("Set to the user's question when this answers an interjection; the main walkthrough is kept for resume_walkthrough."),
    },
  },
  async ({ title, segments, aside_for }, extra) => {
    const result = await resolveScript(ws, { title, segments } as Script, aside_for ? { question: aside_for } : undefined);
    if (!result.script) return text(`Script not played. Fix these and call again:\n- ${result.errors.join("\n- ")}`, true);
    if (!(await hub.ensureOpen())) return text(`No browser connected. Ask the user to open ${hub.url}, then retry.`, true);

    const token = extra._meta?.progressToken;
    const total = result.script.segments.length;
    const outcome = await hub.play(result.script, 0, extra.signal, (i) => {
      if (token !== undefined) {
        extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: i + 1, total } }).catch(() => {});
      }
    });
    const warn = result.warnings.length ? `\n\nWarnings:\n- ${result.warnings.join("\n- ")}` : "";
    return text(describeOutcome(outcome, result.script.segments) + warn);
  },
);

server.registerTool(
  "resume_walkthrough",
  {
    description: "Resume the main walkthrough after answering an interjection. Blocks like present_walkthrough.",
    inputSchema: { from_segment: z.number().int().optional().describe("Defaults to the segment the user paused on.") },
  },
  async ({ from_segment }, extra) => {
    const main = hub.mainScript();
    if (!main) return text("There is no walkthrough to resume.", true);
    const from = Math.max(0, Math.min(from_segment ?? main.index, main.script.segments.length - 1));
    if (!(await hub.ensureOpen())) return text(`No browser connected. Ask the user to open ${hub.url}.`, true);
    const outcome = await hub.play(main.script, from, extra.signal);
    return text(describeOutcome(outcome, main.script.segments));
  },
);

server.registerTool(
  "await_user",
  {
    description: "Keep the walkthrough session open and wait for the user to type a follow-up question in the UI. Returns the question, 'ended', or 'idle' on timeout.",
    inputSchema: {
      prompt: z.string().optional().describe("Shown above the question box, e.g. 'Anything else about replication?'"),
      timeout_seconds: z.number().int().optional().describe("Default 600."),
    },
  },
  async ({ prompt, timeout_seconds }, extra) => {
    if (!(await hub.ensureOpen())) return text(`No browser connected. Ask the user to open ${hub.url}.`, true);
    const outcome = await hub.awaitQuestion(prompt ?? null, (timeout_seconds ?? 600) * 1000, extra.signal);
    return text(describeOutcome(outcome));
  },
);

/** `pair play script.json [--root dir]`: run a hand-written script without an agent. */
async function playFile(file: string) {
  await hub.listen(port);
  const script = JSON.parse(await readFile(file, "utf8")) as Script;
  const result = await resolveScript(ws, script);
  result.warnings.forEach((w) => console.error("warning:", w));
  if (!result.script) {
    result.errors.forEach((e) => console.error("error:", e));
    process.exit(1);
  }
  console.error(`Opening ${hub.url} …`);
  await hub.ensureOpen();
  let outcome = await hub.play(result.script, 0);
  while (outcome.status === "interrupted") {
    console.error(`User asked at segment ${outcome.index}: ${outcome.question}\n(no agent in play mode; resuming)`);
    outcome = await hub.play(result.script, outcome.index);
  }
  console.error(`Outcome: ${outcome.status}`);
  process.exit(0);
}

async function main() {
  if (argv[0] === "play") {
    if (!argv[1]) throw new Error("usage: pair play <script.json> [--root dir]");
    return playFile(argv[1]);
  }
  await hub.listen(port);
  server.server.oninitialized = async () => {
    // Without an explicit root, prefer the client's workspace root over our cwd.
    if (explicitRoot || !server.server.getClientCapabilities()?.roots) return;
    try {
      const { roots } = await server.server.listRoots();
      const first = roots.find((r) => r.uri.startsWith("file://"));
      if (first) ws.setRoot(fileURLToPath(first.uri));
    } catch {
      /* keep cwd */
    }
  };
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error("[pair]", e);
  process.exit(1);
});
