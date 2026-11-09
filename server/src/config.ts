// Command-line flags and environment settings.
//
// Hosted mode (--hosted, or PAIR_HOSTED=1) runs pair as one session of a service
// instead of on a developer's machine: a proxy in front of it serves the UI to
// signed-in users, so pair binds to a configurable address, requires a per-session
// token instead of the localhost check, never opens a browser, and talks to that
// service for its session registry, for sharing, and for speech. Every hosted
// setting is off unless asked for, so the local install behaves as before.

const argv = process.argv.slice(2);

export const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name: string) => argv.includes(`--${name}`);
const env = (name: string) => process.env[name] || undefined;

export interface HostedConfig {
  /** Address to bind, e.g. 0.0.0.0. */
  host: string;
  /** Every HTTP request and WebSocket upgrade must carry `Authorization: Bearer <token>`. */
  token: string;
  /** Session registry endpoint: PUT this session's info, GET every session. */
  registryUrl?: string;
  /** Where share_walkthrough posts walkthroughs (instead of the gh CLI). */
  shareUrl?: string;
  /** Bearer token for the registry and share endpoints. */
  serviceToken?: string;
  /** The commit the checkout is at, recorded on shared walkthroughs (default: git rev-parse HEAD). */
  sha?: string;
  /** Author mode: present_walkthrough validates and records the script without playing it. */
  author: boolean;
  /** How long to wait for a viewer to connect before a tool reports none (ms). */
  connectTimeoutMs: number;
}

export interface SpeechConfig {
  /** OpenAI-compatible base URL, e.g. https://api.deepinfra.com/v1/openai. */
  url: string;
  apiKey?: string;
  model: string;
}

function hostedConfig(): HostedConfig | null {
  if (!has("hosted") && env("PAIR_HOSTED") !== "1") return null;
  const token = flag("token") ?? env("PAIR_TOKEN");
  if (!token) throw new Error("hosted mode needs a session token (--token or PAIR_TOKEN)");
  return {
    host: flag("host") ?? env("PAIR_HOST") ?? "0.0.0.0",
    token,
    registryUrl: flag("registry-url") ?? env("PAIR_REGISTRY_URL"),
    shareUrl: flag("share-url") ?? env("PAIR_SHARE_URL"),
    serviceToken: env("PAIR_SERVICE_TOKEN"),
    sha: flag("sha") ?? env("PAIR_SHA"),
    author: has("author") || env("PAIR_AUTHOR") === "1",
    connectTimeoutMs: Number(env("PAIR_CONNECT_TIMEOUT_MS")) || 10 * 60_000,
  };
}

function speechConfig(): SpeechConfig | null {
  const url = flag("tts-url") ?? env("PAIR_TTS_URL");
  if (!url) return null;
  return { url: url.replace(/\/+$/, ""), apiKey: env("PAIR_TTS_API_KEY"), model: env("PAIR_TTS_MODEL") ?? "hexgrad/Kokoro-82M" };
}

export const hosted = hostedConfig();
/** Kokoro through an OpenAI-compatible speech endpoint instead of the local model (hosted or not). */
export const speech = speechConfig();
