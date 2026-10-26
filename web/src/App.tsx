import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientMessage, KokoroStatus, ResolvedScript, ServerMessage } from "../../shared/protocol";
import { Player, type PlayerState } from "./player";
import { KOKORO_VOICES, Speaker, type Engine } from "./speech";
import { Stage, type TabsState } from "./stage";
import { FileTree, tree } from "./tree";

type LogEntry =
  | { kind: "question"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "script"; key: number; script: ResolvedScript; from: number; reached: number };

const PREFS_KEY = "pair.prefs";
function loadPrefs(): { voice?: string; rate?: number; enabled?: boolean; engine?: Engine; kokoroVoice?: string } {
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
  // Set while the agent is waiting on the user (await_user); options render as buttons.
  const shownPrompt = useRef<string | null>(null);
  // Set once the session is over: { message } is the agent's goodbye (null if the user ended it).
  const [ended, setEnded] = useState<{ message: string | null } | null>(null);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [pausedMain, setPausedMain] = useState<{ title: string; index: number; total: number } | null>(null);
  const [awaiting, setAwaiting] = useState<{ prompt: string | null; options: string[] } | undefined>(undefined);
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
  const [engine, setEngine] = useState<Engine>(prefs.engine ?? "system");
  const [kokoroVoice, setKokoroVoice] = useState(prefs.kokoroVoice ?? "af_heart");
  const [kokoro, setKokoro] = useState<KokoroStatus>({ state: "off" });

  const send = (m: ClientMessage) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify(m));

  useEffect(() => {
    player.speaker.enabled = voiceOn;
    player.speaker.voiceURI = voiceURI || null;
    player.speaker.rate = rate;
    player.speaker.engine = engine;
    player.speaker.kokoroVoice = kokoroVoice;
    savePrefs({ enabled: voiceOn, voice: voiceURI, rate, engine, kokoroVoice });
  }, [player, voiceOn, voiceURI, rate, engine, kokoroVoice]);

  // Choosing Kokoro installs/loads it on the server (no-op once it's running).
  useEffect(() => {
    if (connected && engine === "kokoro" && (kokoro.state === "off" || kokoro.state === "error")) {
      fetch("/api/tts/kokoro/enable", { method: "POST" }).catch(() => {});
    }
  }, [connected, engine, kokoro.state === "off"]);

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
          if (m.text) setEnded(null);
          break;
        case "ended": {
          setEnded({ message: m.message });
          setAwaiting(undefined);
          setStatus(null);
          const goodbye = m.message;
          if (goodbye && goodbye !== shownPrompt.current) {
            shownPrompt.current = goodbye;
            setLog((l) => [...l, { kind: "agent", text: goodbye }]);
            player.speaker.speak(goodbye, 0, () => {}).catch(() => {});
          }
          break;
        }
        case "main":
          setPausedMain(m.paused);
          break;
        case "kokoro":
          player.speaker.kokoroStatus = m.status;
          setKokoro(m.status);
          break;
        case "play": {
          // A reconnect re-sends the current walkthrough; keep what's already loaded.
          if (!m.autoplay && player.state.script?.id === m.script.id) break;
          setEnded(null);
          setAwaiting(undefined);
          setStatus(null);
          setLog((l) => [...l, { kind: "script", key: logKey++, script: m.script, from: m.startAt, reached: m.startAt }]);
          const canSpeak = !player.speaker.enabled || navigator.userActivation?.hasBeenActive !== false;
          player.load(m.script, m.startAt, m.autoplay && canSpeak);
          setNeedsGesture(m.autoplay && !canSpeak);
          break;
        }
        case "await": {
          setEnded(null);
          setAwaiting({ prompt: m.prompt, options: m.options ?? [] });
          setStatus(null);
          const prompt = m.prompt;
          // The agent's question is a turn in the conversation: show it and say it.
          // A reconnect re-sends the pending prompt, so only act on a new one.
          if (prompt && prompt !== shownPrompt.current) {
            shownPrompt.current = prompt;
            setLog((l) => [...l, { kind: "agent", text: prompt }]);
            if (!player.state.playing) player.speaker.speak(prompt, 0, () => {}).catch(() => {});
          }
          break;
        }
        case "stop":
          player.stop();
          player.pause();
          break;
      }
    };
    connect();

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space") {
        e.preventDefault();
        player.toggle();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        player.skip(-1);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        player.skip(1);
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

  const ask = (text?: string, choice?: number) => {
    const q = (text ?? question).trim();
    if (!q) return;
    player.pause();
    player.speaker.stop();
    shownPrompt.current = null;
    send({ type: "interrupt", id: ps.script?.id ?? null, index: ps.index, question: q, context: stage.context(), choice });
    setLog((l) => [...l, { kind: "question", text: q }]);
    setQuestion("");
    // Hand the keyboard back to the player shortcuts (Space, ←, →).
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setAwaiting(undefined);
  };

  const goBack = () => {
    if (!pausedMain) return;
    player.pause();
    player.speaker.stop();
    shownPrompt.current = null;
    send({ type: "return", context: stage.context() });
    setLog((l) => [...l, { kind: "question", text: `↩ Back to: ${pausedMain.title}` }]);
    setAwaiting(undefined);
  };

  const transcriptEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [log.length, ps.index]);

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

        {pausedMain && (
          <button className="return-link" onClick={goBack} title="Ask the agent to pick the walkthrough back up">
            <span className="return-arrow">↩</span>
            <span className="return-text">
              Back to: <strong>{pausedMain.title}</strong>
            </span>
            <span className="return-part">
              part {pausedMain.index + 1} of {pausedMain.total}
            </span>
          </button>
        )}

        <div className="transcript">
          {log.length === 0 && !status && (
            <div className="empty">Ask your agent a question about this codebase. The walkthrough will play here.</div>
          )}
          {log.map((e) =>
            e.kind === "question" ? (
              <div key={`q${log.indexOf(e)}`} className="bubble">{e.text}</div>
            ) : e.kind === "agent" ? (
              <div key={`a${log.indexOf(e)}`} className="bubble agent">{e.text}</div>
            ) : (
              <ScriptView key={e.key} entry={e} live={e.key === lastScriptKey ? ps : null} onSeek={(i) => player.seek(i)} />
            ),
          )}
          {ended && (
            <div className="session-ended">
              <div>Session ended. Ask your agent another question to start a new walkthrough.</div>
              <button
                className="secondary"
                onClick={() => {
                  window.close();
                  // Browsers only let script-opened tabs close themselves.
                  setTimeout(() => setCloseBlocked(true), 300);
                }}
              >
                Close tab
              </button>
              {closeBlocked && <div className="close-note">Your browser won't let this page close itself. Close the tab whenever you're ready.</div>}
            </div>
          )}
          {status && (
            <div className="status">
              <span className="spinner" /> {status}
            </div>
          )}
          <div ref={transcriptEnd} />
        </div>

        <div className="controls">
          <div className="transport">
            <button className="skip" onClick={() => player.skip(-1)} disabled={!ps.script} title="Back (←): restart this part, or go to the previous one" aria-label="Back">
              «
            </button>
            <button className="play" onClick={() => player.toggle()} disabled={!ps.script} title="Play / pause (Space)">
              {ps.playing ? "❚❚ Pause" : ps.finished ? "↺ Replay" : "▶ Play"}
            </button>
            <button className="skip" onClick={() => player.skip(1)} disabled={!ps.script || ps.finished} title="Next part (→)" aria-label="Next">
              »
            </button>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={voiceOn} onChange={(e) => setVoiceOn(e.target.checked)} /> Voice
          </label>
          <select value={engine} onChange={(e) => setEngine(e.target.value as Engine)} disabled={!voiceOn} title="Speech engine">
            <option value="system">System</option>
            <option value="kokoro">Kokoro</option>
          </select>
          {engine === "kokoro" ? (
            <select value={kokoroVoice} onChange={(e) => setKokoroVoice(e.target.value)} disabled={!voiceOn}>
              {KOKORO_VOICES.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          ) : (
            <select value={voiceURI} onChange={(e) => setVoiceURI(e.target.value)} disabled={!voiceOn}>
              <option value="">Auto voice</option>
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name}
                  {v.localService ? "" : " (network)"}
                </option>
              ))}
            </select>
          )}
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
            {[0.9, 1, 1.05, 1.15, 1.3, 1.5].map((r) => (
              <option key={r} value={r}>{r}×</option>
            ))}
          </select>
        </div>

        {voiceOn && engine === "kokoro" && kokoro.state !== "ready" && (
          <div className={`engine-status ${kokoro.state === "error" ? "error" : ""}`}>
            {kokoro.state === "error" ? (
              <>
                Kokoro failed: {kokoro.message}{" "}
                <button className="link" onClick={() => fetch("/api/tts/kokoro/enable", { method: "POST" })}>Retry</button>
              </>
            ) : (
              <>
                <span className="spinner" /> {kokoro.message ?? "Starting Kokoro…"}
                {kokoro.progress !== undefined && ` ${Math.round(kokoro.progress * 100)}%`}
                <span className="engine-note">Using the system voice until it's ready.</span>
              </>
            )}
          </div>
        )}

        <div className={`ask ${awaiting ? "waiting" : ""}`}>
          {awaiting && !awaiting.prompt && <div className="ask-prompt">Any follow-up questions?</div>}
          {awaiting && awaiting.options.length > 0 && (
            <div className="options">
              {awaiting.options.map((o, i) => (
                <button key={o} className="option" onClick={() => ask(o, i)}>{o}</button>
              ))}
            </div>
          )}
          <textarea
            value={question}
            placeholder={
              ended
                ? "Session ended. Continue in your agent's chat."
                : ps.playing
                  ? "Interject — typing pauses the walkthrough…"
                  : awaiting?.options.length
                    ? "…or ask something else"
                    : "Ask a question…"
            }
            disabled={!!ended}
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
            <button onClick={() => ask()} disabled={!question.trim()}>Ask</button>
            {awaiting && (
              <button className="secondary" onClick={() => (send({ type: "end" }), setAwaiting(undefined), setEnded({ message: null }))}>End session</button>
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
  // Skipping back past where this entry resumed should still show the part being played.
  const from = current && !current.finished ? Math.min(entry.from, current.index) : entry.from;
  return (
    <div className={`script ${script.transition ? "transition" : ""}`}>
      {script.aside ? (
        <div className="script-title aside">Answering: {script.aside.question}</div>
      ) : (
        !script.transition && <div className="script-title">{script.title}</div>
      )}
      {from > 0 && !script.aside && <div className="resumed">Resumed from part {from + 1}</div>}
      {script.segments.slice(from, upTo + 1).map((seg, j) => {
        const i = from + j;
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
