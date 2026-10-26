# Pair

Ask an agent "how does our regional replication work?" and watch it walk you through the code the way a teammate would. It opens folders, clicks into files, scrolls to the right place and highlights lines, all in sync with a spoken explanation. You can pause at any point and ask a question.

Pair is a standalone editor UI plus an MCP server, so any MCP-capable agent can drive it. A skill (`skills/code-walkthrough/SKILL.md`) teaches the agent how to present.

## How it works

```
agent ──MCP (stdio)──▶ pair server ──WebSocket──▶ browser player
        investigate       validate script            speak + animate
        (grep, read)      (tree-sitter)              (Monaco, fake cursor)
```

1. **The agent investigates silently**, using its own tools, and calls `show_status` so you can see it's working.
2. **It writes a script** made of segments. Each segment has narration with `{marker}`s and actions anchored to those markers.
3. **`present_walkthrough` validates the script against the repo.** It checks paths, tree-sitter symbols, exact-snippet matches and line ranges. If anything is wrong, nothing plays and the agent gets an error list to fix. This is what keeps it from pointing at made-up code.
4. **The browser plays the script.** Actions fire as the voice reaches each marker. If an animation is still running, the voice waits for it.
5. **The tool call blocks until something happens**: playback finishes, you pause and ask a question, or you end the session. Your question comes back as the tool result. The agent answers with a short aside, then asks where to go next ("Want to see an example run, or head back to the sync walkthrough?"). It doesn't snap back on its own. If you choose to return, it bridges back in a sentence before picking up where you paused.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `show_status` | Open the UI and show "Looking into…" while investigating |
| `outline` | List a file's symbols with line ranges (tree-sitter) |
| `present_walkthrough` | Validate and play a script. Blocks; returns `completed` / `interrupted` (with your question and what was on screen) / `ended` |
| `resume_walkthrough` | Return to the main walkthrough after an aside, with an optional spoken `intro` that bridges back |
| `await_user` | Ask where to go next: the prompt is spoken and shown as the agent's turn, and `options` render as buttons (typing anything else also works) |

## Setup

On macOS, with Node.js 22.12 or newer installed (`brew install node` if you don't have it):

```sh
git clone <this repo> pair && cd pair
./install.sh               # Claude Code, Codex, and opencode (whichever are installed)
./install.sh claude        # just one: claude | codex | opencode
```

The script checks for Node, then installs dependencies and builds. For each harness, it then:

- registers the MCP server globally, using the absolute path to `node`, so harnesses launched from the Dock or an IDE work even if their PATH differs from your shell's
- raises the tool-call timeout to 30 minutes, because a walkthrough keeps its call open
- symlinks the `code-walkthrough` skill

| Harness | MCP config | Skill |
| --- | --- | --- |
| Claude Code | `claude mcp add --scope user`, plus `MCP_TOOL_TIMEOUT` in `~/.claude/settings.json` | `~/.claude/skills/` |
| Codex | `[mcp_servers.pair]` in `~/.codex/config.toml` | `~/.agents/skills/` |
| opencode | `mcp.pair` in `~/.config/opencode/opencode.json(c)` (comments preserved) | reuses one of the above, else `~/.config/opencode/skills/` |

Harnesses that aren't installed are skipped. Before the first edit, each config file is backed up to `<file>.pair-backup`. Re-running is safe, and it's also how you update after a `git pull`. `bin/installpair` is a symlink to the same script.

Then, in any repo, ask "walk me through how X works". The UI opens at http://localhost:7420. The browser needs one click before it's allowed to speak.

### Options

- `--root <dir>` / `PAIR_ROOT`: the repo to show. Defaults to the client's root, then the working directory.
- `--port <n>` / `PAIR_PORT`: the UI port (default 7420). If it's taken, the next free port is used.
- `PAIR_NO_OPEN=1`: don't auto-open a browser tab.

## Controls

- **Space** plays or pauses. **«** / **»** (or **←** / **→**) skip between parts. Back restarts the current part once it's a few words in; otherwise it goes to the previous part.
- **Type a question** at any point to interject. Typing pauses playback.
- **↩ Back to: …** is pinned above the transcript whenever you've stepped away from the main walkthrough. Clicking it asks the agent to pick up where you left off.
- **Click any earlier paragraph** in the transcript to replay from there.

## Voice

Pick the speech engine in the controls under the transcript.

- **System** (default) uses the browser's Web Speech voices. It's free and instant, but it sounds robotic. On macOS, it sounds much better with a *Premium* or *Enhanced* voice: download one under System Settings → Accessibility → Spoken Content → System Voice → Manage Voices. "Auto voice" picks it automatically.
- **Kokoro** is a natural-sounding neural voice ([Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)) that runs locally on the pair server. It needs no API key and nothing leaves your machine. Selecting it installs it the first time: `kokoro-js` goes into `~/.cache/pair/kokoro` (about 730 MB including the model), and the UI shows progress while it downloads. Until it's ready, the system voice keeps speaking. Kokoro reads acronyms letter by letter ("AWS" → "A-W-S").

How Kokoro stays in sync: narration is synthesized one sentence at a time, and the next sentence is prefetched while the current one plays. The model reports how long each sound lasts, and the server maps those durations back onto your words, so highlights land on the right word. Set `PAIR_KOKORO_DIR` to install somewhere else. To uninstall, delete the directory.

## Try it without an agent

```sh
npm run play -- examples/pair-tour.json --root .
```

This plays a hand-written tour of this repo. It's a quick way to test player changes.

## Development

- `npm run typecheck` checks the server and the web code.
- `npm run dev:web` starts the Vite dev server with hot reload. It proxies `/api` and `/ws` to a pair server that's already running on `PAIR_PORT`.

Layout:

- `server/src/index.ts`: MCP tools and the `play` CLI.
- `server/src/script.ts`: script validation and resolution.
- `server/src/symbols.ts`: tree-sitter outlines.
- `server/src/hub.ts`: HTTP and WebSocket server, and the blocking playback outcomes.
- `web/src/player.ts`: speech-synced action scheduling.
- `web/src/stage.ts`: animated explorer and editor operations.
- `web/src/speech.ts`: speech engines (Web Speech with word boundaries and an estimated-timing fallback, or Kokoro clips).
- `server/src/kokoro.ts`: on-demand Kokoro install, synthesis, and word alignment.

## Roadmap

- Streaming segments, so playback starts before the whole script is written
- A pronunciation lexicon for project-specific terms
- Voice questions (speech to text) for interjections
- Saving and sharing walkthroughs as JSON

## License

[MIT](LICENSE)
