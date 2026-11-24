import { useState } from "react";
import { Btn, TextInput } from "./index-kit";
import { kbApi } from "../server/kb";
import type { KbArtefact } from "../server/kb";
import { useKb } from "../server/kbStore";

/** Owner web-plane overrides (BR#21657 — Ray, 2026-11-25: "there is no
 *  mechanism to manually release a claim - perhaps we need to add that to
 *  bridge, admin/overrides menu for tasks?").
 *
 *  The escape hatch for interactive-claim wedges (the BR#3625 class: a
 *  delivered, review-admitted card held forever by a dead interactive
 *  credential — no release existed, takeover was refused takeover-held
 *  behind a stale typed wait, close was gate-refused). Two actions, both
 *  web/human authority (the DO re-verifies the admin-mint session; agents
 *  are refused — never agent-reachable), both audited with actor + typed
 *  reason:
 *
 *  1. Release claim — ANY claim class (interactive or runner) back to the
 *     pool, composed server-side through the normal transition executor.
 *  2. Clear / park a wedged hold — a typed wait, bound ask or stale train
 *     bounce whose defect no longer matches live state. Live train slots
 *     (queued/awaiting-ci/conflicting) are park-only: clearing would strand
 *     the serialized queue, so the server refuses.
 *
 *  Error law (the supersede precedent): a refused override surfaces the
 *  server's message inline and the card stays unchanged — no optimistic
 *  mutation anywhere. */

export interface OwnerOverridesInput {
  task: KbArtefact & { meta?: any };
  onChanged?: () => void;
}

export type OverrideHoldKind = "merge_train" | "await_event" | "bound_ask";
export type OverrideMode =
  | { kind: "release" }
  | { kind: "hold"; hold: OverrideHoldKind; action: "clear" | "park" };

/** Client mirror of the DO's hold markers (core.ts releaseHold) — what the
 *  card is currently parked on. Only kinds the owner override can act on are
 *  reported; live train slots are reported but are park-only. The server
 *  re-validates everything first-hand — this only drives the affordance. */
export function detectHolds(task: KbArtefact & { meta?: any }): Array<{ kind: OverrideHoldKind; label: string; clearable: boolean }> {
  const m = (task.meta ?? {}) as any;
  const holds: Array<{ kind: OverrideHoldKind; label: string; clearable: boolean }> = [];
  const st = String(m.merge_train?.state ?? "");
  if (["bounced", "awaiting", "stopped", "base-red-park"].includes(st))
    holds.push({ kind: "merge_train", label: `merge-train ${st}`, clearable: true });
  else if (["queued", "awaiting-ci", "conflicting"].includes(st))
    holds.push({ kind: "merge_train", label: `merge-train ${st} (live slot)`, clearable: false });
  if (m.blocked?.await_event)
    holds.push({ kind: "await_event", label: `typed await_event (${String(m.blocked.await_event?.event ?? "?")})`, clearable: true });
  if (m.awaiting_ask?.ask_id)
    holds.push({ kind: "bound_ask", label: `bound ask ${String(m.awaiting_ask.ask_id)}`, clearable: true });
  return holds;
}

