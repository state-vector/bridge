/**
 * Interactive claim takeover — the pure decision law (BR#2997 design record,
 * BR#6135 implementation, Ray live ruling 2026-11-04).
 *
 * The op: an in_progress task whose claim is held by a dispatched runner
 * session can be re-taken ATOMICALLY by the card's owner agent or a human
 * (web/human actor) — one write flips meta.session, no release→pool→re-claim
 * pass, so no other dispatcher can win the card in between (the exact race
 * that handed BR#6068 to a runner while its interactive session was paused
 * on the human).
 *
 * Authority is SERVER-VERIFIED, never self-declared (BR#2673: human
 * authority exists only in an interactive authenticated session; a bare
 * agent flag is not one). The three accepted anchors, all derived from
 * token/auth state by the caller (do.ts):
 *   1. human plane — actor matches web:/human: (OWNER_RELEASE_EXEMPT family)
 *   2. owner label — the acting token's agent label IS the card owner
 *   3. owner principal — the acting token's principal IS the card owner
 *      (labels are display; principals are the anchor, do.ts claim path)
 * plus the gateway-attribution pair (body.gateway + body.agent === owner),
 * the same pair the release-ownership rule trusts (BR#3611).
 *
 * Refusals are terminal semantic gates — each carries a [rule: takeover-*]
 * tag that machine.ts RULE_BREACH_CLASSES folds into the never-a-breach
 * families (BR#3430: an ownership rejection is the system working). SoD is
 * NOT transferable (BR#2997): verify/unblock duty cards refuse takeover;
 * their verdict belongs to the duty session's lineage.
 *
 * This module is PURE — no storage, no clock. do.ts owns resolution, the
 * single atomic UPDATE, the audit and the version row.
 */
import { releaseHold } from "./core";
import { OWNER_RELEASE_EXEMPT, VERDICT_ROLES, type Role } from "./machine";

/** The card snapshot the decision needs — fetched by the caller. */
export interface TakeoverTarget {
  id: string;
  type: string;
  status: string;
  /** Current claim holder (owner column). Empty on pooled cards. */
  owner: string;
  /** roles tags (parsed). */
  roles: string[];
  /** Card meta (parsed). meta.session = holder session, meta.taken_over = the
   *  takeover stamp this op writes. */
  meta: Record<string, any>;
  /** Server-verified holder class (BR#6135 design 2): TRUE when the holder
   *  session (meta.session) resolves to a gateway-tagged token — the only
   *  sessions a dispatch spawns. Undefined/true when the holder is unnamed
   *  (meta.session absent — a session-less gateway claim is infrastructure
   *  by construction: resolveSession stamps gateway session-less writes
   *  anonymous, no interactive session can be hiding there). FALSE when the
   *  holder session belongs to a non-gateway token — a peer interactive
   *  session whose claim is NOT interceptable. */
  holderIsRunner?: boolean;
}

/** Who is acting — every field server-derived (token row, actor string). */
export interface TakeoverAuthority {
  actor: string;
  /** auth_tokens.principal of the acting token, when it carries one. */
  actingPrincipal?: string | null;
  /** The gateway attribution pair (body.gateway + body.agent) — a plain
   *  agent token cannot forge it (mcp.ts only forwards agent with the
   *  gateway tag). */
  attributedAgent?: string | null;
  /** The acting session name (resolveSession). */
  session?: string | null;
}

/** Closed union — an Applied/Rejection pair shaped like machine.ts Verdict,
 *  with the rule tag breachClass reads. */
export type TakeoverVerdict =
  | { ok: true; already: boolean; fromSession: string | null; toSession: string | null }
  | { ok: false; rule: TakeoverRuleTag; message: string };

/** The rule tags this module can reject with — every one has a
 *  RULE_BREACH_CLASSES entry in machine.ts. */
export type TakeoverRuleTag =
  | "takeover-target"
  | "takeover-verdict-duty"
  | "takeover-held"
  | "takeover-holder"
  | "takeover-authority";

/** Does the acting identity hold owner-or-human authority over the card?
 *  The named anchors in precedence order; used by the decision and by
 *  tests. Pure string law — no token reads here. */
