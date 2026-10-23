import { useEffect, useMemo, useState } from "react";
import { kbApi } from "../server/kb";
import type { KbArtefact } from "../server/kb";
import { rel } from "../server/views";
import { useKb } from "../server/kbStore";
import { decisionFrame, groupDecisions, DecisionPopover, useDecisionAct, AskOptions, askKernel } from "./decide";
import { Btn, Chip } from "./index-kit";

/** The human-ask plane: proposed decisions + hub asks, rendered EXACTLY ONCE,
 *  as close to their subject as possible (2026-10-23 design, Ray):
 *   - subject is a visible Top row → nested under it, first among children
 *   - subject not in flight (in_review/backlog/done, generic, unfiled) → the
 *     residual band between stats and the fleet table
 *  Flood collapse (identical prior rounds) applies in both contexts. */

export interface AskEntry {
  kind: "verdict" | "decision" | "nodeAsk";
  latest?: KbArtefact;
  prior?: KbArtefact[];
  d?: any;
  nodeAsk?: KbArtefact;
}

export interface HumanAsks {
  ready: boolean;
  /** entries nested under a visible Top row, by target task id */
  byTask: Map<string, AskEntry[]>;
  /** everything whose subject is not on the board — the residual inbox */
  residual: AskEntry[];
  total: number;
}

export function useHumanAsks(visibleTaskIds: Set<string>): HumanAsks {
  const evSeq = useKb((s) => s.events[0]?.seq ?? 0);
  const tasks = useKb((s) => s.tasks);
  const nodeAsks = useMemo(
    () => (tasks as any[])
      .filter((t) => (t.tags ?? []).includes("question") && t.meta?.ask && ["todo", "in_progress", "blocked"].includes(t.status))
      .sort((x, y) => y.created_ts - x.created_ts),
    [tasks],
  );
  const [proposed, setProposed] = useState<KbArtefact[] | null>(null);

  useEffect(() => {
    let on = true;
    kbApi.artefacts({ type: "decision", status: "proposed" })
      .then((r) => {
        if (!on) return;
        const seen = new Set<string>();
        setProposed((r.artefacts ?? []).filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true))));
      })
      .catch((e) => { if (on) { setProposed([]); useKb.getState().reportError("load proposed decisions", e); } });
    return () => { on = false; };
  }, [evSeq]);

  return useMemo(() => {
    if (proposed === null) return { ready: false, byTask: new Map(), residual: [], total: 0 };
    const { verdictCards, generic } = groupDecisions(proposed);
    const byTask = new Map<string, AskEntry[]>();
    const residual: AskEntry[] = [];
    const put = (target: string | null, e: AskEntry) => {
      if (target && visibleTaskIds.has(target)) {
        const list = byTask.get(target) ?? [];
        list.push(e);
        byTask.set(target, list);
      } else residual.push(e);
    };
    for (const { latest, prior } of verdictCards) {
      put(String((latest.meta as any)?.task ?? (latest.meta as any)?.verify_target ?? ""), { kind: "verdict", latest, prior });
    }
    for (const d of generic) put(null, { kind: "decision", d });
    // question-node asks: BR#-numbered, child_of their subject (part_of on the
    // board payload) — surfaced by the same exactly-once rule. Self-asks
    // (agent → itself) are coordination, not a human decision: excluded.
    const seenAsk = new Set<string>();
    for (const nodeAsk of nodeAsks) {
      const am = (nodeAsk.meta ?? {}).ask ?? {};
      if (am.to && am.from && am.to === am.from) continue;
      // identical re-asked asks collapse to the newest
      const key = `${nodeAsk.part_of ?? ""}:${nodeAsk.title}`;
      if (seenAsk.has(key)) continue;
      seenAsk.add(key);
      put(nodeAsk.part_of ?? null, { kind: "nodeAsk", nodeAsk });
    }

    // within a target: verdict → decision → ask; newest first within a rank
    for (const list of byTask.values()) {
      list.sort((a, b) => rankOf(a) - rankOf(b) || ts(b) - ts(a));
    }
    return { ready: true, byTask, residual, total: byTask.size ? [...byTask.values()].reduce((n, l) => n + l.length, 0) + residual.length : residual.length };
  }, [proposed, nodeAsks, visibleTaskIds]);
}

