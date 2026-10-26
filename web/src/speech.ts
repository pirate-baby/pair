// Text-to-speech with word-level progress. Two engines:
//  - "system": the Web Speech API. When a voice doesn't report word boundaries
//    (or voice is off) progress is estimated from speaking rate.
//  - "kokoro": local neural TTS synthesized by the pair server, one sentence at
//    a time, with word timings derived from the model's phoneme durations.
//    Falls back to "system" until Kokoro is ready, or if a request fails.
import type { KokoroSpeech, KokoroStatus } from "../../shared/protocol";

export type SpeakResult = "end" | "stopped";
export type Engine = "system" | "kokoro";

export const KOKORO_VOICES: { id: string; name: string }[] = [
  { id: "af_heart", name: "Heart (US, F)" },
  { id: "af_bella", name: "Bella (US, F)" },
  { id: "af_nicole", name: "Nicole (US, F)" },
  { id: "am_michael", name: "Michael (US, M)" },
  { id: "am_fenrir", name: "Fenrir (US, M)" },
  { id: "am_puck", name: "Puck (US, M)" },
  { id: "bf_emma", name: "Emma (UK, F)" },
  { id: "bm_george", name: "George (UK, M)" },
  { id: "bm_fable", name: "Fable (UK, M)" },
];

interface Chunk {
  start: number;
  text: string;
}
interface Clip extends KokoroSpeech {
  url: string;
}

