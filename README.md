# Pair

_"Walk me through how our caching works across regions"_

_"Why are there two User models?"_

_"Let's really dig into how thumbprint extraction works"_

Pair is an MCP that allows agents to walk you through code the way a human would - by scrolling and highlighting in the codebase as they explain answers to your questions. 

The agent controls the cursor and can navigate the file explorer and code editor as it narrates. 
Interrupt any time to divert the conversation, then return to the original answer with a click. 

>[!WARNING]
> Make sure you allow sound or this video won't make any sense! 

https://github.com/user-attachments/assets/d4865547-c69d-45f3-8a83-efeb903307b4

>[!NOTE]
> Some notes on the video above:
> - the cursor, highlights, and scrolling are the agent, not the user (they are the navigator)
> - the narration stops when you start typing a question (I interrupt to ask about envars)
> - clicking the "go back to X" button interrupts and returns to the original narration 


Uses your agent harness and then either browser native voice or (optionally) Kokoro as a really good local voice model. 

The first time you select Kokoro expect a delay (5-10 min on most connections) while it initially downloads the model. Future use will be near-instant.

## Installation
Requires Node.js ≥ 22.12. The installer is written for macOS (elsewhere it warns and carries on).

```
npm install -g pair-mcp
pair install                       # or: pair install claude | codex | opencode
```

To update, run `npm install -g pair-mcp` again. Harness configs point at the global install, so there's nothing to re-run (`npx` won't work for this, since its cache can be cleared).

Or from source:

```
git clone https://github.com/pirate-baby/pair.git
cd pair && ./install.sh            # or ./install.sh claude | codex | opencode
```

Either way, Pair is installed into each of Claude Code, Codex, and opencode that's on your PATH (missing ones are skipped):
- **Claude Code:** registers the `pair` MCP server (user scope) and sets `MCP_TOOL_TIMEOUT` in `~/.claude/settings.json`, if not already set, so long walkthroughs don't time out
- **Codex:** adds `[mcp_servers.pair]` to `~/.codex/config.toml`
- **opencode:** adds `mcp.pair` to `~/.config/opencode/opencode.json(c)`
- symlinks the `code-walkthrough` skill into each harness's skills directory

Each config file is copied to `<file>.pair-backup` before its first edit. Re-running is safe, and (from source) is how you update after a `git pull`.

While a session is running, Pair serves its UI on `http://localhost:7420` (bound to 127.0.0.1 only). Kokoro is opt-in: the first time you pick it, Pair installs `kokoro-js` into `~/.cache/pair/kokoro` and downloads the ~330 MB model from Hugging Face.

## Usage
In your harness of choice, tell the agent to walk you through or explain some part of your repo. Pair takes it from there. 

### Sharing walkthroughs
After a walkthrough plays, ask the agent to "share this walkthrough on the PR". It posts a comment on the current branch's pull request with the [GitHub CLI](https://cli.github.com) (run `gh auth login` first). The comment holds a collapsed transcript, for anyone without Pair, and the script itself. Nothing is added to your codebase, and only people who can see the repo can see it.

To watch one, click **▶ Play in pair** in the comment. That opens Pair's local UI (http://localhost:7420), so it only works while a Pair session is open in your agent. Or ask your agent to "play the walkthrough on PR 123". You don't need the PR's branch checked out. Pair shows the exact commit the walkthrough was written against, reading it straight from git (and fetching it from `origin` if you don't have it yet), so it works from any branch, even with uncommitted changes, and nothing in your working tree changes. A bar above the editor shows which commit you're looking at; **Back to your checkout** returns to your own files. Any Pair session in the same repo can play it. If the link opens a session for a different repo, or one whose agent is busy elsewhere, Pair lists your other running sessions and their state, so you can open it in the right one. Either way, it plays exactly as written, without regenerating it, and you can still interrupt with questions, which your agent answers from that same commit.

No PR? Ask for a gist instead. Secret gists are unlisted, but anyone with the link can read them.



## Hosted mode

Pair can also run as one session of a service (for example, a walkthrough container behind a web app), instead of on your machine. Everything below is off unless you turn it on; the local install behaves as before.

| Setting | Flag / environment | What it does |
| --- | --- | --- |
| Hosted | `--hosted` / `PAIR_HOSTED=1` | Never opens a browser; waits for a viewer to connect through the service's proxy |
| Bind address | `--host` / `PAIR_HOST` (default `0.0.0.0`) | Where the UI listens |
| Session token | `--token` / `PAIR_TOKEN` (required) | Every request and WebSocket upgrade must carry `Authorization: Bearer <token>`; the proxy adds it, so it never reaches the browser. Replaces the localhost check |
| Session registry | `--registry-url` / `PAIR_REGISTRY_URL` | `PUT` this session's info and `GET` every session, instead of files under `~/.cache/pair/sessions` |
| Public URL | `PAIR_PUBLIC_URL` | The URL viewers reach this session at, recorded in the registry |
| Commit | `--sha` / `PAIR_SHA` | The commit shared walkthroughs record (default: `git rev-parse HEAD`) |
| Share endpoint | `--share-url` / `PAIR_SHARE_URL` | `share_walkthrough` posts the walkthrough JSON there instead of using `gh`; the response is `{"url": ...}` |
| Service token | `PAIR_SERVICE_TOKEN` | Bearer token for the registry and share endpoints |
| Author mode | `--author` / `PAIR_AUTHOR=1` | `present_walkthrough` validates and records the script without playing it, so an agent can write a walkthrough with no viewer (then `share_walkthrough`) |
| Viewer wait | `PAIR_CONNECT_TIMEOUT_MS` (default 10 minutes) | How long tools wait for a viewer |

**Remote Kokoro** (hosted or not): set `--tts-url` / `PAIR_TTS_URL` to an OpenAI-compatible speech endpoint (DeepInfra, Together AI, or a self-hosted [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)), with `PAIR_TTS_API_KEY` and optionally `PAIR_TTS_MODEL` (default `hexgrad/Kokoro-82M`). Pair then calls `/audio/speech` instead of installing kokoro-js and downloading the model. Word timings are estimated from character positions, since those endpoints return audio only.

The UI uses relative URLs, so a proxy can serve it under a path (for example `/pair/<session>/`).

## License

[MIT](LICENSE)
