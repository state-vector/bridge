import { describe, expect, it } from "vitest";
import { TrainLineFactsSchema, TrainLineProjectionSchema, projectTrainLine, repairProgressText, withRecoveryEpisodes, reduceRecoveryEpisode, taskRemediation } from "@bridge/contracts";
import { applyDeployObservation, normalizeBaseStateWithCoverage, reconcileDeployCoverage, reconcileBaseVerdictWithDeployCoverage, resolveLaneOperationalState, type MainCheckVerdict, type DeployWorkflowRun } from "../src/kb/core";

const now = 2_000_000;
const task = { id: "BR#1", title: "Repair deployment", status: "in_progress", url: "https://hub.test/card/BR-1", owner: "agent", active_agent: true,
  last_progress: { note: "Reading the failed deployment log", will: "Fix the missing permission", completion_pct: 25, ts: now - 1000 } };
const facts = (extra: Record<string, unknown>) => TrainLineFactsSchema.parse({ queue: [], ...extra });

describe("one line status and recovery contract", () => {
  it("explains stale evidence and absent executor without declaring main failed", () => {
    const present = now + 90 * 60_000;
    const f = facts({ queue_facts: { at: now, base_state: { verdict: "green" } } });
    const line = projectTrainLine(f, present);
    expect(line).toMatchObject({ phase: "unknown", label: "Health checks paused", blocker: "stale_observation" });
    expect(line.reason).toContain("90 minutes ago");
    expect(line.reason).toContain("No live merge executor");
    expect(line.reason).toContain("does not establish that main is failing");
    expect(projectTrainLine({ ...f, lease: { holder: "runner", heartbeat_ts: present } }, present).label).toBe("Health checks overdue");
  });
  it("withdraws the merge action immediately after a recorded response, then distinguishes observed merge from recovery", () => {
    const fix = { ...task, pr: 2965, pr_url: "https://github.com/o/r/pull/2965", merged: false, conflict: false };
    const f = facts({ stop: { reason: "Old main deployment failed" }, base_red_resolution: {
      verdict: "red", phase: "cure_pr_awaiting_force_merge", held: 2, whats_broken: [], ask: null, fix_card: fix,
    } });
    expect(projectTrainLine(f, now).remediation?.kind).toBe("merge");
    f.merge_response = { phase: "recorded", pr: 2965, at: now };
    const pending = projectTrainLine(f, now);
    expect(pending).toMatchObject({ label: "Merge response received — checking GitHub", remediation: { kind: "machine" } });
    expect(pending.reason).toContain("is recorded");
    expect(pending.reason).not.toContain("PR #2965 is merged");
    f.merge_response = { phase: "observed_merged", pr: 2965, at: now, receipt: fix.pr_url };
    const merged = projectTrainLine(f, now);
    expect(merged).toMatchObject({ phase: "base_red", blocker: "main_failed", label: "Fix merged — verifying deployment", remediation: { kind: "machine" } });
    expect(merged.reason).toContain("PR #2965 is merged");
    expect(merged.reason).toContain("not a green deployment");
  });
  it("names stalled merge machinery, actual elapsed time and a live gateway instead of implying capacity shortage", () => {
    const line = projectTrainLine(facts({ queue: [{ id: "BR#1" }, { id: "BR#2" }], starved: { since: now - 87 * 60_000 },
      lease: { holder: "gateway", heartbeat_ts: now }, queue_facts: { at: now, base_state: { verdict: "green" },
        entries: [{ id: "BR#1", cls: "blocked" }, { id: "BR#2", cls: "ready" }] },
      diagnostic: { ...task, active_agent: false, status: "done" },
    }), now);
    expect(line).toMatchObject({ phase: "error", blocker: "no_progress", label: "Merge machinery stalled" });
    expect(TrainLineProjectionSchema.safeParse({ ...line, phase: "base_red" }).success).toBe(false);
    expect(TrainLineProjectionSchema.safeParse({ ...line, label: "STOP THE LINE — main is failing" }).success).toBe(false);
    expect(line.reason).toContain("87 minutes");
    expect(line.reason).toContain("required checks are green");
    expect(line.reason).toContain("gateway is active");
    expect(line.reason).toContain("1 candidate(s) passed the initial queue gates");
    expect(line.remediation).toMatchObject({ kind: "attention", text: expect.stringContaining("ended without restoring merges") });
    const absent = projectTrainLine(facts({ queue: [{ id: "BR#1" }], starved: { since: 1 } }), now);
    expect(absent.reason).toContain("No live merge executor is confirmed");
  });
  it("shows the actual priority capacity handoff rather than passively waiting for an executor", () => {
    const repair = { ...task, status: "todo", active_agent: false, execution_blockers: [{ kind: "capacity_wait" as const, episode_id: "capacity", text: "Full" }],
      preemption: { phase: "stopping_verification" as const, recovery_id: task.id, victim_id: "BR#2", generation: 1, attempt_id: "one", session: "verify", requested_at: now, checkpoint_commit: "a".repeat(40) } };
    expect(taskRemediation(repair)).toMatchObject({ kind: "queued", text: expect.stringContaining("verification BR#2 is stopping and yielding") });
    expect(taskRemediation({ ...repair, preemption: { ...repair.preemption, phase: "slot_available" } })).toMatchObject({ text: expect.stringContaining("reclaimed slot is available") });
    expect(taskRemediation({ ...repair, execution_blockers: [{ kind: "human_answer_required", episode_id: "human", ask_id: "BR#3", text: "Needs a human choice" }] }).kind).toBe("blocked");
  });
  it("a todo repair with a rejected startup is blocked, not queued for an available agent", () => {
    const wait = { host: "runner", fingerprint: "proof", reason: "execution command requires task executor authority", since: now,
      retained_work: false, attention_at: null, phase: "recovery_required" as const, source: "start_failed" as const };
    const repair = { ...task, status: "todo", active_agent: false,
      execution_blockers: [{ kind: "startup_wait" as const, episode_id: "start:1", text: "Startup prerequisite requires repair; no work has started.", wait }] };
    expect(taskRemediation(repair)).toMatchObject({ kind: "blocked", task: repair });
    const line = projectTrainLine(facts({ stop: { reason: "Deploy failed" }, base_red_resolution: {
      verdict: "red", phase: "diagnosing", held: 1, whats_broken: [], ask: null, fix_card: repair,
    } }), now);
    expect(line.remediation).toMatchObject({ kind: "blocked", text: expect.stringContaining("no work has started") });
    expect(taskRemediation({ ...repair, execution_blockers: [] }).kind).toBe("queued");
  });
  it("a bound, non-conflicting cure is an explicit PR merge action, even before the request is published", () => {
    const fix = { ...task, pr: 2916, pr_url: "https://github.com/o/r/pull/2916", merged: false, conflict: false };
    const f = facts({ stop: { reason: "Deployment failed" }, base_red_resolution: {
      verdict: "red", phase: "cure_pr_awaiting_force_merge", held: 12, whats_broken: [], ask: null, fix_card: fix,
    } });
    const line = projectTrainLine(f, now);
    expect(line).toMatchObject({ label: "Fix ready — your merge is needed", remediation: {
      kind: "merge", pr: 2916, url: fix.pr_url, request: null,
    } });
    f.base_red_resolution!.ask = { id: "BR#2", url: "https://hub.test/card/BR-2", question: "Merge cure", options: ["DONE", "HOLD"] };
    expect(projectTrainLine(f, now).remediation).toMatchObject({ kind: "merge", request: { id: "BR#2" } });
    f.base_red_resolution!.fix_card!.conflict = true;
    expect(projectTrainLine(f, now).remediation?.kind).not.toBe("merge");
    f.base_red_resolution!.fix_card!.conflict = false;
    f.base_red_resolution!.fix_card!.merged = true;
    expect(projectTrainLine(f, now).remediation?.kind).not.toBe("merge");
  });
  it("a current merge refusal cannot advertise yesterday's starvation diagnosis as its repair", () => {
    const line = projectTrainLine(facts({ queue: [{ id: "BR#3974" }], diagnostic: { ...task, id: "BR#6442" },
      queue_facts: { at: now, base_state: { verdict: "green" }, stalled: { last_error: "gh pr merge 2513 --merge: base branch policy prohibits the merge" } },
    }), now);
    expect(line).toMatchObject({ blocker: "merge_failed", label: "Queued PRs cannot merge", remediation: { kind: "attention" } });
    expect(JSON.stringify(line)).not.toContain("BR#6442");
    expect(line.reason).not.toContain("gh pr merge");
  });
  it("a scoped-green base waiting only for the drift check is pending, not a failing main", () => {
    const q = { at: now, base_state: { verdict: "green", red: [], unsettled: [], gate_blocked: true, gate_red: [], gate_unsettled: ["Deploy drift alarm"] } };
    expect(projectTrainLine(facts({ queue_facts: q }), now)).toMatchObject({ phase: "waiting", blocker: "checks_running", label: "Waiting for required checks", remediation: { kind: "machine" } });
    expect(projectTrainLine(facts({ queue_facts: q }), now + 16 * 60_000).phase).toBe("unknown");
    expect(projectTrainLine(facts({ queue_facts: { ...q, base_state: { ...q.base_state, gate_red: [{ name: "Deploy drift alarm" }] } } }), now).phase).toBe("base_red");
    expect(projectTrainLine(facts({ queue_facts: q, stop: { reason: "Actual stop", failing: [{ name: "Test" }] } }), now).phase).toBe("base_red");
  });
  it("cause-bound repairs replace stale diagnostic selection without concealing a concrete human requirement", () => {
    const line = projectTrainLine(facts({ queue_facts: { at: now, base_state: { verdict: "red", red: [], unsettled: [] } },
      diagnostic: { ...task, id: "BR#6442", active_agent: false } }), now);
    const episode = reduceRecoveryEpisode(undefined, { head_sha: "7".repeat(40),
      cause: { kind: "capability_unavailable", check: "Smoke", scenario: "php", capability: "callers", scope: "User.php:2416" }, event_id: "cause", actor: "observer", now,
      event: { kind: "observed", task_id: "BR#6494", next: "Publish callers repair", source: { head_sha: "7".repeat(40), run_id: 100, run_attempt: 1, url: "https://github.com/o/r/actions/runs/100" } } });
    const recoveries = [{ episode, task: { ...task, id: "BR#6494" } }];
    const scope = { kind: "current" as const, head_sha: episode.head_sha, task_ids: ["BR#6494"] };
    expect(withRecoveryEpisodes(line, recoveries, scope)).toMatchObject({ remediation: { kind: "agent", task: { id: "BR#6494" } } });
    expect(withRecoveryEpisodes(line, [{ episode, task: { ...task, id: "BR#6494", active_agent: false } }], scope)).toMatchObject({ remediation: { kind: "queued", task: { id: "BR#6494" } } });
    if (line.phase !== "base_red") throw new Error("expected stopped fixture");
    const human = { ...line, remediation: { kind: "human" as const, text: "Missing credential", action: { id: "BR#2", url: "https://hub.test/card/BR-2", question: "Grant access?", options: ["Grant"] } } };
    expect(withRecoveryEpisodes(human, recoveries, scope).remediation).toEqual(human.remediation);
  });
  it("historical episodes cannot replace the current repair or hold a healthy current head", () => {
    const head = "8".repeat(40), oldHead = "7".repeat(40);
    const make = (sha: string, id: string) => reduceRecoveryEpisode(undefined, {
      head_sha: sha, cause: { kind: "check_failure", check: "Deploy Dev" },
      event_id: `observed-${id}`, actor: "observer", now,
      event: { kind: "observed", task_id: id, next: "Repair", source: {
        head_sha: sha, run_id: 100, run_attempt: 1, url: "https://github.com/o/r/actions/runs/100",
      } },
    });
    const historical = { episode: make(oldHead, "BR#7123"), task: { ...task, id: "BR#7123", active_agent: true } };
    const current = { episode: make(head, "BR#7540"), task: { ...task, id: "BR#7540", active_agent: false } };
    const scope = { kind: "current" as const, head_sha: head, task_ids: ["BR#7540"] };
    const line = projectTrainLine(facts({ stop: { reason: "Deployment failed" } }), now);
    const recoveries = [historical, current]; // same timestamp; old task is active and inserted first
    expect(withRecoveryEpisodes(line, recoveries, scope)).toMatchObject({
      remediation: { kind: "queued", task: { id: "BR#7540" } }, recoveries,
    });
    expect(withRecoveryEpisodes(line, [historical], scope).remediation).toEqual(line.remediation);
    expect(withRecoveryEpisodes(line, recoveries, { kind: "unobserved" }).remediation).toEqual(line.remediation);
    const ready = projectTrainLine(facts({ queue: [{ id: "BR#1" }], lease: { holder: "gw", heartbeat_ts: now }, queue_facts: { at: now, base_state: { verdict: "green" } } }), now);
    expect(ready.phase).toBe("ready");
    expect(withRecoveryEpisodes(ready, [historical], scope)).toMatchObject({ phase: "ready", recoveries: [historical] });
    expect(withRecoveryEpisodes(ready, recoveries, scope).phase).toBe("waiting");
  });
  it("runner transcripts remain diagnostic output, never an invented next action", () => {
    const runner = { ...task, last_progress: { note: "runner: agent output — timing suggests classifier...", ts: now } };
    expect(repairProgressText(runner)).toBe("Agent session is active; next action has not yet been reported.");
    expect(repairProgressText({ ...runner, last_progress: { ...runner.last_progress, will: "Run the classifier regression fixture" } })).toBe("Next: Run the classifier regression fixture");
    expect(repairProgressText(task)).toBe("Reading the failed deployment log");
  });
  const required = ["deploy / Deploy to dev", "post-deploy / Post-Deploy Smoke", "post-deploy / DNS chain (front doors)", "post-deploy / Lodestar Operational Health"];
  const scopedGreen: MainCheckVerdict = { verdict: "green", red: [], settling: [], unsettled: [], green: 4 };
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
    expect(line).toMatchObject({ phase: "base_red", blocker: "main_failed", remediation: { kind: "agent", task } });
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
    expect(applyDeployObservation(state, observation, required, now)?.verdict).toBe("settling"); // BR#14088: in-flight deploy = settling (amber)
    expect(applyDeployObservation({ ...state, deploy_coverage: { ...state.deploy_coverage, covered_by_run_id: 123 } }, observation, required, now)?.verdict).toBe("green");
  });
  it.each(["failure", null] as const)("older same-run success cannot override a newer rerun (%s)", conclusion => {
    const tip = "7".repeat(40);
    const observation = { tip_sha: tip, observed_at: 200, runs: [{ id: 500, run_attempt: 2,
      name: "Deploy Dev", head_sha: tip, status: conclusion ? "completed" as const : "in_progress" as const,
      conclusion, html_url: "https://github.com/o/r/actions/runs/500" }] };
    const state = { verdict: "green", tip_sha: tip, red: [], unsettled: [], check_observed_at: 100,
      deploy_coverage: { phase: "covered", tip_sha: tip, tip_age_secs: 50, covered_by_sha: tip,
        covered_by_run_id: 500, covered_by_run_attempt: 1 } };
    const expected = conclusion ? "red" : "settling"; // BR#14088: an in-flight rerun settles amber, never green
    expect(applyDeployObservation(state, observation, required)?.verdict).toBe(expected);
    expect(applyDeployObservation(state, observation, required, 300)?.verdict).toBe(expected);
    expect(applyDeployObservation({ ...state, deploy_coverage: { ...state.deploy_coverage, covered_by_run_attempt: undefined } }, observation, required, 300)?.verdict).toBe(expected);
    expect(applyDeployObservation({ ...state, deploy_coverage: { ...state.deploy_coverage, covered_by_run_attempt: 3 } }, observation, required, 300)?.verdict).toBe("green");
  });
  it("an exact active retry supersedes only the stale synthetic gate and holds for checks", () => {
    const tip = "e1b6b5954433ccf38c328104447f4af0176a7cf6";
    const runId = 42562274448;
    const runUrl = `https://github.com/state-vector/superpositional/actions/runs/${runId}`;
    const gate = { name: "Deploy health (merge gate)", conclusion: "failure",
      url: "https://github.com/state-vector/superpositional/runs/128982701091" };
    const base = { verdict: "red", tip_sha: tip, tip_age_secs: 1350, red: [gate],
      unsettled: ["Cortex Quality Smoke"], green: 1,
      deploy_coverage: { phase: "failed", tip_sha: tip, tip_age_secs: 1350, failing_run_id: null } };
    const first = { id: runId, run_attempt: 1, name: "Deploy Dev", path: ".github/workflows/deploy-dev.yml",
      head_sha: tip, status: "completed" as const, conclusion: "failure" as const, html_url: runUrl };
    const second = { ...first, run_attempt: 2, status: "in_progress" as const, conclusion: null };
    const observation = { tip_sha: tip, observed_at: now, runs: [first, second] };
    const effective = applyDeployObservation(base, observation, required);
    // BR#14088: the exact active retry holds the lane SETTLING (amber, never green)
    expect(effective).toMatchObject({ verdict: "settling", red: [],
      deploy_coverage: { phase: "settling", tip_sha: tip, active_run_id: runId, active_run_url: runUrl } });
    const line = projectTrainLine(facts({ queue: [{ id: "BR#1" }], queue_facts: { at: now, base_state: effective } }), now);
    expect(line).toMatchObject({ phase: "waiting", blocker: "checks_running", remediation: { kind: "machine", url: runUrl } });

    const native = { ...gate, url: `${runUrl}/job/128986714690` };
    for (const red of [[native], [gate, { ...native, name: "post-deploy / Lodestar Operational Health" }]]) {
      expect(applyDeployObservation({ ...base, red }, observation, required)).toMatchObject({ verdict: "red" });
    }
    expect(applyDeployObservation(base, observation, [...required, gate.name])).toMatchObject({ verdict: "red" });
    expect(applyDeployObservation(base, { ...observation, runs: [{ ...second, head_sha: "a".repeat(40) }] }, required))
      .toMatchObject({ verdict: "red" });
    expect(normalizeBaseStateWithCoverage({ ...base, deploy_coverage: {
      phase: "settling", tip_sha: "a".repeat(40), tip_age_secs: 0, active_run_id: runId,
    } }, required)).toMatchObject({ verdict: "red" });
    const third = { ...first, run_attempt: 3 };
    expect(applyDeployObservation(base, { ...observation, runs: [first, second, third] }, required))
      .toMatchObject({ verdict: "red", deploy_coverage: { phase: "failed", failing_run_id: runId } });
  });
  it("the original empty-checks plus active Spot build is waiting, never deployment-missing", () => {
    const base_state = { verdict: "empty", red: [], unsettled: [], deploy_coverage: {
      phase: "settling", tip_sha: "20b508b3", tip_age_secs: 147, active_run_id: 41911085476, active_run_url: "https://github.com/run/41911085476",
    } };
    expect(normalizeBaseStateWithCoverage(base_state).verdict).toBe("settling"); // BR#14088: empty + active deploy = settling, never "deployment-missing" and never green
    const line = projectTrainLine(facts({ queue_facts: { at: now, base_state } }), now);
    expect(line).toMatchObject({ phase: "waiting", blocker: "checks_running", remediation: { kind: "machine", url: "https://github.com/run/41911085476" } });
  });
  it("BR#14088: a settling tip (green deploy + in-flight smoke) renders amber waiting and never a green lane state", () => {
    // The lane's published base_state for the live shape: the deploy job settled
    // green, the post-admission smoke is still in flight — verdict SETTLING.
    const base_state = { verdict: "settling", red: [], green: 3,
      settling: ["post-deploy / Cortex Quality Smoke"],
      unsettled: ["post-deploy / Cortex Quality Smoke"] };
    const line = projectTrainLine(facts({ queue: [{ id: "BR#14088" }], queue_facts: { at: now, base_state },
      lease: { holder: "runner", heartbeat_ts: now } }), now);
    // amber wait class — never idle/ready/green, and the reason names the in-flight checks
    expect(line).toMatchObject({ phase: "waiting", blocker: "checks_running" });
    expect(line.reason).toContain("post-deploy / Cortex Quality Smoke");
    expect(line.reason).toContain("no green until every required check settles");
    // a settled-green tip (every required check completed-success) leaves the wait class:
    // with a green base_state the projection no longer renders "Required checks are running"
    const greenLine = projectTrainLine(facts({ queue: [{ id: "BR#14088" }], queue_facts: { at: now, base_state: { verdict: "green", red: [], settling: [], unsettled: [], green: 4 } },
      lease: { holder: "runner", heartbeat_ts: now } }), now);
    expect(greenLine.blocker).not.toBe("checks_running");
    expect(greenLine.reason).not.toContain("Required checks are running");
  });

  it("failed main remains loud with ZERO queued changes and carries actual agent progress", () => {
    const line = projectTrainLine(facts({ queue_facts: { at: now, base_state: { verdict: "red", red: [{ name: "Storage Health", url: "https://github.com/run/fail" }] } },
      base_red_resolution: { verdict: "red", phase: "fix_in_progress", held: 0, whats_broken: [], ask: null, fix_card: task } }), now);
    expect(line).toMatchObject({ phase: "base_red", blocker: "main_failed", held: 0, remediation: { kind: "agent", task } });
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
    const recovered = projectTrainLine(facts({ queue: [{ id: "BR#1" }], queue_facts: { at: now, base_state: { verdict: "green" } }, capable: { ready: true, at: now, holder: "gateway" } }), now);
    expect(recovered).toMatchObject({ phase: "ready", blocker: null, remediation: null });
  });

  it("BR#6901: queue activity and executor heartbeats cannot refresh idle main health", () => {
    for (const verdict of ["green", "unsettled", "red"] as const) {
      const line = projectTrainLine(facts({
        queue_facts: { at: now, base_observed_at: 1, base_state: { verdict } },
        capable: { ready: true, at: now, holder: "gateway" },
        lease: { heartbeat_ts: now, holder: "gateway" },
      }), now);
      expect(line).toMatchObject({ phase: "unknown", blocker: "stale_observation", observed_at: 1, held: 0 });
    }
    // Legacy green snapshots expire while idle too; empty queue is not health proof.
    expect(projectTrainLine(facts({ queue_facts: { at: 1, base_state: { verdict: "green" } } }), now).phase).toBe("unknown");
    expect(projectTrainLine(facts({ queue_facts: { at: now, base_observed_at: now, base_state: { verdict: "green" } } }), now))
      .toMatchObject({ phase: "idle", observed_at: now, blocker: null, remediation: null });
  });

  it("holds for an unconfirmed CI timeout without declaring the base red", () => {
    const stop = { kind: "checks_unconfirmed" };
    const queue_facts = { at: now, base_state: { verdict: "unsettled" } };
    expect(projectTrainLine(facts({ stop, queue_facts }), now)).toMatchObject({
      phase: "unknown", blocker: "stale_observation", label: "Required checks overdue",
    });
    expect(projectTrainLine(facts({ stop, queue_facts: { at: now, base_state: { verdict: "red" } } }), now).phase).toBe("base_red");
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
