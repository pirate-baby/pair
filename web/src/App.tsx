import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientMessage, ResolvedScript, ServerMessage } from "../../shared/protocol";
import { Player, type PlayerState } from "./player";
import { Speaker } from "./speech";
import { Stage, type TabsState } from "./stage";
import { FileTree, tree } from "./tree";

type LogEntry =
  | { kind: "question"; text: string }
  | { kind: "script"; key: number; script: ResolvedScript; from: number; reached: number };

const PREFS_KEY = "pair.prefs";
function loadPrefs(): { voice?: string; rate?: number; enabled?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function savePrefs(p: object) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...p }));
  } catch {
    /* storage unavailable */
  }
}

let logKey = 0;

export function App() {
  const stage = useMemo(() => new Stage(), []);
  const player = useMemo(() => new Player(stage), [stage]);
  const editorEl = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);

  const [connected, setConnected] = useState(false);
  const [rootName, setRootName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [awaitPrompt, setAwaitPrompt] = useState<string | null | undefined>(undefined);
  const [ps, setPs] = useState<PlayerState>(player.state);
  const [tabs, setTabs] = useState<TabsState>(stage.tabs);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [question, setQuestion] = useState("");
  const [needsGesture, setNeedsGesture] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const prefs = useMemo(loadPrefs, []);
  const [voiceOn, setVoiceOn] = useState(prefs.enabled ?? true);
  const [voiceURI, setVoiceURI] = useState<string>(prefs.voice ?? "");
  const [rate, setRate] = useState(prefs.rate ?? 1.05);

  const send = (m: ClientMessage) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify(m));

  useEffect(() => {
    player.speaker.enabled = voiceOn;
    player.speaker.voiceURI = voiceURI || null;
    player.speaker.rate = rate;
    savePrefs({ enabled: voiceOn, voice: voiceURI, rate });
  }, [player, voiceOn, voiceURI, rate]);

  useEffect(() => {
    const update = () => setVoices(Speaker.voices());
    update();
    speechSynthesis?.addEventListener?.("voiceschanged", update);
    return () => speechSynthesis?.removeEventListener?.("voiceschanged", update);
  }, []);

  useEffect(() => {
    stage.attach(editorEl.current!);
    stage.onTabs = setTabs;
    player.onState = (s) => {
      setPs(s);
      setLog((l) => {
        const last = l[l.length - 1];
        if (last?.kind !== "script" || last.script.id !== s.script?.id || last.reached >= s.index) return l;
        return [...l.slice(0, -1), { ...last, reached: s.index }];
      });
    };
    player.onSegment = (id, index) => send({ type: "segment", id, index });
    player.onDone = (id) => send({ type: "done", id });
    tree.load("");

    let closed = false;
    let retry: number | undefined;
    const connect = () => {
      const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      socket.current = s;
      s.onopen = () => setConnected(true);
      s.onclose = () => {
        setConnected(false);
        if (!closed) retry = window.setTimeout(connect, 1000);
      };
      s.onmessage = (ev) => handle(JSON.parse(ev.data) as ServerMessage);
    };
    const handle = (m: ServerMessage) => {
      switch (m.type) {
        case "hello":
          setRootName(m.rootName);
          document.title = `Pair — ${m.rootName}`;
          break;
        case "status":
          setStatus(m.text);
          break;
        case "play": {
          setAwaitPrompt(undefined);
          setStatus(null);
          setLog((l) => [...l, { kind: "script", key: logKey++, script: m.script, from: m.startAt, reached: m.startAt }]);
          const canSpeak = !player.speaker.enabled || navigator.userActivation?.hasBeenActive !== false;
          player.load(m.script, m.startAt, m.autoplay && canSpeak);
          setNeedsGesture(m.autoplay && !canSpeak);
          break;
        }
        case "await":
          setAwaitPrompt(m.prompt);
          setStatus(null);
          break;
        case "stop":
          player.stop();
          player.pause();
          break;
      }
    };
    connect();

    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        player.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      closed = true;
      clearTimeout(retry);
      socket.current?.close();
      window.removeEventListener("keydown", onKey);
      player.stop();
      stage.dispose();
    };
  }, [player, stage]);

  const ask = () => {
    const q = question.trim();
    if (!q) return;
    player.pause();
    send({ type: "interrupt", id: ps.script?.id ?? null, index: ps.index, question: q, context: stage.context() });
    setLog((l) => [...l, { kind: "question", text: q }]);
    setQuestion("");
    setAwaitPrompt(undefined);
  };

  const transcriptEnd = useRef<HTMLDivElement>(null);
  useEffect(() => transcriptEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" }), [log.length, ps.index]);

  const lastScriptKey = [...log].reverse().find((e) => e.kind === "script")?.key;

  return (
    <div className="app">
      <FileTree rootName={rootName} onOpen={(p) => stage.open(p, false)} />

      <div className="editor-pane">
        <div className="tabs">
          {tabs.tabs.map((t) => (
            <div key={t} data-tab-path={t} className={`tab ${t === tabs.active ? "active" : ""}`} onClick={() => stage.open(t, false)} title={t}>
              {t.split("/").pop()}
            </div>
          ))}
          <div className="tab-path">{tabs.active}</div>
        </div>
        <div className="editor" ref={editorEl} />
      </div>

      <div className="narration">
        <div className="pane-title">
          <span className={`dot ${connected ? "on" : ""}`} title={connected ? "Connected" : "Disconnected"} />
          Walkthrough
        </div>

        <div className="transcript">
          {log.length === 0 && !status && (
            <div className="empty">Ask your agent a question about this codebase. The walkthrough will play here.</div>
          )}
          {log.map((e) =>
            e.kind === "question" ? (
              <div key={`q${log.indexOf(e)}`} className="bubble">{e.text}</div>
            ) : (
              <ScriptView key={e.key} entry={e} live={e.key === lastScriptKey ? ps : null} onSeek={(i) => player.seek(i)} />
            ),
          )}
          {status && (
            <div className="status">
              <span className="spinner" /> {status}
            </div>
          )}
          <div ref={transcriptEnd} />
        </div>

        <div className="controls">
          <button className="play" onClick={() => player.toggle()} disabled={!ps.script} title="Play / pause (Space)">
            {ps.playing ? "❚❚ Pause" : ps.finished ? "↺ Replay" : "▶ Play"}
          </button>
          <label className="toggle">
            <input type="checkbox" checked={voiceOn} onChange={(e) => setVoiceOn(e.target.checked)} /> Voice
          </label>
          <select value={voiceURI} onChange={(e) => setVoiceURI(e.target.value)} disabled={!voiceOn}>
            <option value="">Auto voice</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name}
                {v.localService ? "" : " (network)"}
              </option>
            ))}
          </select>
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
            {[0.9, 1, 1.05, 1.15, 1.3, 1.5].map((r) => (
              <option key={r} value={r}>{r}×</option>
            ))}
          </select>
        </div>

        <div className={`ask ${awaitPrompt !== undefined ? "waiting" : ""}`}>
          {awaitPrompt !== undefined && <div className="ask-prompt">{awaitPrompt ?? "Any follow-up questions?"}</div>}
          <textarea
            value={question}
            placeholder={ps.playing ? "Interject — typing pauses the walkthrough…" : "Ask a question…"}
            onChange={(e) => {
              setQuestion(e.target.value);
              if (e.target.value) player.pause();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
            rows={2}
          />
          <div className="ask-actions">
            <button onClick={ask} disabled={!question.trim()}>Ask</button>
            {awaitPrompt !== undefined && (
              <button className="secondary" onClick={() => (send({ type: "end" }), setAwaitPrompt(undefined))}>End session</button>
            )}
          </div>
        </div>
      </div>

      {needsGesture && (
        <div className="gesture" onClick={() => (setNeedsGesture(false), player.play())}>
          <button>▶ Start walkthrough</button>
          <div>Your browser needs one click before it can speak.</div>
        </div>
      )}
    </div>
  );
}