const rankOf = (e: AskEntry) => (e.kind === "nodeAsk" ? 2 : e.kind === "decision" ? 1 : 0);
const ts = (e: AskEntry) => (e.latest ?? e.d ?? e.nodeAsk)?.created_ts ?? 0;

function BandVerdictRow({ latest, prior, onDone, openDecision, nested }: {
  latest: KbArtefact; prior: KbArtefact[]; onDone: () => void; openDecision?: (id: string) => void; nested?: boolean;
}) {
  const [showPrior, setShowPrior] = useState(false);
  const [open, setOpen] = useState(false);
  const { busy, err, act } = useDecisionAct(latest, onDone);
  const f = decisionFrame(latest);
  const isBounce = f.verdict === "bounce";
  return (
    <>
      <div className={`ask-band-row ${nested ? "ask-band-nested" : ""}`}>
        <div className="ab-head">
          <Chip tone="urgent">VERDICT</Chip>
          <span className="why-line">{f.target ?? "task"} · {rel(latest.created_ts)}</span>
          <span className="ab-actions">
            <Btn size="sm" variant="accept" disabled={busy} onClick={() => void act("accepted")}>{isBounce ? "Bounce it" : "Accept"}</Btn>
            <Btn size="sm" variant="reject" disabled={busy} onClick={() => void act("rejected")}>Reject</Btn>
            <Btn size="sm" quiet onClick={() => (openDecision ? openDecision(latest.id) : setOpen(true))}>Details</Btn>
            {err && <span className="k-err">{err}</span>}
          </span>
        </div>
        <span className="ab-title" title={latest.title}>
          {isBounce ? "Bounce" : "Accept verification of"} {f.target ?? "task"}
          {prior.length > 0 && (
            <button className="ab-prior" onClick={() => setShowPrior(!showPrior)}>
              {showPrior ? "▾" : "▸"} {prior.length} identical prior
            </button>
          )}
        </span>
        {showPrior && prior.map((d) => (
          <span key={d.id} className="ab-prior-line">{d.id} · {rel(d.created_ts)} · {String((d.meta as any)?.verdict ?? "").toUpperCase()}</span>
        ))}
      </div>
      {open && <DecisionPopover d={latest} onClose={() => setOpen(false)} onChanged={onDone} />}
    </>
  );
}

