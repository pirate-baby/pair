// Types shared by the server (MCP + WebSocket) and the browser player.

/** Where in a file an action points. Exactly one of symbol / lines / match. */
export interface Anchor {
  path?: string;
  /** Qualified symbol name, e.g. "ReplicationManager.syncLoop". Resolved with tree-sitter. */
  symbol?: string;
  /** 1-based inclusive line range. */
  lines?: [number, number];
  /** Exact code snippet (whitespace-insensitive per line). Range = the matched lines. */
  match?: string;
}

/** Actions as authored by the agent. */
export type ScriptAction =
  | { do: "open"; path: string; at?: string }
  | ({ do: "reveal"; at?: string } & Anchor)
  | ({ do: "highlight"; at?: string; keep?: boolean } & Anchor)
  | { do: "clear"; at?: string };

export interface ScriptSegment {
  /** Spoken text. Inline `{id}` markers time actions to the word that follows them. */
  narration: string;
  actions?: ScriptAction[];
}

export interface Script {
  title: string;
  segments: ScriptSegment[];
}

/**
 * A walkthrough saved for sharing (e.g. as a gist): the authored script, not the
 * resolved one, so it re-validates against the viewer's checkout when played.
 */
export interface SharedWalkthrough extends Script {
  /** Format version. */
  pair: 1;
  /** The code it was written against. */
  source?: { repo?: string; commit?: string; branch?: string };
  /** ISO timestamp. */
  created?: string;
}

/** What the UI shows before playing a walkthrough opened from a link (POST /api/shared/preview). */
export interface SharedPreview {
  title: string;
  segments: number;
  /** Where it was loaded from and who posted it. */
  origin?: string;
  source?: SharedWalkthrough["source"];
  /** The checkout differs from the code it was written against. */
  stale?: string | null;
  /** Why it can't play here (wrong repo, anchors that don't exist in this checkout). */
  errors?: string[];
  /** "owner/name" of the GitHub repo it was written for, if known. */
  repo: string | null;
  /** It was written for a different repo than this session shows (another session may match). */
  wrongRepo?: boolean;
  /** Every running pair session, so the user can pick the one in the right repo. */
  sessions: SessionInfo[];
}

/** A running pair server (one per agent session), from the shared registry. */
export interface SessionInfo {
  pid: number;
  port: number;
  url: string;
  root: string;
  /** "owner/name" of the repo's GitHub origin, if any. */
  repo: string | null;
  /** "Claude Code", "Codex", "opencode", … */
  harness: string;
  /** The agent is in a pair tool call right now, so a click reaches it immediately. */
  listening: boolean;
  startedAt: string;
  /** The session serving this page. */
  self?: boolean;
}

/** Actions after server-side validation: concrete paths and line ranges. */
export type ResolvedAction =
  | { do: "open"; path: string; offset: number }
  | { do: "reveal"; path: string; start: number; end: number; offset: number }
  | { do: "highlight"; path: string; start: number; end: number; keep: boolean; label?: string; offset: number }
  | { do: "clear"; offset: number };

export interface ResolvedSegment {
  /** Narration with markers stripped. */
  text: string;
  /** Actions sorted by character offset into `text`. */
  actions: ResolvedAction[];
}

export interface ResolvedScript {
  id: string;
  title: string;
  /** Set when this walkthrough answers an interjection. */
  aside?: { question: string };
  /** A short spoken bridge back into the main walkthrough. */
  transition?: boolean;
  segments: ResolvedSegment[];
}

export interface VisibleContext {
  path?: string;
  visibleLines?: [number, number];
  highlighted?: { path: string; start: number; end: number };
}

/** Lifecycle of the optional local Kokoro TTS engine. */
export interface KokoroStatus {
  state: "off" | "installing" | "loading" | "ready" | "error";
  message?: string;
  /** 0–1 while downloading the model. */
  progress?: number;
}

/** Response of POST /api/tts/kokoro. */
export interface KokoroSpeech {
  /** Base64 WAV. */
  audio: string;
  duration: number;
  /** Start time (seconds) of each word, keyed by character offset into the requested text. */
  words: { offset: number; start: number }[];
}

export type ServerMessage =
  | { type: "hello"; root: string; rootName: string }
  | { type: "kokoro"; status: KokoroStatus }
  | { type: "status"; text: string | null }
  | { type: "play"; script: ResolvedScript; startAt: number; autoplay: boolean }
  | { type: "await"; prompt: string | null; options?: string[] }
  /** The main walkthrough while the user has stepped away from it (null when it's current or done). */
  | { type: "main"; paused: { title: string; index: number; total: number } | null }
  /** The session is over (the agent said goodbye, or the user ended it). */
  | { type: "ended"; message: string | null }
  | { type: "stop" };

export type ClientMessage =
  | { type: "segment"; id: string; index: number }
  | { type: "done"; id: string }
  | { type: "interrupt"; id: string | null; index: number; question: string; context: VisibleContext; choice?: number }
  /** "Back to <main walkthrough>" was clicked. */
  | { type: "return"; context: VisibleContext }
  | { type: "end" };

export interface TreeEntry {
  name: string;
  path: string;
  dir: boolean;
}
