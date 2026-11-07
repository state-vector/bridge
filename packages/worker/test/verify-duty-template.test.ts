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

describe("verifyDutyBody — one explicit acceptance authority", () => {
  it("renders the exact subject and PR leg in the typed review result", () => {
    const body = verifyDutyBody(
      "BR#4400",
      "IMPL: single logging mechanism",
      "https://github.com/state-vector/bridge/pull/287",
      { repo: "state-vector/bridge", n: 287 },
    );
    expect(body).toContain('review_result {kind:"accepted_pr",task_id:"BR#4400"');
    expect(body).toContain('repo:"state-vector/bridge",number:287,head_sha_at_acceptance:');
    expect(body).toContain("Do not separately park the parent");
    expect(body).toContain("waits for required CI");
  });

  // BR#6343 residual (answered ask BR#6354): the parser dedupes duplicate
  // PR citations (BR#6349), but the ACCEPT step must still TEACH the
  // convention — one citation per PR, head adjacent, /commit/<sha> receipts
  // — so a hand-written note cannot re-arm the livelock on a pre-dedupe hub.
  it("requires explicit accepted heads instead of citation/prose parsing", () => {
    const body = verifyDutyBody(
      "BR#1",
      "some impl",
      "https://github.com/state-vector/bridge/pull/287",
      { repo: "state-vector/bridge", n: 287 },
    );
    expect(body).toContain("live full-40-hex head for EVERY accepted PR");
    expect(body).toContain("Include every accepted leg explicitly");
    expect(body).toContain("Findings are not acceptance");
    expect(body).not.toContain("undefined");
  });

  it("falls back to the generic form when the stamp is unresolvable (repo-less dispatch)", () => {
    const body = verifyDutyBody("BR#1", "some impl", "see note");
    expect(body).toContain('repo:"<owner/name>",number:<PR number>');
    expect(body).not.toContain("undefined");
  });
});
