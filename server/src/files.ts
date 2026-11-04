import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CommitView, TreeEntry } from "../../shared/protocol.js";

export type { CommitView };

const exec = promisify(execFile);

const IGNORED = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "__pycache__", "target", ".DS_Store", ".idea", ".turbo", "coverage"]);
const MAX_FILE_BYTES = 2_000_000;

/**
 * Read-only view of the repository the walkthrough is about: the working tree,
 * or (with a view) a commit read straight from git objects, without checking it out.
 */
export class Workspace {
  private gitFiles: Promise<string[] | null> | null = null;
  private gitFilesAt = 0;
  private commitFiles: Promise<Set<string>> | null = null;

  constructor(public root: string, public view: CommitView | null = null) {}

  setRoot(root: string) {
    this.root = root;
    this.gitFiles = null;
    this.commitFiles = null;
  }

  setView(view: CommitView | null) {
    if (view?.commit === this.view?.commit) return;
    this.view = view;
    this.commitFiles = null;
  }

  /** A separate workspace over the same repo at `view`, leaving this one untouched. */
  at(view: CommitView | null): Workspace {
    return new Workspace(this.root, view);
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
    if (this.view) {
      const files = await this.filesAtCommit();
      if (files.has(rel)) return "file";
      const prefix = rel ? rel + "/" : "";
      for (const f of files) if (f.startsWith(prefix)) return "dir";
      return null;
    }
    try {
      const st = await fs.stat(path.join(this.root, rel));
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
    } catch {
      return null;
    }
  }

  async read(rel: string): Promise<string> {
    if (this.view) {
      rel = this.rel(rel);
      if (!(await this.filesAtCommit()).has(rel)) throw new Error(`File not found at commit ${this.view.commit.slice(0, 10)}: ${rel}`);
      try {
        const { stdout } = await exec("git", ["cat-file", "blob", `${this.view.commit}:${rel}`], { cwd: this.root, maxBuffer: MAX_FILE_BYTES, encoding: "utf8" });
        return stdout;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error(`File too large to display: ${rel}`);
        throw e;
      }
    }
    const abs = path.join(this.root, this.rel(rel));
    const st = await fs.stat(abs);
    if (st.size > MAX_FILE_BYTES) throw new Error(`File too large to display: ${rel}`);
    return fs.readFile(abs, "utf8");
  }

  async list(dir: string): Promise<TreeEntry[]> {
    const relDir = dir ? this.rel(dir) : "";
    const files = this.view ? [...(await this.filesAtCommit())] : await this.trackedFiles();
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

  /** Every file in the viewed commit. Commits never change, so this is cached for the view's lifetime. */
  private filesAtCommit(): Promise<Set<string>> {
    if (!this.commitFiles) {
      const commit = this.view!.commit;
      const files = exec("git", ["ls-tree", "-r", "-z", "--name-only", commit], { cwd: this.root, maxBuffer: 64 * 1024 * 1024 })
        .then(({ stdout }) => new Set(stdout.split("\0").filter(Boolean)));
      // Don't cache a failure (e.g. the commit hadn't been fetched yet).
      files.catch(() => this.commitFiles === files && (this.commitFiles = null));
      this.commitFiles = files;
    }
    return this.commitFiles;
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
