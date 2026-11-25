import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * BR#22008 / BR#22007 — SOURCE PINS: free text never drives core workflows.
 *
 * Steering alone rots (the verb matcher shipped WITH a steering card that
 * said "typed interactions only"; prose drift then quietly re-grew three
 * generations of string-remap machinery — BR#3912, BR#5570, BR#17095).
 * These pins make the class MECHANICALLY unforgivable: any reintroduction
 * of free-text dispatch, prose leg-scavenging or prose churn classification
 * fails the suite at the exact file, the same way a type error does.
 *
 * Sanctioned survivors (each is a one-way legacy adapter, never an
 * authority): taskReviewTarget's first-submission receipt parse, the lane
 * queue's legacy-card prose fallback, isChurnPark's pre-typing read
 * adapters, reviewTargetFromNote (BR#20312 head-binding notes), the
 * external runner's own "runner:" label, the unbound-ask mint heuristic
 * (additive only). Everything else is typed by law.
 */

const ROOT = realpathSync(new URL("../../..", import.meta.url).pathname);
const read = (p: string) => readFileSync(`${ROOT}/${p}`, "utf8");
const DO = read("packages/worker/src/kb/do.ts");
const MACHINE = read("packages/worker/src/kb/machine.ts");
const ASK_TS = read("packages/contracts/src/ask.ts");
const ASK_TEMPLATE = read("packages/ui-kit/src/views/askTemplate.tsx");

describe("source pins: typed core workflows (BR#22008)", () => {
  it("the answer matcher is resolveChoice — exact label equality, one authority", () => {
    // the ONE matcher, in contracts, used by the worker
    expect(ASK_TS).toContain("export function resolveChoice");
    expect(DO).toContain("resolveChoice(decision, answer)");
    // the deleted verb-token / string-remap machinery must stay deleted
    for (const banned of ["stripRecommended", "decisionSupersede", "optHit", "selfNamedSupersede", "isBatchSupersedeAuth", "answerStripped", "dispatchText"]) {
      expect(DO.includes(banned), `do.ts must not reintroduce '${banned}' — the BR#3912/BR#5570/BR#17095 verb-token matcher class is deleted by law (BR#22008)`).toBe(false);
    }
  });

  it("ask dispatch never parses the answer for action verbs (commentary is recorded, not executed)", () => {
    // the exact regexes the deleted matcher used on ANSWER text — any
    // reappearance of a verb-token dispatch test trips this pin
    for (const banned of [
      /test\(answer\)/,
      /answer\.match\(/,
      /answer\.startsWith\(/i,
      /\(\s*RELEASE\|CANCEL\|SUPERSEDE\|RE-SCOPE\|KEEP\s*\)/,
    ]) {
      expect(banned.test(DO), `do.ts ask dispatch must not parse the answer (${banned}) — free text is commentary, the typed choice action is the sole dispatch key (BR#22008/BR#22007)`).toBe(false);
    }
  });

  it("legacy option dispatch is closed-set: the registry lives in contracts, keyed on the matched OPTION", () => {
    // the closed registry (contracts) resolves an EXACT-matched option's
    // intent; do.ts feeds it the matched option, never the answer text
    expect(ASK_TS).toContain("export function legacyOptionAction");
    expect(DO).toContain("legacyOptionAction(matchedOption)");
    // the exact-match gate: an option click is exact equality against the
    // ask's own closed set — free text matches nothing
    expect(DO).toContain("(m.ask.options as string[]).find((o) => String(o).trim() === answer)");
  });

  it("PR legs are typed-receipts: no prose-leg override of a typed binding", () => {
    // the phantom-leg stamp (the BR#21657 PR #486 wedge) is deleted:
    // trainParseNoteLegs may appear ONLY at the sanctioned adapter sites
    const hits = DO.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => l.includes("trainParseNoteLegs"));
    expect(hits.length, `trainParseNoteLegs sites (import + reviewTargetFromNote + lane legacy fallback only):\n${hits.map(([n, l]) => `${n}: ${l.trim().slice(0, 90)}`).join("\n")}`).toBe(3);
    // the typed-first precedence is present
    expect(DO).toContain("if (submitted?.kind === \"commit\") return submitted;");
    expect(DO).toContain("const bound = meta.review_target as ReviewTarget | undefined;");
  });

  it("churn parks classify typed-first: no scattered prose prefix tests", () => {
    // the ONE typed predicate + legacy adapters live in machine.ts
    expect(MACHINE).toContain("export function isChurnPark");
    // do.ts must not read the churn prose label directly anywhere
    expect(DO.includes('startsWith("churn guard:")'), "do.ts must use isChurnPark — the typed predicate (machine.ts); prose prefix reads rotted when the birth stamp changed shape (BR#22008 F4)").toBe(false);
    // the classifier takes the typed event
    expect(MACHINE).toContain("awaitEvent?: { event?: string; [k: string]: unknown } | null");
    expect(MACHINE).toContain('input.awaitEvent?.event === "recovery_required"');
    // and do.ts feeds it
    expect(DO).toContain("awaitEvent: validateAwaitEvent(b.await_event)");
  });

  it("gate rejections are typed: rule + owns_exit ride the body, not prose", () => {
    expect(DO).toContain("err.rule = verdict.rule");
    // the human-decision fence stamps the typed owns_exit ask binding
    expect(read("packages/worker/src/kb/execution-work.ts")).toContain("owns_exit: { ask_id: String(boundAsk) }");
    // the envelope passes them through
    expect(DO).toContain("...(e5?.rule ? { rule: String(e5.rule) } : {})");
    expect(DO).toContain("...(e5?.owns_exit ? { owns_exit: e5.owns_exit } : {})");
    // the client surfaces the struct
    expect(read("packages/ui-kit/src/server/kb.ts")).toContain("err.owns_exit_ask = String(body.owns_exit.ask_id)");
  });

  it("the ask one-click button submits the typed choice — no client-side op runs first (the BR#21657 op-first 400 class is dead)", () => {
    // AskActionBtn executes ONLY askAnswer; the server owns the action
    for (const banned of ["kbApi.transition(", "kbApi.releaseClaim(", "kbApi.clearHold(", "kbApi.supersede("]) {
      expect(ASK_TEMPLATE.includes(banned), `askTemplate.tsx must not execute ops client-side ('${banned}') — the button submits the exact choice label and the hub applies the typed action through the legal edges (BR#22008)`).toBe(false);
    }
    expect(ASK_TEMPLATE).toContain("kbApi.askAnswer(askId, plan.answer)");
  });
});
