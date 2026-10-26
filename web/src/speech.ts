// Text-to-speech with word-level progress, via the Web Speech API.
// When a voice doesn't report word boundaries (or voice is off) progress is
// estimated from speaking rate, so actions still fire roughly in sync.

export type SpeakResult = "end" | "stopped";

const CHARS_PER_SEC = 14.5;
const BOUNDARY_GRACE_MS = 700;

export function wordStarts(text: string): number[] {
  return [...text.matchAll(/\S+/g)].map((m) => m.index!);
}

export class Speaker {
  enabled = true;
  rate = 1.05;
  voiceURI: string | null = null;
  private stopCurrent: (() => void) | null = null;
  // Chrome drops events for utterances that get garbage collected.
  private utterance: SpeechSynthesisUtterance | null = null;

  static voices(): SpeechSynthesisVoice[] {
    return typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  }

  /** Prefers on-device voices: they report word boundaries; network voices often don't. */
  static defaultVoice(): SpeechSynthesisVoice | null {
    const vs = Speaker.voices();
    const local = vs.filter((v) => v.localService);
    const score = (v: SpeechSynthesisVoice) =>
      (/(premium|enhanced)/i.test(v.name) ? 4 : 0) + (v.lang === "en-US" ? 2 : 0) + (/^(Ava|Zoe|Samantha|Evan|Nathan)/.test(v.name) ? 1 : 0);
    return [...local].sort((a, b) => score(b) - score(a))[0] ?? vs[0] ?? null;
  }

  stop() {
    this.stopCurrent?.();
  }

  /**
   * Speaks text[from..], calling onProgress with absolute character offsets as
   * each word begins. Resolves "stopped" if stop() is called first.
   */
  speak(text: string, from: number, onProgress: (offset: number) => void): Promise<SpeakResult> {
    this.stop();
    const chunk = text.slice(from);
    const starts = wordStarts(chunk);
    return new Promise((resolve) => {
      let done = false;
      let voiceDone = !this.enabled;
      let clockDone = false;
      let sawBoundary = false;
      let lastOffset = -1;
      const timers: number[] = [];

      const progress = (rel: number) => {
        if (done) return;
        const abs = from + rel;
        if (abs > lastOffset) {
          lastOffset = abs;
          onProgress(abs);
        }
      };
      const finish = (r: SpeakResult) => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        this.stopCurrent = null;
        if (r === "stopped" && this.enabled) speechSynthesis.cancel();
        resolve(r);
      };
      const maybeEnd = () => {
        if (voiceDone && clockDone) {
          progress(chunk.length);
          finish("end");
        }
      };
      this.stopCurrent = () => finish("stopped");

      // Estimated clock: used when voice is off or the voice never reports boundaries.
      const startClock = (elapsedMs = 0) => {
        const cps = CHARS_PER_SEC * this.rate;
        const at = (chars: number) => Math.max(0, (chars / cps) * 1000 - elapsedMs);
        for (const s of starts) timers.push(window.setTimeout(() => !sawBoundary && progress(s), at(s)));
        timers.push(
          window.setTimeout(() => {
            clockDone = true;
            maybeEnd();
          }, at(chunk.length) + 150),
        );
      };

      if (!chunk.trim()) {
        clockDone = voiceDone = true;
        return maybeEnd();
      }

      if (!this.enabled) return startClock();

      const u = new SpeechSynthesisUtterance(chunk);
      const voice = Speaker.voices().find((v) => v.voiceURI === this.voiceURI) ?? Speaker.defaultVoice();
      if (voice) u.voice = voice;
      u.rate = this.rate;
      u.onboundary = (e) => {
        if (e.name && e.name !== "word") return;
        sawBoundary = true;
        clockDone = true;
        progress(e.charIndex);
      };
      u.onend = () => {
        voiceDone = true;
        clockDone ||= sawBoundary;
        maybeEnd();
      };
      u.onerror = (e) => {
        if (e.error === "interrupted" || e.error === "canceled") return;
        // Fall back to silent timing rather than stalling the walkthrough.
        voiceDone = true;
        if (!sawBoundary) startClock();
        else maybeEnd();
      };
      u.onstart = () => {
        progress(0);
        timers.push(window.setTimeout(() => !sawBoundary && startClock(BOUNDARY_GRACE_MS), BOUNDARY_GRACE_MS));
      };
      this.utterance = u;
      speechSynthesis.cancel();
      // Chrome occasionally swallows a speak() issued in the same tick as cancel().
      timers.push(window.setTimeout(() => !done && speechSynthesis.speak(u), 40));
    });
  }
}
