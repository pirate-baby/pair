import { useSyncExternalStore } from "react";
import type { TreeEntry } from "../../shared/protocol";

/** File tree state lives outside React so the presenter can drive it imperatively. */
class TreeStore {
  children = new Map<string, TreeEntry[]>();
  expanded = new Set<string>([""]);
  selected: string | null = null;
  private version = 0;
  private listeners = new Set<() => void>();

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = () => this.version;
  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  async load(dir: string) {
    if (this.children.has(dir)) return;
    const res = await fetch(`/api/list?dir=${encodeURIComponent(dir)}`);
    const body = await res.json();
    this.children.set(dir, Array.isArray(body) ? body : []);
    this.emit();
  }

  async expand(dir: string) {
    await this.load(dir);
    this.expanded.add(dir);
    this.emit();
  }

  async toggle(dir: string) {
    if (this.expanded.has(dir)) {
      this.expanded.delete(dir);
      this.emit();
    } else await this.expand(dir);
  }

  select(path: string | null) {
    this.selected = path;
    this.emit();
  }
}

export const tree = new TreeStore();

export function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function nodeElement(path: string): HTMLElement | null {
  return document.querySelector(`[data-tree-path="${CSS.escape(path)}"]`);
}

function Dir({ dir, depth, onOpen }: { dir: string; depth: number; onOpen: (p: string) => void }) {
  const entries = tree.children.get(dir) ?? [];
  return (
    <>
      {entries.map((e) => {
        const open = tree.expanded.has(e.path);
        return (
          <div key={e.path}>
            <div
              className={`tree-row ${tree.selected === e.path ? "selected" : ""}`}
              data-tree-path={e.path}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => (e.dir ? tree.toggle(e.path) : onOpen(e.path))}
            >
              <span className="tree-twisty">{e.dir ? (open ? "▾" : "▸") : ""}</span>
              <span className={e.dir ? "tree-dir" : "tree-file"}>{e.name}</span>
            </div>
            {e.dir && open && <Dir dir={e.path} depth={depth + 1} onOpen={onOpen} />}
          </div>
        );
      })}
    </>
  );
}

export function FileTree({ rootName, onOpen }: { rootName: string; onOpen: (p: string) => void }) {
  useSyncExternalStore(tree.subscribe, tree.snapshot);
  return (
    <div className="tree">
      <div className="pane-title">{rootName || "Explorer"}</div>
      <div className="tree-scroll" id="tree-scroll">
        <Dir dir="" depth={0} onOpen={onOpen} />
      </div>
    </div>
  );
}
