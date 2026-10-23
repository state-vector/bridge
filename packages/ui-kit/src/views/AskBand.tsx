import { useEffect, useMemo, useState } from "react";
import { kbApi } from "../server/kb";
import type { KbArtefact } from "../server/kb";
import { rel } from "../server/views";
import { useKb } from "../server/kbStore";
import { decisionFrame, groupDecisions, DecisionPopover, useDecisionAct } from "./decide";
import { Btn, Chip, TextInput } from "./index-kit";

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
    () => (tasks as any[]).filter((t) => (t.tags ?? []).includes("question") && t.meta?.ask && ["todo", "in_progress", "blocked"].includes(t.status)),
    [tasks],
  );
  const [proposed, setProposed] = useState<KbArtefact[] | null>(null);

  useEffect(() => {
    let on = true;
    kbApi.artefacts({ type: "decision", status: "proposed" })
      .then((r) => { if (on) setProposed(r.artefacts ?? []); })
      .catch(() => { if (on) setProposed([]); });
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
    // board payload) — surfaced by the same exactly-once rule
    for (const nodeAsk of nodeAsks) {
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
        <span className="ab-kind"><Chip tone="urgent">VERDICT</Chip></span>
        <span className="ab-main">
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
        </span>
        <span className="ab-meta">{rel(latest.created_ts)}</span>
        <span className="ab-actions">
          <Btn size="sm" variant="accept" disabled={busy} onClick={() => void act("accepted")}>{isBounce ? "Bounce it" : "Accept"}</Btn>
          <Btn size="sm" variant="reject" disabled={busy} onClick={() => void act("rejected")}>Reject</Btn>
          <Btn size="sm" quiet onClick={() => (openDecision ? openDecision(latest.id) : setOpen(true))}>Details</Btn>
          {err && <span className="k-err">{err}</span>}
        </span>
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
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const m = (nodeAsk.meta ?? {}) as any;
  const ask = m.ask ?? {};
  const answer = async (a: string) => {
    if (!a.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await kbApi.askAnswer(nodeAsk.id, a.trim());
      await useKb.getState().refresh();
      onDone();
    } catch (e) {
      setErr((e as Error).message || "answer failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`ask-band-row ask-band-node ${nested ? "ask-band-nested" : ""}`}>
      <span className="ab-kind"><Chip tone="needs">ASK</Chip>{ask.urgency === "urgent" && <Chip tone="urgent">URGENT</Chip>}</span>
      <span className="ab-main">
        <span className="ab-title" title={nodeAsk.title}>{nodeAsk.title}</span>
        {nodeAsk.part_of && <span className="ab-prior-line">on {nodeAsk.part_of}</span>}
        {(ask.options ?? []).length > 0 && (
          <span className="ab-options">
            {(ask.options as string[]).map((o) => (
              <Btn key={o} size="sm" variant="accept" disabled={busy} onClick={() => void answer(o)}>{o}</Btn>
            ))}
          </span>
        )}
        {err && <span className="k-err">{err}</span>}
      </span>
      <span className="ab-meta">{rel(nodeAsk.created_ts)}</span>
      <span className="ab-actions">
        <TextInput
          value={text} placeholder="answer…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) void answer(text); }}
        />
        <Btn size="sm" disabled={busy || !text.trim()} onClick={() => void answer(text)}>Answer</Btn>
        <Btn size="sm" quiet title="open the full ask — question, comments, context"
          onClick={() => (openDecision ? openDecision(nodeAsk.id) : onDone())}>Details</Btn>
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
