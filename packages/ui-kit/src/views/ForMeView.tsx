import { useEffect, useMemo, useState } from "react";
import { useKb } from "../server/kbStore";
import { kbApi, type KbArtefact } from "../server/kb";
import { rel } from "../server/views";
import { ActionRow, Btn, Card, Chip, TextInput } from "./index-kit";

/** For Me — the human's inbox. First tab. Surfaces everything awaiting a
 *  human decision or attention:
 *   - proposed KB decisions (BR#621-class) — markdown popover, comment,
 *     accept / reject-with-reason inline; the transition POST route acts
 *     as actor "web" which satisfies the human-authoritative gate
 *   - open agent asks addressed to the human (hub plane)
 *   - open question threads (link into Discussions)
 */

import { decisionFrame, groupDecisions, DecisionPopover, useDecisionAct, AskOptions } from "./decide";

function DecisionRow({ d, onDone }: { d: KbArtefact; onDone: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const { busy, err, act } = useDecisionAct(d, onDone);
  return (
    <Card className="ask-urgent forme-item">
      {(() => {
        const f = decisionFrame(d);
        return (
          <div className="ask-chips">
            <Chip tone="urgent">{f.kind === "verify" ? "VERDICT" : "DECISION"}</Chip>
            {f.verdict && <Chip tone={f.verdict === "bounce" ? "needs" : "done"}>{f.verdict.toUpperCase()}</Chip>}
            {f.target && <Chip tone="scope">{f.target}</Chip>}
            <span className="why-line">{d.id} · proposed {rel(d.created_ts)} · by {(d.meta as any)?.proposed_by ?? d.owner ?? "—"}</span>
          </div>
        );
      })()}
      <h3 className="ask-question">
        {(() => {
          const f = decisionFrame(d);
          return f.kind === "verify"
            ? `${f.verdict === "bounce" ? "Bounce" : "Accept verification of"} ${f.target ?? "task"}`
            : d.title;
        })()}
      </h3>
      {(() => {
        const f = decisionFrame(d);
        const from = (d as any).request_from as string | undefined;
        return f.kind === "generic" && from ? <p className="ask-reason">request from: {from}</p> : null;
      })()}
      <ActionRow>
        {(() => {
          const f = decisionFrame(d);
          const acceptLabel = f.kind === "verify" && f.verdict === "bounce" ? "Bounce it" : "Accept";
          return (
            <>
              <Btn variant="accept" disabled={busy} onClick={() => void act("accepted")}>{acceptLabel}</Btn>
              <Btn variant="reject" disabled={busy} onClick={() => void act("rejected")}>Reject</Btn>
              <Btn quiet onClick={() => setOpen(true)}>Details / comment…</Btn>
            </>
          );
        })()}
        {err && <span className="k-err">{err}</span>}
      </ActionRow>
      {open && <DecisionPopover d={d} onClose={() => setOpen(false)} onChanged={() => onDone(d.id)} />}
    </Card>
  );
}

/** One card per TARGET TASK: latest verdict is actionable, identical prior
 *  rounds collapse into a muted line (the flood fix — round 9 of "unchanged"
 *  bounce verdicts is loop telemetry, not 9 separate human decisions). */
function VerdictGroupRow({ latest, prior, onDone }: { latest: KbArtefact; prior: KbArtefact[]; onDone: (id: string) => void }) {
  const [showPrior, setShowPrior] = useState(false);
  const m = (latest.meta ?? {}) as Record<string, unknown>;
  const target = String(m.task ?? m.verify_target ?? "");
  const verdict = String(m.verdict ?? "").toLowerCase() === "bounce" ? "bounce" : "verified";
  return (
    <Card className="ask-urgent forme-item">
      <div className="ask-chips">
        <Chip tone="urgent">VERDICT</Chip>
        <Chip tone={verdict === "bounce" ? "needs" : "done"}>{verdict.toUpperCase()}</Chip>
        <Chip tone="scope">{target}</Chip>
        <span className="why-line">{latest.id} · proposed {rel(latest.created_ts)}</span>
      </div>
      <h3 className="ask-question" onClick={() => void 0}>
        {(verdict === "bounce" ? `Bounce ${target}` : `Accept verification of ${target}`).slice(0, 110)}
      </h3>
      {prior.length > 0 && (
        <p className="why-line" style={{ margin: "2px 0" }}>
          <Btn size="sm" style={{ fontSize: "10.5px", padding: "1px 8px" }} onClick={() => setShowPrior(!showPrior)}>
            {showPrior ? "▾" : "▸"} {prior.length} identical prior round{prior.length > 1 ? "s" : ""} collapsed
          </Btn>
        </p>
      )}
      {showPrior && prior.map((d) => (
        <p key={d.id} className="why-line" style={{ margin: "1px 0 1px 12px" }}>
          {d.id} · {rel(d.created_ts)} · {String((d.meta as any)?.verdict ?? "").toUpperCase()} — {(d.title ?? "").slice(0, 80)}
        </p>
      ))}
      <VerdictActions d={latest} onDone={onDone} />
    </Card>
  );
}

function VerdictActions({ d, onDone }: { d: KbArtefact; onDone: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const { busy, err, act } = useDecisionAct(d, onDone);
  const verdict = String((d.meta as any)?.verdict ?? "").toLowerCase() === "bounce";
  return (
    <>
      <ActionRow>
        <Btn variant="accept" disabled={busy} onClick={() => void act("accepted")}>{verdict ? "Bounce it" : "Accept"}</Btn>
        <Btn variant="reject" disabled={busy} onClick={() => void act("rejected")}>Reject</Btn>
        <Btn quiet onClick={() => setOpen(true)}>Details / comment…</Btn>
        {err && <span className="k-err">{err}</span>}
      </ActionRow>
      {open && <DecisionPopover d={d} onClose={() => setOpen(false)} onChanged={() => onDone(d.id)} />}
    </>
  );
}

function QuestionNodeRow({ node, onDone }: { node: any; onDone: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const ask = node.meta?.ask ?? {};
  const answer = async (a: string) => {
    if (!a.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await kbApi.askAnswer(node.id, a.trim());
      await useKb.getState().refresh();
      onDone(node.id);
    } catch (e) {
      setErr((e as Error).message || "answer failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="forme-item">
      <div className="ask-chips">
        <Chip tone="needs">ASK</Chip>
        {ask.urgency === "urgent" && <Chip tone="urgent">URGENT</Chip>}
        <span className="why-line">{ask.from ?? "agent"} · {rel(node.created_ts)}</span>
      </div>
      <h3 className="ask-question">{node.title}</h3>
      {ask.reason && <p className="ask-reason"><b>why escalated:</b> {ask.reason}</p>}
      {(ask.options ?? []).length > 0 && (
        <AskOptions options={ask.options as string[]} busy={busy} onPick={(o) => void answer(o)} />
      )}
      <div className="steer-box">
        <TextInput
          value={text}
          placeholder="Answer in your own words…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) void answer(text); }}
        />
        <Btn disabled={busy || !text.trim()} onClick={() => void answer(text)}>Answer</Btn>
        {err && <span className="k-err">{err}</span>}
      </div>
    </Card>
  );
}

export function ForMeView({ openThread }: { openThread?: (taskId: string) => void }) {
  const tasks = useKb((s) => s.tasks);
  const refresh = useKb((s) => s.refresh);
  const [proposed, setProposed] = useState<KbArtefact[] | null>(null);
  const [tick, setTick] = useState(0);

  const load = async () => {
    try {
      const r = await kbApi.artefacts({ type: "decision", status: "proposed" });
      setProposed(r.artefacts ?? []);
    } catch {
      setProposed([]);
    }
  };

  // Blocked-on-ask queue: tasks parked on Ray's GO, with one-click approval.
  // The ask.answer auto-resumes the blocked task server-side.
  const blockedOnAsk = tasks.filter((t: any) => t.meta?.awaiting_ask?.ask_id && t.status === "blocked");
  const answerGo = async (t: any) => {
    try {
      await kbApi.askAnswer(t.meta.awaiting_ask.ask_id, "GO — approved per the receipts on this ask");
      setTick((x) => x + 1);
    } catch { /* surfaced via refresh */ }
  };
  useEffect(() => { void load(); }, [tick]);

  // open question nodes = the ask feed (one plane)
  const asked = useMemo(
    () => (tasks as any[]).filter((t) => {
      if (!(t.tags ?? []).includes("question") || !t.meta?.ask) return false;
      if (!["todo", "in_progress", "blocked"].includes(t.status)) return false;
      const am = t.meta.ask ?? {};
      return !(am.to && am.from && am.to === am.from); // self-asks: coordination, not a human decision
    }),
    [tasks],
  );

  const questions = useMemo(
    () => tasks.filter((t) => t.meta?.kind === "question" || (t.tags ?? []).includes("question")),
    [tasks],
  );

  const bump = () => { void refresh(); setTick((x) => x + 1); };

  const grouped = useMemo(() => groupDecisions(proposed ?? []), [proposed]);

  const total = grouped.verdictCards.length + grouped.generic.length + asked.length + blockedOnAsk.length;

  return (
    <div className="disc-wrap">
      <div className="view-head">
        <h2>For Me</h2>
        <span className="muted-note">{total > 0 ? `${total} awaiting you` : "nothing needs you right now"}</span>
      </div>
      {blockedOnAsk.length > 0 && (
        <Card>
          <h2>Blocked — awaiting your GO ({blockedOnAsk.length})</h2>
          {blockedOnAsk.map((t: any) => {
            const hours = t.meta?.awaiting_ask?.annotated_h ?? 0;
            const reason = String(t.meta?.blocked?.reason ?? "").replace(/^⏳ blocked \d+h — .*? · /, "");
            return (
              <div key={t.id} className="forme-item">
                <span>{t.id}</span>
                <span title={t.title}>{t.title}</span>
                <span className="muted-note">blocked {hours}h · {reason.slice(0, 120)}</span>
                <Btn onClick={() => void answerGo(t)}>GO — approve & resume</Btn>
              </div>
            );
          })}
          <p className="muted-note">GO answers the ask and auto-resumes the task server-side.</p>
        </Card>
      )}

      {proposed === null && <p className="empty">loading…</p>}
      {proposed !== null && proposed.length === 0 && asked.length === 0 && questions.length === 0 && (
        <p className="empty">Nothing needs you right now. Proposed decisions, agent asks and open questions land here.</p>
      )}

      {asked.map((d: any) => (
        <QuestionNodeRow key={d.id} node={d} onDone={bump} />
      ))}

      {grouped.verdictCards.map(({ latest, prior }) => (
        <VerdictGroupRow key={latest.id} latest={latest} prior={prior} onDone={bump} />
      ))}

      {grouped.generic.map((d) => (
        <DecisionRow key={d.id} d={d} onDone={bump} />
      ))}

      {questions.length > 0 && (
        <section className="panel-section">
          <h2>Open question threads · {questions.length}</h2>
          <div className="disc-list">
            {questions.map((t) => (
              <Card key={t.id} className="forme-item forme-link" onClick={() => openThread?.(t.id)}>
                <div className="ask-chips">
                  <Chip tone="scope">QUESTION</Chip>
                  {(t.meta as any)?.awaiting_decision && (
                    <Chip tone="urgent" title="a decision has been filed — accepting it closes this question, rejecting reopens it">
                      AWAITING DECISION {(t.meta as any).awaiting_decision}
                    </Chip>
                  )}
                  <span className="why-line">{t.owner ?? "—"} · updated {rel(t.updated_ts)}</span>
                </div>
                <h3 className="ask-question">{t.title}</h3>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
