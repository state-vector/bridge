import { describe, expect, it } from "vitest";
import { legacyTimeoutChargeGeneration, chargeExecutionFailure, executionAttemptBudgetExhausted, executionAdmissionHold, openLargerModelStrategy, providerRecoveryDiagnosis, validRecoveryRequestProof, recoveryPermitMatches, capabilityBlockers, initialExecution, reduceExecution, nextExecutorStartBarrier, recoverResourceStartBarrier, type Checkpoint, type ExecutionCommand, type ExecutionState } from "../src/execution.ts";
import { continueRecoveryLineage, reduceRecoveryEpisode, type RecoveryCause } from "../src/train-recovery.ts";

const cp: Checkpoint = { repo: "https://github.com/state-vector/bridge.git", remote_ref: "refs/heads/bridge-checkpoints/BR-1/1/1", commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), environment: ["linux"], next: "Run failing integration test", tests: [] };
const begin = { kind: "begin", attempt_id: "one", worker: "mac/worker", action_budget_ms: 60_000 } as const;
const fence = { generation: 1, attempt_id: "one" };
const step = (s: ExecutionState, c: ExecutionCommand, now = 100, host = "mac", session = "dispatch-BR-1") => reduceExecution(s, c, host, session, now);
const started = () => step(initialExecution(), begin);

