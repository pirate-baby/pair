// Optional local neural TTS (Kokoro-82M via kokoro-js / onnxruntime).
// Nothing is installed until the user switches the UI to Kokoro; then the
// package goes into ~/.cache/pair/kokoro and the model is downloaded once.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { KokoroSpeech, KokoroStatus } from "../../shared/protocol.js";

const HOME = process.env.PAIR_KOKORO_DIR ?? path.join(os.homedir(), ".cache", "pair", "kokoro");
const PACKAGE = "kokoro-js@1.2.1";
// This export adds a per-phoneme `durations` output, which is what lets us time words.
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped";
const SAMPLE_RATE = 24_000;
const FRAMES_PER_SEC = 40;
const MAX_CHARS = 400;

const log = (...args: unknown[]) => console.error("[pair:kokoro]", ...args);

interface Tensor {
  data: ArrayLike<number>;
  dims: number[];
}
interface RawAudio {
  audio: Float32Array;
  toWav(): ArrayBuffer;
}
interface KokoroTTS {
  tokenizer: (phonemes: string, opts: unknown) => { input_ids: Tensor };
  model: (inputs: unknown) => Promise<Record<string, Tensor>>;
  generate(text: string, opts: { voice: string; speed: number }): Promise<RawAudio>;
}

export class Kokoro {
  status: KokoroStatus = { state: "off" };
  onStatus: (s: KokoroStatus) => void = () => {};
  private tts: KokoroTTS | null = null;
  private phonemize: ((text: string, lang: string) => Promise<string[]>) | null = null;
  private lengths = new Map<string, number>();
  private starting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private set(status: KokoroStatus) {
    this.status = status;
    this.onStatus(status);
  }

  /** Installs (first time only) and loads the model. Safe to call repeatedly. */
  enable(): Promise<void> {
    if (this.tts) return Promise.resolve();
    this.starting ??= this.start().catch((e) => {
      log(e);
      this.set({ state: "error", message: (e as Error).message });
      this.starting = null;
    });
    return this.starting;
  }

  private async start() {
    if (!existsSync(path.join(HOME, "node_modules", "kokoro-js", "package.json"))) await this.install();
    this.set({ state: "loading", message: "Loading the Kokoro model…" });
    const require = createRequire(path.join(HOME, "package.json"));
    const mod = await import(pathToFileURL(require.resolve("kokoro-js")).href);
    // kokoro-js's own phonemizer; used to estimate each word's share of the audio.
    this.phonemize = (await import(pathToFileURL(require.resolve("phonemizer")).href)).phonemize;
    let lastReport = 0;
    this.tts = (await mod.KokoroTTS.from_pretrained(MODEL, {
      dtype: "fp32",
      device: "cpu",
      progress_callback: (p: { status: string; file?: string; progress?: number }) => {
        // Only the .onnx weights are big enough to be worth reporting.
        if (p.status !== "progress" || !p.file?.endsWith(".onnx") || Date.now() - lastReport < 250) return;
        lastReport = Date.now();
        this.set({ state: "loading", message: "Downloading the Kokoro model (one time, ~330 MB)…", progress: (p.progress ?? 0) / 100 });
      },
    })) as KokoroTTS;
    this.set({ state: "ready" });
  }

