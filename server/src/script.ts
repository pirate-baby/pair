import { randomUUID } from "node:crypto";
import type { Anchor, ResolvedAction, ResolvedScript, Script } from "../../shared/protocol.js";
import type { Workspace } from "./files.js";
import { findSymbol, outline, supportsSymbols, type SymbolInfo } from "./symbols.js";

const MARKER = /\{([A-Za-z0-9_-]+)\}/g;
const LONG_HIGHLIGHT = 60;

export interface ValidationResult {
  script?: ResolvedScript;
  errors: string[];
  warnings: string[];
}

/** Strips `{id}` markers, returning clean text and each marker's character offset. */
export function parseNarration(narration: string) {
  const marks = new Map<string, number>();
  let text = "";
  let last = 0;
  for (const m of narration.matchAll(MARKER)) {
    text += narration.slice(last, m.index);
    marks.set(m[1], text.length);
    last = m.index! + m[0].length;
  }
  text += narration.slice(last);
  // Not trimmed/collapsed: marker offsets index into this exact string.
  return { text, marks };
}

/**
 * Validates every path, symbol, and range in a script against the workspace and
 * resolves them to concrete line ranges, so the player never shows made-up code.
 */
export async function resolveScript(ws: Workspace, script: Script, aside?: { question: string }): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sources = new Map<string, Promise<string | null>>();
  const outlines = new Map<string, Promise<SymbolInfo[] | null>>();

  const source = (rel: string) => {
    if (!sources.has(rel)) sources.set(rel, ws.read(rel).catch(() => null));
    return sources.get(rel)!;
  };
  const symbolsOf = (rel: string) => {
    if (!outlines.has(rel)) outlines.set(rel, source(rel).then((src) => (src === null ? null : outline(rel, src))));
    return outlines.get(rel)!;
  };

  let currentFile: string | null = null;

  const resolveAnchor = async (a: Anchor, where: string): Promise<{ path: string; start: number; end: number; label?: string } | null> => {
    let rel: string;
    try {
      rel = a.path ? ws.rel(a.path) : currentFile ?? "";
    } catch (e) {
      errors.push(`${where}: ${(e as Error).message}`);
      return null;
    }
    if (!rel) {
      errors.push(`${where}: no path given and no file is open yet.`);
      return null;
    }
    const src = await source(rel);
    if (src === null) {
      errors.push(`${where}: file not found: ${rel}`);
      return null;
    }
    const lineCount = src.split("\n").length;
    const given = [a.symbol, a.lines, a.match].filter((x) => x !== undefined).length;
    if (given !== 1) {
      errors.push(`${where}: give exactly one of symbol, lines, or match.`);
      return null;
    }

    if (a.lines) {
      const [start, end] = a.lines;
      if (!(start >= 1 && end >= start && end <= lineCount)) {
        errors.push(`${where}: lines [${start}, ${end}] out of range for ${rel} (${lineCount} lines).`);
        return null;
      }
      return { path: rel, start, end };
    }

    if (a.symbol) {
      if (!supportsSymbols(rel)) {
        errors.push(`${where}: symbol anchors aren't supported for ${rel}; use match or lines.`);
        return null;
      }
      const syms = (await symbolsOf(rel)) ?? [];
      const r = findSymbol(syms, a.symbol);
      if (!r.ok) {
        errors.push(`${where} (${rel}): ${r.error}`);
        return null;
      }
      return { path: rel, start: r.symbol.start, end: r.symbol.end, label: r.symbol.qualified };
    }

    const hits = matchSnippet(src, a.match!);
    if (hits.length === 0) {
      errors.push(`${where}: snippet not found in ${rel}: ${JSON.stringify(a.match!.slice(0, 80))}`);
      return null;
    }
    if (hits.length > 1) {
      errors.push(`${where}: snippet matches ${hits.length} places in ${rel} (lines ${hits.map((h) => h.start).join(", ")}); make it more specific or use lines.`);
      return null;
    }
    return { path: rel, ...hits[0] };
  };

  if (!script.segments?.length) errors.push("Script has no segments.");

  const segments = [];
  for (const [si, seg] of (script.segments ?? []).entries()) {
    const { text, marks } = parseNarration(seg.narration ?? "");
    if (!text.trim()) errors.push(`segment ${si}: narration is empty.`);
    if (text.length > 700) warnings.push(`segment ${si}: narration is long (${text.length} chars); one idea per segment keeps pacing natural.`);

    const actions: ResolvedAction[] = [];
    for (const [ai, action] of (seg.actions ?? []).entries()) {
      const where = `segment ${si} action ${ai} (${action.do})`;
      let offset = 0;
      if (action.at !== undefined) {
        const o = marks.get(action.at);
        if (o === undefined) {
          errors.push(`${where}: marker {${action.at}} doesn't appear in the narration.`);
          continue;
        }
        offset = o;
      }

      if (action.do === "open") {
        let rel: string;
        try {
          rel = ws.rel(action.path);
        } catch (e) {
          errors.push(`${where}: ${(e as Error).message}`);
          continue;
        }
        if ((await ws.exists(rel)) !== "file") {
          errors.push(`${where}: file not found: ${rel}`);
          continue;
        }
        currentFile = rel;
        actions.push({ do: "open", path: rel, offset });
      } else if (action.do === "reveal" || action.do === "highlight") {
        const r = await resolveAnchor(action, where);
        if (!r) continue;
        if (r.path !== currentFile) {
          // Implicitly open the file so the player's tree/tab state stays consistent.
          actions.push({ do: "open", path: r.path, offset });
          currentFile = r.path;
        }
        if (action.do === "reveal") actions.push({ do: "reveal", path: r.path, start: r.start, end: r.end, offset });
        else {
          if (r.end - r.start + 1 > LONG_HIGHLIGHT) warnings.push(`${where}: highlights ${r.end - r.start + 1} lines; consider a narrower range.`);
          actions.push({ do: "highlight", path: r.path, start: r.start, end: r.end, keep: !!action.keep, label: r.label, offset });
        }
      } else if (action.do === "clear") {
        actions.push({ do: "clear", offset });
      } else {
        errors.push(`${where}: unknown action.`);
      }
    }
    // Stable sort keeps authored order for actions sharing an offset.
    actions.sort((a, b) => a.offset - b.offset);
    segments.push({ text, actions });
  }

  if (errors.length) return { errors, warnings };
  return { script: { id: randomUUID(), title: script.title, aside, segments }, errors, warnings };
}

/** Finds a multi-line snippet, comparing trimmed lines; first/last lines may be partial. */
export function matchSnippet(src: string, snippet: string): { start: number; end: number }[] {
  const want = snippet.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!want.length) return [];
  const lines = src.split("\n").map((l) => l.trim());
  const hits: { start: number; end: number }[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length && ok; j++) {
      const line = lines[i + j];
      const edge = j === 0 || j === want.length - 1;
      ok = edge ? line.includes(want[j]) : line === want[j];
    }
    if (ok) hits.push({ start: i + 1, end: i + want.length });
  }
  return hits;
}
