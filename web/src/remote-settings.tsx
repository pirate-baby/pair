// Settings for the hosted speech engine: provider preset, host, API key and model.
// The key is sent to the local pair server once and never comes back.
import { useState } from "react";
import type { RemoteTtsProvider, RemoteTtsPublic, RemoteTtsSaved, RemoteTtsUpdate } from "../../shared/protocol";

export async function saveRemoteSettings(update: RemoteTtsUpdate): Promise<RemoteTtsSaved> {
  const res = await fetch("/api/tts/remote/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as RemoteTtsSaved;
}

export function RemoteSettings({ settings, onSaved, onClose }: { settings: RemoteTtsPublic; onSaved: (s: RemoteTtsPublic) => void; onClose: () => void }) {
  const [provider, setProvider] = useState<RemoteTtsProvider>(settings.provider);
  const [host, setHost] = useState(settings.host || settings.presets[settings.provider].host);
  const [model, setModel] = useState(settings.model);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const preset = settings.presets[provider];

  const pickProvider = (p: RemoteTtsProvider) => {
    const next = settings.presets[p];
    setProvider(p);
    setHost(next.host);
    setModel(next.model);
    setResult(null);
  };

  const save = async () => {
    setBusy(true);
    setResult(null);
    try {
      const update: RemoteTtsUpdate = { provider, host, model, test: true };
      if (provider !== settings.provider) update.voice = preset.voice;
      if (key.trim()) update.apiKey = key.trim();
      else if (clearKey) update.apiKey = null;
      const saved = await saveRemoteSettings(update);
      onSaved(saved.settings);
      setKey("");
      setClearKey(false);
      if (!saved.settings.configured) setResult({ ok: false, text: saved.settings.host ? `Saved. ${preset.label} needs an API key.` : "Saved. Add a host to use it." });
      else if (saved.test?.ok === false) setResult({ ok: false, text: `Saved, but the test failed: ${saved.test.error}` });
      else setResult({ ok: true, text: "Saved. The provider answered." });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="remote-settings">
      <div className="remote-settings-head">
        <strong>Hosted voice</strong>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      <label>
        Provider
        <select value={provider} onChange={(e) => pickProvider(e.target.value as RemoteTtsProvider)}>
          {(Object.keys(settings.presets) as RemoteTtsProvider[]).map((p) => (
            <option key={p} value={p}>{settings.presets[p].label}</option>
          ))}
        </select>
      </label>
      <label>
        Host
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://…/v1" spellCheck={false} />
      </label>
      <label>
        API key{!preset.needsKey && " (optional)"}
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={settings.hasKey && !clearKey ? "Saved; type to replace" : "Not set"}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {settings.hasKey && !key && (
        <label className="remote-settings-check">
          <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Remove the saved key
        </label>
      )}
      <label>
        Model
        <input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
      </label>
      <div className="remote-settings-actions">
        <button onClick={save} disabled={busy}>{busy ? "Testing…" : "Save"}</button>
        {result && <span className={result.ok ? "ok" : "error"}>{result.text}</span>}
      </div>
      <div className="engine-note">
        Narration text is sent to this provider. The key is kept in your user config on this machine, not in the browser.
      </div>
    </div>
  );
}
