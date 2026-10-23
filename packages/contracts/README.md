# contracts

The shapes every runtime trusts and nothing verifies — recorded, versioned, CI-checked (BR#2844).

- `fixtures/orient.json` — the orient response contract (hub → every runner/session). The candidates-key incident: a key rename silently zeroed the runner's work list.
- `fixtures/mcp-tools.json` — the MCP tool registry contract (name + required args). The ask_answer/answer_ask incident: the registry declared a tool the dispatch never handled, while the implemented tool lived under a different name.

## Rules

1. Changing a recorded shape requires updating the fixture in the same PR — and the consumers (runner, kit) in the same change.
2. CI (TODO per BR#2844): the hub's live orient response validates against the fixture; the mcp.ts tool table generates both tools/list and the dispatch, making registry/divergence unrepresentable.
3. Fixtures are recorded from production (the source of truth), minimized to shape (keys + types), with one live exemplar per collection for realism.
