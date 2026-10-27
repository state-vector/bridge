import { useState } from "react";
import { Btn, TextInput } from "./index-kit";
import { kbApi } from "../server/kb";
import type { KbArtefact } from "../server/kb";
import { useKb } from "../server/kbStore";

/** "Supersede" (BR#3910, Ray 2026-10-28): the action next to Reframe / Claim
 *  locally — one-click human supersede of a dead card. Kills two incident
 *  classes: the answer-before-click misfire (BR#3649 — the only supersede
 *  affordance was buried, so GO answers landed while the click never did) and
 *  the timer-spin churn (BR#3905 — dead-premise blocked cards nobody could
 *  discoverably kill, so proxy-watch kept spawning re-check duties).
 *
 *  Flow: confirm dialog shows the CURRENT status (a stale-page click on a card
 *  that moved since load is refused server-side and the refusal is surfaced —
 *  no silent no-ops), optional replacement task id with BR# validation, then
 *  one POST. The server composes the documented two-step (blocked → release →
 *  todo → superseded, BR#1852/BR#1935 precedent) and enforces the web/human
 *  gate (BR#2480) — this button is only rendered on blocked|todo task cards.
 *
 *  Error law (the defect class being fixed): a failed attempt surfaces the
 *  server's message inline AND in the banner, and the card stays unchanged —
 *  there is no optimistic state mutation anywhere in this component. */

export interface SupersedeInput {
  task: KbArtefact & { meta?: any };
  onChanged?: () => void;
  size?: "sm" | "md";
}

/** Accept "BR#123", "#123" or "123" — normalize to the board's id shape; null
 *  when the text is non-empty but not a task reference (dialog blocks submit). */
export function normalizeReplacementId(raw: string): string | null {
  const t = raw.trim();
  if (!t) return ""; // empty = allowed (replacement is optional)
  const m = /^(?:BR#?|#)?(\d+)$/i.exec(t);
  return m ? `BR#${m[1]}` : null;
}

export function SupersedeBtn({ task, onChanged, size = "sm" }: SupersedeInput) {
  const [open, setOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const replacementId = normalizeReplacementId(replacement);
  const invalid = replacement.trim() !== "" && replacementId === null;

  const supersede = async () => {
    if (invalid || replacementId === null) return;
    setBusy(true);
    setErr("");
    try {
      const r = await kbApi.supersede(task.id, replacementId || undefined);
      setDone(r.replacement_id ? `superseded — replaced by ${r.replacement_id}` : "superseded");
      setOpen(false);
      await useKb.getState().refresh();
      onChanged?.();
    } catch (e) {
      // surface, don't swallow: the server refused (state moved, bad
      // replacement, gate) — the card is unchanged and the reason is visible
      const msg = (e as Error).message || "supersede failed";
      setErr(msg);
      useKb.getState().reportError("supersede", e);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return <span className="ok" style={{ marginLeft: 6 }}>{done}</span>;
  }
  if (!open) {
    return (
      <Btn size={size} quiet disabled={busy}
        title="Supersede: retire this card as dead (web/human only). Composes release → superseded in one click; optional replacement task id."
        onClick={() => { setErr(""); setOpen(true); }}>
        Supersede…
      </Btn>
    );
  }
  return (
    <span className="supersede-pop" role="dialog" aria-label={`Supersede ${task.id}`}>
      <div className="progress-note" style={{ marginBottom: 4 }}>
        Supersede <b>{task.id}</b> — status <b>{task.status}</b> → superseded. The server releases then supersedes in one step; this cannot be undone by the card itself.
      </div>
      <div className="row" style={{ gap: 4 }}>
        <TextInput
          value={replacement}
          placeholder="replacement task id (optional, e.g. BR#3517)"
          onChange={(e) => { setReplacement(e.target.value); setErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !invalid) void supersede(); }}
          style={invalid ? { borderColor: "var(--err, #c0392b)" } : undefined}
        />
        <Btn size={size} variant="reject" disabled={busy || invalid} title={invalid ? "use BR#<number>, #<number> or a bare number" : "supersede now"} onClick={() => void supersede()}>
          {busy ? "superseding…" : "Confirm supersede"}
        </Btn>
        <Btn size={size} quiet disabled={busy} onClick={() => { setOpen(false); setErr(""); }}>Cancel</Btn>
      </div>
      {invalid && <p className="k-err">replacement must be a task id like BR#3517 (or a bare number)</p>}
      {err && <p className="k-err">supersede refused — card unchanged: {err}</p>}
    </span>
  );
}
