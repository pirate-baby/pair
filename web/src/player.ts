import type { ResolvedAction, ResolvedScript } from "../../shared/protocol";
import { Speaker, wordStarts } from "./speech";
import type { Stage } from "./stage";

const SEGMENT_GAP_MS = 450;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PlayerState {
  script: ResolvedScript | null;
  index: number;
  /** Character offset of the word being spoken in the current segment. */
  offset: number;
  playing: boolean;
  finished: boolean;
}

class Cancelled extends Error {}

/**
 * Performs a resolved script: speaks each segment and fires its actions as the
 * voice reaches their markers. Speech never runs more than one action ahead of
 * the visuals; if an animation is still going when the next marker is reached,
 * the voice holds until it catches up, like a presenter waiting for the screen.
 */
export class Player {
  readonly speaker = new Speaker();
  state: PlayerState = { script: null, index: 0, offset: 0, playing: false, finished: false };
  onState: (s: PlayerState) => void = () => {};
  onSegment: (id: string, index: number) => void = () => {};
  onDone: (id: string) => void = () => {};

  private run = 0;
  private held = false;
  private wakers: (() => void)[] = [];
  /** Where to resume speaking within the current segment after a pause. */
  private resumeAt = 0;

  constructor(private stage: Stage) {}

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  private wake() {
    this.wakers.splice(0).forEach((w) => w());
  }

  /** Waits while paused; `voice` callers also wait while the voice is held for the visuals. */
  private async gate(run: number, voice = true) {
    while (!this.state.playing || (voice && this.held)) {
      await new Promise<void>((r) => this.wakers.push(r));
      if (run !== this.run) throw new Cancelled();
    }
    if (run !== this.run) throw new Cancelled();
  }

  load(script: ResolvedScript, startAt: number, autoplay: boolean) {
    this.stop();
    this.set({ script, index: startAt, offset: 0, finished: false, playing: false });
    this.resumeAt = 0;
    this.speaker.prefetch(script.segments[startAt]?.text ?? "");
    this.start(this.run, startAt);
    if (autoplay) this.play();
  }

  play() {
    if (!this.state.script || this.state.playing) return;
    if (this.state.finished) {
      // Replay from the top.
      this.stop();
      this.set({ index: 0, offset: 0, finished: false });
      this.resumeAt = 0;
      this.start(this.run, 0);
    }
    this.set({ playing: true });
    this.wake();
  }

  pause() {
    if (!this.state.playing) return;
    this.set({ playing: false });
    this.speaker.stop();
  }

  toggle() {
    this.state.playing ? this.pause() : this.play();
  }

  /** Jump to a segment (keeps play/pause state). */
  seek(index: number) {
    const script = this.state.script;
    if (!script) return;
    const playing = this.state.playing;
    this.stop();
    this.resumeAt = 0;
    this.set({ index, offset: 0, finished: false, playing });
    this.start(this.run, index);
  }

  stop() {
    this.run++;
    this.held = false;
    this.speaker.stop();
    this.wake();
  }

  private start(run: number, from: number) {
    this.perform(run, from).catch((e) => {
      if (!(e instanceof Cancelled)) console.error(e);
    });
  }

  private async perform(run: number, from: number) {
    const script = this.state.script!;
    for (let i = from; i < script.segments.length; i++) {
      await this.gate(run);
      this.set({ index: i, offset: this.resumeAt });
      this.onSegment(script.id, i);
      await this.segment(run, i);
      this.resumeAt = 0;
      if (i < script.segments.length - 1) await sleep(SEGMENT_GAP_MS);
    }
    await this.gate(run);
    this.set({ finished: true, playing: false, offset: Infinity });
    this.onDone(script.id);
  }

  private async segment(run: number, i: number) {
    const seg = this.state.script!.segments[i];
    const starts = wordStarts(seg.text);
    let next = 0;
    let tail: Promise<void> = Promise.resolve();
    let pending = 0;

    const enqueue = (a: ResolvedAction) => {
      pending++;
      const prev = tail;
      tail = prev.then(async () => {
        await this.gate(run, false);
        await this.apply(a);
        pending--;
      });
      tail.catch(() => {});
      return prev;
    };
    const fireUpTo = (offset: number, duringSpeech: boolean) => {
      while (next < seg.actions.length && seg.actions[next].offset <= offset) {
        const busy = pending > 0;
        const before = enqueue(seg.actions[next++]);
        if (duringSpeech && busy) {
          // Hold the voice until the earlier action finishes.
          this.held = true;
          this.speaker.stop();
          before.finally(() => {
            if (run !== this.run) return;
            this.held = false;
            this.wake();
          });
        }
      }
    };

    // When resuming mid-segment, the earlier actions already ran.
    if (this.resumeAt > 0) while (next < seg.actions.length && seg.actions[next].offset < this.resumeAt) next++;
    fireUpTo(this.resumeAt, false);

    let pos = this.resumeAt;
    let prefetched = false;
    for (;;) {
      await this.gate(run);
      const speaking = this.speaker.speak(seg.text, pos, (offset) => {
        if (run !== this.run) return;
        // Resume from the start of the current word.
        pos = starts.filter((s) => s <= offset).pop() ?? 0;
        this.resumeAt = pos;
        this.set({ offset });
        fireUpTo(offset, true);
      });
      // Request the next segment's audio only after this one's, so it doesn't queue ahead of it.
      const upcoming = this.state.script!.segments[i + 1];
      if (!prefetched && upcoming) this.speaker.prefetch(upcoming.text);
      prefetched = true;
      const result = await speaking;
      if (run !== this.run) throw new Cancelled();
      if (result === "end") break;
    }
    fireUpTo(Infinity, false);
    await tail;
    if (run !== this.run) throw new Cancelled();
  }

  private async apply(a: ResolvedAction) {
    switch (a.do) {
      case "open":
        return this.stage.open(a.path);
      case "reveal":
        return this.stage.reveal(a.path, a.start, a.end);
      case "highlight":
        return this.stage.highlight(a.path, a.start, a.end, a.keep);
      case "clear":
        return this.stage.clear();
    }
  }
}
