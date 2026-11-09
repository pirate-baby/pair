// Kokoro through an OpenAI-compatible speech endpoint (DeepInfra, Together, a
// self-hosted Kokoro-FastAPI, …), instead of installing kokoro-js and downloading
// the model in every session. Same interface as the local engine (kokoro.ts).
//
// The endpoint returns audio only, so word timings are estimated: each word starts
// at its share of the characters. The local engine's phoneme timings are better;
// this is close enough to keep highlights in step with sentence-sized clips.
import type { KokoroSpeech, KokoroStatus } from "../../shared/protocol.js";
import type { SpeechConfig } from "./config.js";

/** Seconds of audio in a PCM WAV file, from its header. */
export function wavDuration(wav: Buffer): number {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let byteRate = 0;
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") byteRate = wav.readUInt32LE(at + 16);
    // Streamed WAVs may leave the data size as 0 or 0xFFFFFFFF: use what arrived.
    if (id === "data") return (size && size !== 0xffffffff ? Math.min(size, wav.length - at - 8) : wav.length - at - 8) / byteRate;
    at += 8 + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

/** Word start times spread over the clip by character position. */
export function estimateWords(text: string, duration: number): KokoroSpeech["words"] {
  const words = [...text.matchAll(/\S+/g)];
  const total = text.trimEnd().length || 1;
  return words.map((m) => ({ offset: m.index!, start: (m.index! / total) * duration }));
}

export class RemoteKokoro {
  status: KokoroStatus = { state: "ready" };
  onStatus: (s: KokoroStatus) => void = () => {};

  constructor(private config: SpeechConfig) {}

  enable(): Promise<void> {
    return Promise.resolve();
  }

  async speak(text: string, voice: string, speed: number): Promise<KokoroSpeech> {
    const res = await fetch(`${this.config.url}/audio/speech`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey && { authorization: `Bearer ${this.config.apiKey}` }),
      },
      body: JSON.stringify({ model: this.config.model, input: text, voice, speed, response_format: "wav" }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      this.status = { state: "error", message: `Speech endpoint: HTTP ${res.status} ${detail}` };
      this.onStatus(this.status);
      throw new Error(this.status.message);
    }
    if (this.status.state !== "ready") {
      this.status = { state: "ready" };
      this.onStatus(this.status);
    }
    const wav = Buffer.from(await res.arrayBuffer());
    const duration = wavDuration(wav);
    return { audio: wav.toString("base64"), duration, words: estimateWords(text, duration) };
  }
}