export function takeoverAuthority(target: TakeoverTarget, a: TakeoverAuthority): boolean {
  if (OWNER_RELEASE_EXEMPT.test(a.actor)) return true; // web:/human:/system: plane
  if (target.owner && a.actor === target.owner) return true; // owner label
  if (target.owner && a.actingPrincipal && a.actingPrincipal === target.owner) return true; // owner principal
  if (target.owner && a.attributedAgent && a.attributedAgent === target.owner) return true; // gateway pair
  return false;
}

/** The one decision — total over (target, authority). Every refusal message
 *  MUST keep its trailing [rule: <tag>] inside the 300-char audit slice —
 *  breachClass classifies from that tag (BR#4295), and a tag cut mid-way
 *  folds as `other` (the BR#3612 wording-drift class, in reverse). Keep
 *  messages ≤ ~270 chars including the tag. */
export function decideTakeover(target: TakeoverTarget, a: TakeoverAuthority): TakeoverVerdict {
  if (target.type !== "task" || target.status !== "in_progress") {
    return {
      ok: false,
      rule: "takeover-target",
      message:
        `claim takeover applies to an in_progress task — ${target.id} is a ${target.status} ${target.type}. ` +
        "A todo card claims normally (todo → in_progress); a blocked card exits via its typed wait; in_review goes through review.",
    };
  }
  // SoD is not transferable (BR#2997): a verify/unblock duty's verdict
  // belongs to its duty lineage — taking it mid-verdict would let the
  // author steer its own review.
  if (target.roles.some((r) => VERDICT_ROLES.includes(r as Role))) {
    return {
      ok: false,
      rule: "takeover-verdict-duty",
      message:
        `${target.id} is a verify/unblock duty card — separation of duties is not transferable (BR#2997). ` +
        "The duty session renders its own verdict; if stuck, escalate rather than take over.",
    };
  }
  // A card holding a machine wait is owned by the wait, not the executor
  // (BR#4067 law, same predicate as every release path): a train queue slot,
  // a typed await_event, a bound ask.
  const hold = releaseHold(target.meta);
  if (hold) {
    return {
      ok: false,
      rule: "takeover-held",
      message:
        `${target.id} is held by ${hold} — the wait owns the exit, not the executor. ` +
        "Retake after the wait resolves (merge lands / await fires / ask answers).",
    };
  }
  if (!takeoverAuthority(target, a)) {
    return {
      ok: false,
      rule: "takeover-authority",
      message:
        `claim takeover of ${target.id} is owner/web/human-anchored (BR#2673 — server-verified): you are ${a.actor || "anonymous"}, holder ${target.owner || "none"}. ` +
        "Not the owner? coordinate via ask_agent, or raise a human ask (the web plane can take over).",
    };
  }
  const holderSession = typeof target.meta.session === "string" ? target.meta.session : null;
  const toSession = a.session ? String(a.session).slice(0, 120) : null;
  // Idempotent: the acting session already holds the claim — nothing to do.
  // (Report it rather than refuse: a re-run takeover after a lost reply must
  // not look like a failed grab.)
  if (toSession && holderSession === toSession) {
    return { ok: true, already: true, fromSession: holderSession, toSession };
  }
  // Design (2), second half: the holder must be a dispatch-spawned runner
  // session — the op exists to move claims OFF runner leases, never to
  // intercept a peer interactive session's live claim (that claim ends via
  // the holder's own rule-9 exit or a human release on the web plane). The
  // class is SERVER-verified by the caller from the token row (sessions →
  // auth_tokens gateway tag), the same trust anchor as every identity check
  // here — a session NAME proves nothing.
  if (holderSession && target.holderIsRunner === false) {
    return {
      ok: false,
      rule: "takeover-holder",
      message:
        `claim holder ${String(holderSession).slice(0, 60)} is not a dispatch-spawned runner session — takeover intercepts runner leases only (BR#6135). ` +
        "Peer claims end via rule-9 release or a human web release.",
    };
  }
  return { ok: true, already: false, fromSession: holderSession, toSession };
}

/** The meta stamp the executor (do.ts) writes on a successful takeover —
 *  kept here so the shape is named and closed (BR#2997's meta.taken_over,
 *  plus the churn-funk reset the design record calls for). */
export interface TakenOverStamp {
  from_session: string | null;
  to_session: string | null;
  by: string;
  at: number;
  reason: string;
}
