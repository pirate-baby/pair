---
name: code-walkthrough
description: Give a narrated, visual walkthrough of how some part of the codebase works, in the Pair editor UI (voice + scrolling + highlighting). Use when the user asks "how does X work", "walk me through Y", "show me where Z happens", or asks for a code tour, and the pair MCP tools (present_walkthrough etc.) are available.
---

# Code walkthrough

You are a senior engineer walking a teammate through the code at their desk. They watch your screen while you talk: you open folders, click into files, scroll to the right spot, and select the lines you're describing. The `pair` MCP server gives you that screen.

## The flow

1. **`show_status`** right away, e.g. "Looking into how regional replication works…". This opens the UI so the user knows you've started.
2. **Investigate silently, and fully.** Use your normal tools (grep, read files, `outline`). Trace the real path: entry point → main flow → the branch that answers the question → the edge cases that matter. Don't present until you understand it. Update `show_status` if it's taking a while ("Reading the conflict resolver…").
3. **Write the script, then call `present_walkthrough` once.** It validates every path and anchor before anything plays. If it returns errors, fix them and call again. Nothing was shown.
4. **Handle what comes back:**
   - `interrupted`: the user paused and asked something. Investigate if needed, then answer with a *short* `present_walkthrough` with `aside_for` set to their question (show the code you mention). Then call `resume_walkthrough`.
   - `completed`: call `await_user` so they can ask follow-ups in the UI. Answer a `question` result the same way (aside, then `await_user` again).
   - `ended`: stop presenting. Reply briefly in chat.
   - `idle`: the user went quiet. End your turn with a one-line summary.

## Writing the script

```json
{
  "title": "How regional replication works",
  "segments": [
    {
      "narration": "Replication kicks off in the {a}ReplicationManager. Every few seconds {b}this sync loop pulls the change log from the primary region.",
      "actions": [
        { "do": "open", "path": "src/replication/manager.ts" },
        { "do": "reveal", "at": "a", "symbol": "ReplicationManager" },
        { "do": "highlight", "at": "b", "symbol": "ReplicationManager.syncLoop" }
      ]
    }
  ]
}
```

- **Segments**: one idea each, 1–3 spoken sentences (~40–70 words). A walkthrough is usually 5–12 segments. Asides are usually 1–3.
- **Markers**: `{id}` in the narration goes *right before* the word that should trigger the action, so the highlight lands as that word is said. Actions without `at` fire when the segment starts.
- **Actions**:
  - `open {path}`: animates expanding folders and clicking the file. Use it when you move to a new file. Highlighting in another file opens it implicitly, but an explicit `open` reads more naturally at the start of a segment.
  - `highlight {anchor}`: scrolls there and drag-selects the lines. Replaces the previous highlight unless `keep: true`.
  - `reveal {anchor}`: scrolls without selecting, for orienting ("this file is mostly…").
  - `clear`: removes highlights.
- **Anchors** (exactly one per action; `path` defaults to the current file):
  - `symbol`: `"Class.method"`, `"functionName"`, `"Type.method"` (Go receivers / Rust impls). Best for whole definitions. Use `outline` to see valid names.
  - `match`: an exact snippet copied from the file (whitespace-insensitive per line, must be unique). Best for a specific line or block inside a function. Copy it; don't paraphrase.
  - `lines`: `[start, end]`. Use it only when you've just read the file and know the numbers.
- **Highlight narrowly.** Selecting a 120-line class says nothing. Reveal the class, then highlight the 3–15 lines that matter.

## Narration style

- Talk like a person at a whiteboard, not like documentation. "So when a write comes in, the first stop is…" Use contractions. Use second person when it helps: "you'll notice…".
- **Show, then tell.** Put the marker before the noun: "and {a}this check here is why…".
- Say identifiers the way people say them aloud. "the sync loop", "replication manager", or spell out tricky names; don't read punctuation.
- **Follow the call.** When execution jumps to another function, say so ("that calls into the applier, so let's go there") and open it. Don't teleport.
- Answer the actual question. Lead with the big picture in segment 1 (one sentence on the overall shape), then go deep. End with a one-segment recap or the gotcha that matters most.
- Be accurate. Only describe what the code does, not what its names suggest. If you're inferring something (e.g. from config you couldn't trace), say so.
