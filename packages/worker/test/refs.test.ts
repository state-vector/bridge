import { describe, expect, it } from "vitest";

/**
 * BR#4015 — ref hyperlinking + prompt-context builder (pure modules, no react).
 *
 * The copy-paste problem: card text is full of BR#NNN / PR #N / bare URLs that
 * rendered as dead text (snarkdown does not auto-link), and handing a card to
 * an agent meant hand-assembling the context. These tests pin the scanner's
 * contract: real anchors, never a wrong-repo guess, never a double-wrap, and
 * the paste block built from live card data.
 */

import {
  cardPath,
  escHtml,
  linkifyHtml,
  mayContainRefs,
} from "../../ui-kit/src/views/refs.ts";
import {
  buildPromptContext,
  splitConditionsText,
} from "../../ui-kit/src/views/promptContext.ts";

const REPO = "state-vector/bridge";

describe("cardPath (BR#3990 grammar)", () => {
  it("BR#N → dash-form canonical segment", () => {
    expect(cardPath("BR#3822")).toBe("/card/BR-3822");
  });

  it("legacy PREFIX-N ids pass through", () => {
    expect(cardPath("TASK-007")).toBe("/card/TASK-007");
  });

  it("non-card ids never link", () => {
    expect(cardPath("ASK-abc123")).toBeNull();
    expect(cardPath("evt-42")).toBeNull();
    expect(cardPath("br#3822")).toBeNull(); // strict grammar, not freeform
  });
});

describe("linkifyHtml", () => {
  it("card refs become real anchors with data-task-ref for SPA nav", () => {
    const out = linkifyHtml("see BR#4015 and TASK-7");
    expect(out).toContain(`href="/card/BR-4015"`);
    expect(out).toContain(`data-task-ref="BR#4015"`);
    expect(out).toContain(`href="/card/TASK-7"`);
    expect(out).toContain(`>TASK-7</a>`);
  });

  it("bare URLs get target=_blank anchors; trailing sentence punctuation stays out", () => {
    const out = linkifyHtml("run https://github.state-vector/x/actions/runs/123 then stop.");
    expect(out).toContain(`href="https://github.state-vector/x/actions/runs/123"`);
    expect(out.endsWith("then stop.</a>")).toBe(false);
    expect(out.endsWith("then stop.")).toBe(true);
  });

  it("owner/repo#N always links (unambiguous)", () => {
    const out = linkifyHtml("PR state-vector/superpositional#2513 is open");
    expect(out).toContain(`href="https://github.com/state-vector/superpositional/issues/2513"`);
    expect(out).toContain(`>state-vector/superpositional#2513</a>`);
  });

  it("PR #N / GH#N link only with repo context — never a guessed repo", () => {
    expect(linkifyHtml("merge PR #254 now")).toBe("merge PR #254 now");
    const withRepo = linkifyHtml("merge PR #254 now", { repo: REPO });
    expect(withRepo).toContain(`href="https://github.com/${REPO}/pull/254"`);
    const gh = linkifyHtml("GH#2386 is closed", { repo: REPO });
    expect(gh).toContain(`href="https://github.com/${REPO}/issues/2386"`);
  });

  it("bare #N links only with repo context", () => {
    expect(linkifyHtml("lands via #251, then trains")).toBe("lands via #251, then trains");
    const out = linkifyHtml("lands via #251, then trains", { repo: REPO });
    expect(out).toContain(`href="https://github.com/${REPO}/issues/251"`);
  });

  it("does not touch text inside existing anchors, code, or tags", () => {
    const mdLink = `<a href="https://x.example">docs</a> and <code>BR#12</code>`;
    expect(linkifyHtml(mdLink)).toBe(mdLink);
    // attribute values are tag parts — never scanned
    const out = linkifyHtml(`<a href="/card/BR-1">x</a>`, { repo: REPO });
    expect(out).toBe(`<a href="/card/BR-1">x</a>`);
  });

  it("is idempotent — anchoring twice changes nothing", () => {
    const src = "BR#4015 + https://example.com/a + state-vector/bridge#251";
    const once = linkifyHtml(src);
    expect(linkifyHtml(once)).toBe(once);
  });

  it("escapes only what IT generates — raw HTML passes through (callers escHtml first)", () => {
    // contract: input is rendered HTML; un-linkable fragments are untouched,
    // emitted fragments are escaped (attribute-safe)
    const out = linkifyHtml("merge #9 &amp; go", { repo: REPO });
    expect(out).toContain(`href="https://github.com/${REPO}/issues/9"`);
    expect(escHtml(`x" onload="x`)).toBe(`x&quot; onload=&quot;x`);
  });

  it("mayContainRefs gates cheaply", () => {
    expect(mayContainRefs("plain prose only")).toBe(false);
    expect(mayContainRefs("has BR#12")).toBe(true);
    expect(mayContainRefs("has #9")).toBe(true);
  });
});

