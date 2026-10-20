# BR#542 — Briefs surface with provenance and source receipts

TASK-016 analysis child. Deliverable type: recorded knowledge (spec). No UI implementation, no generation logic, no brief source-model change in this slice.

Predecessor: BR#546 (same analysis, superseded when TASK-016's verification round closed). This doc supersedes that body and grounds it in the current code.

## 1. What a "brief" is (grounded in the code)

Two brief flavours exist today; both need provenance:

1. **Session brief** — the `orient` response (`packages/worker/src/kb/do.ts:1485-1658`). Sections and their current sources:
   - `instructions` → `composeBootstrap(projectName, settings.board)` (`core.ts:234`, server-versioned rules template) + `settings.bootstrap_md` + kind playbook (`settings.playbooks.cron|interactive` ?? `DEFAULT_CRON_PLAYBOOK`) + role playbooks (`settings.roles.<role>` ?? `DEFAULT_ROLE_PLAYBOOKS`, selected by the token's `role:*` tags)
   - `board` → `settings.board` (+ operator `board.prompt`)
   - `counts`, `open_artefacts`, `my_tasks`, `unclaimed_work` → live queries over the `artefacts` table
   - `pending_asks` → `asks` table rows
   - `action_required` → reaper output + verification notices (derived from `relations` + task statuses)
   - `my_score` (+ `hints`) → computed from progress/audit events (`scoreAgent`)
2. **Task-scoped brief** (issue #4, KB v2) — given a task/goal/RFC id, assembles goal + constraining steering + accepted decisions + supporting research + open discussions + warnings, with ids/links back to sources. Not yet implemented; this slice defines its provenance contract only.

SettingsView already promises agents "briefings" compiled from settings (`packages/webapp/src/components/SettingsView.tsx:64,89,110`) — the briefs surface is where a human can see exactly what was compiled and from where.

## 2. Provenance contract (what must be displayed alongside a brief)

Every brief section carries a list of **receipt entries**. One entry:

```ts
interface BriefProvenanceEntry {
  record_type: "setting" | "server-default" | "artefact" | "ask" | "event" | "computed";
  record_id: string;        // settings key, artefact id (e.g. "BR#542"), ask id, event op, or derivation name
  label: string;            // human-readable, e.g. "steering — protocol rules", "setting: roles.analysis"
  updated_ts?: number;      // recency cue when the source record has one
  link?: string;            // board-native link (artefact view, settings anchor) — not a new URL scheme
}
```

Minimum always-visible payload per section: **source label + record identity + recency cue when the source has one**. A user must be able to trace any brief claim back to the exact record it came from.

## 3. Source receipts / record types that provenance must reference

Only existing record types — no new persistence (see §5):

| Brief section | Receipt entry (`record_type` → `record_id`) |
|---|---|
| Rules block in `instructions` | `server-default` → `composeBootstrap` (versioned with the worker build; show build version as recency cue) |
| Project name | `setting` → `project_name` |
| Board block / `board.prompt` | `setting` → `board` |
| Extra guidance | `setting` → `bootstrap_md` |
| Kind playbook | `setting` → `playbooks.cron` or `playbooks.interactive`; when the default was used: `server-default` → `DEFAULT_CRON_PLAYBOOK` |
| Role playbook per `role:*` | `setting` → `roles.<role>`; when the default was used: `server-default` → `DEFAULT_ROLE_PLAYBOOKS.<role>` |
| `open_artefacts` / `my_tasks` / `unclaimed_work` / `counts` | `artefact` → the artefact ids actually returned (task, steering, goal, decision, research, discussion, progress, agent) |
| `pending_asks` | `ask` → ask ids |
| `action_required` / notices | `event` → the audit/audit-event references (reaper/nudge ops) and the task ids they concern |
| `my_score` + hints | `computed` → derivation name (`scoreAgent` over progress/audit events) — no stored record exists; the entry names the derivation instead of pretending there is one |

Task-scoped brief (issue #4 flavour): provenance is the assembled artefact list — `goal` ids, constraining `steering` ids, accepted `decision` ids, supporting `research` ids, open `discussion`/question-task ids, and contradicting/warning artefact ids. Rule 8 applies to the display too: superseding artefacts replace superseded ones in the receipt list.

## 4. Display requirements (webapp)

- A brief renders its content independently from its provenance metadata: content first, provenance attached per section — never interleaved into the brief text.
- **Both inline and side panel**, with defined roles:
  - **Inline (always-on summary):** compact chips/badges per section — `type · id · recency` (e.g. `setting · roles.analysis · 2d ago`). Follows the existing card-chip vocabulary (tags/sentiment chips).
  - **Side panel (drill-in):** the full receipt list for the selected section — label, id, origin, `updated_ts`, link — reusing the existing board side-panel component pattern (`Panel.tsx`) and artefact detail navigation already used by TaskDetail/DecisionDetail.
- Inline is the always-available summary; the side panel is the expanded view. Either may ship first, but the inline badges must not depend on the panel.
- Provenance badges must be visually distinguishable from task tags so provenance is never mistaken for editable task metadata.

## 5. Storage requirements (explicit split from display)

- **No new tables, columns, or persistence shapes.** Provenance is derived at read time from the same sources the brief was composed from (`settings`, `artefacts`, `asks`, `events`) and rides in the brief response as an additive optional field (`provenance`, per §2).
- Clients must tolerate brief responses without the `provenance` field (back-compat).
- If the task-scoped brief later needs caching (issue #4 performance), that is **new storage and out of scope** — it requires an accepted decision before any impl child touches it.
- The brief source model (`orient` response shape) changes only by the additive optional `provenance` field; no field is removed or repurposed.

## 6. Fallback behavior (missing / incomplete / unresolvable provenance)

- **Missing provenance** for a section: the brief still renders fully; the section shows an explicit `source unknown` badge — never a silent absence.
- **Partial provenance** (some receipts resolvable, some not): render the resolvable receipts and show a visible gap indicator (e.g. `+2 unresolved`) — never present a partial list as complete.
- **Unresolvable source** (artefact deleted/superseded beyond recovery): render a tombstone receipt — id + "no longer resolvable" — instead of silently dropping the entry.
- **Resolution failure must never block the brief:** a provenance lookup error degrades to the `source unknown` state for the affected sections; the brief itself stays usable.

## 7. Out of scope (unchanged from the task)

- No provenance UI implementation, no content generation logic, no change to the underlying brief source model beyond the additive optional `provenance` response field defined in §5, no KB v2 brief assembly implementation, no storage changes.

## 8. Impl handoff notes

- Suggested mount: a `briefs` tab in `packages/webapp/src/components/` following the `DiscussionsView` tab precedent (`App.tsx` `TABS_ALL`); the session brief renders from the orient-equivalent payload the webapp already fetches, the task-scoped brief from a selected task.
- Test seam: provenance construction is a pure function over (settings, artefact rows, asks, events) — testable without a DO, mirroring `kb-core.test.ts` coverage style.
- Boundary with sibling slice BR#541 (in-board create/edit form): disjoint — that slice owns task mutation surfaces; this one owns read-only brief display. No shared files beyond `App.tsx` tab registration; merge order independent.
