# GH#1777 — sp-dev MCP unreachable: evidence map and post-fix disposition

**Provenance:** BR#561 — analysis child of BR#52 (`#qps GH#1777 — sp-dev MCP unreachable (canonical, #1834 dupes it)`, labels `CRITICAL`, `gtm-blocker`, `mcp`, `issue:stability`, `dogfood`).
**Status:** POST-FIX. The fix landed upstream before this card was finalized; this document is the bounded reference for the three failure surfaces, the observability receipts that prove the failure mode on dev, and the disposition of the acceptance criteria against what actually landed.
**Out of scope for this child:** code changes, deploys, or any fix attempt. This map bounds future implementation work only.
**Repo-side delivery of sibling analysis BR#562** (done + reviewed via BR#564); this card adds the post-fix receipts and dispositions.

## Live receipts (verified 2026-10-20, session `br561-analysis-evidence-map`)

| Receipt | State |
| --- | --- |
| Issue [#1777](https://github.com/state-vector/superpositional/issues/1777) — "[CRITICAL][dogfood][mcp] sp-dev MCP server unreachable: every tool call returns 'fetch failed' (incl. list_repos) — pre-push review blocked" | **CLOSED** 2026-10-19T13:08:44Z (canonical) |
| Issue [#1834](https://github.com/state-vector/superpositional/issues/1834) — "CRITICAL: sp-dev MCP server unreachable — review_plan/list_repos fetch failed on all calls" | **CLOSED** 2026-10-17T04:34:29Z (consolidated duplicate; closed first, canonical #1777 closed later with the full receipts) |
| PR [#1973](https://github.com/state-vector/superpositional/pull/1973) — "test(mcp): pin the sp-dev launch-env binding — missing MCP_URL export fails RED at the binding (GH #1777)" | **MERGED** 2026-10-16T09:49:15Z, mergeCommit `69412e6aa228a4836579db40a03d1251183eecd8`, verified ON-MAIN |
| Test pin shipped by PR #1973 | `infra/mcp-launch-env.test.ts` — fails RED on the exact missing-`MCP_URL` binding shape |
| Dev-machine fix path | `launchctl setenv MCP_URL https://mcp.dev.superpositional.dev` + durable LaunchAgent `~/Library/LaunchAgents/superpositional-mcp-url.plist` (dev only; no prod config touched) |
| Closure gate | Review-quality loop (GH #1328) blocked the first closure for a missing bug-corpus scenario id; re-closed with `scenario: none — owned by #1777` (launchd env-binding infra, not a review-pipeline code defect) |
| Bridge chain | BR#52 / BR#562 (analysis) / BR#563 (impl) / BR#564 (review) / BR#51 + BR#595 (dup + dup-review) all **done** |

**Fresh re-verification in this session (2026-10-20):** `launchctl getenv MCP_URL` → `https://mcp.dev.superpositional.dev` (exit 0); plist present on disk (dated Oct 16); server endpoint answers live — `401` on POST, `405` on GET.

## Failure surfaces

### Surface 1 — launch-env binding failure (root cause, confirmed)

**Symptom shape:** desktop-launched sessions never inherit `MCP_URL`, so `sp-dev` never launches and every MCP tool call fails with `fetch failed` (including `list_repos` and `review_plan`) — pre-push review blocked end to end.

**Confirmed mechanism (X1-B diagnosis, closed on GH#1777):** the `opencode.json` sp-dev entry resolves the server URL from `{env:MCP_URL}` in the *process* environment. `MCP_URL` was only ever exported by direnv (`.envrc`) inside shell sessions. GUI/desktop-launched sessions never run a shell profile, so the variable was unset at launch: the client resolved no server URL and every tool call failed. The defect is purely in the **client/session environment binding** — launchd-level env inheritance, not shell-only inheritance.

### Surface 2 — server health is distinct (confirmed healthy)

**Symptom shape:** the MCP server itself kept answering on its endpoint while the desktop session was broken — clean `401` on POST `/initialize`, `405` on GET. This distinction is what proves the root cause: an unhealthy server would fail differently (connection refused / 5xx), so `fetch failed` in the session had to come from the client resolving no URL at all, not from a dead server. Re-verified live 2026-10-20 in this session (401/405 receipts above).

### Surface 3 — duplicate-issue consolidation

**Symptom shape:** GH#1834 reported the identical failure (same tools, same `fetch failed` signature) and was closed 2026-10-17 as consolidated into GH#1777; the canonical issue is **#1777 only**. Timeline note: the duplicate closed *before* the canonical issue (dup closed first as a consolidation record; #1777 stayed open until the full acceptance receipts existed, then closed 2026-10-19). Dup review receipts live in BR#595.

## Observability receipts that prove the failure mode on dev

Captured and posted on GH#1777 at close (wave3 fresh desktop-launched session, 2026-10-19); re-verified here 2026-10-20 where machine-accessible:

1. **Missing-binding shape (pre-fix, red):** `infra/mcp-launch-env.test.ts` reproduces the desktop-launch shape (no shell profile → `{env:MCP_URL}` unresolved) and failed RED at the binding before the fix (PR #1973).
2. **Launchd-level binding (post-fix, green):** `launchctl getenv MCP_URL` → `https://mcp.dev.superpositional.dev`; durable via `~/Library/LaunchAgents/superpositional-mcp-url.plist` (survives reboots; shell env matches).
3. **Server-answers-while-session-broken (root-cause proof):** `401` on POST `/initialize` and `405` on GET against `https://mcp.dev.superpositional.dev` — captured during the X1-B diagnosis while the desktop session was failing, re-verified live 2026-10-20.
4. **Positive dev-session check:** `list_repos` returned real data (5 repos, all READY — superpositional READY, indexed 2026-10-19, 3,443 files / 53,201 entities); `review_plan` executed and grounded on the repo index (verdict: approve).
5. **Closure-gate receipt:** `scenario: none — owned by #1777` recorded in the closing comment per the GH#1328 bug-corpus protocol.

## Acceptance criteria for the implementation child — post-fix disposition

| # | Criterion (as written) | Disposition |
| --- | --- | --- |
| 1 | The dev launch path binds `MCP_URL` for desktop-launched sessions without relying on shell-only inheritance | **SATISFIED** — binding now happens at launchd level (`launchctl setenv` + durable LaunchAgent plist), independent of any shell profile; red-first test pins the shape |
| 2 | The red-first test fails before the fix and passes after the fix on the exact missing-binding shape | **SATISFIED** — `infra/mcp-launch-env.test.ts` landed RED-first via PR #1973 (merged 69412e6aa, ON-MAIN) |
| 3 | Acceptance checks return real MCP data in the dev session | **SATISFIED** — wave3 receipts 2026-10-19: `list_repos` → 5 real repos READY; `review_plan` → grounded approve |
| 4 | No prod config, no main-branch pushes, no unrelated MCP tool changes introduced | **SATISFIED** — fix is dev-machine launchd env + a test-only PR diff; prod config untouched (explicitly recorded in the issue closure) |

## Residuals (owned elsewhere — do not action from this child)

- **Machine-local durability:** the durable binding is a dev-machine artifact (launchctl + LaunchAgent plist). A fresh dev machine must reproduce the two setup steps; the authoritative record is the GH#1777 closing comment. (Out-of-scope explicitly forbids a shell-specific workaround as the *primary* solution — the plist is the primary solution.)
- **Client-config dependency shape:** `opencode.json` still resolves `{env:MCP_URL}` from the process environment. If a future desktop build launches sessions from a different supervisor that does not inherit launchd env, the same shape can recur. Watch item, not actioned — server business logic and client config resolution are out of scope here.
- **#1834 stays consolidated:** do not reopen or re-scope; it remains the duplicate of the canonical #1777.

## Out of scope (unchanged from the task body)

- Any fix to the MCP server business logic beyond the launch-env binding.
- Prod config changes, deployment actions, or shell-specific workaround documentation as the primary solution.
- Reopening or re-scoping GH#1834; it remains the duplicate and must not be worked independently.
- Any non-MCP stability work from X1 batch B.

## References

- Parent: BR#52 (`#qps GH#1777 — sp-dev MCP unreachable (canonical, #1834 dupes it)`, done)
- Sibling analysis child: BR#562 (done) — original evidence map; this card is its repo-side delivery with post-fix receipts
- Impl child: BR#563 (done — fix landed via PR #1973); review child BR#564 (done, live receipts)
- Duplicate: BR#51 (done) + dup-review BR#595 (done) — consolidation receipts
- Verify child BR#565 — judges this map
- Upstream: GH issue #1777 (canonical, closed), GH issue #1834 (dup, closed), PR #1973 (merged)