describe("buildPromptContext", () => {
  const now = Date.now();
  const task: any = {
    id: "BR#3822",
    type: "task",
    title: "Hub: ask-bound blocks spawn racing sweep duties",
    status: "blocked",
    owner: "opencode-ray",
    project: "Superpositional",
    tags: ["bridge", "impl"],
    updated_ts: now - 120_000,
    body_md: "suppression reads meta.awaiting_ask, but askCreate stamps neither",
    meta: {
      session: "bridge-task-BR-3817",
      blocked: {
        reason: "merge-train: queued — verify ACCEPT",
        unblock_condition: "(1) PR #249 merges (mergeCommit non-null) AND (2) main CI green after.",
      },
      last_progress: {
        note: "duty queued on the train",
        actor: "a-session",
        ts: now - 300_000,
        completion_pct: 90, confidence_pct: 95, risk_pct: 5, context_pct: 25,
      },
      provenance: { repo: "state-vector/bridge", pr: 249, merge_sha: "abc123", signer: "detached-cody" },
    },
    relations: [],
  };

  const versions = [
    { seq: 2, ts: now - 60_000, actor: "runner:", action: "progress", summary: "runner: run finished AFTER the task moved", data: {} },
    { seq: 1, ts: now - 900_000, actor: "a-session", action: "transition", summary: "parked on the train", data: {} },
  ] as any[];

  it("identity line, permalink, state bits", () => {
    const ctx = buildPromptContext(task, { origin: "https://bridge.example" });
    expect(ctx).toContain(`Bridge card BR#3822 — "${task.title}"`);
    expect(ctx).toContain("https://bridge.example/card/BR-3822");
    expect(ctx).toContain("status blocked");
    expect(ctx).toContain("owner opencode-ray");
    expect(ctx).toContain("project Superpositional");
    expect(ctx).toContain("Tags: bridge, impl");
  });

  it("blocked reason + split resume conditions ride along", () => {
    const ctx = buildPromptContext(task);
    expect(ctx).toContain("Why blocked: merge-train: queued — verify ACCEPT");
    expect(ctx).toContain("Resumes when:");
    expect(ctx).toContain("- PR #249 merges (mergeCommit non-null) AND");
  });

  it("last progress + gauges + provenance", () => {
    const ctx = buildPromptContext(task);
    expect(ctx).toContain("Last progress (a-session ·");
    expect(ctx).toContain("done 90% · conf 95% · risk 5% · ctx 25%");
    expect(ctx).toContain("https://github.com/state-vector/bridge/pull/249 (merged abc123)");
  });

  it("description + history (runner noise filtered, newest first) + stale warning", () => {
    const ctx = buildPromptContext(task, { versions });
    expect(ctx).toContain("Description:\nsuppression reads meta.awaiting_ask");
    expect(ctx).toContain("Recent history (newest first):");
    expect(ctx).toContain("- [transition] a-session ·");
    expect(ctx).not.toContain("runner: run finished");
    expect(ctx).toContain(`get_artefact "BR#3822"`);
  });

  it("relative permalink fallback without origin", () => {
    const ctx = buildPromptContext(task);
    expect(ctx).toContain("(permalink: /card/BR-3822)");
  });
});

describe("splitConditionsText", () => {
  it("splits (1)/(2) contracts; single condition stays whole", () => {
    expect(splitConditionsText("(1) a thing. (2) another thing.")).toEqual([
      "a thing.", "another thing.",
    ]);
    expect(splitConditionsText("just one bar")).toEqual(["just one bar"]);
    expect(splitConditionsText(undefined)).toEqual([]);
  });
});
