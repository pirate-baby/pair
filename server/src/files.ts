import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { TreeEntry } from "../../shared/protocol.js";

const exec = promisify(execFile);

const IGNORED = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "__pycache__", "target", ".DS_Store", ".idea", ".turbo", "coverage"]);
const MAX_FILE_BYTES = 2_000_000;

/** Read-only view of the repository the walkthrough is about. */
export class Workspace {
  private gitFiles: Promise<string[] | null> | null = null;
  private gitFilesAt = 0;

  constructor(public root: string) {}

  setRoot(root: string) {
    this.root = root;
    this.gitFiles = null;
  }

  get name() {
    return path.basename(this.root);
  }

  /** Normalizes a user/agent-supplied path to a root-relative POSIX path, rejecting escapes. */
  rel(p: string): string {
    const abs = path.isAbsolute(p) && p.startsWith(this.root + path.sep) ? p : path.resolve(this.root, p.replace(/^\/+/, ""));
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes the workspace: ${p}`);
    return rel.split(path.sep).join("/");
  }

  async exists(rel: string): Promise<"file" | "dir" | null> {
    try {
      const st = await fs.stat(path.join(this.root, rel));
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
    } catch {
      return null;
    }
  }

  async read(rel: string): Promise<string> {
    const abs = path.join(this.root, this.rel(rel));
    const st = await fs.stat(abs);
    if (st.size > MAX_FILE_BYTES) throw new Error(`File too large to display: ${rel}`);
    return fs.readFile(abs, "utf8");
  }

  async list(dir: string): Promise<TreeEntry[]> {
    const relDir = dir ? this.rel(dir) : "";
    const files = await this.trackedFiles();
    let entries: TreeEntry[];
    if (files) {
      const prefix = relDir ? relDir + "/" : "";
      const seen = new Map<string, TreeEntry>();
      for (const f of files) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (!seen.has(name)) seen.set(name, { name, path: prefix + name, dir: slash !== -1 });
      }
      entries = [...seen.values()];
    } else {
      const dirents = await fs.readdir(path.join(this.root, relDir), { withFileTypes: true });
      entries = dirents
        .filter((d) => !IGNORED.has(d.name))
        .map((d) => ({ name: d.name, path: relDir ? `${relDir}/${d.name}` : d.name, dir: d.isDirectory() }));
    }
    return entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  }

  /** Git-visible files (tracked + untracked, minus ignored), or null outside a git repo. */
  private trackedFiles(): Promise<string[] | null> {
    if (!this.gitFiles || Date.now() - this.gitFilesAt > 10_000) {
      this.gitFilesAt = Date.now();
      this.gitFiles = exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: this.root,
        maxBuffer: 64 * 1024 * 1024,
      })
        .then(({ stdout }) => stdout.split("\0").filter(Boolean))
        .catch(() => null);
    }
    return this.gitFiles;
  }
}
