import { useMemo, useState } from "react";
import type { Presence } from "@bridge/specs";
import { useBridge } from "../lib/store";
import { actorEvents, latestTaskId, presenceLabel, rel } from "../lib/views";
import { Avatar, ActorChip } from "./ui";

function SessionRow({ p }: { p: Presence }) {
  const events = useBridge((s) => s.events);
  const steer = useBridge((s) => s.steer);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const recent = useMemo(() => actorEvents(events, p.id, 6), [events, p.id]);
  const task = useMemo(() => latestTaskId(events, p.id), [events, p.id]);

  const submit = () => {
    if (!text.trim()) return;
    void steer(p.id, text.trim());
    setText("");
  };

  return (
    <div className="session">
      <button className="session-head" onClick={() => setOpen(!open)}>
        <Avatar p={p} active={p.active} />
        <div className="roster-main">
          <div className="roster-name">
            {presenceLabel(p)} <ActorChip kind={p.kind} />
          </div>
          <div className="roster-step">
            {recent[0] ? `${recent[0].kind} · ${recent[0].title ?? recent[0].task_id ?? ""}` : p.status ?? "no signal"}
          </div>
        </div>
        <span className="session-ts">{recent[0] ? rel(recent[0].ts) : p.last_ts ? rel(p.last_ts) : ""}</span>
        <span className="session-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="session-body">
          {task && <div className="session-run">task: {task}</div>}
          <div className="steps">
            {recent.map((e) => (
              <div key={e.id} className={`step step-${e.kind === "blocked" ? "state" : "message"}`}>
                <span className="step-kind">{e.kind === "blocked" ? "◆" : "·"}</span>
                <span className="step-label">
                  {e.kind}
                  {e.title ? ` — ${e.title}` : ""}
                </span>
                <span className="step-ts">{rel(e.ts)}</span>
              </div>
            ))}
            {recent.length === 0 && <p className="empty">no recent activity</p>}
          </div>
          {p.active && (
            <div className="steer-box">
              <input
                value={text}
                placeholder={task ? `Steer ${presenceLabel(p)} on ${task}…` : `Nudge ${presenceLabel(p)}…`}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              <button onClick={submit} disabled={!text.trim()}>
                Steer
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SessionList() {
  const presence = useBridge((s) => s.presence);
  const board = useBridge((s) => s.board);
  const events = useBridge((s) => s.events);

  const list = presence
    .filter((p) => {
      if (board === "all") return true;
      return events.some((e) => e.actor === p.id && e.board === board);
    })
    .sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.last_ts - a.last_ts);

  return (
    <div className="session-list">
      {list.map((p) => (
        <SessionRow key={p.id} p={p} />
      ))}
      {list.length === 0 && <p className="empty">No actors yet — adapters will populate this.</p>}
    </div>
  );
}
