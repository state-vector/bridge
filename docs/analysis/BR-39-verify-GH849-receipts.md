# BR#39 verify receipts — GH#849 php-session-fixation guard miss

Session: ses_ea871c952ffeyUyRc42sw6ff5S (resumed) / BR-39-qps849 — 2026-10-20.

## Live receipts (repo `state-vector/superpositional`, correct context)

- **PR #1921**: state `MERGED`, mergedAt `2026-10-16T07:52:37Z`, base `main`.
  Title: "fix(guards): security guard detects removed session-protection controls (GH #849)".
  Files: `packages/agents/guards/security/template.md`, `packages/agents/lenses/architectural_coherence/template.md`, `packages/guards/guard-templates.json`, `packages/guards/guard-templates.ts`.
- **Fix matches the guard miss (not a narrower symptom)**: security template on main HEAD (fetched live via GitHub contents API) contains the removed-session-protection anchor entry (API grep match confirmed). Per the PR/issue body, the miss was the guard reading *removed session-protection controls* as pass (empty evidence + anchor list gap), plus a claim-verification demotion route (#1920). The fix adds the anchor, a REMOVED-DEFENCE SWEEP pass-gate, and a pinned removal claim shape — i.e. the full miss, not only one draw.
- **Issue #849**: was OPEN; **CLOSED by this session** with a receipts comment (close-guard-compliant): https://github.com/state-vector/superpositional/issues/849
- **Hold #1929**: resolved as an issue — it is an OPEN CI issue ("eval red on unchanged guard fixtures"), and the eval-gate confirmation-draw fix landed via **PR #1972 (MERGED 2026-10-16T09:51:16Z)**. No code hold remains; PR #1921 itself was merged while #1929 tracked the CI tier.
- Eval residue noted on #849 by the fix author (guard fixture single-draw variance, narrative scorer causal-term list) — tracked separately, not gating this close.

## Verdict

Fix merged on main, issue closed with live receipts. BR#39 ready for review acceptance.
