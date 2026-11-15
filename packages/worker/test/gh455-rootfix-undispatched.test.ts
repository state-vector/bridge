import { describe, expect, it } from "vitest";
import {
  BASE_RED_UNDISPATCHED_GRACE_MS,
  classifyBaseRedEpisodeState,
  trainBaseRedAskWarranted,
} from "../src/kb/core.ts";

/** GH #455 (2026-11-15): a root-fix card for a red main sat UNCLAIMED in todo
 *  for 30+ minutes while the executor was alive and the lane ticked — nothing
 *  dispatched it, nothing alarmed, and the base-red human ask stayed
 *  suppressed on the claim that "the fix work runs automatically". The
 *  classifier treated "a card exists" as fix_in_progress regardless of
 *  dispatch liveness. The closed state machine gains the distinction:
 *  a todo card with no agent is NOT progress — it is undispatched work,
 *  and past a grace window it warrants the human ask instead of silence. */

const card = (over: Partial<Parameters<typeof classifyBaseRedEpisodeState>[0]["card"]> = {}) => ({
  id: "BR#14634",
  title: "ROOT-FIX (BR#5189 p0): fix main — red at 5ad22e794 (deploy / Deploy to dev)",
  status: "todo",
  exhausted: false,
  ...over,
});

describe("GH#455: base-red episode classification distinguishes dispatched from queued", () => {
  it("a claimed card (in_progress/in_review) is fix_in_progress — unchanged", () => {
    for (const status of ["in_progress", "in_review"]) {
      const s = classifyBaseRedEpisodeState({ card: card({ status }) });
      expect(s.phase).toBe("fix_in_progress");
      expect(s.warrantAsk).toBe(false);
    }
  });

  it("an UNCLAIMED todo card within the grace window is fix_undispatched, no ask", () => {
    const s = classifyBaseRedEpisodeState({
      card: card({ status: "todo", active_agent: false, unclaimed_ms: 60_000 }),
    });
    expect(s.phase).toBe("fix_undispatched");
    expect(s.warrantAsk).toBe(false);
    expect(s.card?.id).toBe("BR#14634");
  });

  it("an UNCLAIMED todo card PAST the grace window warrants the human ask", () => {
    const s = classifyBaseRedEpisodeState({
      card: card({ status: "todo", active_agent: false, unclaimed_ms: BASE_RED_UNDISPATCHED_GRACE_MS + 1 }),
    });
    expect(s.phase).toBe("fix_dispatch_starved");
    expect(s.warrantAsk).toBe(true);
  });

  it("the grace boundary is inclusive — exactly at grace is still undispatched, not starved", () => {
    const s = classifyBaseRedEpisodeState({
      card: card({ status: "todo", active_agent: false, unclaimed_ms: BASE_RED_UNDISPATCHED_GRACE_MS }),
    });
    expect(s.phase).toBe("fix_undispatched");
    expect(s.warrantAsk).toBe(false);
  });

  it("a todo card WITH a live agent is fix_in_progress — dispatched runners hold the claim", () => {
    const s = classifyBaseRedEpisodeState({
      card: card({ status: "todo", active_agent: true, unclaimed_ms: 99 * 60_000 }),
    });
    expect(s.phase).toBe("fix_in_progress");
    expect(s.warrantAsk).toBe(false);
  });

  it("missing liveness fields (legacy callers) keep todo cards at fix_in_progress — no behaviour change", () => {
    const s = classifyBaseRedEpisodeState({ card: card({ status: "todo" }) });
    expect(s.phase).toBe("fix_in_progress");
    expect(s.warrantAsk).toBe(false);
  });

  it("an exhausted card still wins over undispatched — manual intervention stays the terminal escalation", () => {
    const s = classifyBaseRedEpisodeState({
      card: card({ status: "todo", exhausted: true, active_agent: false, unclaimed_ms: 99 * 60_000 }),
    });
    expect(s.phase).toBe("fix_exhausted");
    expect(s.warrantAsk).toBe(true);
  });

  it("trainBaseRedAskWarranted threads dispatch liveness through", () => {
    expect(
      trainBaseRedAskWarranted({
        card: { id: "BR#1", title: "t", status: "todo", exhausted: false, active_agent: false, unclaimed_ms: 60_000 },
      }),
    ).toBe(false);
    expect(
      trainBaseRedAskWarranted({
        card: {
          id: "BR#1", title: "t", status: "todo", exhausted: false,
          active_agent: false, unclaimed_ms: BASE_RED_UNDISPATCHED_GRACE_MS + 1,
        },
      }),
    ).toBe(true);
    expect(
      trainBaseRedAskWarranted({
        card: { id: "BR#1", title: "t", status: "in_progress", exhausted: false },
      }),
    ).toBe(false);
  });
});