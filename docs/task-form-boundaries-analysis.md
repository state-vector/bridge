# TASK-016 analysis child (BR#541): in-board task create/edit form — slice boundaries

Analysis-only deliverable. Defines the in-board create/edit form slice so the
implementation child can be written without guessing scope. No code changed here;
docs for the form itself ride with the impl PR (this doc changes no user-visible
behaviour).

Parent: TASK-016 "Board UX pass". Sibling: BR#540 (discussions tab, same pattern).

## 1. Live receipts (2026-10-20)

- **PR #16** (`state-vector/bridge`, head `bridge/TASK-016`, commit `52a3387a`) is
  **OPEN, unmerged, Workers build FAILURE, 0 reviews** — verified via `gh pr view 16`
  (statusCheckRollup: `Workers Builds: bridge` → FAILURE, completedAt 2026-10-20T01:39:43Z).
  It already contains a first `TaskForm.tsx` draft + BoardView wiring + store/kb.ts
  `edit` pref + lib/kb.ts widening. The impl child lands from that branch (fixing the
  build + the deviations in §7) or reimplements to this spec.
- The form does **not** exist on main today: `BoardView.tsx:358` promises "create … or
  here" but no board create control exists; the only web create affordance is the
  Knowledge-tab form (`KnowledgeView.tsx:54-57`, type/title/body only).

## 2. Current board surface (verified on main, this worktree)

- **Card controls** (`BoardView.tsx:206-223`): transition buttons only — `done`,
  `blocked`, `retry` (→ todo, releases claim). No create, no edit, no field editing.
- **Side-panel task editor** (`TaskDetail.tsx`): edits **body_md** (inline textarea +
  `kbApi.update`, lines 135-156), **progress** note/sentiment/gauges (POST
  `/api/kb/progress`, lines 95-111), and **status** via transition buttons incl. the
  blocked note/unblock-condition sub-form (lines 178-211). Read-only audit strip:
  id, owner, session, status_ts, tags, updated_ts (lines 257-264).
- So today's board-exposed edit surface = body + progress + status. Title, owner and
  tags are *displayed* but not editable anywhere on the board.

## 3. Server contract constraints (the binding ones)

Verified in `packages/worker/src/kb/do.ts` and `core.ts`:

| Constraint | Receipt |
|---|---|
| `update` accepts **title, body_md, meta, tags** | do.ts:786-798 (`body.tags !== undefined ? sanitizeTags(...)`) |
| `update` does **not** touch status — transitions are the only status path | do.ts:796 comment + handler |
| `update` does **not** accept **owner** — owner changes only via claim/release transitions (claim sets owner=actor; →todo clears it) | do.ts:1025-1046, 1103; no owner in update handler |
| `update` **replaces meta wholesale** — any form submit must round-trip the current meta or it wipes `last_progress`/`blocked`/`qualification`/`attempt`/`session` | do.ts:789 (`body.meta !== undefined ? ... : row.meta`), PR #16 draft comment |
| `create` accepts **type, title, body_md, meta, owner, tags, project**; tasks enter the **unclaimed pool** (owner empty unless explicitly passed) | do.ts:585-608 (tags :587, owner :591) |
| Server-side validation: title required, title ≤ 300 chars, body ≤ 100 000, meta ≤ 20 keys | core.ts:324-338 `LIMITS` / `checkLimits` |
| Web client gap: `kbApi.update` patch type omits `tags`; `kbApi.create` omits `tags` | lib/kb.ts:108-113. Small client widening — **not** a backend change |

Per the parent's rule — *"if the current API contract cannot support one of the listed
editable fields, that field must be removed from this slice rather than widening
backend scope"* — the contract above, not preference, decides the field list (§4).

## 4. Editable-field boundary (resolves the parent's unknowns with receipts)

| Field | Create | Edit | Why |
|---|---|---|---|
| title | ✅ required | ✅ | update ✓ (≤300 chars) |
| body / description | ✅ optional | ✅ | update ✓ (≤100 000) |
| tags / labels | ❌ v1 (default none) | ✅ comma-separated | server ✓ at create too, but the draft omits it and board-defaults rule says empty; tags-at-create is the one residual owner call (§8) |
| status | ❌ | ❌ in this form | `update` cannot set status (do.ts:796); status editing **remains on the existing transition controls** (card buttons + side panel). The parent's "editable: status" is honoured *in-board* — just not duplicated in the form. Forking transition semantics into the form would violate the single-surface rule |
| assignee / owner | ✅ optional, default **empty (unclaimed pool)** | ❌ **removed** | create contract ✓ (do.ts:591); `update` has **no owner** field → removed from edit per the parent's API-contract rule. Claiming/release stays with the transition controls |
| id, timestamps, provenance, history | ❌ | ❌ | server-managed; read-only |
| `meta.*` (last_progress, blocked, qualification, attempt, session) | ❌ | ❌ never form-editable | round-tripped **untouched** by the form (§5, R6) |

The parent's unknown — *"if the current board card controls differ from the
side-panel editor"* — is resolved by inspection: they do differ (cards = transitions
only; panel = body/progress/status). The form therefore adds **title + tags(edit) +
owner(create)**, reuses existing surfaces for status/progress, and mirrors nothing
else. No field list confirmation is outstanding beyond §8's one optional call.

## 5. Entry / exit behaviour

