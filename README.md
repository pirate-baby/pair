# Pair

_"Walk me through how our caching works across regions"_

_"Why are there two User models?"_

_"Let's really dig into how thumbprint extraction works"_

Pair is an MCP that allows agents to walk you through code the way a human would - by scrolling and highlighting in the codebase as they explain answers to your questions. 

The agent controls the cursor and can navigate the file explorer and code editor as it narrates. 
Interrupt any time to divert the conversation, then return to the original answer with a click. 


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
git clone https://github.com/pirate-baby/pair.git
cd pair && ./install.sh            # or ./install.sh claude | codex | opencode
```

This builds Pair and installs it into each of Claude Code, Codex, and opencode that's on your PATH (missing ones are skipped):
- **Claude Code:** registers the `pair` MCP server (user scope) and sets `MCP_TOOL_TIMEOUT` in `~/.claude/settings.json`, if not already set, so long walkthroughs don't time out
- **Codex:** adds `[mcp_servers.pair]` to `~/.codex/config.toml`
- **opencode:** adds `mcp.pair` to `~/.config/opencode/opencode.json(c)`
- symlinks the `code-walkthrough` skill into each harness's skills directory

Each config file is copied to `<file>.pair-backup` before its first edit. Re-running is safe, and is how you update after a `git pull`.

While a session is running, Pair serves its UI on `http://localhost:7420` (bound to 127.0.0.1 only). Kokoro is opt-in: the first time you pick it, Pair installs `kokoro-js` into `~/.cache/pair/kokoro` and downloads the ~330 MB model from Hugging Face.

## Usage
In your harness of choice, tell the agent to walk you through or explain some part of your repo. Pair takes it from there. 



## License

[MIT](LICENSE)
