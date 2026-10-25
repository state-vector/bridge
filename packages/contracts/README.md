# contracts

The shapes every runtime trusts and nothing used to verify — recorded, versioned, CI-checked (BR#2844). One package, zod-only, imported by the hub worker and mirrored by the Rust runner through the same checked-in fixtures.

- `fixtures/orient.json` — the orient response contract (hub → every runner/session). The candidates-key incident: a key rename silently zeroed the runner's work list.
- `fixtures/mcp-tools.json` — the MCP tool registry contract (name + required args). The ask_answer/answer_ask incident: the registry declared a tool the dispatch never handled, while the implemented tool lived under a different name.
- `fixtures/identity-profiles.json` — the git identity profile contract (BR#3185). The runner's built-in `worker` class (detached-cody per BR#3181) must match this fixture exactly — the `builtin_worker_identity_matches_contract` test fails when they drift. Applying a profile writes repo-local git config only; global config is never touched.
- `fixtures/pairing-poll.json` — the pairing start/poll contract (recorded from `kb/do.ts`; the authorized poll's token is redacted — it leaves the registry exactly once).
- `config.schema.json` — the `~/.bridge/config.json` projection of `src/config.ts`, drift-alarmed from both sides (regen-diff here; serialized-key parity in `store.rs`).

## Schemas (`src/`)

| module | contract |
|---|---|
| `orient.ts` | the orient response — exactly 14 required keys; the hub's serializer and the runner's Rust gate both build from this |
| `mcp.ts` | the 16 tool argument schemas — THE single source the hub's tool table imports |
| `table.ts` | the generated tool table type: `{ name, schema, handler }` total over ToolName — a declared-but-unhandled tool is a compile error |
| `pairing.ts` | device pairing start/poll payloads (discriminated union on poll `status`) |
| `provision.ts` | agent/self provisioning — `exists` (no secret) vs vended are distinct shapes (the BR#2878 churn engine) |
| `ask.ts` | ask create/answer payloads |
| `config.ts` | the config file — schema_version + settings; never the token, never the principal |
## Rules

1. Changing a recorded shape requires updating the fixture in the same PR — and the consumers (runner, hub, kit) in the same change. CI enforces each direction:
   - `fixtures/orient.json` ↔ `src/orient.ts` (key-set parity, both directions) ↔ the Rust gate (`dispatch.rs orient_contract_error` + drift-alarm test).
   - `fixtures/mcp-tools.json` ↔ the generated tools/list (worker `test/mcp-tools.test.ts`). The tools/list response AND the dispatch are generated from one table (`worker/src/mcp-tools.ts`), so registry/dispatch divergence is unrepresentable, and the fixture pins the generated surface against silent edits.
   - `config.schema.json` ↔ `src/config.ts` (regen-diff) ↔ the single writer (`store.rs` serialized-key parity + never-a-credential).
2. Fixtures are recorded from production (the source of truth), minimized to shape (keys + types), with one live exemplar per collection for realism. Secrets never ride a fixture (redacted placeholders only).
3. The runner validates inbound orient before acting: the Rust gate fails the tick loudly, naming the drifted key — silent zeros die. Renamed keys without a contract update are a red build, not a production incident.
