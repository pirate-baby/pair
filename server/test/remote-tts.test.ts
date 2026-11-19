import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { estimateWords, RemoteTts, wavDuration } from "../src/remote-tts.ts";

const tempFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "pair-tts-")), "config", "tts.json");

/** A mono 16-bit WAV of `samples` silent samples; `declared` overrides the data chunk's size field. */
function wav(sampleRate: number, samples: number, declared?: number) {
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + data, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(declared ?? data, 40);
  return buf;
}

/** A stand-in speech API on localhost that records each request and answers with `reply`. */
async function fakeProvider(reply: (res: http.ServerResponse) => void) {
  const requests: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(body || "null") });
      reply(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { host, requests, close: () => new Promise((r) => server.close(r)) };
}

test("loads defaults when no settings file exists", () => {
  const tts = new RemoteTts(tempFile());
  const s = tts.publicSettings();
  assert.equal(s.host, "");
  assert.equal(s.hasKey, false);
  assert.equal(s.configured, false);
  assert.equal(s.provider, "openai");
  assert.equal(s.model, s.presets.openai.model);
});

test("saves settings to a file only the user can read", () => {
  const file = tempFile();
  const tts = new RemoteTts(file);
  const saved = tts.save({ provider: "deepinfra", host: "https://api.deepinfra.com/v1/openai/", model: "hexgrad/Kokoro-82M", voice: "af_bella", apiKey: "sk-test-123" });
  assert.equal(saved.configured, true);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const loaded = new RemoteTts(file).load();
  assert.deepEqual(loaded, { provider: "deepinfra", host: "https://api.deepinfra.com/v1/openai", apiKey: "sk-test-123", model: "hexgrad/Kokoro-82M", voice: "af_bella" });
});

test("keeps the saved key when a save omits it and clears it when blank", () => {
  const tts = new RemoteTts(tempFile());
  tts.save({ host: "https://api.openai.com/v1", apiKey: "sk-keep" });
  tts.save({ model: "tts-1" });
  assert.equal(tts.load().apiKey, "sk-keep");
  assert.equal(tts.load().model, "tts-1");
  const cleared = tts.save({ apiKey: "" });
  assert.equal(tts.load().apiKey, "");
  assert.equal(cleared.hasKey, false);
  assert.equal(cleared.configured, false);
});

test("public settings never include the api key", () => {
  const file = tempFile();
  const tts = new RemoteTts(file);
  const saved = tts.save({ host: "https://api.openai.com/v1", apiKey: "sk-secret-value" });
  for (const view of [saved, tts.publicSettings()]) {
    assert.equal(view.hasKey, true);
    assert.ok(!JSON.stringify(view).includes("sk-secret-value"));
  }
  assert.ok(readFileSync(file, "utf8").includes("sk-secret-value"));
});

test("computes duration from a wav header", () => {
  assert.equal(wavDuration(wav(24_000, 12_000)), 0.5);
  assert.ok(Number.isNaN(wavDuration(Buffer.from("ID3 not a wav file"))));
});

test("computes duration from the actual bytes when the declared size is wrong", () => {
  assert.equal(wavDuration(wav(24_000, 24_000, 0xffffffff)), 1);
  assert.equal(wavDuration(wav(24_000, 24_000, 0)), 1);
});

test("estimates increasing word start times within the clip", () => {
  const text = "Here, the sync loop runs. Then it stops";
  const words = estimateWords(text, 3);
  assert.deepEqual(
    words.map((w) => w.offset),
    [...text.matchAll(/\S+/g)].map((m) => m.index),
  );
  assert.equal(words[0].start, 0);
  for (let i = 1; i < words.length; i++) assert.ok(words[i].start > words[i - 1].start);
  assert.ok(words[words.length - 1].start < 3);
});

test("sends text to the provider's speech endpoint with the bearer key", async () => {
  const audio = wav(24_000, 48_000);
  const provider = await fakeProvider((res) => res.writeHead(200, { "content-type": "audio/wav" }).end(audio));
  try {
    const tts = new RemoteTts(tempFile());
    tts.save({ provider: "openai", host: provider.host, apiKey: "sk-abc", model: "gpt-4o-mini-tts", voice: "alloy" });
    const out = await tts.speak("Hello there, world.", "nova", 1.15);
    assert.equal(provider.requests.length, 1);
    const [req] = provider.requests;
    assert.equal(req.url, "/v1/audio/speech");
    assert.equal(req.headers.authorization, "Bearer sk-abc");
    assert.deepEqual(req.body, { model: "gpt-4o-mini-tts", input: "Hello there, world.", voice: "nova", speed: 1.15, response_format: "wav" });
    assert.equal(out.duration, 2);
    assert.equal(Buffer.from(out.audio, "base64").length, audio.length);
    assert.equal(out.words.length, 3);
  } finally {
    await provider.close();
  }
});

test("reports the provider's error without leaking the key", async () => {
  const provider = await fakeProvider((res) =>
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Incorrect API key provided: sk-leaky" } })),
  );
  try {
    const tts = new RemoteTts(tempFile());
    tts.save({ provider: "openai", host: provider.host, apiKey: "sk-leaky" });
    await assert.rejects(tts.speak("Hi."), (e: Error) => {
      assert.match(e.message, /401/);
      assert.match(e.message, /Incorrect API key/);
      assert.ok(!e.message.includes("sk-leaky"));
      return true;
    });
  } finally {
    await provider.close();
  }
});

test("refuses to synthesize until a host is configured", async () => {
  let called = false;
  const fetchSpy = (async () => {
    called = true;
    return new Response("");
  }) as typeof fetch;
  const tts = new RemoteTts(tempFile());
  await assert.rejects(tts.speak("Hi.", undefined, 1, fetchSpy), /isn't set up/);
  tts.save({ provider: "openai", host: "https://api.openai.com/v1" });
  await assert.rejects(tts.speak("Hi.", undefined, 1, fetchSpy), /needs an API key/);
  assert.equal(called, false);
});
