import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Console chat — board Q&A on the local model, write-capable with
 *  confirmation: an exchange that implies new work yields a task DRAFT,
 *  and only an explicit human click creates it (dispatch_create_task →
 *  hub MCP create_artefact). The console never dispatches work. */

interface TaskDraft {
  title: string;
  body: string;
}

interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  sources?: { id: string; title?: string }[];
  engine?: string;
}

export function Chat() {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [msgs.length, busy, draft]);

  const send = async () => {
    const question = input.trim();
    if (!question || busy) return;
    setInput("");
    setErr("");
    setDraft(null);
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setBusy(true);
    try {
      const history = msgs.slice(-6).map((m) => ({ role: m.role, text: m.text }));
      const r = await invoke<any>("chat_send", { question, history });
      const answer = r.answer ?? String(r);
      setMsgs((m) => [...m, { role: "assistant", text: answer, sources: r.sources ?? [], engine: r.engine }]);

      // write pass: does the exchange imply a new task? DRAFT only —
      // creation happens on explicit confirmation below.
      if (answer && !answer.startsWith("No chat engine")) {
        try {
          const prop = await invoke<any>("chat_propose_task", { question, answer });
          if (prop && prop.title) setDraft({ title: prop.title, body: prop.body ?? "" });
        } catch {
          /* proposal is best-effort */
        }
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const createTask = async () => {
    if (!draft) return;
    setCreating(true);
    setErr("");
    try {
      const r = await invoke<any>("dispatch_create_task", { title: draft.title, body: draft.body });
      const id = r?.id ?? "task";
      setMsgs((m) => [...m, { role: "assistant", text: `Task created: ${id} — "${draft.title}" is on the board as todo.` }]);
      setDraft(null);
    } catch (e) {
      setErr(`create failed: ${String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="gw-main chat">
      <div className="chat-scroll" ref={scrollRef}>
        {msgs.length === 0 && !draft && (
          <span className="gw-log-empty">
            ask about the board — "what's blocked?", "recap BR#46", "we should add retry limits to the shipper" (that one drafts a task)
          </span>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg chat-msg-${m.role}`}>
            <div className="chat-bubble">{m.text}</div>
            {m.role === "assistant" && (m.sources?.length ?? 0) > 0 && (
              <div className="chat-srcs">
                {m.sources!.map((s) => (
                  <span key={s.id} className="chat-src gw-mono" title={s.title}>
                    {s.id}
                  </span>
                ))}
                {m.engine && <span className="gw-fmeta">{m.engine}</span>}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="chat-msg chat-msg-assistant">
            <div className="chat-bubble">…</div>
          </div>
        )}
        {draft && (
          <div className="gw-card chat-draft">
            <h2>draft task — confirm to create</h2>
            <input
              className="gw-input"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <textarea
              className="gw-input"
              rows={4}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            <div className="gw-row">
              <button
                className="gw-btn gw-btn-run"
                disabled={creating || !draft.title.trim()}
                onClick={() => void createTask()}
              >
                Create task
              </button>
              <button className="gw-btn" disabled={creating} onClick={() => setDraft(null)}>
                Discard
              </button>
            </div>
            <span className="gw-note">
              nothing is created until you confirm; created tasks land in todo — dispatch is a separate decision
            </span>
          </div>
        )}
        {err && <span className="gw-err">{err}</span>}
      </div>
      <div className="gw-card">
        <div className="gw-row">
          <input
            className="gw-input"
            style={{ flex: 1 }}
            value={input}
            placeholder="ask the board, or describe work…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) void send();
            }}
          />
          <button className="gw-btn gw-btn-run" disabled={busy || !input.trim()} onClick={() => void send()}>
            Send
          </button>
        </div>
      </div>
    </main>
  );
}
