import { describe, expect, it } from "vitest";
import { ExecutionStateSchema, attemptDiagnosisCoversAttempt, executionNeedsRecoveryPermit, legacyTimeoutChargeGeneration, chargeExecutionFailure, executionAttemptBudgetExhausted, executionAdmissionHold, openLargerModelStrategy, providerRecoveryDiagnosis, validRecoveryRequestProof, recoveryPermitMatches, capabilityBlockers, initialExecution, reduceExecution, nextExecutorStartBarrier, recoverResourceStartBarrier, externalWaitCoveredBy, externalWaitHeadMoved, isReadOnlyCheckObservation, actionableMailbox, isAcpStartupInterrupt, startupInterruptBackoffMs, ACP_STARTUP_INTERRUPT_STDERR, type Checkpoint, type ExecutionCommand, type ExecutionMessage, type ExecutionState } from "../src/execution.ts";
import { continueRecoveryLineage, reduceRecoveryEpisode, type RecoveryCause } from "../src/train-recovery.ts";

const cp: Checkpoint = { repo: "https://github.com/state-vector/bridge.git", commit: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), environment: ["linux"], next: "Run failing integration test", tests: [] };
const begin = { kind: "begin", attempt_id: "one", worker: "mac/worker", action_budget_ms: 60_000 } as const;
const fence = { generation: 1, attempt_id: "one" };
const step = (s: ExecutionState, c: ExecutionCommand, now = 100, host = "mac", session = "dispatch-BR-1") => reduceExecution(s, c, host, session, now);
const started = () => step(initialExecution(), begin);

