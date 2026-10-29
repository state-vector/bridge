/**
 * BR#3990 — the MCP payload stamper. Pins what the hub adds to every tool
 * payload: only card-grammar ids get urls, free-text subtrees are never
 * touched, existing url fields are preserved, and no origin means no
 * stamping. The id⇄URL grammar itself is pinned against @bridge/specs in
 * specs-permalink.test.ts.
 */
import { describe, expect, it } from "vitest";
import { stampPermalinks } from "../src/permalink.ts";

describe("stampPermalinks (the MCP payload stamper)", () => {
  const ORIGIN = "https://hub.fleetbridge.run";

  it("stamps url on every artefact row of an orient-shaped payload", () => {
    const payload = {
      project: "demo",
      instructions: "long prose with BR#123 inside — untouched",
      open_artefacts: [
        { id: "BR#3990", type: "task", title: "Permalinks", status: "in_progress", updated_ts: 1 },
        { id: "BR#3955", type: "task", title: "Unblock", status: "todo", updated_ts: 2 },
      ],
      my_tasks: [],
      unclaimed_work: [
        { id: "TASK-007", type: "task", title: "legacy id card", status: "todo" },
      ],
      my_score: { label: "a", score: 62 },
    };
    stampPermalinks(payload, ORIGIN);
    expect((payload.open_artefacts[0] as any).url).toBe(`${ORIGIN}/card/BR-3990`);
    expect((payload.open_artefacts[1] as any).url).toBe(`${ORIGIN}/card/BR-3955`);
    expect((payload.unclaimed_work[0] as any).url).toBe(`${ORIGIN}/card/TASK-007`);
    expect((payload.my_score as any).url).toBeUndefined();
  });

  it("stamps ask rows via artefact_id without touching the ask text", () => {
    const payload = {
      inbox: [
        {
          id: "ASK-mvg1jb99-bo82",
          question: "do you want X folded into Y? (BR#3966 mentioned)",
          artefact_id: "BR#3966",
        },
      ],
    };
    stampPermalinks(payload, ORIGIN);
    expect((payload.inbox[0] as any).artefact_url).toBe(`${ORIGIN}/card/BR-3966`);
    expect((payload.inbox[0] as any).url).toBeUndefined(); // ASK id is not a card
  });

  it("skips free-text/opaque subtrees and never overwrites an existing url", () => {
    const payload = {
      get_artefact: {
        id: "BR#1",
        title: "card",
        meta: { ask: { artefact_id: "BR#2" }, last_progress: { note: "…" } },
      },
      row: { id: "BR#3", title: "already linked", url: "https://elsewhere/card/BR-3" },
    };
    stampPermalinks(payload, ORIGIN);
    const art = payload.get_artefact as any;
    expect(art.url).toBe(`${ORIGIN}/card/BR-1`);
    expect(art.meta.ask.artefact_url).toBeUndefined(); // meta is opaque data
    expect((payload.row as any).url).toBe("https://elsewhere/card/BR-3");
  });

  it("no origin → payload returned untouched", () => {
    const payload = { open_artefacts: [{ id: "BR#9", type: "task", title: "x", status: "todo" }] };
    const before = JSON.stringify(payload);
    stampPermalinks(payload, undefined);
    stampPermalinks(payload, "");
    expect(JSON.stringify(payload)).toBe(before);
  });

  it("is idempotent — stamping twice changes nothing", () => {
    const payload = { artefacts: [{ id: "BR#5", type: "task", title: "x", status: "todo" }] };
    stampPermalinks(payload, ORIGIN);
    const once = JSON.stringify(payload);
    stampPermalinks(payload, ORIGIN);
    expect(JSON.stringify(payload)).toBe(once);
  });
});
