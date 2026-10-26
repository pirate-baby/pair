import type { VisibleContext } from "../../shared/protocol";
import { FakeCursor } from "./cursor";
import { monaco } from "./monaco";
import { ancestors, nodeElement, tree } from "./tree";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null, timeoutMs = 3000): Promise<T | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return null;
}

export interface TabsState {
  tabs: string[];
  active: string | null;
}

/**
 * The editor + explorer as a presenter sees it: every operation is animated the
 * way a person would do it (expand folders, click the file, scroll, select).
 */
export class Stage {
  readonly cursor = new FakeCursor();
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private models = new Map<string, monaco.editor.ITextModel>();
  private decorations: monaco.editor.IEditorDecorationsCollection | null = null;
  private highlights: monaco.editor.IModelDeltaDecoration[] = [];
  private lastHighlight: VisibleContext["highlighted"];
  tabs: TabsState = { tabs: [], active: null };
  onTabs: (t: TabsState) => void = () => {};

  attach(el: HTMLElement) {
    this.editor = monaco.editor.create(el, {
      readOnly: true,
      theme: "vs-dark",
      automaticLayout: true,
      smoothScrolling: true,
      minimap: { enabled: true },
      fontSize: 13,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      stickyScroll: { enabled: false },
      model: null,
    });
    this.decorations = this.editor.createDecorationsCollection();
  }

  dispose() {
    this.editor?.dispose();
    this.models.forEach((m) => m.dispose());
  }

  /** Open a file the way a person would: expand each folder, then click the file. */
  async open(path: string, animate = true) {
    if (this.tabs.active === path) return;
    if (this.tabs.tabs.includes(path)) {
      if (animate) await this.clickTab(path);
      return this.activate(path);
    }
    for (const dir of ancestors(path)) {
      if (tree.expanded.has(dir)) continue;
      await tree.load(dir.split("/").slice(0, -1).join("/"));
      const el = await waitFor(() => nodeElement(dir));
      if (el && animate) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        await this.cursor.moveToElement(el);
        await this.cursor.click();
      }
      await tree.expand(dir);
      if (animate) await sleep(160);
    }
    await tree.load(ancestors(path).pop() ?? "");
    const fileEl = await waitFor(() => nodeElement(path));
    if (fileEl && animate) {
      fileEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      await sleep(120);
      await this.cursor.moveToElement(fileEl);
      await this.cursor.click();
    }
    tree.select(path);
    await this.activate(path);
    if (animate) await sleep(250);
  }

  private async clickTab(path: string) {
    const el = document.querySelector(`[data-tab-path="${CSS.escape(path)}"]`);
    if (el) {
      await this.cursor.moveToElement(el);
      await this.cursor.click();
    }
  }

  async activate(path: string) {
    if (!this.models.has(path)) {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      const body = await res.json();
      const content = typeof body.content === "string" ? body.content : `// ${body.error ?? "Could not load file"}`;
      this.models.set(path, monaco.editor.createModel(content, undefined, monaco.Uri.file("/" + path)));
    }
    if (!this.tabs.tabs.includes(path)) this.tabs = { ...this.tabs, tabs: [...this.tabs.tabs, path] };
    this.tabs = { ...this.tabs, active: path };
    this.onTabs(this.tabs);
    this.highlights = [];
    this.lastHighlight = undefined;
    this.decorations?.clear();
    this.editor?.setModel(this.models.get(path)!);
    tree.select(path);
  }

  async reveal(path: string, start: number, end: number) {
    await this.open(path);
    const ed = this.editor!;
    const visible = ed.getVisibleRanges()[0];
    const viewportLines = visible ? visible.endLineNumber - visible.startLineNumber : 30;
    if (visible && start >= visible.startLineNumber + 1 && end <= visible.endLineNumber - 1) return;
    if (end - start + 3 > viewportLines) ed.revealLineNearTop(start, monaco.editor.ScrollType.Smooth);
    else ed.revealLinesInCenter(start, end, monaco.editor.ScrollType.Smooth);
    await sleep(420);
  }

  /** Scroll to the range, then "drag-select" it with the cursor. */
  async highlight(path: string, start: number, end: number, keep: boolean) {
    await this.reveal(path, start, end);
    const ed = this.editor!;
    const model = ed.getModel()!;
    if (!keep) this.highlights = [];
    const base = [...this.highlights];
    const lineDeco = (s: number, e: number): monaco.editor.IModelDeltaDecoration => ({
      range: new monaco.Range(s, 1, e, 1),
      options: { isWholeLine: true, className: "pair-hl", linesDecorationsClassName: "pair-hl-gutter" },
    });

    const point = (line: number, col: number) => {
      const pos = ed.getScrolledVisiblePosition({ lineNumber: line, column: col });
      const box = ed.getDomNode()!.getBoundingClientRect();
      return pos ? { x: box.left + pos.left, y: box.top + pos.top + pos.height / 2 } : null;
    };
    const startCol = Math.max(1, model.getLineFirstNonWhitespaceColumn(start));
    const p0 = point(start, startCol);
    if (p0) await this.cursor.moveTo(p0.x, p0.y);

    // Grow the selection line by line, like a mouse drag.
    const lines = end - start + 1;
    const steps = Math.min(lines, 12);
    const stepMs = Math.min(45, 500 / steps);
    for (let i = 1; i <= steps; i++) {
      const line = start + Math.round((i / steps) * (lines - 1));
      this.decorations!.set([...base, lineDeco(start, line)]);
      const p = point(line, Math.max(1, model.getLineMaxColumn(line) > 80 ? 40 : model.getLineMaxColumn(line)));
      if (p) await this.cursor.glideTo(p.x, p.y, stepMs);
      else await sleep(stepMs);
    }
    this.highlights = [...base, lineDeco(start, end)];
    this.decorations!.set(this.highlights);
    this.lastHighlight = { path, start, end };
  }

  clear() {
    this.highlights = [];
    this.decorations?.clear();
    this.lastHighlight = undefined;
  }

  context(): VisibleContext {
    const r = this.editor?.getVisibleRanges()[0];
    return {
      path: this.tabs.active ?? undefined,
      visibleLines: r ? [r.startLineNumber, r.endLineNumber] : undefined,
      highlighted: this.lastHighlight,
    };
  }
}
