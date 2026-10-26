#!/usr/bin/env node
// Minimal, comment-preserving config edits used by bin/installpair.
//
//   json-set <file> <key.path> <json>           set a value (creates the file; works on .json and .jsonc)
//   json-set-default <file> <key.path> <json>   same, but only if the key is absent
//   toml-section <file> <section> <body>        replace [section] (and its subtables) with body
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";

const [cmd, file, key, value] = process.argv.slice(2);

function read(f, fallback) {
  return existsSync(f) ? readFileSync(f, "utf8") : fallback;
}
function write(f, text) {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
}

function jsonSet(onlyIfAbsent) {
  const text = read(file, "{}\n");
  const keyPath = key.split(".");
  const tree = parseTree(text);
  if (text.trim() && !tree) throw new Error(`${file} is not valid JSON/JSONC`);
  if (onlyIfAbsent && tree && findNodeAtLocation(tree, keyPath)) return console.log("unchanged");
  const edits = modify(text, keyPath, JSON.parse(value), { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  write(file, applyEdits(text, edits));
  console.log("updated");
}

function tomlSection(section, body) {
  const lines = read(file, "").split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header) skipping = header[1] === section || header[1].startsWith(section + ".");
    if (!skipping) out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  const block = `[${section}]\n${body.trim()}\n`;
  write(file, (out.length ? out.join("\n") + "\n\n" : "") + block);
  console.log("updated");
}

try {
  if (cmd === "json-set") jsonSet(false);
  else if (cmd === "json-set-default") jsonSet(true);
  else if (cmd === "toml-section") tomlSection(key, value);
  else throw new Error(`unknown command: ${cmd}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