- **R1 Create entry** — `+ task` button in the board view head (existing board
  affordance; PR #16 already wires it, `BoardView.tsx` head controls). Opens an empty
  form seeded only with board defaults: `type: "task"`, status = initial task status
  (todo), owner empty (unclaimed pool), no tags, body empty. **Entry from card
  controls only — no navigation flow.**
- **R2 Edit entry** — `edit` button in the existing card action row, gated by a new
  `edit` toggle in the card-fields menu (default **on**, mirroring PR #16's
  `BoardPrefs.edit`). Pre-populates title/body/tags from the selected task (fetch by
  id; owner shown read-only in edit mode or hidden — draft hides the field).
- **R3 Success** — form closes, board returns to the same context. No manual refresh
  needed: every mutation emits a KB event and the store's WS handler already calls
  `refresh()` (`store/kb.ts:76-84`); the draft additionally refreshes on close.
- **R4 Cancel** — no mutation; **edit-cancel restores the side-panel detail view for
  the same task** (deterministic restore, not a dead panel); create-cancel just
  closes. (Deviation from PR #16 draft, §7-D2.)
- **R5 Single surface** — opening the create form while a side panel is open **closes
  the panel first**, and vice versa: card actions that open the form are mutually
  exclusive with the task side panel for that task. The form replaces the panel
  deterministically — never two task-detail asides at once. (Deviation from draft, §7-D1.)
- **R6 Meta round-trip** — edit submit must fetch-and-repost the current `meta`
  untouched (draft does this; PR #16 TaskForm comment). Submitting stale meta after a
  concurrent agent write is the slice's conflict case (§6).
- **R7 Close restores state** — closing the form restores the previous board
  selection/panel state where the previous state was the detail view (R4); otherwise
  plain close. Existing read-only card actions (open detail) stay as-is.

## 6. Validation and error handling

- **Local-first**: title required + non-empty blocks submit (disabled button +
  inline message, as in draft); mirror server limits locally (title ≤ 300, body
  ≤ 100 000) so obvious invalid states surface inline before the network call.
- **Submit failure** (any status from the existing mutation path): form **stays
  open**, draft preserved, visible inline error (`failed: <message>` as in draft).
  Unknown/transport failures never auto-close the form.
- **Conflict / stale meta**: if the save is rejected because the task moved (e.g.
  reclaimed-abandoned → auto-transition ran server-side between load and submit, or
  meta was mutated concurrently), keep the editor open, surface a
  retry/resolution message (re-fetch + re-seed non-title/body state on retry), never
  silently discard the draft. No optimistic close on fire-and-forget — success closes
  only after the mutation resolves.
- **Auth**: 401 funnels into the existing sign-in gate (`KbAuthError` →
  `escalateAuth`, `store/kb.ts:8-10`) — the form does not handle auth itself.

## 7. Slice boundary vs the PR #16 draft (impl must-fix list)

The impl child can land from `bridge/TASK-016` fixing exactly these, or reimplement:

- **D1 (defect)** Draft can render the create form *and* the detail panel
  simultaneously (`creating && selectedTaskId` both true → two `.detail-panel`
  asides). Fix per R5: mutually exclusive state.
- **D2 (deviation)** Draft's `closePanel` nulls the selection — cancel after edit
  drops the panel entirely instead of restoring it (R4).
- **D3 (in draft, keep)** `kbApi.update`/`create` patch types widened client-side for
  `tags` — in scope; server already accepts them (§3).
- **D4 (keep)** Owner input only in create mode, optional, default empty; hidden in
  edit mode.
- **D5 (keep)** Meta round-trip before update (R6).
- **D6 (out of draft, add)** Inline length validation mirroring `LIMITS` (§6); draft
  only checks title non-empty.
- **Build**: branch's Workers build is red on `52a3387a` — the impl child must land
  green (type-check/build receipts in the PR).

## 8. Residual owner call (one, optional)

- **tags at create time**: v1 default = none (board-defaults rule). If the owner
  wants seeded tags (e.g. `webapp`), the create payload already supports it
  (do.ts:587) — say the word and it becomes a create-form field. Everything else in
  the parent's "dependencies and unknowns" is resolved above by code receipt.

## 9. Out of scope (unchanged from the parent, restated for review)

No form implementation in *this* task; no backend mutation changes (server already
supports every field in §4); no unrelated board layout redesign; no discussion-tab
work (BR#540's slice); no briefs/provenance work; read-only card actions untouched.

## 10. Acceptance criteria for the future impl task (write it from this section)

1. `+ task` in board head opens an empty create form (R1); `edit` on a card opens a
   pre-filled edit form (R2); both are single-surface with the side panel (R5).
2. Edit form edits title/body/tags only; create form edits title/body(/owner
   optional) only; status/owner-edit/meta are not form-editable (§4).
3. Success closes and the card reflects the change without manual refresh (R3);
   cancel never mutates and restores prior selection state (R4).
4. Empty title blocks submit inline; server rejections keep the form open with the
   draft and a visible error; conflict/stale keeps the editor open with a retry
   message (§6).
5. Meta is round-tripped untouched on update (R6) — a task with `last_progress` +
   tags keeps both after an edit save.
6. `README.md` + `packages/site/content.md` updated in the impl PR (user-visible
   behaviour changes there, not here).
7. Receipts: green build, PR diff showing `TaskForm` + `BoardView` wiring, and a
   smoke path (mock hub `npm run hub` or e2e) exercising create → edit → cancel →
   conflict.

## 11. Review receipts for this analysis

- Every contract claim in §2-§3 cites file:line in this worktree (main @ `7da24b4`).
- PR #16 live state cited via `gh` CLI receipts (§1) — re-checkable at review time.
- Draft deviations (§7) are each traceable to a diff hunk of PR #16
  (`TaskForm.tsx:474+`, `BoardView.tsx` hunks, `store/kb.ts` hunk).