function ScriptView({ entry, live, onSeek }: { entry: Extract<LogEntry, { kind: "script" }>; live: PlayerState | null; onSeek: (i: number) => void }) {
  const { script } = entry;
  const current = live && live.script?.id === script.id ? live : null;
  const upTo = current ? (current.finished ? script.segments.length - 1 : current.index) : entry.reached;
  return (
    <div className="script">
      {script.aside ? <div className="script-title aside">Answering: {script.aside.question}</div> : <div className="script-title">{script.title}</div>}
      {entry.from > 0 && !script.aside && <div className="resumed">Resumed from part {entry.from + 1}</div>}
      {script.segments.slice(entry.from, upTo + 1).map((seg, j) => {
        const i = entry.from + j;
        const isLive = current && !current.finished && i === current.index;
        const cut = isLive ? spokenEnd(seg.text, current.offset) : seg.text.length;
        return (
          <p key={i} className={`seg ${isLive ? "live" : ""}`} onClick={() => current && onSeek(i)} title={current ? "Replay from here" : undefined}>
            <span className="spoken">{seg.text.slice(0, cut)}</span>
            <span className="unspoken">{seg.text.slice(cut)}</span>
          </p>
        );
      })}
    </div>
  );
}

/** End of the word starting at `offset`, so the word being spoken lights up whole. */
function spokenEnd(text: string, offset: number) {
  if (!isFinite(offset)) return text.length;
  const m = /\S*/.exec(text.slice(offset));
  return Math.min(text.length, offset + (m?.[0].length ?? 0));
}
