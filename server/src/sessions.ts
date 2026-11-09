import { execFile } from "node:child_process";
import { mkdirSync, unlinkSync } from "node:fs";
import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SessionInfo } from "../../shared/protocol.js";

const exec = promisify(execFile);

/**
 * Every running pair server (one per agent session) registers here, so a "Play in pair"
 * link that lands on one session can offer the others, e.g. the one in the right repo.
 */
const DIR = process.env.PAIR_SESSIONS_DIR ?? path.join(os.homedir(), ".cache", "pair", "sessions");

/** "owner/name" from a GitHub remote URL (ssh or https), lowercased. */
export function repoSlug(remote: string | undefined | null): string | null {
  const m = remote?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

/** Friendly harness name from the MCP client's self-reported name. */
export function harnessName(client: string | undefined): string {
  if (!client) return "Unknown agent";
  if (/claude/i.test(client)) return "Claude Code";
  if (/codex/i.test(client)) return "Codex";
  if (/opencode/i.test(client)) return "opencode";
  return client;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class SessionRegistry implements Registry {
  private file = path.join(DIR, `${process.pid}.json`);
  private info: Omit<SessionInfo, "self"> | null = null;
  private writing = Promise.resolve();

  /** Registers this server once it's listening; removed again when the process exits. */
  async start(url: string, root: string, harness: string) {
    const port = Number(new URL(url).port);
    this.info = { pid: process.pid, port, url, root, repo: null, harness, listening: false, startedAt: new Date().toISOString() };
    mkdirSync(DIR, { recursive: true });
    const cleanup = () => {
      try {
        unlinkSync(this.file);
      } catch {
        /* already gone */
      }
    };
    process.on("exit", cleanup);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => process.exit(0));
    await this.setRoot(root);
  }

  async setRoot(root: string) {
    if (!this.info) return;
    const remote = await exec("git", ["remote", "get-url", "origin"], { cwd: root }).then((r) => r.stdout.trim(), () => null);
    this.update({ root, repo: repoSlug(remote) });
  }

  update(patch: Partial<Omit<SessionInfo, "self">>) {
    if (!this.info) return;
    const next = { ...this.info, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.info)) return;
    this.info = next;
    const data = JSON.stringify(next);
    // Serialized and atomic, so a reader never sees a half-written file.
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, this.file);
    }).catch(() => {});
  }

  /** All live sessions, this one included (flagged `self`). Entries for dead processes are cleaned up. */
  async list(): Promise<SessionInfo[]> {
    await this.writing;
    const names = await readdir(DIR).catch(() => [] as string[]);
    const out: SessionInfo[] = [];
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      const pid = Number(name.slice(0, -5));
      if (!alive(pid)) {
        await unlink(path.join(DIR, name)).catch(() => {});
        continue;
      }
      try {
        const s = JSON.parse(await readFile(path.join(DIR, name), "utf8")) as SessionInfo;
        out.push({ ...s, self: pid === process.pid });
      } catch {
        /* mid-write or corrupt; skip */
      }
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}

/** What the hub needs from a session registry. */
export interface Registry {
  start(url: string, root: string, harness: string): Promise<void>;
  setRoot(root: string): Promise<void>;
  update(patch: Partial<Omit<SessionInfo, "self">>): void;
  list(): Promise<SessionInfo[]>;
}

/**
 * Hosted mode: sessions register with the service that runs them (PUT this session's
 * info; GET returns every session the viewer may switch to), not with files on one
 * machine keyed by process ID.
 */
export class HttpSessionRegistry implements Registry {
  private info: Omit<SessionInfo, "self"> | null = null;
  private writing = Promise.resolve();

  constructor(
    private endpoint: string,
    private token: string | undefined,
    /** The public URL viewers reach this session at (the proxy's), not the bind address. */
    private publicUrl?: string,
  ) {}

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.token && { authorization: `Bearer ${this.token}` }) };
  }

  async start(url: string, root: string, harness: string) {
    const port = Number(new URL(url).port);
    this.info = null;
    const remote = await exec("git", ["remote", "get-url", "origin"], { cwd: root }).then((r) => r.stdout.trim(), () => null);
    // Set via update() so the first record is always sent, even if nothing changes later.
    this.info = { pid: process.pid, port, url: this.publicUrl ?? url, root: "", repo: null, harness, listening: false, startedAt: new Date().toISOString() };
    this.update({ root, repo: repoSlug(remote) });
    await this.writing;
  }

  async setRoot(root: string) {
    if (!this.info) return;
    const remote = await exec("git", ["remote", "get-url", "origin"], { cwd: root }).then((r) => r.stdout.trim(), () => null);
    this.update({ root, repo: repoSlug(remote) });
  }

  update(patch: Partial<Omit<SessionInfo, "self">>) {
    if (!this.info) return;
    const next = { ...this.info, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.info)) return;
    this.info = next;
    const body = JSON.stringify(next);
    this.writing = this.writing
      .then(() => fetch(this.endpoint, { method: "PUT", headers: this.headers(), body }))
      .then((r) => void (r.ok || console.error("[pair] session registry:", r.status)))
      .catch((e) => console.error("[pair] session registry:", e));
  }

  async list(): Promise<SessionInfo[]> {
    await this.writing;
    try {
      const r = await fetch(this.endpoint, { headers: this.headers() });
      const all = r.ok ? ((await r.json()) as SessionInfo[]) : [];
      return all.map((s) => ({ ...s, self: s.url === this.info?.url }));
    } catch {
      return this.info ? [{ ...this.info, self: true }] : [];
    }
  }
}
