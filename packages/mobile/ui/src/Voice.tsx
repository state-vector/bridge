import { useCallback, useEffect, useRef, useState } from "react";

const LS = { url: "bridge.url", token: "bridge.mcp.token" };

interface Msg {
  role: "user" | "assistant";
  text: string;
  sources?: Array<{ id: string; title: string }>;
}

interface PendingAnswer {
  ask_id: string;
  answer: string;
}

type Phase = "idle" | "listening" | "thinking" | "speaking";

/** Tauri IPC — present only inside the native shell; browser builds fall
 *  back to the text leg (voice needs the mic + synthesizer anyway). */
function hasShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = (window as any).__TAURI_INTERNALS__;
  return t.invoke(cmd, args) as Promise<T>;
}

export function Voice() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [partial, setPartial] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingAnswer | null>(null);
  const [text, setText] = useState("");
  const [hub, setHub] = useState(localStorage.getItem(LS.url) ?? "");
  const [token, setToken] = useState(localStorage.getItem(LS.token) ?? "");
  const scrollRef = useRef<HTMLDivElement>(null);
  const native = hasShell();

  const saveToken = () => {
    localStorage.setItem(LS.url, hub.trim());
    localStorage.setItem(LS.token, token.trim());
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, partial, pending]);

  const runTurn = useCallback(
    async (question: string) => {
      if (!question.trim()) return;
      setError("");
      setMsgs((m) => [...m, { role: "user", text: question }]);
      setPhase("thinking");
      try {
        const res = await invoke<any>("voice_turn", {
          args: {
            hub: (localStorage.getItem(LS.url) ?? "").trim(),
            token: (localStorage.getItem(LS.token) ?? "").trim(),
            question,
            history: msgs.slice(-8).map((m) => ({ role: m.role, text: m.text })),
          },
        });
        setMsgs((m) => [...m, { role: "assistant", text: res.answer ?? "", sources: res.sources }]);
        if (res.pending_answer) setPending(res.pending_answer);
        setPhase("speaking"); // voice_turn speaks the answer itself
        if (!res.pending_answer && !(res.answer ?? "").trim()) setPhase("idle");
      } catch (e) {
        setError(String((e as Error).message ?? e));
        setPhase("idle");
      }
    },
    [msgs]
  );

  // Voice events from the shell.
  useEffect(() => {
    if (!native) return;
    let unlisten: Array<() => void> = [];
    let stopped = false;
    (async () => {
      try {
        const ev = await import("@tauri-apps/api/event");
        const on = await ev.listen<{ text: string }>("voice://partial", (e) => {
          setPartial(e.payload.text ?? "");
        });
        const fin = await ev.listen<{ text: string }>("voice://final", (e) => {
          setPartial("");
          const q = e.payload.text ?? "";
          setPhase("thinking");
          void invoke("voice_listen_stop").catch(() => {});
          void runTurnRef.current?.(q);
        });
        const done = await ev.listen("voice://speak-done", () => {
          setPhase((p) => (p === "speaking" ? "idle" : p));
        });
        const err = await ev.listen<{ stage: string; message: string }>("voice://error", (e) => {
          setError(`${e.payload.stage}: ${e.payload.message}`);
        });
        if (stopped) {
          [on, fin, done, err].forEach((u) => u());
        } else {
          unlisten = [on, fin, done, err];
        }
      } catch (e) {
        setError(`voice events unavailable: ${e}`);
      }
    })();
    return () => {
      stopped = true;
      unlisten.forEach((u) => u());
    };
  }, [native, runTurn]);

  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;

  const startListening = async () => {
    setError("");
    setPartial("");
    try {
      await invoke("voice_listen_start");
      setPhase("listening");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const stopListening = async () => {
    try {
      await invoke("voice_listen_stop");
    } catch { /* final already flushed */ }
    setPhase((p) => (p === "listening" ? "idle" : p));
  };

  const bargeIn = async () => {
    try {
      await invoke("voice_speak_stop");
    } catch { /* not speaking */ }
    setPhase("idle");
  };

  const confirmPending = async (ok: boolean) => {
    const p = pending;
    setPending(null);
    if (!p || !ok) {
      if (!ok) setMsgs((m) => [...m, { role: "assistant", text: "Held — I won't send that." }]);
      return;
    }
    setPhase("thinking");
    try {
      await invoke("voice_confirm_answer", {
        hub: (localStorage.getItem(LS.url) ?? "").trim(),
        token: (localStorage.getItem(LS.token) ?? "").trim(),
        askId: p.ask_id,
        answer: p.answer,
      });
      setMsgs((m) => [...m, { role: "assistant", text: `Sent — answered ${p.ask_id}.` }]);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
    setPhase("idle");
  };

  const micLabel =
    phase === "listening" ? "Listening… tap to stop" :
    phase === "thinking" ? "Thinking…" :
    phase === "speaking" ? "Speaking… tap to interrupt" :
    "Tap to talk";

  const micEnabled = native && (phase === "idle" || phase === "listening");

  return (
    <div className="mb-voice">
      <div className="mb-vscroll" ref={scrollRef}>
        {msgs.length === 0 && (
          <p className="mb-empty">
            Ask about your board by voice — "what's in review?", "what needs me?", "tell me about
            BR#123".
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`mb-vmsg mb-vmsg-${m.role}`}>
            <div className="mb-vbubble">{m.text}</div>
            {m.sources && m.sources.length > 0 && (
              <div className="mb-chips">
                {m.sources.map((s) => (
                  <span key={s.id} className="mb-chip mb-chip-src" title={s.title}>
                    {s.id}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {partial && phase === "listening" && (
          <div className="mb-vmsg mb-vmsg-user">
            <div className="mb-vbubble mb-vpartial">{partial}…</div>
          </div>
        )}
        {phase === "thinking" && (
          <div className="mb-vmsg mb-vmsg-assistant">
            <div className="mb-vbubble mb-vpartial">…</div>
          </div>
        )}
        {pending && (
          <div className="mb-vmsg mb-vmsg-assistant">
            <div className="mb-vbubble">
              Answer {pending.ask_id} with: "{pending.answer}" — send it?
            </div>
            <div className="mb-actions">
              <button className="mb-btn primary" onClick={() => void confirmPending(true)}>
                Confirm — send
              </button>
              <button className="mb-btn danger" onClick={() => void confirmPending(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {error && <div className="mb-verror">{error}</div>}

      <div className="mb-vbar">
        <button
          className={`mb-mic ${phase === "listening" ? "mb-mic-live" : ""} ${phase === "speaking" || phase === "thinking" ? "mb-mic-busy" : ""}`}
          onClick={() => {
            if (phase === "listening") void stopListening();
            else if (phase === "speaking" || phase === "thinking") void bargeIn();
            else void startListening();
          }}
          disabled={!micEnabled && phase === "idle" && !native}
        >
          <span className="mb-mic-dot" />
          {micLabel}
        </button>
        <form
          className="mb-vtype"
          onSubmit={(e) => {
            e.preventDefault();
            const q = text;
            setText("");
            void runTurn(q);
          }}
        >
          <input
            value={text}
            placeholder={native ? "…or type" : "Type your question (voice needs the iOS app)"}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" disabled={!text.trim() || phase === "thinking"}>
            Ask
          </button>
        </form>
      </div>

      {!token.trim() && (
        <div className="mb-card mb-vconnect">
          <h2>Connect</h2>
          <input
            value={hub}
            placeholder="https://bridge…workers.dev"
            onChange={(e) => setHub(e.target.value)}
          />
          <input
            value={token}
            placeholder="bridge MCP token (Connect tab)"
            onChange={(e) => setToken(e.target.value)}
            onBlur={saveToken}
          />
          <span className="mb-note">the console is read-only; ask answers ask for confirmation first</span>
        </div>
      )}
    </div>
  );
}
