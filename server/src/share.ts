import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Script, SharedWalkthrough } from "../../shared/protocol.js";
import { parseNarration } from "./script.js";

const exec = promisify(execFile);
const FILE_SUFFIX = ".pair.json";
const MAIN_FILE = "walkthrough" + FILE_SUFFIX;

const git = (root: string, ...args: string[]) =>
  exec("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) => stdout.trim());
const tryGit = (root: string, ...args: string[]) => git(root, ...args).catch(() => null);

/** Every path a script points at, so we can tell whether they changed since it was written. */
function scriptPaths(script: Script): string[] {
  const paths = new Set<string>();
  for (const seg of script.segments) for (const a of seg.actions ?? []) if ("path" in a && a.path) paths.add(a.path);
  return [...paths];
}

/** Where the walkthrough was written: the repo, commit, and branch it was validated against. */
async function sourceOf(root: string): Promise<SharedWalkthrough["source"]> {
  const [repo, commit, branch] = await Promise.all([
    tryGit(root, "remote", "get-url", "origin"),
    tryGit(root, "rev-parse", "HEAD"),
    tryGit(root, "rev-parse", "--abbrev-ref", "HEAD"),
  ]);
  return {
    ...(repo && { repo: repo.replace(/^https:\/\/[^@/]+@/, "https://") }),
    ...(commit && { commit }),
    ...(branch && branch !== "HEAD" && { branch }),
  };
}

/** Problems that would stop a teammate from seeing the same code the walkthrough was written against. */
async function publishWarnings(root: string, shared: SharedWalkthrough): Promise<string[]> {
  const { commit } = shared.source ?? {};
  if (!commit) return ["This isn't a git repo, so the walkthrough has no commit to pin to."];
  const warnings: string[] = [];
  const dirty = await tryGit(root, "status", "--porcelain", "--", ...scriptPaths(shared));
  if (dirty) warnings.push(`Files in the walkthrough have uncommitted changes, so viewers may see different code:\n${dirty}`);
  const remote = await tryGit(root, "branch", "-r", "--contains", commit);
  if (!remote) warnings.push(`Commit ${commit.slice(0, 10)} isn't on any remote branch yet. Push it so viewers can check it out.`);
  return warnings;
}

const WHERE = (shared: SharedWalkthrough, withRepo = true) => {
  const { repo, commit, branch } = shared.source ?? {};
  return [withRepo && repo, branch && `branch \`${branch}\``, commit && `commit \`${commit.slice(0, 10)}\``].filter(Boolean).join(", ");
};

const numbered = (shared: SharedWalkthrough) => shared.segments.map((s, i) => `${i + 1}. ${parseNarration(s.narration).text.trim()}`);

function transcript(shared: SharedWalkthrough): string {
  const where = WHERE(shared);
  return [
    `# ${shared.title}`,
    "",
    "A narrated code walkthrough for [pair](https://github.com/pirate-baby/pair).",
    where ? `Written against ${where}.` : "",
    "",
    "**To play it:** ask your agent to \"play the pair walkthrough at <this gist's link>\", or run `npm run play -- <this gist's link> --root <your checkout>` from the pair repo.",
    "",
    "## Transcript",
    "",
    ...numbered(shared),
    "",
  ].filter((l, i, all) => l !== "" || all[i - 1] !== "").join("\n");
}

/** Hidden marker that identifies a walkthrough comment on a PR. */
const PR_MARKER = "<!-- pair-walkthrough v1 -->";
/** GitHub rejects comment bodies over 65,536 characters. */
const MAX_COMMENT = 65_000;

/** A fence longer than any backtick run inside the content, so snippets containing ``` can't break out of it. */
function fenceFor(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

function prComment(shared: SharedWalkthrough): string {
  const json = JSON.stringify(shared, null, 2);
  const fence = fenceFor(json);
  const where = WHERE(shared, false);
  return [
    PR_MARKER,
    `### ▶️ Pair walkthrough: ${shared.title}`,
    "",
    `Ask your agent to "play the pair walkthrough on this PR" to watch it in [pair](https://github.com/pirate-baby/pair).${where ? ` Written against ${where}.` : ""}`,
    "",
    "<details><summary>Transcript</summary>",
    "",
    ...numbered(shared),
    "",
    "</details>",
    "",
    "<details><summary>Walkthrough script (read by pair)</summary>",
    "",
    fence + "json",
    json,
    fence,
    "",
    "</details>",
    "",
  ].join("\n");
}

function shareable(script: Script, source: SharedWalkthrough["source"]): SharedWalkthrough {
  return { pair: 1, title: script.title, segments: script.segments, source, created: new Date().toISOString() };
}

async function gh(args: string[], cwd: string, what: string): Promise<string> {
  try {
    return (await exec("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") throw new Error("The GitHub CLI (gh) isn't installed. Install it (brew install gh) and run gh auth login.");
    throw new Error(`${what} failed: ${(err.stderr || err.message).trim()}`);
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pair-share-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Posts a walkthrough as a comment on a pull request (via the gh CLI) and returns the comment URL.
 * `pr` is a number or URL; omitted, gh uses the PR for the current branch.
 */
export async function publishToPr(root: string, script: Script, pr?: string): Promise<{ url: string; warnings: string[] }> {
  const shared = shareable(script, await sourceOf(root));
  const warnings = await publishWarnings(root, shared);
  const body = prComment(shared);
  if (body.length > MAX_COMMENT) throw new Error(`The walkthrough is too large for a PR comment (${body.length} characters; GitHub allows about 65,000). Share it as a gist instead.`);
  return withTempDir(async (dir) => {
    const file = path.join(dir, "comment.md");
    await writeFile(file, body);
    const out = await gh(["pr", "comment", ...(pr ? [pr] : []), "--body-file", file], root, "gh pr comment");
    return { url: out.split("\n").pop()!, warnings };
  });
}

/** Publishes a walkthrough as a secret GitHub gist (via the gh CLI) and returns its URL. */
export async function publishGist(root: string, script: Script): Promise<{ url: string; warnings: string[] }> {
  const shared = shareable(script, await sourceOf(root));
  const warnings = await publishWarnings(root, shared);
  return withTempDir(async (dir) => {
    await writeFile(path.join(dir, MAIN_FILE), JSON.stringify(shared, null, 2) + "\n");
    await writeFile(path.join(dir, "README.md"), transcript(shared));
    const out = await gh(["gist", "create", "--desc", `pair walkthrough: ${script.title}`, "README.md", MAIN_FILE], dir, "gh gist create");
    return { url: out.split("\n").pop()!, warnings };
  });
}

/** PR reference (number, #number, or pull request URL) from `source`, or null if it isn't one. */
function prRef(source: string): string | null {
  const n = source.match(/^(?:pr\s*)?#?(\d{1,9})$/i);
  if (n) return n[1];
  return source.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/)?.[0] ?? null;
}

interface PrView {
  number: number;
  body: string;
  author?: { login: string };
  comments: { body: string; url: string; author?: { login: string } }[];
}

/** The latest walkthrough on a PR (its comments, then its description), and who posted it. */
async function fromPr(ref: string, root: string): Promise<{ raw: string; origin: string }> {
  const pr = JSON.parse(await gh(["pr", "view", ref, "--json", "number,body,author,comments"], root, "gh pr view")) as PrView;
  const posts = [{ body: pr.body, author: pr.author, url: `the description of PR #${pr.number}` }, ...pr.comments.map((c) => ({ ...c, url: c.url }))];
  for (const post of posts.reverse()) {
    const at = post.body?.indexOf(PR_MARKER) ?? -1;
    if (at === -1) continue;
    const m = post.body.slice(at).match(/(`{3,})json\r?\n([\s\S]*?)\r?\n\1/);
    if (!m) continue;
    return { raw: m[2], origin: `${post.url}${post.author ? ` (posted by ${post.author.login})` : ""}` };
  }
  throw new Error(`PR #${pr.number} has no pair walkthrough comment.`);
}

const GIST_ID = /^[0-9a-f]{20,40}$/i;

/** Gist id from a gist URL or bare id, or null if `source` isn't one. */
function gistId(source: string): string | null {
  if (GIST_ID.test(source)) return source;
  let u: URL;
  try {
    u = new URL(source);
  } catch {
    return null;
  }
  if (u.hostname !== "gist.github.com") return null;
  return u.pathname.split("/").filter(Boolean).find((p) => GIST_ID.test(p)) ?? null;
}

interface GistFile {
  filename: string;
  raw_url: string;
  truncated?: boolean;
  content?: string;
}

/** Fetches a gist through gh when available (works for any gist you can see), else the public API (secret gists work by id). */
async function fetchGist(id: string): Promise<GistFile[]> {
  let body: string;
  try {
    ({ stdout: body } = await exec("gh", ["api", `gists/${id}`], { maxBuffer: 32 * 1024 * 1024 }));
  } catch {
    const res = await fetch(`https://api.github.com/gists/${id}`, { headers: { accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`Couldn't fetch gist ${id}: HTTP ${res.status}`);
    body = await res.text();
  }
  return Object.values((JSON.parse(body) as { files: Record<string, GistFile> }).files);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't fetch ${url}: HTTP ${res.status}`);
  return res.text();
}

/**
 * Loads a shared walkthrough from a PR (number or URL), a gist URL/id, a raw URL, or a local file.
 * PR numbers are looked up in the repo at `root`; file paths are relative to `cwd`.
 */
export async function loadWalkthrough(source: string, root: string, cwd = root): Promise<SharedWalkthrough & { origin?: string }> {
  source = source.trim();
  let raw: string;
  let origin: string | undefined;
  const pr = prRef(source);
  const id = gistId(source);
  if (pr) {
    ({ raw, origin } = await fromPr(pr, root));
  } else if (id) {
    const files = await fetchGist(id);
    const file = files.find((f) => f.filename.endsWith(FILE_SUFFIX)) ?? files.find((f) => f.filename.endsWith(".json"));
    if (!file) throw new Error(`Gist ${id} has no ${FILE_SUFFIX} file.`);
    raw = file.truncated || file.content === undefined ? await fetchText(file.raw_url) : file.content;
  } else if (/^https?:\/\//.test(source)) {
    raw = await fetchText(source);
  } else {
    raw = await readFile(path.resolve(cwd, source), "utf8");
  }

  let data: SharedWalkthrough;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${source} isn't valid JSON.`);
  }
  if (typeof data?.title !== "string" || !Array.isArray(data.segments)) throw new Error(`${source} isn't a pair walkthrough (needs a title and segments).`);
  return { ...data, origin };
}

/** Whether the viewer's checkout differs from the code the walkthrough was written against. */
export async function freshness(root: string, shared: SharedWalkthrough): Promise<string | null> {
  const { commit, branch } = shared.source ?? {};
  if (!commit) return null;
  const head = await tryGit(root, "rev-parse", "HEAD");
  if (!head || head === commit) return null;
  const short = commit.slice(0, 10);
  const known = await tryGit(root, "cat-file", "-e", `${commit}^{commit}`);
  if (known === null) {
    return `It was written against commit ${short}${branch ? ` on ${branch}` : ""}, which isn't in this checkout. Fetch it (or check out the PR branch) to see exactly what the author saw.`;
  }
  const changed = await tryGit(root, "diff", "--name-only", commit, "--", ...scriptPaths(shared));
  return changed
    ? `It was written against commit ${short}${branch ? ` on ${branch}` : ""}; these files have changed since then, so some narration may be out of date:\n${changed}`
    : null;
}