  private install() {
    this.set({ state: "installing", message: "Installing Kokoro (one time)…" });
    mkdirSync(HOME, { recursive: true });
    if (!existsSync(path.join(HOME, "package.json"))) writeFileSync(path.join(HOME, "package.json"), '{ "private": true }\n');
    // Use the npm that ships with the Node running us, so PATH quirks don't matter.
    const nodeDir = path.dirname(process.execPath);
    const npm = existsSync(path.join(nodeDir, "npm")) ? path.join(nodeDir, "npm") : "npm";
    return new Promise<void>((resolve, reject) => {
      const child = spawn(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error", PACKAGE], {
        cwd: HOME,
        env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ""}` },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm install ${PACKAGE} failed: ${stderr.trim().split("\n").pop() ?? code}`))));
    });
  }

  private async phonemeLength(word: string): Promise<number> {
    // All-caps acronyms are spelled out by kokoro-js; approximate ~2 phonemes per letter.
    if (/^[A-Z0-9]{2,6}[.,!?;:]*$/.test(word) && /[A-Z]/.test(word)) return strip(word).length * 2;
    const key = word.toLowerCase();
    if (!this.lengths.has(key)) {
      const out = this.phonemize ? await this.phonemize(word, "en-us").catch(() => [word]) : [word];
      this.lengths.set(key, strip(out.join(" ")).length);
    }
    return this.lengths.get(key)!;
  }

  /** Synthesizes text (one sentence or so) and times each word. Calls are serialized. */
  speak(text: string, voice: string, speed: number): Promise<KokoroSpeech> {
    const run = this.queue.then(() => this.synth(text.slice(0, MAX_CHARS), voice, speed));
    this.queue = run.catch(() => {});
    return run;
  }

  private async synth(text: string, voice: string, speed: number): Promise<KokoroSpeech> {
    const tts = this.tts;
    if (!tts) throw new Error("Kokoro isn't ready");
    // generate() doesn't expose the phonemes or the durations output, so capture them in passing.
    let phonemes = "";
    let outputs: Record<string, Tensor> = {};
    const { tokenizer, model } = tts;
    tts.tokenizer = (p, o) => ((phonemes = p), tokenizer(p, o));
    tts.model = async (i) => (outputs = await model(i));
    let audio: RawAudio;
    try {
      audio = await tts.generate(text, { voice, speed });
    } finally {
      tts.tokenizer = tokenizer;
      tts.model = model;
    }
    const duration = audio.audio.length / SAMPLE_RATE;
    let words: KokoroSpeech["words"] = [];
    if (outputs.durations) {
      const lengths = await Promise.all([...text.matchAll(/\S+/g)].map((m) => this.phonemeLength(m[0])));
      words = alignWords(text, phonemes, Array.from(outputs.durations.data, Number), duration, lengths);
    }
    return { audio: Buffer.from(audio.toWav()).toString("base64"), duration, words };
  }
}

// Stress marks, spacing and punctuation don't take time on their own.
const strip = (s: string) => s.replace(/[ˈˌː\s.,!?;:"'()\[\]—–-]/g, "");

/**
 * Maps per-phoneme durations back onto the words of the original text.
 * Phoneme words don't line up 1:1 with text words ("in the" → "ɪnðə"), so each
 * text word's expected phoneme length (from phonemizing it alone) is laid
 * cumulatively over the actual phoneme string, scaled to fit.
 */
export function alignWords(text: string, phonemes: string, durations: number[], audioSeconds: number, wordLengths: number[]) {
  // durations = [start pad, one per phoneme char, end pad]
  const starts: number[] = [];
  let t = durations[0] ?? 0;
  for (let i = 0; i < phonemes.length; i++) {
    starts.push(t);
    t += durations[i + 1] ?? 0;
  }
  const total = durations.reduce((a, b) => a + b, 0) / FRAMES_PER_SEC;
  const scale = total > 0 ? audioSeconds / total : 1;
  const timeAt = (c: number) => ((starts[c] ?? t) / FRAMES_PER_SEC) * scale;

  // Positions in `phonemes` of the characters that carry sound.
  const voiced = [...phonemes].flatMap((ch, i) => (strip(ch) ? [i] : []));
  const words = [...text.matchAll(/\S+/g)];
  const expected = words.map((_, i) => Math.max(1, wordLengths[i] ?? 1));
  const fit = voiced.length / expected.reduce((a, b) => a + b, 0);

  let cum = 0;
  return words.map((m, i) => {
    const at = Math.min(voiced.length - 1, Math.round(cum * fit));
    cum += expected[i];
    return { offset: m.index!, start: Number(timeAt(voiced[Math.max(0, at)] ?? 0).toFixed(3)) };
  });
}
