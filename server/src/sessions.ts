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

export class SessionRegistry {
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
