import { describe, expect, it } from "vitest";
import { verifyDutyBody } from "../src/kb/do.ts";

// BR#4425: the verify duty's ACCEPT step must name the ONE typed machine leg
// ({event:"pr_merged",repo,n}) for the merge-train park. The old template
// described the proxy only as a conjunction ("mergeCommit non-null AND main
// green"); duties imitated the prose, the text parsed to 2 machine atoms, the
// blocked-needs-typed-await gate refused the park (BR#3986), and — pre-#288 —
// the refusal rode as a retryable 503 infra fault, so the duty blind-retried
// the same payload: 3 transition_rejected events, breach class
// gate:multi-atom-condition (specimens BR#4425 on BR#4400, BR#4303 on BR#4297).

describe("verifyDutyBody — the merge-train park carries its typed leg (BR#4425)", () => {
  it("renders the concrete typed await_event when the PR stamp resolves", () => {
    const body = verifyDutyBody(
      "BR#4400",
      "IMPL: single logging mechanism",
      "https://github.com/state-vector/bridge/pull/287",
      { repo: "state-vector/bridge", n: 287 },
    );
    expect(body).toContain('await_event {event:"pr_merged", repo:"state-vector/bridge", n:287}');
    // the refusal law is taught, not just the shape
    expect(body).toContain("One typed leg per park (BR#3986)");
    expect(body).toContain("parses to 2 machine atoms");
    // the park note and the conjunction-as-prose instruction stay
    expect(body).toContain("`merge-train: queued`");
    expect(body).toContain("carry the conjunction as plain prose in unblock_condition");
  });

  it("falls back to the generic form when the stamp is unresolvable (repo-less dispatch)", () => {
    const body = verifyDutyBody("BR#1", "some impl", "see note");
    expect(body).toContain('{event:"pr_merged", repo:"<owner/name>", n:<PR you verified>}');
    expect(body).not.toContain("undefined");
  });
});