function BandDecisionRow({ d, onDone, openDecision, nested }: {
  d: KbArtefact; onDone: () => void; openDecision?: (id: string) => void; nested?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { busy, err, act } = useDecisionAct(d, onDone);
  const f = decisionFrame(d);
  return (
    <>
      <div className={`ask-band-row ${nested ? "ask-band-nested" : ""}`}>
        <span className="ab-kind"><Chip tone="urgent">{f.kind === "verify" ? "VERDICT" : "DECISION"}</Chip></span>
        <span className="ab-main"><span className="ab-title" title={d.title}>{d.title}</span></span>
        <span className="ab-meta">{rel(d.created_ts)}</span>
        <span className="ab-actions">
          <Btn size="sm" variant="accept" disabled={busy} onClick={() => void act("accepted")}>Accept</Btn>
          <Btn size="sm" variant="reject" disabled={busy} onClick={() => void act("rejected")}>Reject</Btn>
          <Btn size="sm" quiet onClick={() => (openDecision ? openDecision(d.id) : setOpen(true))}>Details</Btn>
          {err && <span className="k-err">{err}</span>}
        </span>
      </div>
      {open && <DecisionPopover d={d} onClose={() => setOpen(false)} onChanged={onDone} />}
    </>
  );
}

function BandNodeAskRow({ nodeAsk, onDone, openDecision, nested }: {
  nodeAsk: KbArtefact; onDone: () => void; openDecision?: (id: string) => void; nested?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const m = (nodeAsk.meta ?? {}) as any;
  const ask = m.ask ?? {};

  // the subject BY NAME — an id alone doesn't say what the ask is about
  const subject = useKb((s) => s.tasks.find((t) => t.id === nodeAsk.part_of));
  // rows point, the detail view acts: option buttons answer inline (one click,
  // no typing); free-text answering lives in the node's detail view
  const answer = async (a: string) => {
    setBusy(true);
    try {
      await kbApi.askAnswer(nodeAsk.id, a.trim());
      await useKb.getState().refresh();
      onDone();
    } catch (e) {
      useKb.getState().reportError("answer ask", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`ask-band-row ask-band-node ${nested ? "ask-band-nested" : ""}`}>
      <span className="ab-kind"><Chip tone="needs">ASK</Chip>{ask.urgency === "urgent" && <Chip tone="urgent">URGENT</Chip>}</span>
      <span className="ab-main">
        <span className="ab-title" title={nodeAsk.title}>{askKernel(nodeAsk.title)}</span>
        {m.ask?.reason && <span className="ab-reason" title={m.ask.reason}>why escalated: {m.ask.reason.length > 120 ? `${m.ask.reason.slice(0, 120)}…` : m.ask.reason}</span>}
        <span className="ab-prior-line">
          {m.ask?.from ?? "agent"} → {m.ask?.to ?? "any"}
          {nodeAsk.part_of && <> · on {nodeAsk.part_of}{subject ? ` — ${subject.title.slice(0, 80)}${subject.title.length > 80 ? "…" : ""}` : ""}</>}
        </span>
        {(ask.options ?? []).length > 0 && (
          <AskOptions options={ask.options as string[]} busy={busy} onPick={(o) => void answer(o)} />
        )}
      </span>
      <span className="ab-meta">{rel(nodeAsk.created_ts)}</span>
      <span className="ab-actions">
        {ask.reframe
          ? <span className="muted-note">reframed — awaiting re-ask</span>
          : <Btn size="sm" variant="reject" disabled={busy} title="kick back to the asker: restructure per the ask contract (add feedback in the detail view)"
              onClick={() => { setBusy(true); kbApi.askReframe(nodeAsk.id).catch((e) => useKb.getState().reportError("reframe ask", e)).finally(() => { setBusy(false); void useKb.getState().refresh(); }); }}>Reframe</Btn>}
        <Btn size="sm" quiet title="open the full ask — question, options, free-text answer, comments"
          onClick={() => openDecision?.(nodeAsk.id)}>Details</Btn>
      </span>
    </div>
  );
}

export function AskEntries({ entries, onDone, openDecision, nested }: {
  entries: AskEntry[]; onDone: () => void; openDecision?: (id: string) => void; nested?: boolean;
}) {
  return (
    <>
      {entries.map((e) => e.kind === "verdict"
        ? <BandVerdictRow key={e.latest!.id} latest={e.latest!} prior={e.prior ?? []} onDone={onDone} openDecision={openDecision} nested={nested} />
        : e.kind === "decision"
        ? <BandDecisionRow key={e.d!.id} d={e.d!} onDone={onDone} openDecision={openDecision} nested={nested} />
        : <BandNodeAskRow key={e.nodeAsk!.id} nodeAsk={e.nodeAsk!} onDone={onDone} openDecision={openDecision} nested={nested} />)}
    </>
  );
}

/** Residual band: asks whose subject is not on the board. Header only when
 *  non-empty; nothing here means every ask already nests under its task. */
export function AskBand({ asks, onChanged, openDecision }: {
  asks: HumanAsks; onChanged?: () => void; openDecision?: (id: string) => void;
}) {
  const refresh = useKb((s) => s.refresh);
  if (!asks.ready || asks.residual.length === 0) return null;
  const bump = () => { void refresh(); onChanged?.(); };
  return (
    <div className="ask-band">
      {asks.residual.length > 0 && (
        <div className="ab-head muted-note">awaiting you — subjects not in flight</div>
      )}
      <AskEntries entries={asks.residual} onDone={bump} openDecision={openDecision} />
    </div>
  );
}
