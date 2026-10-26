import { createRequire } from "node:module";
import path from "node:path";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);
const WASM_DIR = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");

const GRAMMARS: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin", ".kts": "kotlin",
  ".rb": "ruby",
  ".c": "c", ".h": "c",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
  ".cs": "c_sharp",
  ".php": "php",
  ".swift": "swift",
  ".scala": "scala",
  ".ex": "elixir", ".exs": "elixir",
  ".lua": "lua",
  ".dart": "dart",
  ".zig": "zig",
};

// Node types that define a named symbol across the supported grammars.
const DEFINITIONS = new Set([
  // JS / TS
  "class_declaration", "abstract_class_declaration", "function_declaration", "generator_function_declaration",
  "method_definition", "interface_declaration", "type_alias_declaration", "enum_declaration", "internal_module", "module",
  // Python
  "class_definition", "function_definition",
  // Go
  "method_declaration", "type_spec",
  // Rust
  "function_item", "struct_item", "enum_item", "trait_item", "impl_item", "mod_item", "function_signature_item",
  // Java / Kotlin / C# / Scala / Swift / PHP
  "constructor_declaration", "record_declaration", "object_declaration", "struct_declaration", "namespace_declaration",
  "protocol_declaration", "object_definition", "trait_definition", "function_declaration_item",
  // Ruby
  "class", "method", "singleton_method",
  // C / C++
  "class_specifier", "struct_specifier", "namespace_definition",
]);

const NAME_TYPES = new Set(["identifier", "type_identifier", "property_identifier", "field_identifier", "simple_identifier", "constant", "name"]);

export interface SymbolInfo {
  /** Dotted, container-qualified name, e.g. "ReplicationManager.syncLoop". */
  qualified: string;
  name: string;
  kind: string;
  start: number;
  end: number;
}

let ready: Promise<void> | null = null;
const languages = new Map<string, Promise<Parser.Language>>();

function grammarFor(file: string): string | null {
  return GRAMMARS[path.extname(file).toLowerCase()] ?? null;
}

async function parserFor(file: string): Promise<Parser | null> {
  const grammar = grammarFor(file);
  if (!grammar) return null;
  ready ??= Parser.init();
  await ready;
  if (!languages.has(grammar)) languages.set(grammar, Parser.Language.load(path.join(WASM_DIR, `tree-sitter-${grammar}.wasm`)));
  const parser = new Parser();
  parser.setLanguage(await languages.get(grammar)!);
  return parser;
}

export function supportsSymbols(file: string) {
  return grammarFor(file) !== null;
}

function nameOf(node: Parser.SyntaxNode): string | null {
  const field = node.childForFieldName("name") ?? (node.type === "impl_item" ? node.childForFieldName("type") : null);
  if (field) return field.text;
  // C-style: function_definition -> declarator -> ... -> identifier
  let decl = node.childForFieldName("declarator");
  while (decl) {
    if (NAME_TYPES.has(decl.type) || decl.type === "qualified_identifier" || decl.type === "destructor_name") return decl.text;
    decl = decl.childForFieldName("declarator") ?? decl.namedChildren.find((c) => NAME_TYPES.has(c.type)) ?? null;
  }
  return node.namedChildren.find((c) => NAME_TYPES.has(c.type))?.text ?? null;
}

/** Go methods are top-level; qualify them with their receiver type. */
function goReceiver(node: Parser.SyntaxNode): string | null {
  if (node.type !== "method_declaration") return null;
  const recv = node.childForFieldName("receiver");
  const typeNode = recv?.descendantsOfType("type_identifier")[0];
  return typeNode?.text ?? null;
}

/** `const handler = () => {}` / `const x = function () {}` */
function arrowName(node: Parser.SyntaxNode): string | null {
  if (node.type !== "variable_declarator") return null;
  const value = node.childForFieldName("value");
  if (!value || !["arrow_function", "function", "function_expression", "class"].includes(value.type)) return null;
  return node.childForFieldName("name")?.text ?? null;
}

export async function outline(file: string, source: string): Promise<SymbolInfo[] | null> {
  const parser = await parserFor(file);
  if (!parser) return null;
  const tree = parser.parse(source);
  const out: SymbolInfo[] = [];

  const visit = (node: Parser.SyntaxNode, scope: string[]) => {
    let childScope = scope;
    const isDef = DEFINITIONS.has(node.type);
    const name = isDef ? nameOf(node) : arrowName(node);
    if (name) {
      const receiver = goReceiver(node);
      const qualifiedParts = receiver ? [...scope, receiver, name] : [...scope, name];
      // Include decorators / export keywords that wrap the definition.
      let span = node;
      while (span.parent && ["decorated_definition", "export_statement", "lexical_declaration", "variable_declaration"].includes(span.parent.type)) span = span.parent;
      out.push({
        qualified: qualifiedParts.join("."),
        name,
        kind: node.type,
        start: span.startPosition.row + 1,
        end: span.endPosition.row + 1,
      });
      childScope = qualifiedParts;
    }
    for (const child of node.namedChildren) visit(child, childScope);
  };
  visit(tree.rootNode, []);
  tree.delete();
  parser.delete();
  return out;
}

export type Resolution = { ok: true; symbol: SymbolInfo } | { ok: false; error: string };

export function findSymbol(symbols: SymbolInfo[], wanted: string): Resolution {
  const w = wanted.replace(/::|#|->/g, ".").replace(/\(\)$/, "");
  const exact = symbols.filter((s) => s.qualified === w);
  if (exact.length === 1) return { ok: true, symbol: exact[0] };
  const suffix = exact.length ? exact : symbols.filter((s) => s.qualified.endsWith("." + w) || s.name === w);
  if (suffix.length === 1) return { ok: true, symbol: suffix[0] };
  if (suffix.length > 1) {
    return { ok: false, error: `Symbol "${wanted}" is ambiguous: ${suffix.map((s) => `${s.qualified} (L${s.start})`).join(", ")}. Use a qualified name or lines.` };
  }
  const lower = w.toLowerCase().split(".").pop()!;
  const near = symbols.filter((s) => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase())).slice(0, 8);
  const hint = near.length ? ` Similar: ${near.map((s) => s.qualified).join(", ")}.` : ` Call outline() to list this file's symbols.`;
  return { ok: false, error: `Symbol "${wanted}" not found.${hint}` };
}
