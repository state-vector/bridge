import { describe, expect, it } from "vitest";
import { TrainLineFactsSchema, TrainLineProjectionSchema, projectTrainLine, repairProgressText, withRecoveryEpisodes, reduceRecoveryEpisode } from "@bridge/contracts";
import { applyDeployObservation, normalizeBaseStateWithCoverage, reconcileDeployCoverage, reconcileBaseVerdictWithDeployCoverage, resolveLaneOperationalState, type MainCheckVerdict, type DeployWorkflowRun } from "../src/kb/core";

const now = 2_000_000;
const task = { id: "BR#1", title: "Repair deployment", status: "in_progress", url: "https://hub.test/card/BR-1", owner: "agent", active_agent: true,
  last_progress: { note: "Reading the failed deployment log", will: "Fix the missing permission", completion_pct: 25, ts: now - 1000 } };
const facts = (extra: Record<string, unknown>) => TrainLineFactsSchema.parse({ queue: [], ...extra });

describe("one line status and recovery contract", () => {
  it("cause-bound repairs replace stale diagnostic selection without concealing a concrete human requirement", () => {
    const line = projectTrainLine(facts({ queue_facts: { at: now, base_state: { verdict: "red", red: [], unsettled: [] } },
      diagnostic: { ...task, id: "BR#6442", active_agent: false } }), now);
    const episode = reduceRecoveryEpisode(undefined, { head_sha: "7".repeat(40),
      cause: { kind: "capability_unavailable", check: "Smoke", scenario: "php", capability: "callers", scope: "User.php:2416" }, event_id: "cause", actor: "observer", now,
      event: { kind: "observed", task_id: "BR#6494", next: "Publish callers repair", source: { head_sha: "7".repeat(40), run_id: 100, run_attempt: 1, url: "https://github.com/o/r/actions/runs/100" } } });
    const recoveries = [{ episode, task: { ...task, id: "BR#6494" } }];
    expect(withRecoveryEpisodes(line, recoveries)).toMatchObject({ remediation: { kind: "agent", task: { id: "BR#6494" } } });
    expect(withRecoveryEpisodes(line, [{ episode, task: { ...task, id: "BR#6494", active_agent: false } }])).toMatchObject({ remediation: { kind: "queued", task: { id: "BR#6494" } } });
    if (line.phase !== "stopped") throw new Error("expected stopped fixture");
    const human = { ...line, remediation: { kind: "human" as const, text: "Missing credential", action: { id: "BR#2", url: "https://hub.test/card/BR-2", question: "Grant access?", options: ["Grant"] } } };
    expect(withRecoveryEpisodes(human, recoveries).remediation).toEqual(human.remediation);
  });
  it("runner transcripts remain diagnostic output, never an invented next action", () => {
    const runner = { ...task, last_progress: { note: "runner: agent output — timing suggests classifier...", ts: now } };
    expect(repairProgressText(runner)).toBe("Agent session is active; next action has not yet been reported.");
    expect(repairProgressText({ ...runner, last_progress: { ...runner.last_progress, will: "Run the classifier regression fixture" } })).toBe("Next: Run the classifier regression fixture");
    expect(repairProgressText(task)).toBe("Reading the failed deployment log");
  });
  const required = ["deploy / Deploy to dev", "post-deploy / Post-Deploy Smoke", "post-deploy / DNS chain (front doors)", "post-deploy / Lodestar Operational Health"];
  const scopedGreen: MainCheckVerdict = { verdict: "green", red: [], unsettled: [], green: 4 };
  const workflow = (id: number, head_sha: string, conclusion: string): DeployWorkflowRun => ({
    id, head_sha, name: "Deploy Dev", path: ".github/workflows/deploy-dev.yml", status: "completed", conclusion, html_url: `https://github.com/actions/runs/${id}`,
  });
  it("exact incident: scoped-green + failed tip deployment + older green receipt stops the line, not starvation or stale-gate recovery", () => {
    const tip = "78760d10ae3028a0b4795d2db695d522f4505dbb";
    const old = "e99f74f81314fa7b6cc6a7544f887396f153f9fd";
    const plan = reconcileDeployCoverage({ tipSha: tip, tipAgeSecs: 7800, baseVerdict: scopedGreen, required,
      workflowRuns: [workflow(41926939169, tip, "failure"), workflow(41924676992, old, "success")] });
    expect(plan.coverage).toMatchObject({ phase: "failed", tip_sha: tip, failing_run_id: 41926939169 });
    expect(plan.covered_by_sha).toBe(old);
    const effective = reconcileBaseVerdictWithDeployCoverage(scopedGreen, plan.coverage);
    expect(effective.verdict).toBe("red");
    const base_state = normalizeBaseStateWithCoverage({ ...scopedGreen, tip_sha: tip, deploy_coverage: plan.coverage });
    expect(base_state?.verdict).toBe("red");
    expect(resolveLaneOperationalState({ baseState: { verdict: "red", tip_sha: tip, red: effective.red }, now }).phase).toBe("stopped_red");
    const line = projectTrainLine(facts({ queue: [{ id: "BR#5971" }], starved: { since: 1 },
      queue_facts: { at: now, base_state }, diagnostic_ask: { id: "BR#6443", url: "https://hub.test/card/BR-6443", question: "Diagnose or bypass?", options: ["Bypass"] },
      base_red_resolution: { verdict: "red", phase: "fix_in_progress", held: 1, whats_broken: [], ask: null, fix_card: task },
    }), now);
    expect(line).toMatchObject({ phase: "stopped", blocker: "main_failed", remediation: { kind: "agent", task } });
    expect(line.evidence.some((e) => e.url?.endsWith("41926939169"))).toBe(true);
  });
  it("a previous success on the same SHA cannot conceal a newer failed deployment", () => {
    const plan = reconcileDeployCoverage({ tipSha: "tip", tipAgeSecs: 900, baseVerdict: scopedGreen, required,
      workflowRuns: [workflow(2, "tip", "failure"), workflow(1, "tip", "success")] });
    expect(plan.coverage.phase).toBe("failed");
    const recovered = reconcileDeployCoverage({ tipSha: "tip", tipAgeSecs: 900, baseVerdict: scopedGreen, required,
      workflowRuns: [workflow(3, "tip", "success"), workflow(2, "tip", "failure")] });
    expect(recovered.coverage).toMatchObject({ phase: "covered", covered_by_sha: "tip", covered_by_run_id: 3 });
  });
  it("healthy/ready cannot carry failure facts or a recovery request", () => {
    expect(TrainLineProjectionSchema.safeParse({ phase: "ready", label: "ready", reason: "", blocker: "main_failed", evidence: [], held: 1, observed_at: now,
      remediation: { kind: "attention", text: "fix it" } }).success).toBe(false);
  });
  it("a newer matching gateway receipt clears an older pending observation; a borrowed older green run cannot", () => {
    const tip = "7".repeat(40);
    const observation = { tip_sha: tip, observed_at: now - 1000, runs: [{ id: 123, name: "Deploy Dev", path: ".github/workflows/deploy-dev.yml", head_sha: tip,
      status: "in_progress" as const, conclusion: null, html_url: "https://github.com/o/r/actions/runs/123" }] };
    const state = { verdict: "green", tip_sha: tip, red: [], unsettled: [], deploy_coverage: {
      phase: "covered", tip_sha: tip, tip_age_secs: 50, covered_by_sha: tip, covered_by_run_id: 122,
    } };
    expect(applyDeployObservation(state, observation, required, now)?.verdict).toBe("unsettled");
    expect(applyDeployObservation({ ...state, deploy_coverage: { ...state.deploy_coverage, covered_by_run_id: 123 } }, observation, required, now)?.verdict).toBe("green");
  });
  it("the original empty-checks plus active Spot build is waiting, never deployment-missing", () => {
    const base_state = { verdict: "empty", red: [], unsettled: [], deploy_coverage: {
      phase: "settling", tip_sha: "20b508b3", tip_age_secs: 147, active_run_id: 41911085476, active_run_url: "https://github.com/run/41911085476",
    } };
    expect(normalizeBaseStateWithCoverage(base_state).verdict).toBe("unsettled");
    const line = projectTrainLine(facts({ queue_facts: { at: now, base_state } }), now);
    expect(line).toMatchObject({ phase: "waiting", blocker: "checks_running", remediation: { kind: "machine", url: "https://github.com/run/41911085476" } });
  });

  it("failed main remains loud with ZERO queued changes and carries actual agent progress", () => {
    const line = projectTrainLine(facts({ queue_facts: { at: now, base_state: { verdict: "red", red: [{ name: "Storage Health", url: "https://github.com/run/fail" }] } },
      base_red_resolution: { verdict: "red", phase: "fix_in_progress", held: 0, whats_broken: [], ask: null, fix_card: task } }), now);
    expect(line).toMatchObject({ phase: "stopped", blocker: "main_failed", held: 0, remediation: { kind: "agent", task } });
    expect(line.evidence[0].url).toBe("https://github.com/run/fail");
    expect(TrainLineProjectionSchema.safeParse(line).success).toBe(true);
  });

  it("a parked repair is never described as running; a human action has an exact link", () => {
    const f = facts({ stop: { reason: "Build failed" }, base_red_resolution: {
      verdict: "red", phase: "fix_exhausted", held: 0, whats_broken: [], fix_card: { ...task, status: "blocked", active_agent: false, blocked_reason: "Missing signing key" }, ask: null,
    } });
    expect(projectTrainLine(f, now).remediation?.kind).toBe("attention");
    f.base_red_resolution!.ask = { id: "BR#2", url: "https://hub.test/card/BR-2", question: "Restore signing access?", options: ["Restore signing access"] };
    expect(projectTrainLine(f, now)).toMatchObject({ remediation: { kind: "human", action: { id: "BR#2", url: "https://hub.test/card/BR-2" } } });
  });

  it("stale observations do not turn green, and green recovery clears the interruption", () => {
    expect(projectTrainLine(facts({ queue: [{ id: "BR#1" }], queue_facts: { at: 1, base_state: { verdict: "green" } } }), now).phase).toBe("unknown");
    const recovered = projectTrainLine(facts({ queue_facts: { at: now, base_state: { verdict: "green" } }, capable: { ready: true, at: now, holder: "gateway" } }), now);
    expect(recovered).toMatchObject({ phase: "ready", blocker: null, remediation: null });
  });

  it("all interruption causes have an explicit recovery disposition", () => {
    for (const extra of [
      { queue_facts: { at: now, base_state: { verdict: "empty" } } },
      { queue_facts: { at: now, base_state: { verdict: "green", gate_blocked: true } } },
      { queue_facts: { at: now, stalled: { last_error: "Merge method refused" } } },
      { starved: { since: 1 } }, { bypass_wait: { pr: 123 } }, { queue: [{ id: "BR#1" }] },
    ]) {
      const line = projectTrainLine(facts(extra), now);
      expect(line.blocker).toBeTruthy();
      expect(line.remediation).not.toBeNull();
      expect(TrainLineProjectionSchema.safeParse(line).success).toBe(true);
    }
  });
});