describe("durable execution failure boundaries", () => {
  it("finishes an authored local handoff only after stopped proof, never by exit code", () => {
    let s = step(started(), { kind: "local_handoff", ...fence, reason: "Local device needed", action: "Run on paired device", findings: "Remote device is unavailable", tried: "Inspected device binding", next: "Verify on local device", evidence: ["device binding"], approvals: [], recipient: null });
    const outcome = { kind: "interrupted", exit_code: null, stdout_tail: "WIP retained", stderr_tail: "" } as const;
    s = step(s, { kind: "stopped", ...fence, writers: "no_live_group_members", outcome });
    expect(s.handoff.phase).toBe("preparing");
    expect(() => step(s, { kind: "prepare", ...fence, operation_id: "new-effect", action: "Must not run", input_revision: cp.commit, budget_ms: 1000 })).toThrow(/stopped/);
    s = step(s, { kind: "finalize", ...fence, writers: "no_live_group_members", outcome }, 1_000_000);
    expect(s.attempt?.phase).toBe("quiesced");
    expect(s.handoff).toMatchObject({ phase: "waiting", checkpoint: null, quiescence: { kind: "runner", generation: 1 } });
  });
  it("recovers historical scratch ENOSPC once without sliding backoff or clearing real signing defects", () => {
    const reason = "gate: identity profile failed — refusing to dispatch (sign-check scratch dir: No space left on device (os error 28)). Fix the runner's identity config or provision the signing key.";
    const legacy = { kind: "repair_required", fingerprint: "same-worker/config", failures: 5, reason } as const;
    const recovered = recoverResourceStartBarrier(legacy, 100);
    expect(recovered).toMatchObject({ kind: "cooldown", fingerprint: legacy.fingerprint, until_ts: 60_100 });
    expect(recoverResourceStartBarrier(recovered, 50_000)).toBe(recovered);
    expect(recoverResourceStartBarrier(recovered, 70_000)).toBe(recovered);
    let repeated = recovered;
    for (let i = 1; i <= 5; i++) repeated = nextExecutorStartBarrier(repeated, legacy.fingerprint, reason, i * 70_000, "prerequisite");
    expect(repeated).toMatchObject({ kind: "cooldown", failures: 1, until_ts: 410_000 });
    for (const failure of ["gate: signing key not found", "gate: sign check failed (exit 255)", "gate: No space left on device in unrelated tool", "gate: sign-check scratch dir: Permission denied (os error 13)"]) {
      const barrier = nextExecutorStartBarrier(null, legacy.fingerprint, failure, 100, "prerequisite");
      expect(barrier.kind).toBe("repair_required");
      expect(recoverResourceStartBarrier(barrier, 200)).toBe(barrier);
    }
  });
  it("bounds unstarted failures across restarts; only changed prerequisites reset their budget", () => {
    const one = nextExecutorStartBarrier(null, "worker/config-one", "begin refused", 100);
    expect(one).toMatchObject({ kind: "cooldown", failures: 1, until_ts: 60_100 });
    const two = nextExecutorStartBarrier(JSON.parse(JSON.stringify(one)), "worker/config-one", "still refused", 70_000);
    expect(two).toMatchObject({ kind: "cooldown", failures: 2, until_ts: 190_000 });
    const three = nextExecutorStartBarrier(two, "worker/config-one", "still refused", 200_000);
    expect(three).toMatchObject({ kind: "repair_required", failures: 3 });
    expect(nextExecutorStartBarrier(null, "worker/config-one", "gate: prerequisite missing", 100, "prerequisite")).toMatchObject({ kind: "repair_required", failures: 1 });
    expect(nextExecutorStartBarrier(three, "worker/config-repaired", "new prerequisite failure", 300_000)).toMatchObject({ kind: "cooldown", failures: 1 });
    expect(() => step(started(), { kind: "start_failed", stage: "begin", reason: "unknown start outcome", retained_work: false, failure_class: "transport" })).toThrow(/unquiesced/);
  });
  it("retries a begin that raced a readiness hold while preserving identity failures", () => {
    const legacy = "ERROR: gate: begin requires the provisioned worker from the runner's live readiness proof";
    const current = "ERROR: gate: gateway admission changed before begin; retry through the scheduler";
    const barrier = { kind: "repair_required", fingerprint: "worker/config", failures: 2, reason: legacy } as const;
    const recovered = recoverResourceStartBarrier(barrier, 100);
    expect(recovered).toMatchObject({ kind: "cooldown", until_ts: 60_100 });
    expect(recoverResourceStartBarrier(recovered, 200)).toBe(recovered);
    expect(nextExecutorStartBarrier(null, barrier.fingerprint, current, 200, "prerequisite")).toMatchObject({ kind: "cooldown", until_ts: 60_200 });
    const mismatch = nextExecutorStartBarrier(null, barrier.fingerprint, "gate: begin worker identity differs from the advertised credential", 200, "prerequisite");
    expect(mismatch.kind).toBe("repair_required");
    expect(recoverResourceStartBarrier(mismatch, 300)).toBe(mismatch);
  });
  it("keeps a fault's retry budget/history across unrelated commits without carrying verification coverage", () => {
    const cause: RecoveryCause = { kind: "check_failure", check: "Smoke" };
    let episode = reduceRecoveryEpisode(undefined, { head_sha: cp.base, cause, event_id: "failed", actor: "runner", now: 1,
      event: { kind: "observed", task_id: "BR#1", source: { head_sha: cp.base, run_id: 1, run_attempt: 1, url: "https://github.com/state-vector/bridge/actions/runs/1" }, next: "Inspect" } });
    episode = reduceRecoveryEpisode(episode, { head_sha: cp.base, cause, event_id: "retry", actor: "runner", now: 2,
      event: { kind: "attempt_started", task_id: "BR#1", attempt_id: "retry-one", attempt_kind: "retry", action: "Retry", next: "Check" } });
    episode = reduceRecoveryEpisode(episode, { head_sha: cp.base, cause, event_id: "retry-result", actor: "runner", now: 3,
      event: { kind: "attempt_finished", task_id: "BR#1", attempt_id: "retry-one", outcome: "failed", summary: "Still red", receipts: [], next: "Repair" } });
    const continued = continueRecoveryLineage(episode, cp.commit, "BR#1", 4);
    expect(continued.lineage_id).toBe(episode.id);
    expect(continued.attempts).toEqual(episode.attempts);
    expect(continued.verified_receipts).toEqual([]);
    const denied = reduceRecoveryEpisode(continued, { head_sha: cp.commit, cause, event_id: "new-sha-blind-retry", actor: "other-host", now: 5,
      event: { kind: "attempt_started", task_id: "BR#1", attempt_id: "retry-two", attempt_kind: "retry", action: "Retry", next: "Check" } });
    expect(denied.stage.phase).toBe("exhausted");
  });
  it("does not let lease expiry or host death imply writer quiescence", () => {
    const s = started();
    expect(() => step(s, { ...begin, attempt_id: "two" }, 1_000_000, "linux")).toThrow(/quiescence/);
    expect(() => step(s, { kind: "poll", ...fence }, 1_000_000)).toThrow(/expired/);
    expect(() => step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" }, 1_000_000, "linux")).toThrow(/fenced/);
  });
  it.each([null, cp])("starts fresh on another host after quiescence with legacy checkpoint %j", (checkpoint) => {
    let s = started();
    if (checkpoint) s = step(s, { kind: "checkpoint", ...fence, checkpoint });
    s = step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" });
    s = step(s, { ...begin, attempt_id: "two" }, 200, "linux");
    expect(s.attempt).toMatchObject({ phase: "running", host: "linux", generation: 2, checkpoint: null, restored_tree: null });
    expect(() => step(s, { kind: "checkpoint", ...fence, checkpoint: cp })).toThrow(/fenced/);
  });
  it("does not deliver retired writers' claim-ended stops to a replacement", () => {
    const text = "Task claim ended. Stop the writer and report process-group quiescence; do not continue execution.";
    const previousStop = { kind: "message", message_id: "claim-ended:1:one", priority: "interrupt", text } as const;
    let s = step(started(), previousStop);
    s = step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" });
    const legacyInbox = s.messages;
    s = step(s, { ...begin, attempt_id: "two" }, 200);
    s.messages = legacyInbox; // A previously persisted replacement left the older stop queued.
    const secondFence = { generation: 2, attempt_id: "two" };
    s = step(s, { ...previousStop, message_id: "claim-ended:2:two" }, 201);
    s = step(s, { kind: "quiesce", ...secondFence, writers: "process_group_empty" }, 202);

    const replacement = step(s, { ...begin, attempt_id: "three" }, 300);
    expect(replacement.messages.map(m => m.state)).toEqual(["acted", "acted"]);
    const poll = { kind: "poll", generation: 3, attempt_id: "three" } as const;
    expect(step(replacement, poll, 301).attempt?.phase).toBe("running");

    s = step(s, { kind: "message", message_id: "operator-stop", priority: "interrupt", text: "Stop before the next push" });
    const held = step(step(s, { ...begin, attempt_id: "three" }, 300), poll, 301);
    expect(held.attempt?.phase).toBe("stopping");
    expect(held.messages.at(-1)).toMatchObject({ id: "operator-stop", state: "delivered" });
  });

  it("rejects content-unbound test evidence", () => {
    expect(() => step(started(), { kind: "checkpoint", ...fence, checkpoint: { ...cp, tests: [{ tree: cp.base, command: "test", outcome: "passed", receipt: "run/1" }] } })).toThrow(/evidence/);
  });
  it("delivers, acknowledges and acts upon coordination in order; interruption gates mutations", () => {
    let s = step(started(), { kind: "message", message_id: "stop", text: "Use the published repair", priority: "interrupt" });
    expect(s.attempt?.phase).toBe("stopping");
    expect(() => step(s, { kind: "ack", ...fence, message_id: "stop", state: "acted" })).toThrow(/delivery/);
    s = step(s, { kind: "poll", ...fence });
    expect(s.messages[0].state).toBe("delivered");
    expect(() => step(s, { kind: "ack", ...fence, message_id: "stop", state: "acted" })).toThrow(/acknowledgement/);
    s = step(s, { kind: "ack", ...fence, message_id: "stop", state: "acknowledged" });
    s = step(s, { kind: "ack", ...fence, message_id: "stop", state: "acted" });
    expect(s.messages[0].state).toBe("acted");
  });
  it("retains unknown external effects across attempts and forbids blind re-execution", () => {
    let s = step(started(), { kind: "prepare", ...fence, operation_id: "deploy", action: "Deploy exact SHA", input_revision: cp.commit, budget_ms: 1000 });
    s = step(s, { kind: "poll", ...fence }, 1200);
    expect(s.operations[0].state).toBe("outcome_unknown");
    s = step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" }, 1200);
    expect(() => step(s, { ...begin, attempt_id: "two" }, 1200)).toThrow(/unknown external/);
    s = step(s, { kind: "result", ...fence, operation_id: "deploy", outcome: "succeeded", receipts: ["https://github.com/state-vector/bridge/actions/runs/1"] }, 1200);
    expect(s.operations[0].state).toBe("succeeded");
  });
  it("persists a higher reasoning minimum and requires quiescence before yield", () => {
    let s = step(started(), { kind: "escalate", ...fence, tier: "large", reason: "Two failed proof attempts at medium reasoning" });
    expect(s.requirements.tier).toBe("large");
    expect(() => step(s, { kind: "yield", ...fence })).toThrow(/quiescent/);
    expect(() => step(s, { kind: "escalate", ...fence, tier: "small", reason: "downgrade" })).toThrow(/increase/);
    s = step(s, { kind: "checkpoint", ...fence, checkpoint: cp });
    s = step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" });
    expect(step(s, { kind: "yield", ...fence }).requirements.tier).toBe("large");
  });
  it("composes live capability blockers without mistaking an installed CLI for cloud access", () => {
    expect(capabilityBlockers({ tier: "large", tools: ["cargo"], environment: ["aws:prod:write"], host: "mac" }, { tier: "small", tools: ["aws"], environment: ["linux"] }, "linux")).toEqual(["reasoning:large", "tool:cargo", "environment:aws:prod:write", "host:mac"]);
  });
  it("enforces an action budget even with constant transport output", () => {
    let s = step(started(), { kind: "poll", ...fence }, 60_101);
    expect(s.attempt?.phase).toBe("stopping");
    expect(s.budget_exhaustions).toBe(1);
    s = step(s, { kind: "poll", ...fence }, 60_102);
    expect(s.budget_exhaustions).toBe(1);
  });
});

describe("witnessed legacy recovery fences", () => {
  function held() {
    let s = step(started(), {kind:"quiesce",...fence,writers:"process_group_empty"});
    s.budget_exhaustions = 3;
    const terminal = {...fence,writers:"process_group_empty" as const,outcome:{kind:"failed" as const,exit_code:1,stdout_tail:"",stderr_tail:"acp session/prompt failed: Authentication required: provider authentication required "}};
    s.terminal = terminal;
    s.recovery_permit = {phase:"available",id:"permit",...fence,task_revision:"revision",checkpoint_commit:null,terminal:structuredClone(terminal),
      proof:{id:"probe",host:"mac",backend:"opencode",model:"route",config_revision:"config",result:{kind:"succeeded",response_receipt:"request-read"},observed_at:150,
        request:{kind:"configured_model_request",max_output_tokens:32000,tools:"none"},actual_model:"actual",configuration_receipt:"config-read",receipts:["request-read"],
        witness:{kind:"configured_route_observed",configured_model:"route",allowed_actual_models:["actual"],configured_max_output_tokens:32000,observed_max_output_tokens:32000,configuration_receipt:"config-read"}},
      diagnosis:"provider_authentication",continuation:"Reconcile existing output",evidence:["request-read"],authorized_by:"reviewer"};
    return s;
  }
  const capability = {backend:"opencode",model:"route",config_revision:"config"} as const;
  it("accepts a configured proxy receipt only for route recovery, with the observed request ceiling", () => {
    const proof = held().recovery_permit!.proof;
    const witness = { ...proof.witness, kind: "configured_proxy_request" as const };
    expect(validRecoveryRequestProof({ ...proof, witness }, "provider_route_unavailable")).toBe(true);
    expect(validRecoveryRequestProof({ ...proof, witness }, "provider_quota")).toBe(false);
    expect(validRecoveryRequestProof({ ...proof, witness }, "provider_authentication")).toBe(false);
    expect(validRecoveryRequestProof({ ...proof, witness: { ...witness, observed_max_output_tokens: 1 } }, "provider_route_unavailable")).toBe(false);
  });
  it("invalidates proof for changed evidence, routing, work and age while preserving the record", () => {
    const s=held();
    expect(recoveryPermitMatches(s,capability,"mac","revision",200)).toBe(true);
    for (const c of [{...capability,model:"other"},{...capability,config_revision:"new"}]) expect(recoveryPermitMatches(s,c,"mac","revision",200)).toBe(false);
    expect(recoveryPermitMatches(s,capability,"other","revision",200)).toBe(false);
    expect(recoveryPermitMatches(s,capability,"mac","new",200)).toBe(false);
    for (const time of [149,300151]) expect(recoveryPermitMatches(s,capability,"mac","revision",time)).toBe(false);
    const changed=structuredClone(s); changed.terminal!.outcome.stderr_tail="different";
    expect(recoveryPermitMatches(changed,capability,"mac","revision",200)).toBe(false);
    const changedCheckpoint=structuredClone(s); changedCheckpoint.attempt!.checkpoint=cp;
    expect(recoveryPermitMatches(changedCheckpoint,capability,"mac","revision",200)).toBe(false);
    for (const state of ["prepared","outcome_unknown"] as const) {
      const unknown=structuredClone(s); unknown.operations=[{id:"write",action:"publish",input_revision:"old",deadline:1100,state,receipts:[]}];
      expect(recoveryPermitMatches(unknown,capability,"mac","revision",200)).toBe(false);
    }
    const next=reduceExecution(s,{...begin,attempt_id:"recovered"},"mac","dispatch-BR-1",200,"revision");
    expect(next.budget_exhaustions).toBe(3);
    expect(next.recovery_permit?.phase).toBe("consumed");
    expect(next.terminal).toEqual(s.terminal);
  });
  it("does not consume a provider permit when starting a reviewed larger-model strategy", () => {
    const state = held();
    const terminal = state.terminal!;
    terminal.outcome.stderr_tail = "acp session/prompt failed: Internal error: No deployments available for selected model, Try again in 30 seconds. Passed model=test/small. pre-call-checks=False, cooldown_list=[]";
    const permit = state.recovery_permit!;
    permit.terminal = structuredClone(terminal);
    permit.diagnosis = "provider_route_unavailable";
    permit.proof.witness = { ...permit.proof.witness, kind: "configured_proxy_request" };
    expect(recoveryPermitMatches(state, capability, "mac", "revision", 200)).toBe(true);
    openLargerModelStrategy(state, "medium", "Reviewed different model", "independent_review", "revision");
    const next = reduceExecution(state, { ...begin, attempt_id: "larger-model" }, "mac", "dispatch-BR-1", 200, "revision");
    expect(next.generation).toBe(2);
    expect(next.recovery_permit?.phase).toBe("available");
  });
  it("recognizes the archived ACP routing failure without inferring exhausted credit", () => {
    const stderr_tail = `acp session/prompt failed: Internal error: No deployments available for selected model, Try again in 30 seconds. Passed model=glm-5.3-flash. pre-call-checks=False, cooldown_list=['${"a".repeat(64)}'] `;
    expect(providerRecoveryDiagnosis({kind:"failed",exit_code:null,stdout_tail:"",stderr_tail})).toBe("provider_route_unavailable");
    expect(providerRecoveryDiagnosis({kind:"failed",exit_code:null,stdout_tail:"",stderr_tail:`tool output: ${stderr_tail}`})).toBeNull();
  });
  it("diagnoses a lost prompt response only with matching structured pending retry evidence", () => {
    const cause = { class: "route_unavailable" as const, backend: "opencode", model: "llmgw/glm-5.3-flash",
      code: null, error_name: "provider.no-route", message: "route unavailable", data: { error: { type: "provider.no-route" } },
      evidence_line: "ACP opencode/retry was pending when the prompt stopped", at_ms: 100 };
    const outcome = { kind: "timed_out" as const, exit_code: null, stdout_tail: "", stderr_tail: "", cause };
    expect(providerRecoveryDiagnosis(outcome)).toBe("provider_route_unavailable");
    expect(providerRecoveryDiagnosis({ ...outcome, kind: "interrupted" })).toBeNull();
    expect(providerRecoveryDiagnosis({ ...outcome, cause: { ...cause, data: { error: { type: "tool.execution" } } } })).toBeNull();
    expect(providerRecoveryDiagnosis({ ...outcome, cause: { ...cause, evidence_line: null } })).toBeNull();
    expect(providerRecoveryDiagnosis({ ...outcome, cause: { ...cause, class: "diagnostic" } })).toBeNull();
  });
  it("does not turn missing output or generic errors into provider diagnoses", () => {
    for (const stderr_tail of ["No deployments available", "provider quota maybe", "test failed", ""]) {
      expect(providerRecoveryDiagnosis({kind:"failed",exit_code:1,stdout_tail:"",stderr_tail})).toBeNull();
    }
    expect(providerRecoveryDiagnosis(held().terminal!.outcome)).toBe("provider_authentication");
  });
});

describe("cause-preserving strategy attempts", () => {
  it("counts a timeout generation once across poll and terminal accounting", () => {
    let s=started(); s=step(s,{kind:"poll",...fence},60_101);
    expect(s.budget_exhaustions).toBe(1);
    chargeExecutionFailure(s,1); chargeExecutionFailure(s,1);
    expect(s.budget_exhaustions).toBe(1);
    chargeExecutionFailure(s,2); expect(s.budget_exhaustions).toBe(2);
  });
  it("requires recovery for a route failure when a larger-model strategy belongs to another revision", () => {
    const outcome = { kind: "failed", exit_code: 1, stdout_tail: "",
      stderr_tail: "acp session/prompt failed: Internal error: No deployments available for selected model, Try again in 30 seconds. Passed model=test/small. pre-call-checks=False, cooldown_list=[]" } as const;
    const receipt = { ...fence, writers: "process_group_empty", outcome } as const;
    const state = step(step(started(), { kind: "stopped", ...receipt }), { kind: "finalize", ...receipt });
    expect(executionAdmissionHold(state, "reviewed")).toBe("provider_route");
    openLargerModelStrategy(state, "medium", "Reviewed different model", "independent_review", "reviewed");
    const resume = { ...begin, attempt_id: "different-strategy" };
    expect(executionAdmissionHold(state, "edited")).toBe("provider_route");
    expect(() => reduceExecution(state, resume, "mac", "dispatch-BR-1", 200, "edited")).toThrow(/provider route/);
    expect(executionAdmissionHold(state, "reviewed")).toBeNull();
    expect(reduceExecution(state, resume, "mac", "dispatch-BR-1", 200, "reviewed").generation).toBe(2);
  });
  it("admits a genuinely larger strategy with preserved history and bounded new failures", () => {
    const s=started(); s.budget_exhaustions=3;
    openLargerModelStrategy(s,"medium","The current model cannot resolve the cross-system invariant","independent_review","revision");
    s.requirements.tier="medium";
    expect(s.budget_exhaustions).toBe(3);
    expect(executionAttemptBudgetExhausted(s,"revision")).toBe(false);
    expect(executionAttemptBudgetExhausted(s,"changed")).toBe(true);
    chargeExecutionFailure(s,1); // late old-strategy result must not spend new-strategy attempts
    expect(s.retry_strategy?.failures).toBe(0);
    for (const generation of [2,3,4]) chargeExecutionFailure(s,generation);
    expect(executionAttemptBudgetExhausted(s,"revision")).toBe(true);
    expect(s.budget_exhaustions).toBe(7);
    expect(()=>openLargerModelStrategy(s,"medium","same strategy","independent_review","revision")).toThrow(/strictly increase/);
    openLargerModelStrategy(s,"large","Need deeper reasoning","independent_review","revision");
    expect(s.retry_strategy?.epoch).toBe(2);
    expect(executionAttemptBudgetExhausted(s,"revision")).toBe(false);
  });
});

describe("legacy timeout accounting migration", () => {
  it("recognizes only an exact recorded timeout charge and never subtracts history", () => {
    const begun=started(); begun.budget_exhaustions=2;
    const polled=step(begun,{kind:"poll",...fence},60_101);
    const legacy=structuredClone(polled); legacy.failure_charged_generation=null;
    expect(legacyTimeoutChargeGeneration(legacy,begun,[polled])).toBe(1);
    for(const wrong of [
      {...polled,budget_exhaustions:2},
      {...polled,attempt:{...polled.attempt!,attempt_id:"other"}},
      {...polled,attempt:{...polled.attempt!,generation:2}},
    ]) expect(legacyTimeoutChargeGeneration(legacy,begun,[wrong])).toBeNull();
    expect(legacyTimeoutChargeGeneration(legacy,null,[polled])).toBeNull();
    expect(legacyTimeoutChargeGeneration(legacy,begun,[])).toBeNull();
    const interrupted=step(begun,{kind:"message",message_id:"stop",text:"Pause",priority:"interrupt"});
    expect(legacyTimeoutChargeGeneration({...interrupted,failure_charged_generation:null},begun,[interrupted])).toBeNull();
    legacy.failure_charged_generation=legacyTimeoutChargeGeneration(legacy,begun,[polled]);
    chargeExecutionFailure(legacy,1);
    expect(legacy.budget_exhaustions).toBe(3);
  });
});
