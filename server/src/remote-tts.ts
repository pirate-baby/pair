// Hosted text-to-speech through any OpenAI-compatible "audio/speech" endpoint
// (OpenAI itself, DeepInfra's hosted Kokoro, or a self-hosted server).
// Settings, including the API key, live in a per-user config file on this
// machine; the browser only ever sees whether a key is set.
//
// Only type imports from local modules here: the tests load this file directly.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KokoroSpeech, RemoteTtsPreset, RemoteTtsProvider, RemoteTtsPublic, RemoteTtsUpdate } from "../../shared/protocol.js";

export const PRESETS: Record<RemoteTtsProvider, RemoteTtsPreset> = {
  openai: { label: "OpenAI", host: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", voice: "alloy", needsKey: true },
  deepinfra: { label: "DeepInfra (Kokoro)", host: "https://api.deepinfra.com/v1/openai", model: "hexgrad/Kokoro-82M", voice: "af_heart", needsKey: true },
  custom: { label: "Custom", host: "", model: "tts-1", voice: "alloy", needsKey: false },
};

const MAX_CHARS = 1000;
const TIMEOUT_MS = Number(process.env.PAIR_TTS_TIMEOUT_MS) || 30_000;

interface Stored {
  provider: RemoteTtsProvider;
  host: string;
  apiKey: string;
  model: string;
  voice: string;
}

export function defaultSettingsFile() {
  const dir = process.env.PAIR_CONFIG_DIR ?? path.join(os.homedir(), ".config", "pair");
  return path.join(dir, "tts.json");
}

const isProvider = (p: unknown): p is RemoteTtsProvider => typeof p === "string" && Object.hasOwn(PRESETS, p);

export class RemoteTts {
  readonly file: string;

  constructor(file = defaultSettingsFile()) {
    this.file = file;
  }

  /** Read on every use, so every Pair session on the machine sees the latest settings. */
  load(): Stored {
    let raw: Partial<Stored> = {};
    try {
      if (existsSync(this.file)) raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      /* unreadable or corrupt: treat as unset */
    }
    const provider = isProvider(raw.provider) ? raw.provider : "openai";
    const preset = PRESETS[provider];
    const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
    return {
      provider,
      host: str(raw.host, ""),
      apiKey: str(raw.apiKey, ""),
      model: str(raw.model, preset.model),
      voice: str(raw.voice, preset.voice),
    };
  }

  /** What the browser may see: everything except the key. */
  publicSettings(s = this.load()): RemoteTtsPublic {
    return {
      provider: s.provider,
      host: s.host,
      model: s.model,
      voice: s.voice,
      hasKey: !!s.apiKey,
      configured: configured(s),
      presets: PRESETS,
    };
  }

  /** apiKey: omitted keeps the saved key, "" or null clears it. */
  save(update: RemoteTtsUpdate): RemoteTtsPublic {
    const cur = this.load();
    const next: Stored = { ...cur };
    if (update.provider !== undefined) {
      if (!isProvider(update.provider)) throw new Error(`Unknown provider "${update.provider}"`);
      next.provider = update.provider;
    }
    if (update.host !== undefined) {
      const host = String(update.host).trim().replace(/\/+$/, "");
      if (host && !/^https?:\/\/[^\s/]+/i.test(host)) throw new Error("Host must be an http:// or https:// URL");
      next.host = host;
    }
    if (update.model !== undefined) next.model = String(update.model).trim();
    if (update.voice !== undefined) next.voice = String(update.voice).trim();
    if (update.apiKey !== undefined) next.apiKey = update.apiKey === null ? "" : String(update.apiKey).trim();

    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    // writeFileSync's mode only applies when creating the file.
    chmodSync(this.file, 0o600);
    return this.publicSettings(next);
  }

  /** Synthesizes one sentence or so and estimates when each word starts. */
  async speak(text: string, voice?: string, speed = 1, fetchImpl: typeof fetch = fetch): Promise<KokoroSpeech> {
    const s = this.load();
    if (!s.host) throw new NotConfigured("The hosted voice isn't set up yet: add a host in the voice settings.");
    if (!configured(s)) throw new NotConfigured(`${PRESETS[s.provider].label} needs an API key: add one in the voice settings.`);
    const input = text.slice(0, MAX_CHARS);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (s.apiKey) headers.authorization = `Bearer ${s.apiKey}`;
    const scrub = (msg: string) => (s.apiKey ? msg.split(s.apiKey).join("***") : msg);

    let res: Response;
    try {
      res = await fetchImpl(`${s.host}/audio/speech`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: s.model,
          input,
          voice: voice || s.voice,
          speed: Math.min(4, Math.max(0.25, speed || 1)),
          response_format: "wav",
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(scrub(`Couldn't reach ${s.host}: ${(e as Error).message}`));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(scrub(`${PRESETS[s.provider].label} returned ${res.status}: ${errorMessage(body) || res.statusText}`));
    }
    const audio = Buffer.from(await res.arrayBuffer());
    const duration = wavDuration(audio);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("The provider didn't return WAV audio");
    return { audio: audio.toString("base64"), duration, words: estimateWords(input, duration) };
  }
}

export class NotConfigured extends Error {}

function configured(s: Stored) {
  return !!s.host && (!!s.apiKey || !PRESETS[s.provider].needsKey);
}

/** Pulls a readable message out of the common API error shapes. */
function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.detail?.error ?? j?.detail ?? j?.error ?? j?.message;
    if (typeof m === "string") return m;
    if (m) return JSON.stringify(m).slice(0, 300);
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 300);
}

/**
 * Seconds of audio in a WAV file. Streamed WAVs often declare a placeholder
 * data size (0 or 0xFFFFFFFF), so the bytes actually received win when they disagree.
 * Returns NaN for anything that isn't a WAV.
 */
export function wavDuration(buf: Buffer): number {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return NaN;
  let byteRate = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      byteRate = buf.readUInt32LE(body + 8);
    } else if (id === "data") {
      if (!byteRate) return NaN;
      const remaining = buf.length - body;
      const bytes = size === 0 || size > remaining ? remaining : size;
      return bytes / byteRate;
    }
    off = body + size + (size & 1);
  }
  return NaN;
}

/**
 * Hosted APIs don't report word timings, so spread the words over the clip in
 * proportion to their length, with a little extra for the pause after punctuation.
 */
export function estimateWords(text: string, duration: number): KokoroSpeech["words"] {
  const words = [...text.matchAll(/\S+/g)];
  const weights = words.map((m) => {
    const sounded = Math.max(1, m[0].replace(/[^\p{L}\p{N}]/gu, "").length);
    const pause = /[.!?]["')\]]*$/.test(m[0]) ? 4 : /[,;:]["')\]]*$/.test(m[0]) ? 2 : 0;
    return { sounded, pause };
  });
  const total = weights.reduce((a, w) => a + w.sounded + w.pause, 0) || 1;
  let cum = 0;
  return words.map((m, i) => {
    const start = Number(((cum / total) * duration).toFixed(3));
    cum += weights[i].sounded + weights[i].pause;
    return { offset: m.index!, start };
  });
}
