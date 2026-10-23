import { useEffect, useMemo, useState } from "react";
import { kbApi } from "../server/kb";
import type { KbArtefact } from "../server/kb";
import { rel } from "../server/views";
import { decisionFrame, groupDecisions, DecisionPopover, useDecisionAct } from "./decide";
import type { AskFeed } from "./ForMeView";
import { useKb } from "../server/kbStore";
import { Btn, Chip } from "./index-kit";

/** The ask band — decisions + asks awaiting the human, rendered as compact
 *  rows (process-row height) between the dashboard stats and the fleet table.
 *  Kernel + options inline; click for the full decision popover. */

function BandVerdictRow({ latest, prior, onDone }: { latest: KbArtefact; prior: KbArtefact[]; onDone: () => void }) {
  const [showPrior, setShowPrior] = useState(false);
  const [open, setOpen] = useState(false);
  const { busy, err, act } = useDecisionAct(latest, onDone);
  const f = decisionFrame(latest);
  const isBounce = f.verdict === "bounce";
  return (
    <>
      <div className="ask-band-row">
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
          <Btn size="sm" quiet onClick={() => setOpen(true)}>Details</Btn>
          {err && <span className="k-err">{err}</span>}
        </span>
      </div>
      {open && <DecisionPopover d={latest} onClose={() => setOpen(false)} onChanged={onDone} />}
    </>
  );
}

function BandDecisionRow({ d, onDone }: { d: KbArtefact; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const { busy, err, act } = useDecisionAct(d, onDone);
  const f = decisionFrame(d);
  return (
    <>
      <div className="ask-band-row">
        <span className="ab-kind"><Chip tone="urgent">{f.kind === "verify" ? "VERDICT" : "DECISION"}</Chip></span>
        <span className="ab-main">
          <span className="ab-title" title={d.title}>{f.kind === "verify" ? d.title : d.title}</span>
        </span>
        <span className="ab-meta">{rel(d.created_ts)}</span>
        <span className="ab-actions">
          <Btn size="sm" variant="accept" disabled={busy} onClick={() => void act("accepted")}>Accept</Btn>
          <Btn size="sm" variant="reject" disabled={busy} onClick={() => void act("rejected")}>Reject</Btn>
          <Btn size="sm" quiet onClick={() => setOpen(true)}>Details</Btn>
          {err && <span className="k-err">{err}</span>}
        </span>
      </div>
      {open && <DecisionPopover d={d} onClose={() => setOpen(false)} onChanged={onDone} />}
    </>
  );
}

function BandAskRow({ d, resolve, onDone }: { d: any; resolve: NonNullable<AskFeed["resolve"]>; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (action: "unblocked" | "completed") => {
    setBusy(true);
    try {
      await resolve(d, action, undefined, undefined);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ask-band-row">
      <span className="ab-kind"><Chip tone="needs">ASK</Chip>{d.urgent && <Chip tone="urgent">URGENT</Chip>}</span>
      <span className="ab-main"><span className="ab-title" title={d.title ?? d.question}>{d.title ?? d.question}</span></span>
      <span className="ab-meta">{rel(d.opened_ts ?? d.created_ts ?? d.ts ?? Date.now())}</span>
      <span className="ab-actions">
        <Btn size="sm" variant="accept" disabled={busy} onClick={() => void act("unblocked")}>Unblock</Btn>
        <Btn size="sm" quiet disabled={busy} onClick={() => void act("completed")}>Done</Btn>
      </span>
    </div>
  );
}

export function AskBand({ askFeed, onChanged }: { askFeed?: AskFeed; onChanged?: () => void }) {
  const events = useKb((st) => st.events);
  const [proposed, setProposed] = useState<KbArtefact[] | null>(null);

  const load = async () => {
    try {
      const r = await kbApi.artefacts({ type: "decision", status: "proposed" });
      setProposed(r.artefacts ?? []);
    } catch { setProposed([]); }
  };
  // refetch when the live event feed moves (new decision = new event)
  const evSeq = events[0]?.seq ?? 0;
  useEffect(() => { void load(); }, [evSeq, onChanged]);

  const grouped = useMemo(() => groupDecisions(proposed ?? []), [proposed]);
  const asked = useMemo(
    () => (askFeed?.decisions ?? []).filter((d: any) => !d.resolved && (d.target === "human" || d.asker === "human" || !d.target)),
    [askFeed?.decisions],
  );

  if (proposed === null) return null;
  if (grouped.verdictCards.length === 0 && grouped.generic.length === 0 && asked.length === 0) return null;

  const bump = () => { onChanged?.(); void load(); };

  return (
    <div className="ask-band">
      {asked.map((d: any) => (
        <BandAskRow key={d.id} d={d} resolve={askFeed!.resolve} onDone={bump} />
      ))}
      {grouped.verdictCards.map(({ latest, prior }) => (
        <BandVerdictRow key={latest.id} latest={latest} prior={prior} onDone={bump} />
      ))}
      {grouped.generic.map((d) => (
        <BandDecisionRow key={d.id} d={d} onDone={bump} />
      ))}
    </div>
  );
}

