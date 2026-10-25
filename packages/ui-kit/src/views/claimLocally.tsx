import { useState } from "react";
import { Btn } from "./index-kit";
import type { KbArtefact } from "../server/kb";

/** "Claim locally" (BR#3218, Ray 2026-10-25): next to Reframe, one click puts a
 *  ready-to-paste takeover prompt on the clipboard for a local interactive agent
 *  (opencode/claude session on Ray's machine) to take the work over.
 *
 *  The prompt is built from LIVE artefact data — never hand-typed — and embeds
 *  the takeover protocol (orient → claim → heartbeat → worktree discipline →
 *  detached-cody signing per BR#3181 → PR + in_review). The local agent then
 *  runs the same rules as any bridge session; nothing about the card state is
 *  changed by this button (it is a prompt producer, not a state mutation). */

export interface ClaimLocallyInput {
  task: KbArtefact & { meta?: any };
  /** optional richer context: reason line, ask options, parent title */
  ask?: { reason?: string; options?: string[]; to?: string; from?: string };
  onChanged?: () => void;
}

const TAKEOVER_PROTOCOL = `TAKEOVER PROTOCOL (Superpositional bridge — follow all of it):
1. START: orient (session: "<unique-name>"). Work from its response, not memory.
2. VERIFY STATE FIRST-HAND: this card may be partially done — check the artefact (get_artefact), any linked PR, and the live repo before claiming. Never trust this prompt's summary over live state.
3. CLAIM: transition {id, to: "in_progress", session} before working.
4. HEARTBEAT: log_progress {id, did, will, session} every ≤10 min. Declared silence (grace_minutes / subprocess block) before any long quiet op — undeclared silence = abandoned.
5. SHARED-CHECKOUT DISCIPLINE: work in a git worktree off fresh origin/main (git worktree add .worktrees/<branch> -b <branch> origin/main); stage explicit paths only, never git add -A; never touch global git config.
6. SIGN AS DETACHED-CODY (BR#3181 ruling): every commit via
   git -c user.name=detached-cody -c user.email=297316395+detached-cody@users.noreply.github.com -c gpg.format=ssh -c user.signingkey=$HOME/.ssh/sv-agents-signing.pub -c gpg.ssh.program=/usr/bin/ssh-keygen commit
   (unsigned commits are rejected by the 5c verify gate — do not bypass).
7. DOCS RIDE: if the change alters user-visible behaviour, update README.md and packages/site/content.md in the same branch (rule 7b).
8. FINISH: PR against main, then transition {id, to: "in_review", note: "PR <link>"} — a verify task auto-spawns; a fresh-session verifier closes or bounces. Separation of duties is enforced: you cannot verify your own work.
9. HUMAN LEGS: if a step genuinely requires Ray (merge-gate on a human-gated class, dashboard-side check, credentials), file ONE precise ask bound to the task and stop — never self-serve it, never park silently.`;

export function buildClaimLocallyPrompt({ task, ask }: ClaimLocallyInput): string {
  const lines: string[] = [];
  lines.push(`Take over this bridge task locally: ${task.id} — "${task.title}"`);
  lines.push("");
  lines.push(`Card state: ${task.type} · status ${task.status}${task.owner ? ` · owner ${task.owner}` : " · unclaimed"}${task.part_of ? ` · part of ${task.part_of}` : ""}${task.tags?.length ? ` · tags: ${task.tags.join(", ")}` : ""}`);
  if (task.body_md && task.body_md.trim() && task.body_md.trim() !== task.title) {
    lines.push("");
    lines.push("Card body (acceptance / spec — verify against live state):");
    lines.push(task.body_md.trim());
  }
  if (ask?.reason) {
    lines.push("");
    lines.push(`Why escalated: ${ask.reason}`);
  }
  if (ask?.options?.length) {
    lines.push(`Decision options on the card: ${ask.options.map((o) => `"${o}"`).join(" | ")}`);
  }
  lines.push("");
  lines.push(TAKEOVER_PROTOCOL);
  return lines.join("\n");
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to legacy path */ }
  // Legacy fallback (non-secure contexts / older Safari): hidden textarea + execCommand.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

/** The button. Renders next to Reframe; click copies the takeover prompt and
 *  shows quick feedback ("Copied"). On clipboard failure the prompt opens in a
 *  new window so the agent-prompt is never lost. */
export function ClaimLocallyBtn({ task, ask, size = "sm" }: ClaimLocallyInput & { size?: "sm" | "md" }) {
  const [copied, setCopied] = useState(false);
  const prompt = buildClaimLocallyPrompt({ task, ask });
  const onClick = async () => {
    const ok = await copyText(prompt);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } else {
      const w = window.open("", "_blank", "noopener,width=760,height=640");
      if (w) { w.document.body.textContent = prompt; }
    }
  };
  return (
    <Btn size={size} quiet disabled={copied}
      title="Claim locally: copies a takeover prompt for a local interactive agent (protocol + card context + detached-cody signing)"
      onClick={() => void onClick()}>
      {copied ? "Copied ✓" : "Claim locally"}
    </Btn>
  );
}