export function OwnerOverrides({ task, onChanged }: OwnerOverridesInput) {
  const m = (task.meta ?? {}) as any;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<OverrideMode | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");

  const claimed = ["in_progress", "blocked"].includes(task.status) && !!String(task.owner ?? "");
  const holds = detectHolds(task);
  if (["done", "superseded"].includes(task.status) || (!claimed && holds.length === 0)) return null;

  const act = async () => {
    if (reason.trim().length < 3 || !mode) return;
    setBusy(true);
    setErr("");
    try {
      if (mode.kind === "release") {
        await kbApi.releaseClaim(task.id, reason.trim());
        setDone("claim released — the card is back in the pool");
      } else {
        await kbApi.clearHold(task.id, mode.hold, mode.action, reason.trim());
        setDone(mode.action === "clear" ? `${mode.hold} hold cleared` : "card parked over the wedged hold");
      }
      setOpen(false);
      setMode(null);
      setReason("");
      await useKb.getState().refresh();
      onChanged?.();
    } catch (e) {
      // surface, don't swallow: the server refused (stale state, live slot,
      // agent credential, missing reason) — the card is unchanged
      const msg = (e as Error).message || "override failed";
      setErr(msg);
      useKb.getState().reportError("owner override", e);
    } finally {
      setBusy(false);
    }
  };

  if (done) return <span className="ok" style={{ marginLeft: 6 }}>{done}</span>;

  const start = (next: OverrideMode) => { setErr(""); setMode(next); setOpen(true); };

  if (!open) {
    return (
      <div className="row" style={{ marginTop: 6 }}>
        <Btn size="sm" quiet
          title="Owner overrides (BR#21657): manually release a claim or clear/park a wedged hold. Web/human authority — every action is audited with a typed reason; agents cannot do this."
          onClick={() => { setErr(""); setOpen(true); }}>
          Owner overrides…
        </Btn>
      </div>
    );
  }
  return (
    <span className="supersede-pop" role="dialog" aria-label={`Owner overrides ${task.id}`}>
      {!mode && (
        <>
          <div className="progress-note" style={{ marginBottom: 4 }}>
            <b>Owner overrides</b> — break a wedge the machine exits can't. Web/human authority; every action writes an audit event with your reason.
          </div>
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            {claimed && (
              <Btn size="sm" variant="reject"
                title={`Release the claim (holder ${String(m.session ?? task.owner ?? "?")}) to the pool — any claim class, interactive or runner. The card's hold state is untouched.`}
                onClick={() => start({ kind: "release" })}>
                Release claim…
              </Btn>
            )}
            {holds.map((h) => h.clearable ? (
              <Btn key={h.kind} size="sm" quiet
                title={`Clear the ${h.label} marker whose defect no longer matches live state — the card keeps its status; audited.`}
                onClick={() => start({ kind: "hold", hold: h.kind, action: "clear" })}>
                Clear {h.kind}…
              </Btn>
            ) : (
              <Btn key={h.kind} size="sm" quiet
                title={`Park the card over the live ${h.label} — the serialized train owns the slot, so it cannot be cleared; park freezes the wedge for inspection.`}
                onClick={() => start({ kind: "hold", hold: h.kind, action: "park" })}>
                Park…
              </Btn>
            ))}
            <Btn size="sm" quiet disabled={busy} onClick={() => { setOpen(false); setMode(null); }}>Close</Btn>
          </div>
          {err && <p className="k-err">{err}</p>}
        </>
      )}
      {mode && (
        <>
          <div className="progress-note" style={{ marginBottom: 4 }}>
            {mode.kind === "release"
              ? <>Release the claim on <b>{task.id}</b> → todo (pool). Holder <span className="gw-mono">{String(m.session ?? task.owner ?? "")}</span> loses the card; hold state is untouched (clear it separately if stale).</>
              : <>{mode.action === "clear" ? "Clear" : "Park over"} the {mode.hold} hold on <b>{task.id}</b>{mode.action === "park" ? " — the card parks blocked for human inspection" : " — the stale marker is removed; the card keeps its status"}.</>}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <TextInput
              value={reason}
              placeholder="reason (required, audited — why does live state no longer match?)"
              onChange={(e) => { setReason(e.target.value); setErr(""); }}
              onKeyDown={(e) => { if (e.key === "Enter" && reason.trim().length >= 3) void act(); }}
            />
            <Btn size="sm" variant="reject" disabled={busy || reason.trim().length < 3}
              title={reason.trim().length < 3 ? "type a reason first — it is written to the audit log" : "apply the override"}
              onClick={() => void act()}>
              {busy ? "applying…" : "Confirm"}
            </Btn>
            <Btn size="sm" quiet disabled={busy} onClick={() => { setMode(null); setErr(""); }}>Back</Btn>
          </div>
          {reason.trim().length > 0 && reason.trim().length < 3 && <p className="k-err">reason required (min 3 chars)</p>}
          {err && <p className="k-err">override refused — card unchanged: {err}</p>}
        </>
      )}
    </span>
  );
}
