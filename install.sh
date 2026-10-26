#!/usr/bin/env bash
# One-step setup for Pair on macOS: checks for Node, builds, and installs
# the MCP server + code-walkthrough skill into your coding-agent harnesses.
#
#   ./install.sh            set up every supported harness that's present
#   ./install.sh claude     just Claude Code   (also: codex, opencode)
#
# Harnesses that aren't installed are reported and skipped. Re-running is safe
# (and is how you update after a git pull).

set -uo pipefail

# Resolve symlinks (bin/installpair points here) without relying on readlink -f.
src="${BASH_SOURCE[0]}"
while [[ -L "$src" ]]; do
  dir="$(cd "$(dirname "$src")" && pwd)"
  src="$(readlink "$src")"
  [[ "$src" == /* ]] || src="$dir/$src"
done
PAIR_DIR="$(cd "$(dirname "$src")" && pwd)"

SERVER="$PAIR_DIR/dist/server/server/src/index.js"
SKILL_SRC="$PAIR_DIR/skills/code-walkthrough"
SKILL_NAME="code-walkthrough"
EDIT="$PAIR_DIR/scripts/config-edit.mjs"
HARNESSES=(claude codex opencode)
# Walkthroughs hold a tool call open until playback ends or the user interjects.
TOOL_TIMEOUT_SEC=1800
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=12

if [[ -t 1 ]]; then
  BOLD=$'\e[1m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m' DIM=$'\e[2m' RESET=$'\e[0m'
else
  BOLD="" GREEN="" YELLOW="" RED="" DIM="" RESET=""
fi
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
warn() { echo "  ${YELLOW}!${RESET} $*"; }
fail() { echo "  ${RED}✗${RESET} $*"; }
die()  { echo "${RED}$*${RESET}" >&2; exit 1; }

usage() {
  local IFS='|'
  echo "usage: $(basename "$0") [${HARNESSES[*]}]"
  echo "  No argument installs into all of them; missing harnesses are skipped."
}

# ---------------------------------------------------------------- Node runtime

node_ok() {
  local v
  v="$("$1" -v 2>/dev/null)" || return 1
  v="${v#v}"
  local major="${v%%.*}" rest="${v#*.}"
  local minor="${rest%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( major > NODE_MIN_MAJOR || (major == NODE_MIN_MAJOR && minor >= NODE_MIN_MINOR) ))
}

# Sets NODE to an absolute path. Harnesses launched from the Dock or an IDE
# often don't share your shell's PATH, so configs get this path, not "node".
resolve_node() {
  NODE="$(command -v node 2>/dev/null)"
  if [[ -z "$NODE" ]]; then
    notify "Pair needs Node.js ≥ $NODE_MIN_MAJOR.$NODE_MIN_MINOR"
    die "Node.js isn't installed. Install it (e.g. 'brew install node', or https://nodejs.org), then re-run this script."
  fi
  if ! node_ok "$NODE"; then
    notify "Pair needs Node.js ≥ $NODE_MIN_MAJOR.$NODE_MIN_MINOR"
    die "Found Node $("$NODE" -v) at $NODE, but Pair needs ≥ $NODE_MIN_MAJOR.$NODE_MIN_MINOR. Upgrade it, then re-run this script."
  fi
}

# macOS notification, for when the script was launched without a visible terminal.
notify() {
  command -v osascript >/dev/null && osascript -e "display notification \"$1\" with title \"Pair install\"" >/dev/null 2>&1
  return 0
}

build() {
  echo "${BOLD}pair${RESET}"
  [[ "$(uname -s)" == Darwin ]] || warn "this script targets macOS; continuing anyway"
  resolve_node
  ok "node $("$NODE" -v) at $NODE"

  local npm_bin
  npm_bin="$(dirname "$NODE")/npm"
  [[ -x "$npm_bin" ]] || die "npm not found next to $NODE."
  # npm's scripts (vite, tsc) must run on the same Node. Scoped to the npm calls
  # so it can't change which harness CLIs (e.g. `claude`) get found later.
  local npm_path="$(dirname "$NODE"):$PATH"

  if [[ ! -f "$PAIR_DIR/node_modules/.package-lock.json" || "$PAIR_DIR/package-lock.json" -nt "$PAIR_DIR/node_modules/.package-lock.json" ]]; then
    echo "  Installing dependencies…"
    (cd "$PAIR_DIR" && PATH="$npm_path" "$npm_bin" ci --no-audit --no-fund --loglevel=error) || die "npm ci failed."
  fi
  echo "  Building…"
  local log
  log="$(mktemp -t pair-build)"
  (cd "$PAIR_DIR" && PATH="$npm_path" "$npm_bin" run build --silent >"$log" 2>&1) || {
    tail -20 "$log" >&2
    die "Build failed (full log: $log)."
  }
  rm -f "$log"
  ok "built"
}

# ---------------------------------------------------------------- Harnesses

# Copy a config file aside once before the first edit, so changes are easy to undo.
backup() {
  [[ -f "$1" && ! -f "$1.pair-backup" ]] && cp "$1" "$1.pair-backup" && echo "  ${DIM}backed up $1 → $1.pair-backup${RESET}"
  return 0
}

# Symlink the skill into a skills directory. Never clobbers a real directory.
link_skill() {
  local dir="$1" dest="$1/$SKILL_NAME"
  mkdir -p "$dir" || { fail "couldn't create $dir"; return 1; }
  if [[ -L "$dest" ]]; then
    rm "$dest"
  elif [[ -e "$dest" ]]; then
    warn "$dest exists and isn't a symlink; left it alone"
    return 1
  fi
  ln -s "$SKILL_SRC" "$dest" && ok "skill linked at $dest"
}

install_claude() {
  local settings="$HOME/.claude/settings.json" status=0
  claude mcp remove --scope user pair >/dev/null 2>&1
  local out
  if out="$(claude mcp add --scope user pair -- "$NODE" "$SERVER" 2>&1)"; then
    ok "MCP server registered (user scope)"
  else
    fail "claude mcp add failed ($(command -v claude)):"
    echo "$out" | tail -3 | cut -c1-200 | sed 's/^/      /'
    status=1
  fi
  backup "$settings"
  case "$("$NODE" "$EDIT" json-set-default "$settings" env.MCP_TOOL_TIMEOUT "\"$((TOOL_TIMEOUT_SEC * 1000))\"")" in
    updated) ok "MCP_TOOL_TIMEOUT set to ${TOOL_TIMEOUT_SEC}s in $settings" ;;
    unchanged) ok "MCP_TOOL_TIMEOUT already set in $settings; left as is" ;;
    *) warn "couldn't set MCP_TOOL_TIMEOUT in $settings; long walkthroughs may time out" ;;
  esac
  link_skill "$HOME/.claude/skills" || status=1
  return $status
}

install_codex() {
  local config="${CODEX_HOME:-$HOME/.codex}/config.toml" status=0
  backup "$config"
  if "$NODE" "$EDIT" toml-section "$config" mcp_servers.pair "$(cat <<EOF
command = "$NODE"
args = ["$SERVER"]
startup_timeout_sec = 20
tool_timeout_sec = $TOOL_TIMEOUT_SEC
EOF
)" >/dev/null; then
    ok "MCP server added to $config"
  else
    fail "couldn't update $config"; status=1
  fi
  # Codex discovers user skills in ~/.agents/skills.
  link_skill "$HOME/.agents/skills" || status=1
  return $status
}

install_opencode() {
  local dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode" config status=0
  if [[ -f "$dir/opencode.jsonc" ]]; then config="$dir/opencode.jsonc"; else config="$dir/opencode.json"; fi
  backup "$config"
  if "$NODE" "$EDIT" json-set "$config" mcp.pair \
    "{\"type\":\"local\",\"command\":[\"$NODE\",\"$SERVER\"],\"enabled\":true,\"timeout\":$((TOOL_TIMEOUT_SEC * 1000))}" >/dev/null; then
    ok "MCP server added to $config"
  else
    fail "couldn't update $config"; status=1
  fi
  # opencode also reads ~/.claude/skills and ~/.agents/skills; avoid a duplicate skill.
  local d
  for d in "$dir/skills" "$HOME/.claude/skills" "$HOME/.agents/skills"; do
    if [[ -e "$d/$SKILL_NAME" ]]; then
      ok "skill already visible to opencode via $d"
      return $status
    fi
  done
  link_skill "$dir/skills" || status=1
  return $status
}

main() {
  local targets=()
  [[ $# -gt 1 ]] && { usage; exit 2; }
  case "${1:-}" in
    "") targets=("${HARNESSES[@]}") ;;
    -h|--help) usage; exit 0 ;;
    claude|claude-code) targets=(claude) ;;
    codex|opencode) targets=("$1") ;;
    *) echo "Unknown harness: $1"; usage; exit 2 ;;
  esac

  build

  local installed=() skipped=() failed=() h
  for h in "${targets[@]}"; do
    echo "${BOLD}$h${RESET}"
    if ! command -v "$h" >/dev/null; then
      warn "not found on PATH; skipped"
      skipped+=("$h")
      continue
    fi
    if "install_$h"; then installed+=("$h"); else failed+=("$h"); fi
  done

  echo
  [[ ${#installed[@]} -gt 0 ]] && echo "${GREEN}Installed:${RESET} ${installed[*]}"
  [[ ${#skipped[@]} -gt 0 ]] && echo "${YELLOW}Skipped (not found):${RESET} ${skipped[*]}"
  [[ ${#failed[@]} -gt 0 ]] && echo "${RED}Failed:${RESET} ${failed[*]}"
  if [[ ${#installed[@]} -gt 0 ]]; then
    echo "Restart any running sessions, then ask \"walk me through how … works\"."
  elif [[ ${#failed[@]} -eq 0 ]]; then
    echo "No supported harness found. Install Claude Code, Codex, or opencode, then re-run this script."
  fi
  [[ ${#failed[@]} -eq 0 ]]
}

main "$@"
