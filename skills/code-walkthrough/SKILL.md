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
   - `interrupted`: the user paused and asked something. Investigate if needed, then answer with a *short* `present_walkthrough` with `aside_for` set to their question (show the code you mention).
   - `completed` after an aside: **ask before you move on** (see below).
   - `completed` after the main walkthrough: `await_user` with a spoken prompt and a few follow-up options.
   - `question`: the user typed something or picked an option. If they chose to go back, `resume_walkthrough` with an `intro`. Otherwise answer with an aside, then ask again.
   - `return`: the user clicked the "Back to: …" link that the UI shows whenever the main walkthrough is paused. They've already decided, so don't ask again: call `resume_walkthrough` with an `intro` right away. It can arrive mid-aside or while you're waiting in `await_user`.
   - `ended`: stop presenting. Reply briefly in chat.
   - `idle`: the user went quiet. End your turn with a one-line summary.

## Navigating the conversation

An interjection is a fork in the road. A good presenter doesn't silently snap back to the script after a tangent, and doesn't wander off on one either. They say where they are and let the listener choose.

- **After answering an aside, never resume on your own.** Call `await_user` with a short spoken `prompt` that names both directions, plus matching `options`:
  - prompt: "Want me to walk through an example run, or should we head back to the sync walkthrough? We were on the applier."
  - options: `["Show an example run", "Back to the sync walkthrough"]`
- **Name the destinations concretely.** "Back to the sync walkthrough" beats "Resume". "Show how retries are scheduled" beats "Go deeper".
- **Offer 2–3 options at most.** The user can always type something else.
- **Bridge back when resuming.** Pass `resume_walkthrough` a one- or two-sentence `intro` that re-establishes where you were: "Okay, back to the sync loop. We'd just seen it pull the change log, so next is applying it." Only then does the main walkthrough continue.
- **Changing direction is the user's call.** If an interjection suggests the main walkthrough was the wrong path ("wait, this isn't the replication I meant"), confirm before abandoning it: "Sounds like you mean the cross-region backups. Want me to switch to those?"
- **The user can also leave a tangent on their own.** The UI pins a "Back to: <walkthrough>" link while the main walkthrough is paused, and the « / » buttons (← / → keys) skip between parts. Skips are reported to the server, so `resume_walkthrough` continues from wherever they've moved to.
- **At the end of the main walkthrough**, offer natural next steps the same way ("Want to see how failures are retried, or is that what you needed?").

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

Narration is **spoken aloud** by a text-to-speech voice and never rendered as markdown. Write what you would *say* to a teammate looking at your screen, not what you would type in a code review.

- Talk like a person at a whiteboard, not like documentation. "So when a write comes in, the first stop is…" Use contractions. Use second person when it helps: "you'll notice…".
- **Show, then tell.** Put the marker before the noun: "and {a}this check here is why…".

### Write for the ear

- **No markdown at all.** No backticks, code fences, asterisks, bullets, links, or headings. The voice either reads the symbols out or drops them, and both sound broken. `present_walkthrough` rejects narration containing backticks, markdown emphasis, `<placeholders>`, template expressions, file paths, or call syntax like `foo()`.
- **Point at code instead of reading it.** The highlight already shows the exact text, so narrate *around* it, the way you'd gesture at a screen:
  - ✗ "That stable `likes-<video-id>` job ID means removing a like later does not remove or requeue the downstream music."
  - ✓ "The job ID, {a}this 'likes dash video ID' right here, is stable, so removing a like later doesn't remove or requeue the downstream music."
- **Say identifiers the way people say them.** Turn names into words: `syncLoop` → "the sync loop", `ReplicationManager` → "the replication manager", `MAX_RETRIES` → "max retries", `user_id` → "user ID". Say punctuation only when it's the point, and then as a word: "likes dash video ID", "dot env file".
- **Don't read paths, signatures, or expressions.** Say "the manager file in the replication folder", not "src/replication/manager.ts". Say "it takes the region and a timeout", not "(region: string, timeoutMs = 5000)". Say "if the queue is empty", not "if !queue.length".
- **Placeholders and templates become plain words.** `<video-id>` → "the video ID", `${region}-replica` → "the region name, then dash replica".
- **Acronyms:** write them the way they're said. Write all-caps for letter-by-letter (AWS, SQL, UV), and a spelled-out word for ones said as words (Kubernetes rather than k8s, "postgres" rather than PostgreSQL). If a name is ambiguous, write it the way you'd say it.
- **Numbers and units:** "five seconds", "about a thousand rows", "three retries". Don't write "5000ms".
- **Keep sentences short and linear.** Avoid parentheticals and semicolons. Use a dash or a new sentence for an aside, as in the example above.
- **Follow the call.** When execution jumps to another function, say so ("that calls into the applier, so let's go there") and open it. Don't teleport.
- Answer the actual question. Lead with the big picture in segment 1 (one sentence on the overall shape), then go deep. End with a one-segment recap or the gotcha that matters most.
- Be accurate. Only describe what the code does, not what its names suggest. If you're inferring something (e.g. from config you couldn't trace), say so.