it("requests a checkpoint-bound coordination stop without attesting quiescence", () => {
  const command = { kind: "request_coordination_wait", ...fence, ask_id: "BR#42", checkpoint_commit: cp.commit } as const;
  expect(() => step(started(), command)).toThrow(/recorded checkpoint/);
  const checkpointed = step(started(), { kind: "checkpoint", ...fence, checkpoint: cp });
  const waiting = step(checkpointed, command);
  expect(waiting.attempt?.phase).toBe("stopping");
  expect(waiting.terminal).toBeNull();
  expect(waiting.coordination_wait_intent).toEqual({ ...fence, ask_id: "BR#42", checkpoint_commit: cp.commit });
  expect(() => step(waiting, { ...command, generation: fence.generation + 1 })).toThrow(/fenced/);
  const changedCheckpoint = { ...cp, commit: cp.base };
  expect(() => step(waiting, { kind: "checkpoint", ...fence, checkpoint: changedCheckpoint })).toThrow(/bound to the recorded checkpoint/);
});

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
    for (const failure of ["gate: signing key not found", "gate: sign check failed (exit 255)", "gate: No space left on device in unrelated tool", "gate: sign-check scratch dir: Permission denied (os error 13)", "gate: identity profile failed: git config user.name failed"]) {
      const barrier = nextExecutorStartBarrier(null, legacy.fingerprint, failure, 100, "prerequisite");
      expect(barrier.kind).toBe("repair_required");
      expect(recoverResourceStartBarrier(barrier, 200)).toBe(barrier);
    }
  });
  it("recovers identity-profile ENOSPC as a bounded resource cooldown, never a permanent prerequisite", () => {
    // BR#6992 live specimen: a full workspace volume refused `git config
    // user.name` while provisioning a worktree identity; the bare error text
    // fenced the gateway permanently. The runner now surfaces git's stderr,
    // so the OS error evidence in the reason is what makes it recoverable —
    // without it (the negative cases above) an identity defect stays a
    // prerequisite.
    const reason = "gate: identity profile failed: git config user.name failed: error: could not write '.git/config.lock': No space left on device (os error 28)";
    const legacy = { kind: "repair_required", fingerprint: "same-worker/config", failures: 2, reason } as const;
    const recovered = recoverResourceStartBarrier(legacy, 100);
    expect(recovered).toMatchObject({ kind: "cooldown", fingerprint: legacy.fingerprint, failures: 1, until_ts: 60_100 });
    let repeated = recovered;
    for (let i = 1; i <= 5; i++) repeated = nextExecutorStartBarrier(repeated, legacy.fingerprint, reason, i * 70_000, "prerequisite");
    expect(repeated).toMatchObject({ kind: "cooldown", failures: 1 });
    // The evidence gate is AND-ed, not substring-lucky: an ENOSPC mention
    // outside the identity-profile gate, or an identity gate whose git stderr
    // named a different cause, both stay prerequisites.
    for (const failure of ["gate: identity profile failed: git config user.email failed: error: unknown", "No space left on device while signing the receipt"]) {
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

  it("BR#19479: settles prior-attempt preemption at begin from real quiescence and never replays it", () => {
    const preemptText = "Priority line recovery BR#19440 needs this slot. Stop safely, confirm process-group quiescence and yield.";
    let s = step(started(), { kind: "message", message_id: "recovery-preempt:BR#19440:1:one", priority: "interrupt", text: preemptText, fence: { generation: 1, attempt_id: "one" } });
    s = step(s, { kind: "poll", ...fence });
    expect(s.attempt?.phase).toBe("stopping"); // the fresh interrupt stops its own attempt
    s = step(s, { kind: "ack", ...fence, message_id: "recovery-preempt:BR#19440:1:one", state: "acknowledged" });
    s = step(s, { kind: "ack", ...fence, message_id: "recovery-preempt:BR#19440:1:one", state: "acted" });
    s = step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" });
    s = step(s, { ...begin, attempt_id: "two" }, 200);
    expect(s.messages).toMatchObject([{ id: "recovery-preempt:BR#19440:1:one", state: "acted", fence: { generation: 1, attempt_id: "one" } }]); // audit preserved, nothing deleted
    expect(step(s, { kind: "poll", generation: 2, attempt_id: "two" }, 201).attempt?.phase).toBe("running"); // no replayed stop
    expect(actionableMailbox(s.messages, { generation: 2, attempt_id: "two" })).toHaveLength(0); // nothing actionable in the launch prompt
  });

  it("BR#19479: a crash leaves prior-attempt control delivered; begin settles it so the restart reaches work", () => {
    let s = step(started(), { kind: "message", message_id: "recovery-preempt:BR#19440:1:one", priority: "interrupt", text: "Priority line recovery needs this slot.", fence: { generation: 1, attempt_id: "one" } });
    s = step(s, { kind: "poll", ...fence }); // delivered; the writer is killed before any ack
    const outcome = { kind: "interrupted", exit_code: null, stdout_tail: "", stderr_tail: "" } as const;
    s = step(s, { kind: "stopped", ...fence, writers: "process_group_empty", outcome });
    s = step(s, { kind: "finalize", ...fence, writers: "process_group_empty", outcome }, 150);
    s = step(s, { ...begin, attempt_id: "two" }, 200);
    expect(s.messages[0]).toMatchObject({ id: "recovery-preempt:BR#19440:1:one", state: "acted" }); // settled by quiescence evidence, not model prose
    expect(step(s, { kind: "poll", generation: 2, attempt_id: "two" }, 201).attempt?.phase).toBe("running");
    expect(actionableMailbox(s.messages, { generation: 2, attempt_id: "two" })).toHaveLength(0);
  });

  it("BR#19479: generation-bearing preempt IDs fence even without the typed field (older rows)", () => {
    let s = started();
    s.messages.push({ id: "recovery-preempt:BR#19440:1:one", text: "Priority line recovery needs this slot.", priority: "interrupt", state: "acknowledged" });
    s = step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" });
    s = step(s, { ...begin, attempt_id: "two" }, 200);
    expect(s.messages[0].state).toBe("acted");
    expect(actionableMailbox(s.messages, { generation: 2, attempt_id: "two" })).toHaveLength(0);
  });

  it("BR#19479: acknowledged-but-unacted coordination survives begin and stays actionable", () => {
    let s = started();
    s.messages.push({ id: "ask:BR#19480", text: "narrow factual continuation", priority: "normal", state: "acknowledged" });
    s = step(s, { kind: "quiesce", ...fence, writers: "process_group_empty" });
    s = step(s, { ...begin, attempt_id: "two" }, 200);
    expect(s.messages[0]).toMatchObject({ id: "ask:BR#19480", state: "acknowledged" }); // not settled, not suppressed
    expect(actionableMailbox(s.messages, { generation: 2, attempt_id: "two" }).map(m => m.id)).toEqual(["ask:BR#19480"]);
  });

  it("BR#19479: a fresh current-attempt preemption still stops the running attempt and renders actionable", () => {
    let s = step(started(), { kind: "quiesce", ...fence, writers: "process_group_empty" });
    s = step(s, { ...begin, attempt_id: "two" }, 200);
    const two = { generation: 2, attempt_id: "two" };
    s = step(s, { kind: "message", message_id: "recovery-preempt:BR#19442:2:two", priority: "interrupt", text: "Priority line recovery needs this slot.", fence: two });
    expect(s.messages[0]).toMatchObject({ fence: two, state: "queued" });
    s = step(s, { kind: "poll", ...two }, 201);
    expect(s.attempt?.phase).toBe("stopping"); // fresh current interrupts are never suppressed
    expect(actionableMailbox(s.messages, two).map(m => m.id)).toEqual(["recovery-preempt:BR#19442:2:two"]);
  });

  it("BR#19479: the actionable projection excludes acted history and other-attempt control only", () => {
    const mailbox: ExecutionMessage[] = [
      { id: "recovery-preempt:BR#19440:1:old", text: "stop", priority: "interrupt", state: "acted" },
      { id: "recovery-preempt:BR#19441:1:old", text: "stop", priority: "interrupt", state: "delivered" },
      { id: "ask:BR#19480", text: "pending", priority: "normal", state: "acknowledged" },
      { id: "recovery-preempt:BR#19442:2:two", text: "stop", priority: "interrupt", state: "queued", fence: { generation: 2, attempt_id: "two" } },
    ];
    expect(actionableMailbox(mailbox, { generation: 2, attempt_id: "two" }).map(m => m.id)).toEqual(["ask:BR#19480", "recovery-preempt:BR#19442:2:two"]);
    expect(actionableMailbox(mailbox, { generation: 1, attempt_id: "old" }).map(m => m.id)).toEqual(["recovery-preempt:BR#19441:1:old", "ask:BR#19480"]);
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
    s.budget_exhausted_at = 100;
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
  it("does not authorize another begin just because a recorded exhaustion is old", () => {
    const state = held();
    state.recovery_permit = null;
    expect(executionAdmissionHold(state, "revision")).toBe("retry_budget");
    expect(() => reduceExecution(state, { ...begin, attempt_id: "unchanged" }, "mac", "dispatch-BR-1",
      3 * 86_400_000, "revision")).toThrow(/current recovery permit/);
  });
  it("accepts a configured proxy receipt only for route recovery, with the observed request ceiling", () => {
    const proof = held().recovery_permit!.proof;
    if (!("request" in proof)) throw new Error("fixture needs a configured request");
    const witness = { ...proof.witness, kind: "configured_proxy_request" as const };
    expect(validRecoveryRequestProof({ ...proof, witness }, "provider_route_unavailable")).toBe(true);
    expect(validRecoveryRequestProof({ ...proof, witness }, "provider_quota")).toBe(false);
    expect(validRecoveryRequestProof({ ...proof, witness }, "provider_authentication")).toBe(false);
    expect(validRecoveryRequestProof({ ...proof, witness: { ...witness, observed_max_output_tokens: 1 } }, "provider_route_unavailable")).toBe(false);
  });
  it("keeps legacy managed permits readable but requires a checked reservation to spend one", () => {
    const state = held();
    const permit = state.recovery_permit!;
    permit.diagnosis = "provider_route_unavailable";
    const proof = {
      id: "managed-review", host: "mac", backend: "opencode" as const, model: "route", config_revision: "config",
      result: { kind: "succeeded" as const, response_receipt: "execution:review" },
      observed_at: 150, receipts: ["execution:review"],
      witness: { kind: "managed_review_prompt" as const, project: "bridge", tier: "small" as const },
    };
    permit.proof = proof;
    const decoded = ExecutionStateSchema.parse(state);
    expect(recoveryPermitMatches(decoded, { ...capability, tier: "small" }, "mac", "revision", 200)).toBe(false);
    expect(() => reduceExecution(decoded, { ...begin, attempt_id: "legacy-permit" }, "mac", "dispatch-BR-1", 200, "revision")).toThrow(/current recovery permit/);
    permit.proof = { ...proof, witness: { ...proof.witness, assignment: "reserved_review_v1" } };
    expect(recoveryPermitMatches(state, { ...capability, tier: "small" }, "mac", "revision", 200)).toBe(true);
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
    if (!("request" in permit.proof)) throw new Error("fixture needs a configured request");
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

describe("accepted recovery diagnosis stamps (BR#18198)", () => {
  /** A stopped, budget-exhausted attempt with resolved operations — the
   *  BR#17785 shape the recovery sweep keeps re-fencing. */
  function exhausted() {
    const receipt = { ...fence, writers: "process_group_empty" as const, outcome: { kind: "failed" as const, exit_code: 1, stdout_tail: "", stderr_tail: "runner stopped" } };
    let s = step(step(started(), { kind: "stopped", ...receipt }), { kind: "finalize", ...receipt }, 1_000);
    s.budget_exhaustions = 3;
    s.budget_exhausted_at = 1_000;
    return s;
  }
  const stamp = { kind: "diagnosis_accepted", ...fence, hold: "retry_budget", duty: "BR#17814", accepted_by: "reviewer" } as const;

  it("stamps the accepted reconciliation and clears the retry_budget hold for the covered attempt", () => {
    const s = exhausted();
    expect(executionAdmissionHold(s, "revision")).toBe("retry_budget");
    expect(attemptDiagnosisCoversAttempt(s)).toBe(false);
    const next = reduceExecution(s, stamp, "system:recovery", "", 2_000, "revision");
    expect(next.attempt_diagnosis).toMatchObject({ generation: 1, attempt_id: "one", hold: "retry_budget", duty: "BR#17814" });
    expect(attemptDiagnosisCoversAttempt(next)).toBe(true);
    // The scheduler's own reservation is now the admissible retry: begin
    // needs no recovery permit (the begin gate reads the same hold).
    expect(executionAdmissionHold(next, "revision")).toBeNull();
    expect(executionNeedsRecoveryPermit(next, "revision")).toBe(false);
    const resumed = reduceExecution(next, { ...begin, attempt_id: "fresh-generation" }, "mac", "dispatch-BR-2", 3_000, "revision");
    expect(resumed.generation).toBe(2);
    expect(resumed.attempt?.phase).toBe("running");
    expect(resumed.recovery_permit).toBeNull();
  });
  it("keeps the fencing hold when the stamp is missing or the attempt moved on", () => {
    const unstamped = exhausted();
    expect(executionAdmissionHold(unstamped, "revision")).toBe("retry_budget");
    // A newer generation invalidates the stamp: coverage follows the attempt.
    let moved = reduceExecution(unstamped, stamp, "system:recovery", "", 2_000, "revision");
    moved = step(moved, { ...begin, attempt_id: "next" }, 3_000);
    const stoppedNext = { generation: 2, attempt_id: "next", writers: "process_group_empty" as const, outcome: { kind: "failed" as const, exit_code: 1, stdout_tail: "", stderr_tail: "stopped again" } };
    moved = step(moved, { kind: "stopped", ...stoppedNext }, 4_000);
    moved = step(moved, { kind: "finalize", ...stoppedNext }, 4_000);
    expect(attemptDiagnosisCoversAttempt(moved)).toBe(false);
    moved.budget_exhaustions = 4;
    moved.budget_exhausted_at = 4_000;
    expect(executionAdmissionHold(moved, "revision")).toBe("retry_budget");
  });
  it("refuses every session command and stamps only from the hub's internal write", () => {
    const running = started();
    expect(() => reduceExecution(running, stamp, "mac", "dispatch-BR-1", 2_000, "revision")).toThrow(/hub-authoritative/);
    // Even on an otherwise stampable stopped attempt, a non-empty session
    // (gateway, worker, or any authenticated caller) is refused outright.
    expect(() => reduceExecution(exhausted(), stamp, "other-host", "other-session", 2_000, "revision")).toThrow(/hub-authoritative/);
    const wrongAttempt = { ...stamp, attempt_id: "other" };
    expect(() => reduceExecution(exhausted(), wrongAttempt, "system:recovery", "", 2_000, "revision")).toThrow(/exact quiesced stopped attempt/);
  });
  it("refuses to stamp unresolved external operations", () => {
    const s = exhausted();
    s.operations = [{ id: "publish", action: "Push exact ref", input_revision: "old-head", deadline: 2_000, state: "outcome_unknown", receipts: [] }];
    expect(() => reduceExecution(s, stamp, "system:recovery", "", 2_000, "revision")).toThrow(/reconciled external operations/);
    expect(attemptDiagnosisCoversAttempt(s)).toBe(false);
    expect(executionAdmissionHold(s, "revision")).toBe("unknown_operations");
  });
  it("acknowledges an identical replay without a second write", () => {
    const stamped = reduceExecution(exhausted(), stamp, "system:recovery", "", 2_000, "revision");
    const replay = reduceExecution(stamped, stamp, "system:recovery", "", 3_000, "revision");
    expect(replay.attempt_diagnosis).toEqual(stamped.attempt_diagnosis);
    expect(replay.revision).toBe(stamped.revision);
  });
  it("parses legacy journals without the stamp field (additive default, no policy bump)", () => {
    const legacy = JSON.parse(JSON.stringify(exhausted()));
    delete legacy.attempt_diagnosis;
    const parsed = ExecutionStateSchema.parse(legacy);
    expect(parsed.attempt_diagnosis).toBeNull();
    expect(parsed.policy_version).toBe(1);
  });
});

describe("durable external-CI waits (BR#18328)", () => {
  const wait = { type: "pr_required_checks" as const, repo: "state-vector/superpositional", pr: 3644, head_sha: "3".repeat(40), contexts: ["ci / Build", "ci / Lodestar Scenarios"] };
  const park = { kind: "await_external" as const, ...fence, writers: "process_group_empty" as const, wait };

  it("parks the live attempt quiesced with no terminal evidence and no failure charge", () => {
    const s = step(started(), park, 200);
    expect(s.attempt?.phase).toBe("quiesced");
    expect(s.terminal).toBeNull();
    expect(s.budget_exhaustions).toBe(0);
    expect(s.failure_charged_generation).toBe(0);
    expect(s.external_wait).toMatchObject({ type: "pr_required_checks", repo: wait.repo, pr: wait.pr, head_sha: wait.head_sha, contexts: wait.contexts, generation: 1, attempt_id: "one", declared_at: 200 });
    // Waiting is not a failed attempt: no admission hold, no recovery permit.
    expect(executionAdmissionHold(s, "revision")).toBeNull();
    expect(executionNeedsRecoveryPermit(s, "revision")).toBe(false);
  });

  it("replays an identical park durably but refuses a different signature once parked", () => {
    const s = step(started(), park, 200);
    expect(step(s, park, 300)).toEqual(s);
    const amended = { ...park, wait: { ...wait, contexts: ["a different context set"] } };
    expect(() => step(s, amended, 300)).toThrow(/only the live writer/);
    expect(() => step(s, { ...park, wait: { ...wait, head_sha: "4".repeat(40) } }, 300)).toThrow(/only the live writer/);
  });

  it("re-keys prepared read-only check observations and refuses write-capable operations", () => {
    let s = step(started(), { kind: "prepare", ...fence, operation_id: "watch", action: "gh run watch 44822825389 --exit-status --interval 30", input_revision: cp.commit, budget_ms: 1000 });
    s = step(s, park, 200);
    expect(s.operations[0]).toMatchObject({ id: "watch", state: "succeeded" });
    expect(String(s.operations[0].receipts[0])).toContain("re-keyed");
    const hostile = step(started(), { kind: "prepare", ...fence, operation_id: "merge", action: "gh pr merge 3644 --squash", input_revision: cp.commit, budget_ms: 1000 });
    expect(() => step(hostile, park, 200)).toThrow(/merge.*not a read-only check observation/);
    // a parked attempt can no longer run effects either — the attempt fence fires first
    expect(() => step(s, { kind: "prepare", ...fence, operation_id: "late", action: "gh pr merge 3644", input_revision: cp.commit, budget_ms: 1000 })).toThrow(/lease expired or writer stopped/);
  });

  it("a new attempt clears the wait: a stale intent never parks a generation that did not declare it", () => {
    let s = step(started(), { kind: "prepare", ...fence, operation_id: "watch", action: "gh pr checks 3644", input_revision: cp.commit, budget_ms: 1000 });
    s = step(s, park, 200);
    const next = step(s, { ...begin, attempt_id: "two" }, 300);
    expect(next.generation).toBe(2);
    expect(next.attempt?.phase).toBe("running");
    expect(next.external_wait).toBeNull();
    // the re-keyed observation no longer blocks the next begin
    expect(next.operations[0].state).toBe("succeeded");
  });

  it("classifies GitHub check observation commands as the only re-keyable reads", () => {
    for (const read of ["gh run watch 123 --exit-status", "gh run view 123", "gh run list --limit 5", "gh pr checks 3644", "gh pr view 3644 --json mergeable", "gh pr status 3644", "gh api repos/o/r/pulls/3644", "gh api -X GET repos/o/r/check-runs"]) {
      expect(isReadOnlyCheckObservation(read)).toBe(true);
    }
    for (const write of ["gh pr merge 3644 --squash", "gh api -f body=hello repos/o/r/issues", "gh api -F body=hello repos/o/r/issues", "gh api --input payload.json repos/o/r", "gh api -X POST repos/o/r/check-runs", "gh run watch 123 && gh pr merge 3644", "cargo test --workspace", ""]) {
      expect(isReadOnlyCheckObservation(write)).toBe(false);
    }
  });

  it("coverage needs the same repo, PR and head plus every declared context", () => {
    expect(externalWaitHeadMoved(wait, "4".repeat(40))).toBe(true);
    expect(externalWaitHeadMoved(wait, wait.head_sha)).toBe(false);
    const observed = { repo: wait.repo, pr: wait.pr, head_sha: wait.head_sha, contexts: ["ci / Build", "ci / Lodestar Scenarios", "extra / external=SUCCESS"] };
    expect(externalWaitCoveredBy(wait, observed)).toBe(true); // extras are fine
    expect(externalWaitCoveredBy(wait, { ...observed, head_sha: "4".repeat(40) })).toBe(false); // amended head
    expect(externalWaitCoveredBy(wait, { ...observed, contexts: ["ci / Build"] })).toBe(false); // missing declared context
    expect(externalWaitCoveredBy(wait, { ...observed, repo: "state-vector/bridge" })).toBe(false);
    expect(externalWaitCoveredBy(wait, { ...observed, pr: 2 })).toBe(false);
  });
});

describe("zero-effect startup interrupts (BR#22116)", () => {
  const blip = { kind: "interrupted", exit_code: null, stdout_tail: "", stderr_tail: ACP_STARTUP_INTERRUPT_STDERR } as const;
  const stoppedBlip = { kind: "stopped" as const, ...fence, writers: "process_group_empty" as const, outcome: blip };
  const finalizeBlip = { kind: "finalize" as const, ...fence, writers: "process_group_empty" as const, outcome: blip };

  it("classifies a zero-effect startup interrupt with a structured cause and starts the cadence counter", () => {
    const s = step(started(), stoppedBlip, 200); // began_at=100, inside the 30s window
    expect(s.terminal?.outcome.cause).toMatchObject({
      class: "diagnostic", error_name: "acp_startup_interrupt",
      evidence_line: ACP_STARTUP_INTERRUPT_STDERR, backend: "opencode",
    });
    expect(isAcpStartupInterrupt(s.terminal!.outcome)).toBe(true);
    expect(s.startup_interrupt).toMatchObject({ consecutive: 1, generation: 1, attempt_id: "one", backoff_until: 200 + startupInterruptBackoffMs(1) });
    // the blip itself never charged anything
    expect(s.budget_exhaustions).toBe(0);
    expect(s.failure_charged_generation).toBe(0);
  });

  it("paces the next dispatch with the counter's own backoff and never demands a recovery permit — even with a pinned legacy budget", () => {
    let s = step(started(), stoppedBlip, 200);
    s = step(s, finalizeBlip, 300);
    s = { ...s, budget_exhaustions: 4, budget_exhausted_at: 100 }; // the BR#19889 pinned-legacy specimen
    expect(executionAdmissionHold(s, "revision", 10_000)).toBe("startup_interrupt");
    // backoff lapsed: dispatchable with NO recovery permit and NO duty cycle
    expect(executionAdmissionHold(s, "revision", 40_000)).toBeNull();
    expect(executionNeedsRecoveryPermit(s, "revision")).toBe(false);
  });

  it("grows the backoff exponentially across consecutive same-signature blips and caps it", () => {
    expect(startupInterruptBackoffMs(1)).toBe(30_000);
    expect(startupInterruptBackoffMs(2)).toBe(60_000);
    expect(startupInterruptBackoffMs(3)).toBe(120_000);
    expect(startupInterruptBackoffMs(9)).toBe(600_000);
    expect(startupInterruptBackoffMs(30)).toBe(600_000);
    let s = step(started(), stoppedBlip, 200);
    s = step(s, finalizeBlip, 300);
    s = step(s, { ...begin, attempt_id: "two" }, 40_000); // backoff lapsed
    s = step(s, { ...stoppedBlip, generation: 2, attempt_id: "two" }, 45_000);
    expect(s.startup_interrupt).toMatchObject({ consecutive: 2, backoff_until: 45_000 + 60_000, generation: 2, attempt_id: "two" });
  });

  it("preserves the stamped evidence when finalize replays the bare captured outcome", () => {
    const s = step(step(started(), stoppedBlip, 200), finalizeBlip, 300);
    expect(s.attempt?.phase).toBe("quiesced");
    expect(isAcpStartupInterrupt(s.terminal!.outcome)).toBe(true);
    // the counter counted the blip exactly once across the pair
    expect(s.startup_interrupt?.consecutive).toBe(1);
  });

  it("does not classify when the window, output, stderr signature or existing cause does not match", () => {
    const late = step(started(), stoppedBlip, 131_000); // outside the 30s window
    expect(late.terminal?.outcome.cause).toBeUndefined();
    expect(late.startup_interrupt).toBeNull();
    const withOutput = step(started(), { ...stoppedBlip, outcome: { ...blip, stdout_tail: "made real progress" } }, 200);
    expect(withOutput.terminal?.outcome.cause).toBeUndefined();
    expect(withOutput.startup_interrupt).toBeNull();
    const other = step(started(), { ...stoppedBlip, outcome: { ...blip, stderr_tail: "acp timed out — stalled: no output for 5m" } }, 200);
    expect(other.terminal?.outcome.cause).toBeUndefined();
    const withCause = step(started(), { ...stoppedBlip, outcome: { ...blip, cause: { class: "provider_internal" as const, backend: "opencode", model: null, code: null, error_name: "provider.quota", message: "quota", evidence_line: null, at_ms: 100 } } }, 200);
    expect(withCause.terminal?.outcome.cause).toMatchObject({ class: "provider_internal" });
    expect(withCause.startup_interrupt).toBeNull();
    // legacy journals carry no began_at: the window is unprovable, never classified
    const legacy = started();
    delete (legacy.attempt as { began_at?: number }).began_at;
    const stoppedLegacy = step(legacy, stoppedBlip, 200);
    expect(stoppedLegacy.terminal?.outcome.cause).toBeUndefined();
    expect(stoppedLegacy.startup_interrupt).toBeNull();
  });

  it("any real outcome — completed, failed or a genuine mid-run interrupt — proves the dispatch path and resets the cadence", () => {
    let s = step(started(), stoppedBlip, 200);
    s = step(s, finalizeBlip, 300);
    s = step(s, { ...begin, attempt_id: "two" }, 40_000);
    s = step(s, { kind: "stopped", ...fence, generation: 2, attempt_id: "two", writers: "process_group_empty", outcome: { kind: "interrupted", exit_code: null, stdout_tail: "mid-run output", stderr_tail: ACP_STARTUP_INTERRUPT_STDERR } }, 50_000);
    expect(s.startup_interrupt).toBeNull();
    s = step(s, { kind: "stopped", ...fence, generation: 2, attempt_id: "two", writers: "process_group_empty", outcome: { kind: "interrupted", exit_code: null, stdout_tail: "mid-run output", stderr_tail: ACP_STARTUP_INTERRUPT_STDERR } }, 50_100);
    // identical redelivery of the same attempt's evidence stays aligned
    expect(isAcpStartupInterrupt(s.terminal!.outcome)).toBe(false);
  });
});