/** Sentence-sized pieces: short enough to synthesize quickly, long enough for natural prosody. */
export function chunkText(text: string): Chunk[] {
  const out: Chunk[] = [];
  // Sentence ends are punctuation followed by whitespace, so "index.ts" stays whole.
  for (const m of text.matchAll(/(?:[^.!?]|[.!?](?!["')\]]*(?:\s|$)))+(?:[.!?]+["')\]]*|$)\s*/g)) {
    if (!m[0].trim()) continue;
    let piece = { start: m.index!, text: m[0] };
    // Split very long sentences at commas.
    while (piece.text.length > 300) {
      const cut = piece.text.lastIndexOf(", ", 280);
      if (cut < 40) break;
      out.push({ start: piece.start, text: piece.text.slice(0, cut + 2) });
      piece = { start: piece.start + cut + 2, text: piece.text.slice(cut + 2) };
    }
    const prev = out[out.length - 1];
    // Fold tiny fragments ("Okay.") into the previous chunk.
    if (prev && piece.text.trim().length < 16) prev.text += piece.text;
    else out.push(piece);
  }
  return out;
}

const CHARS_PER_SEC = 14.5;
const BOUNDARY_GRACE_MS = 700;

export function wordStarts(text: string): number[] {
  return [...text.matchAll(/\S+/g)].map((m) => m.index!);
}

export class Speaker {
  enabled = true;
  rate = 1.05;
  voiceURI: string | null = null;
  engine: Engine = "system";
  kokoroVoice = "af_heart";
  kokoroStatus: KokoroStatus = { state: "off" };
  private clips = new Map<string, Promise<Clip>>();
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

  private useKokoro() {
    return this.enabled && this.engine === "kokoro" && this.kokoroStatus.state === "ready";
  }

  /** Warm the cache for text that's about to be spoken (e.g. the next segment). */
  prefetch(text: string) {
    if (!this.useKokoro()) return;
    for (const c of chunkText(text).slice(0, 2)) this.clip(c.text).catch(() => {});
  }

  private clip(text: string): Promise<Clip> {
    const key = `${this.kokoroVoice}|${this.rate}|${text}`;
    let p = this.clips.get(key);
    if (!p) {
      p = fetch("/api/tts/kokoro", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voice: this.kokoroVoice, speed: this.rate }),
      })
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          const bytes = Uint8Array.from(atob(body.audio), (c) => c.charCodeAt(0));
          return { ...body, url: URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })) } as Clip;
        })
        .catch((e) => {
          this.clips.delete(key);
          throw e;
        });
      this.clips.set(key, p);
      // Keep the cache bounded; the oldest clips are the least likely to replay.
      if (this.clips.size > 60) {
        const [oldKey, old] = this.clips.entries().next().value!;
        this.clips.delete(oldKey);
        old.then((c) => URL.revokeObjectURL(c.url), () => {});
      }
    }
    return p;
  }

  /**
   * Speaks text[from..], calling onProgress with absolute character offsets as
   * each word begins. Resolves "stopped" if stop() is called first.
   */
  speak(text: string, from: number, onProgress: (offset: number) => void): Promise<SpeakResult> {
    return this.useKokoro() ? this.speakKokoro(text, from, onProgress) : this.speakSystem(text, from, onProgress);
  }

  private speakKokoro(text: string, from: number, onProgress: (offset: number) => void): Promise<SpeakResult> {
    this.stop();
    const chunks = chunkText(text);
    let index = Math.max(0, chunks.findIndex((c) => c.start + c.text.length > from));
    let stopped = false;
    let audio: HTMLAudioElement | null = null;
    let wake: (() => void) | null = null;
    let lastOffset = -1;
    const progress = (abs: number) => {
      if (!stopped && abs > lastOffset) {
        lastOffset = abs;
        onProgress(abs);
      }
    };
    this.stopCurrent = () => {
      stopped = true;
      audio?.pause();
      wake?.();
    };

    return (async (): Promise<SpeakResult> => {
      for (; index < chunks.length; index++) {
        const chunk = chunks[index];
        let clip: Clip;
        try {
          clip = await this.clip(chunk.text);
          if (chunks[index + 1]) this.clip(chunks[index + 1].text).catch(() => {});
        } catch (e) {
          if (stopped) return "stopped";
          console.warn("[pair] Kokoro failed; using the system voice", e);
          return this.speakSystem(text, Math.max(from, chunk.start), onProgress);
        }
        if (stopped) return "stopped";

        // Resuming mid-chunk: start at the first word at or after `from`.
        const first = clip.words.find((w) => chunk.start + w.offset >= from);
        const startAt = first && chunk.start + first.offset > chunk.start ? Math.max(0, first.start - 0.05) : 0;
        const a = new Audio(clip.url);
        audio = a;
        a.currentTime = startAt;
        const ended = new Promise<void>((r) => {
          wake = r;
          a.onended = () => r();
          a.onerror = () => r();
        });
        try {
          await a.play();
        } catch (e) {
          console.warn("[pair] audio playback failed", e);
          if (stopped) return "stopped";
          return this.speakSystem(text, Math.max(from, chunk.start), onProgress);
        }
        const tick = window.setInterval(() => {
          for (const w of clip.words) if (w.start <= a.currentTime + 0.03 && chunk.start + w.offset >= from) progress(chunk.start + w.offset);
        }, 40);
        await ended;
        clearInterval(tick);
        if (stopped) return "stopped";
        from = chunk.start + chunk.text.length;
      }
      progress(text.length);
      this.stopCurrent = null;
      return "end";
    })();
  }

  private speakSystem(text: string, from: number, onProgress: (offset: number) => void): Promise<SpeakResult> {
    this.stop();
    const chunk = text.slice(from);
    const starts = wordStarts(chunk);
    return new Promise((resolve) => {
      let done = false;
      let voiceDone = !this.enabled;
      let clockDone = false;
      let sawBoundary = false;
      let started = false;
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
        started = true;
        progress(0);
        timers.push(window.setTimeout(() => !sawBoundary && startClock(BOUNDARY_GRACE_MS), BOUNDARY_GRACE_MS));
      };
      this.utterance = u;
      speechSynthesis.cancel();
      // Chrome occasionally swallows a speak() issued in the same tick as cancel().
      timers.push(window.setTimeout(() => !done && speechSynthesis.speak(u), 40));
      // Some environments (no voices installed, audio blocked) never start or error.
      timers.push(
        window.setTimeout(() => {
          if (started || done) return;
          console.warn("[pair] speech didn't start; continuing without voice");
          speechSynthesis.cancel();
          voiceDone = true;
          startClock();
        }, 1500),
      );
    });
  }
}
