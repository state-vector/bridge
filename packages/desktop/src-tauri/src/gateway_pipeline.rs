//! Production adapter for the single local lifecycle registry. Blocking work
//! lives only in bounded preparation/finalization/admission jobs.
use super::*;
use super::attempt_journal::{self as journal, Disposition, Outcome, OutcomeKind, Record, Step, Work, WriterProof};
use super::lifecycle::{self, Ownership, Prepared, Finished, Pipeline, Reporter, Released, Ticket};

#[derive(Clone, Serialize, Deserialize)]
struct Task { id: String, title: String, body_md: String, project: String, meta: serde_json::Value, roles: Vec<String> }
#[derive(Clone, Serialize, Deserialize)]
struct Input { ticket: Ticket, task: Option<Task> }
enum FinalWork { Active(Record, ExecutionRuntime), Fresh(Record), Journal(Record), ObserveReservation(Record), Legacy(stopped_outbox::StoppedReceipt) }
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AdmissionReply {
    Reserved { task_id: String, session: String, task: Option<Task> },
    ReservationPending {}, ReservationLapsed {}, AtCapacity {}, FinalizationBackpressure {}, NoEligibleWork {},
    GatewayNotReady { reason: String }, Ready {},
}
enum Admission {
    Idle { until: Instant },
    Request { id: String },
    Waiting { id: String, job: lifecycle::Job<Result<AdmissionReply, String>> },
    Retry { id: String, until: Instant },
    Assigned(Input),
    Held { reason: String },
}
enum Recovery {
    Initial,
    Loading { job: lifecycle::Job<Result<Vec<Recovered>, String>>, initial: bool },
    Ready { next: Instant },
    Retry { next: Instant, initial: bool },
    Held { reason: String },
}
enum Recovered { Running(InFlight), Final(Ownership, FinalWork) }
type Registry = Pipeline<Input, InFlight, FinalWork>;
type Config = Arc<Mutex<GatewayReadinessData>>;
const CONTROLLER_LOCK_FILE: &str = ".bridge/gateway-runtime.lock";

fn config(shared: &Config) -> DispatchConfig { let mut cfg = shared.lock().expect("gateway readiness poisoned").cfg.clone(); cfg.url = cfg.url.trim_end_matches('/').into(); cfg }
pub(super) fn root(cfg: &DispatchConfig) -> Result<PathBuf, String> {
    let key = journal::stable_key(&[cfg.url.trim_end_matches('/'), cfg.label.as_deref().ok_or("gateway host missing")?]);
    Ok(PathBuf::from(std::env::var_os("HOME").ok_or("gateway home missing")?).join(".bridge/lifecycle").join(key))
}
pub(super) fn terminal_root(cfg: &DispatchConfig) -> Result<PathBuf, String> { Ok(root(cfg)?.join("terminal")) }
fn reservation_path(cfg: &DispatchConfig, ticket: &Ticket) -> Result<PathBuf, String> {
    let key = journal::stable_key(&[&ticket.task_id, &ticket.session]);
    Ok(root(cfg)?.join("reservations").join(format!("{key}.json")))
}
fn remove_reservation(cfg: &DispatchConfig, ticket: &Ticket) -> Result<(), String> {
    std::fs::remove_file(reservation_path(cfg, ticket)?).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }).map_err(|e| e.to_string())
}

/// Persist the exact owner/worktree BEFORE the transport may create a process.
/// An intent without a launch identity is uncertainty, never not-launched proof.
pub(super) fn arm_launch(cfg: &DispatchConfig, task: &str, generation: u64, attempt_id: &str, worktree: Option<PathBuf>, cancel: Option<Arc<AtomicBool>>) -> Result<crate::transport::RunControl, String> {
    let record = Record { owner: Ownership::Attempt { ticket: Ticket { task_id: task.into(), session: claim_session(cfg, task) }, host: cfg.label.clone().ok_or("gateway host missing")?, generation, attempt_id: attempt_id.into() },
        host: cfg.label.clone().unwrap(), url: cfg.url.trim_end_matches('/').into(), observed_at: now_ms(), disposition: Disposition::Pending,
        process: None, work: Work::UnknownWriter { reason: "Launch intent persisted; process/result proof must be reconciled".into() } };
    let launch_root = root(cfg)?.join("launches");
    // Worktree location is retained alongside intent even if transport never
    // returns. The writer/result record replaces this only after physical proof.
    let intent = Launch { record, worktree };
    journal::write_file(&launch_root.join(intent.record.name()), &serde_json::to_vec(&intent).map_err(|e| e.to_string())?)?;
    Ok(crate::transport::RunControl::with_cancel(cancel).observe_launch(move |process| {
        let mut launched = intent.clone(); launched.record.process = Some(process);
        journal::write_file(&launch_root.join(launched.record.name()), &serde_json::to_vec(&launched).map_err(|e| e.to_string())?)
    }))
}
#[derive(Clone, Serialize, Deserialize)]
struct Launch { record: Record, worktree: Option<PathBuf> }
pub(super) fn launch_record(cfg: &DispatchConfig, owner: &Record) -> Option<Record> {
    std::fs::read(root(cfg).ok()?.join("launches").join(owner.name())).ok().and_then(|b| serde_json::from_slice::<Launch>(&b).ok()).map(|l| l.record)
}
fn remove_launch(cfg: &DispatchConfig, record: &Record) -> Result<(), String> {
    std::fs::remove_file(root(cfg)?.join("launches").join(record.name())).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }).map_err(|e| e.to_string())
}

pub(super) fn capture(cfg: &DispatchConfig, task: &str, runtime: &ExecutionRuntime, result: &opencode::RunOutcome, worktree: Option<PathBuf>) -> Result<Record, String> {
    journal::insert(&terminal_root(cfg)?, record(cfg, task, runtime, result, worktree)?)
}
fn record(cfg: &DispatchConfig, task: &str, runtime: &ExecutionRuntime, result: &opencode::RunOutcome, worktree: Option<PathBuf>) -> Result<Record, String> {
    let owner = Ownership::Attempt { ticket: Ticket { task_id: task.into(), session: claim_session(cfg, task) },
        host: cfg.label.clone().ok_or("gateway host missing")?, generation: runtime.generation, attempt_id: runtime.attempt_id.clone() };
    let outcome = Outcome { kind: if runtime.control.stop.load(Ordering::SeqCst) { OutcomeKind::Interrupted } else if result.timed_out { OutcomeKind::TimedOut } else if result.ok && !void_run(&result.stdout_tail, &result.stderr_tail) { OutcomeKind::Completed } else { OutcomeKind::Failed },
        exit_code: result.exit_code, stdout_tail: result.stdout_tail.clone(), stderr_tail: result.stderr_tail.clone() };
    let work = if let Some(writers) = runtime.control.writer_state().and_then(WriterProof::observed) {
        Work::Stopped { outcome, writers, worktree, step: Step::Stop }
    } else { Work::Unproven { outcome, worktree } };
    Ok(Record { host: cfg.label.clone().unwrap(), url: cfg.url.trim_end_matches('/').into(), owner,
        observed_at: now_ms(), work, disposition: Disposition::Pending, process: runtime.control.identity() })
}

fn prepare(shared: &Config, snap: &SharedSnapshot, input: Input, cancel: Arc<AtomicBool>) -> Prepared<InFlight, FinalWork> {
    let cfg = config(shared);
    let ticket = input.ticket;
    let owner = Ownership::Reservation { ticket: ticket.clone() };
    remember_claim_session(&cfg, &ticket.task_id, &ticket.session);
    let result = (|| -> Result<Option<InFlight>, String> {
        if cancel.load(Ordering::SeqCst) { return Ok(None); }
        let task = match input.task {
            Some(task) => task,
            None => serde_json::from_value(mcp_call(&cfg, &mut 0, "get_artefact", json!({"id":ticket.task_id}))?).map_err(|e| format!("reserved task contract drift: {e}"))?,
        };
        if task.id != ticket.task_id || task.meta["session"] != ticket.session { return Err("gate: reserved task/session changed before preparation".into()); }
        let proof = {
            let data = shared.lock().expect("gateway readiness poisoned");
            match &data.state {
                GatewayReadinessState::Ready(proof) if proof.observed.elapsed() < Duration::from_secs(60) => proof.clone(),
                _ => return Err("gateway readiness no longer fresh; retain and reconcile reservation".into()),
            }
        };
        let available = available_backends(&cfg);
        let mut meta = task.meta;
        meta["execution_project"] = json!(task.project);
        let role_work = task.roles.iter().any(|r| matches!(r.as_str(), "review" | "analysis" | "unblock"));
        let mut prepared = Vec::new();
        let mut observed = proof.observed;
        spawn_opencode(&cfg, snap, &ticket.task_id, &task.title, &task.body_md, &meta,
            "Begin by orienting in Bridge with your provided executor session. Follow its live instructions. The hub alone owns eligibility, lifecycle and model policy; reconcile any captured prior result before repeating effects.",
            None, role_work, "task", &available, &mut prepared, &proof.worker, &mut observed, Some(cancel)) ;
        Ok(prepared.pop())
    })();
    match result {
        Ok(Some(running)) => Prepared::Running { owner: Ownership::Attempt { ticket, host: cfg.label.clone().unwrap_or_default(),
            generation: running.execution.generation, attempt_id: running.execution.attempt_id.clone() }, value: running },
        result => {
            let reason = result.err().unwrap_or_else(|| "Preparation returned before an agent writer launched".into());
            // A begun-but-unlaunched attempt uses the very same terminal path.
            if let Ok(state) = execution_request(&cfg, &ticket.task_id, &ticket.session, &format!("prepare-inspect-{}", now_ms()), json!({"kind":"inspect"})) {
                let a = &state["attempt"];
                if a["session"] == ticket.session && a["host"].as_str() == cfg.label.as_deref() {
                    if let (Some(generation), Some(attempt_id)) = (a["generation"].as_u64(), a["attempt_id"].as_str()) {
                        let owner = Ownership::Attempt { ticket: ticket.clone(), host: cfg.label.clone().unwrap(), generation, attempt_id: attempt_id.into() };
                        let record = Record { owner: owner.clone(), host: cfg.label.clone().unwrap(), url: cfg.url.trim_end_matches('/').into(), observed_at: now_ms(), disposition: Disposition::Pending, process: None,
                            work: Work::Stopped { outcome: Outcome { kind: OutcomeKind::Interrupted, exit_code: None, stdout_tail: String::new(), stderr_tail: reason }, writers: WriterProof::ProcessGroupEmpty, worktree: None, step: Step::Stop } };
                        return Prepared::Finalize { owner, value: FinalWork::Fresh(record) };
                    }
                }
            }
            let record = Record { owner: owner.clone(), host: cfg.label.clone().unwrap_or_default(), url: cfg.url.trim_end_matches('/').into(), observed_at: now_ms(), disposition: Disposition::Pending, process: None, work: Work::Unstarted { reason } };
            Prepared::Finalize { owner, value: FinalWork::Fresh(record) }
        },
    }
}

fn finalize_record(shared: &Config, mut record: Record, report: &Reporter, fresh: bool) -> Result<(), (Record, String)> {
    let result = (|| -> Result<(), String> {
        let cfg = config(shared);
        if cfg.url.trim_end_matches('/') != record.url || cfg.label.as_deref() != Some(record.host.as_str()) { return Err("gate: journal belongs to another originating host/hub".into()); }
        let root = terminal_root(&cfg)?;
        if !fresh && matches!(record.owner, Ownership::Attempt { .. }) {
            let ticket = record.ticket();
            let receipt = execution_request(&cfg, &ticket.task_id, &ticket.session, &record.command_id("lookup"),
                json!({"kind":"receipt","target_command_id":record.command_id("finalize")}))?;
            if receipt["kind"] == "receipt_found" {
                report.released(Released::from_hub(&record.owner, &receipt["result"])?);
                // A recovered ACK is enough to retire old local delivery, never
                // permission to touch a newer generation's worktree/HEAD.
                if root.join(record.name()).exists() {
                    if let Work::Stopped { outcome, writers, worktree, .. } = record.work.clone() { record.work = Work::Stopped { outcome, writers, worktree, step: Step::Acknowledged { reply: receipt["result"].clone() } }; journal::save(&root, &record)?; }
                    remove_launch(&cfg, &record)?;
                    worker_session::retire(&cfg, &record)?;
                    journal::remove(&root, &record)?;
                }
                remove_reservation(&cfg, record.ticket())?;
                return Ok(());
            }
        }
        if let Disposition::Rejected { reason } = &record.disposition { return Err(reason.clone()); }
        if !fresh && !root.join(record.name()).exists() {
            // A recovery scan can race a completed local delivery. Read its
            // immutable ACK; never resurrect an older checkpoint stage or
            // mutate a newly-started generation just to clean up stale memory.
            let ticket = record.ticket();
            let stage = if matches!(record.work, Work::Unstarted { .. }) { "cancel-start" } else { "finalize" };
            let receipt = execution_request(&cfg, &ticket.task_id, &ticket.session, &record.command_id("lookup"),
                json!({"kind":"receipt","target_command_id":record.command_id(stage)}))?;
            if receipt["kind"] == "receipt_found" { report.released(Released::from_hub(&record.owner, &receipt["result"])?); return Ok(()); }
            if matches!(record.work, Work::Unstarted { .. }) {
                let task = mcp_call(&cfg, &mut 0, "get_artefact", json!({"id":ticket.task_id}))?;
                report.released(Released::reservation_reconciled(&record.owner, &task)?); return Ok(());
            }
            return Err("gate: terminal journal disappeared without a matching immutable ACK; ownership retained".into());
        }
        // Persisted stage is always the source of recovery, including after a
        // lost response. Every mutating RPC uses its original deterministic ID.
        record = journal::insert(&root, record.clone())?;
        if let Work::Unproven { outcome, worktree } = record.work.clone() {
            let process = record.process.as_ref().ok_or("gate: launch identity unavailable; retain owner for original-host reconciliation")?;
            let state = crate::transport::stop_recovered(process);
            let writers = WriterProof::observed(state).ok_or_else(|| if state == crate::transport::GroupState::Live { "Exact recovered process group is still stopping; retry physical proof" } else { "gate: recovered group identity/visibility cannot prove stopped writers" }.to_string())?;
            record.work = Work::Stopped { outcome, writers, worktree, step: Step::Stop };
            journal::save(&root, &record)?;
        }
        if let Work::Stopped { outcome, writers, step, .. } = &record.work {
            if !matches!(step, Step::Acknowledged { .. }) {
                let Ownership::Attempt { generation, attempt_id, .. } = &record.owner else { return Err("gate: stopped journal has no attempt fence".into()); };
                let ticket = record.ticket();
                let bounded = bounded_outcome(outcome);
                let reply = execution_request(&cfg, &ticket.task_id, &ticket.session, &record.command_id("stopped"),
                    json!({"kind":"stopped","generation":generation,"attempt_id":attempt_id,"writers":writers,"outcome":bounded}))?;
                report.released(Released::from_hub(&record.owner, &reply)?);
            }
        }
        loop {
            match record.work.clone() {
                Work::Unproven { .. } | Work::UnknownWriter { .. } => return Err("gate: no process-group-empty proof; retain outcome and capacity for host reconciliation".into()),
                Work::Unstarted { .. } => {
                    let ticket = record.ticket().clone();
                    let task = mcp_call(&cfg, &mut 0, "get_artefact", json!({"id":ticket.task_id}))?;
                    let released = match Released::reservation_reconciled(&record.owner, &task) {
                        Ok(receipt) => receipt,
                        Err(_) => {
                            let reply = execution_request(&cfg, &ticket.task_id, &ticket.session, &record.command_id("cancel-start"),
                                json!({"kind":"cancel_start","writers":"not_launched","retained_work":true}))?;
                            if reply["kind"] == "held" { return Err(format!("gate: startup cancellation held: {}", reply["reason"])); }
                            Released::from_hub(&record.owner, &reply)?
                        },
                    };
                    report.released(released);
                    remove_reservation(&cfg, record.ticket())?;
                    journal::remove(&root, &record)?;
                    return Ok(());
                },
                Work::Stopped { outcome, writers, worktree, step } => {
                    let Ownership::Attempt { generation, attempt_id, .. } = &record.owner else { return Err("gate: stopped journal has no attempt fence".into()); };
                    let ticket = record.ticket().clone();
                    let next = match step {
                        Step::Stop => if worktree.is_some() { Step::Capture } else { Step::Finalize },
                        Step::Capture => {
                            let path = worktree.as_deref().ok_or("gate: checkpoint worktree missing")?;
                            Step::Publish { checkpoint: crate::checkpoint::capture(path, &ticket.task_id, *generation,
                                "Reconcile the captured terminal result and remaining task action; do not repeat unknown effects.", vec![std::env::consts::OS.into(), std::env::consts::ARCH.into()])? }
                        },
                        Step::Publish { checkpoint } => {
                            crate::checkpoint::publish_captured(worktree.as_deref().ok_or("gate: checkpoint worktree missing")?, &checkpoint)?;
                            Step::Register { checkpoint }
                        },
                        Step::Register { checkpoint } => {
                            execution_request(&cfg, &ticket.task_id, &ticket.session, &record.command_id("checkpoint"),
                                json!({"kind":"checkpoint","generation":generation,"attempt_id":attempt_id,"checkpoint":checkpoint}))?;
                            Step::Finalize
                        },
                        Step::Finalize => {
                            let bounded = bounded_outcome(&outcome);
                            let reply = execution_request(&cfg, &ticket.task_id, &ticket.session, &record.command_id("finalize"),
                                json!({"kind":"finalize","generation":generation,"attempt_id":attempt_id,"writers":writers,"outcome":bounded}))?;
                            let released = Released::from_hub(&record.owner, &reply)?;
                            report.released(released);
                            Step::Acknowledged { reply }
                        },
                        Step::Acknowledged { reply } => {
                            report.released(Released::from_hub(&record.owner, &reply)?);
                            if matches!(reply["task_status"].as_str(), Some("done" | "superseded")) {
                                if let Some(path) = worktree.as_ref() {
                                    if let Some(retained) = cleanup_worktree_at(path, &ticket.task_id, true) { dlog(&ticket.task_id, &retained); }
                                }
                            }
                            remove_reservation(&cfg, record.ticket())?;
                            remove_launch(&cfg, &record)?;
                            worker_session::retire(&cfg, &record)?;
                            journal::remove(&root, &record)?;
                            return Ok(());
                        },
                    };
                    record.work = Work::Stopped { outcome, writers, worktree, step: next };
                    journal::save(&root, &record)?;
                },
            }
        }
    })();
    result.map_err(|error| (record, error))
}
fn bounded_outcome(outcome: &Outcome) -> Outcome {
    Outcome { kind: outcome.kind.clone(), exit_code: outcome.exit_code, stdout_tail: tail_bytes(&outcome.stdout_tail, 16_000), stderr_tail: tail_bytes(&outcome.stderr_tail, 8_000) }
}
fn tail_bytes(text: &str, max: usize) -> String {
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) { start += 1; }
    text[start..].to_string()
}

const RESERVATION_OBSERVATION_INTERVAL: Duration = Duration::from_secs(5);
fn reservation_observable(record: &Record) -> bool {
    matches!(record.owner, Ownership::Reservation { .. }) && matches!(record.work, Work::Unstarted { .. }) && record.process.is_none()
}

fn reservation_release(cfg: &DispatchConfig, record: &Record) -> Result<Released, String> {
    if !reservation_observable(record) || record.validate().is_err()
        || record.url != cfg.url.trim_end_matches('/') || cfg.label.as_deref() != Some(record.host.as_str()) {
        return Err("gate: reservation observation lacks exact unstarted host/owner proof".into());
    }
    let task = mcp_call(cfg, &mut 0, "get_artefact", json!({"id":record.ticket().task_id}))?;
    Released::reservation_reconciled(&record.owner, &task)
}

/// Offline bootstrap for an old controller that cannot reconsider its durable
/// holds. The SAME controller flock excludes live/restarting controllers; only
/// ended, rejected, never-launched reservations are eligible. Default is a drill.
pub(super) fn reconcile_reservations(cfg: &DispatchConfig, apply: bool, task: Option<&str>) -> Result<serde_json::Value, String> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("gateway home missing")?);
    reconcile_reservations_locked(cfg, apply, task, &home.join(CONTROLLER_LOCK_FILE))
}
fn reconcile_reservations_locked(cfg: &DispatchConfig, apply: bool, task: Option<&str>, lock_path: &Path) -> Result<serde_json::Value, String> {
    let _lock = worker_session::Lock::acquire(lock_path)?.ok_or("gate: stop only the gateway controller before reconciling reservations; live controller lock is held")?;
    let terminal = terminal_root(cfg)?;
    let host = cfg.label.as_deref().ok_or("gateway host missing")?;
    let records = journal::pending(&terminal, host, cfg.url.trim_end_matches('/'))?;
    let mut eligible = Vec::new(); let mut waiting = Vec::new(); let mut protected = 0;
    for record in records {
        if task.is_some_and(|task| task != record.ticket().task_id) { continue; }
        if !reservation_observable(&record) || !matches!(record.disposition, Disposition::Rejected { .. }) { protected += 1; continue; }
        match reservation_release(cfg, &record) {
            Ok(_) => {
                if apply {
                    // Retain the original rejected record as evidence before
                    // using the normal exact-owner cleanup. No outcome is made up.
                    let archive = root(cfg)?.join("reconciled-reservations").join(record.name());
                    if !archive.exists() { journal::write_file(&archive, &serde_json::to_vec(&record).map_err(|e| e.to_string())?)?; }
                    reservation_release(cfg, &record)?; // fresh claim facts, never a cached authorization
                    remove_reservation(cfg, record.ticket())?;
                    journal::remove(&terminal, &record)?;
                }
                eligible.push(json!({"owner":record.owner,"applied":apply}));
            },
            Err(error) => waiting.push(json!({"owner":record.owner,"reason":error})),
        }
    }
    Ok(json!({"kind":"reservation_reconciliation","apply":apply,"eligible":eligible,"waiting":waiting,"protected":protected,
        "note":"Only ended rejected unstarted local reservations are reconciled. Worker/WIP/attempt/unknown-effect records are never modified."}))
}

/// A rejected unstarted reservation is not an unknown writer/effect. Observe
/// new hub-owned claim facts in the bounded finalizer pool; never repeat its
/// cancel_start or turn an old failure into permission to launch a writer.
fn observe_reservation(shared: &Config, record: Record, report: Reporter) -> Finished<FinalWork> {
    let cfg = config(shared);
    if !reservation_observable(&record) || record.validate().is_err()
        || record.url != cfg.url || cfg.label.as_deref() != Some(record.host.as_str()) {
        return Finished::Held { value: FinalWork::Journal(record), reason: "gate: reservation observation lacks exact unstarted host/owner proof".into() };
    }
    let result = (|| -> Result<(), String> {
        let released = reservation_release(&cfg, &record)?;
        // Only these exact old reservation/journal identities are retired.
        // Never touch a worktree, newer attempt, worker manifest, or hub state.
        remove_reservation(&cfg, record.ticket())?;
        journal::remove(&terminal_root(&cfg)?, &record)?;
        report.released(released);
        Ok(())
    })();
    match result {
        Ok(()) => Finished::Complete,
        Err(_) => Finished::Retry { value: FinalWork::ObserveReservation(record), after: RESERVATION_OBSERVATION_INTERVAL },
    }
}

fn finalize(shared: &Config, work: FinalWork, report: Reporter) -> Finished<FinalWork> {
    let work = match work { FinalWork::Active(record, runtime) => { runtime.stop_maintenance(); FinalWork::Fresh(record) }, other => other };
    match work {
        FinalWork::Active(_, _) => unreachable!(),
        FinalWork::ObserveReservation(record) => observe_reservation(shared, record, report),
        FinalWork::Legacy(receipt) => {
            let cfg = config(shared);
            let result = stopped_outbox_root().ok_or("legacy outbox missing".into()).and_then(|root| {
                stopped_outbox::persist(&root, &receipt).and_then(|path| stopped_outbox::deliver(&path, &receipt, now_ms(), |r| {
                    let reply = execution_request(&cfg, &r.task_id, &r.session, r.request()["command_id"].as_str().unwrap(), r.request()["command"].clone())?;
                    let owner = Ownership::Attempt { ticket: Ticket { task_id: r.task_id.clone(), session: r.session.clone() }, host: r.host.clone(), generation: r.generation, attempt_id: r.attempt_id.clone() };
                    report.released(Released::from_hub(&owner, &reply)?); Ok(())
                }))
            });
            match result { Ok(()) => Finished::Complete, Err(reason) if reason.contains("gate:") => Finished::Held { value: FinalWork::Legacy(receipt), reason }, Err(_) => Finished::Retry { value: FinalWork::Legacy(receipt), after: Duration::from_secs(5) } }
        },
        work @ (FinalWork::Fresh(_) | FinalWork::Journal(_)) => {
        let (record, fresh) = match work { FinalWork::Fresh(record) => (record, true), FinalWork::Journal(record) => (record, false), _ => unreachable!() };
        // Older builds persisted this wait as a terminal Rejected disposition.
        // Migrate only provably unstarted reservations to observation-only work;
        // all attempts, process identities and unknown effects retain their gate.
        if reservation_observable(&record) && matches!(record.disposition, Disposition::Rejected { .. }) {
            return observe_reservation(shared, record, report);
        }
        match finalize_record(shared, record, &report, fresh) {
            Ok(()) => Finished::Complete,
            Err((mut record, error)) => {
                if error.contains("gate:") || error.contains("[rule:") {
                    if reservation_observable(&record) {
                        // Keep the existing on-disk disposition readable by a
                        // rollback build; the closed runtime variant permits
                        // only observation, not replay of the rejected write.
                        record.disposition = Disposition::Rejected { reason: error.clone() };
                        if let Ok(root) = terminal_root(&config(shared)) { let _ = journal::save(&root, &record); }
                        return Finished::Retry { value: FinalWork::ObserveReservation(record), after: RESERVATION_OBSERVATION_INTERVAL };
                    }
                    record.disposition = Disposition::Rejected { reason: error.clone() };
                    if let Ok(root) = terminal_root(&config(shared)) { let _ = journal::save(&root, &record); }
                    Finished::Held { value: FinalWork::Journal(record), reason: error }
                } else {
                    dlog(&record.ticket().task_id, &format!("terminal delivery deferred; durable stage/owner retained: {error}"));
                    Finished::Retry { value: if fresh { FinalWork::Fresh(record) } else { FinalWork::Journal(record) }, after: Duration::from_secs(5) }
                }
            },
        } },
    }
}

fn reserve(shared: &Config, id: &str) -> Result<AdmissionReply, String> {
    let cfg = config(shared); let root = root(&cfg)?;
    journal::write_file(&root.join("admission.json"), &serde_json::to_vec(id).map_err(|e| e.to_string())?)?;
    let reply = execution_request(&cfg, "gateway", &cfg.session_name(), id, json!({"kind":"schedule","mode":"reserve"}))?;
    let reply: AdmissionReply = serde_json::from_value(reply).map_err(|e| format!("gate: scheduler protocol drift: {e}"))?;
    if let AdmissionReply::Reserved { task_id, session, task } = &reply {
        let input = Input { ticket: Ticket { task_id: task_id.clone(), session: session.clone() }, task: task.clone() };
        journal::write_file(&reservation_path(&cfg, &input.ticket)?, &serde_json::to_vec(&input).map_err(|e| e.to_string())?)?;
    }
    if !matches!(reply, AdmissionReply::ReservationPending { .. }) {
        std::fs::remove_file(root.join("admission.json")).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }).map_err(|e| e.to_string())?;
    }
    Ok(reply)
}

fn recover(shared: &Config, skip: Vec<Ticket>) -> Result<Vec<Recovered>, String> {
    let cfg = config(shared); let mut recovered = Vec::new();
    let root = root(&cfg)?; let host = cfg.label.as_deref().ok_or("gateway host missing")?;
    let mut known: std::collections::BTreeSet<Ticket> = skip.into_iter().collect();
    for record in journal::pending(&root.join("terminal"), host, cfg.url.trim_end_matches('/'))? {
        if known.insert(record.ticket().clone()) { recovered.push(Recovered::Final(record.owner.clone(), FinalWork::Journal(record))); }
    }
    for running in worker_session::discover(&cfg, &known.iter().cloned().collect::<Vec<_>>())? {
        let ticket = running.worker.as_ref().expect("discovery returns supervised workers").owner.ticket().clone();
        // The persisted worker manifest, not a new claim, mutable task cache or
        // conversation ID, supplies the original session/fence.
        known.insert(ticket); recovered.push(Recovered::Running(running));
    }
    if let Ok(entries) = std::fs::read_dir(root.join("launches")) {
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            let launch: Launch = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| format!("gate: launch journal unreadable: {e}"))?;
            let mut record = launch.record; record.validate()?;
            if record.host != host || record.url != cfg.url { return Err("gate: launch journal belongs to another originating host/hub".into()); }
            if !known.insert(record.ticket().clone()) { continue; }
            let ticket = record.ticket();
            let state = execution_request(&cfg, &ticket.task_id, &ticket.session, &format!("recover-launch-{}", now_ms()), json!({"kind":"inspect"}))?;
            let Ownership::Attempt { generation, attempt_id, .. } = &record.owner else { return Err("gate: launch intent has no attempt fence".into()); };
            record.work = if state["terminal"]["generation"] == *generation && state["terminal"]["attempt_id"] == *attempt_id {
                Work::Stopped { outcome: serde_json::from_value(state["terminal"]["outcome"].clone()).map_err(|e| format!("gate: recovered terminal outcome drift: {e}"))?,
                    writers: serde_json::from_value(state["terminal"]["writers"].clone()).map_err(|e| format!("gate: recovered writer proof drift: {e}"))?, worktree: launch.worktree, step: Step::Stop }
            } else {
                Work::Unproven { outcome: Outcome { kind: OutcomeKind::ResultUnavailable, exit_code: None, stdout_tail: String::new(), stderr_tail: "Daemon restarted before capturing the transport result; inspect existing receipts and preserved work before continuing".into() }, worktree: launch.worktree }
            };
            let record = journal::insert(&root.join("terminal"), record)?;
            recovered.push(Recovered::Final(record.owner.clone(), FinalWork::Journal(record)));
        }
    }
    if let Ok(entries) = std::fs::read_dir(root.join("reservations")) {
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            let input: Input = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| format!("gate: reservation journal unreadable; preserve ownership: {e}"))?;
            if !known.insert(input.ticket.clone()) { continue; }
            let state = execution_request(&cfg, &input.ticket.task_id, &input.ticket.session, &format!("recover-inspect-{}", now_ms()), json!({"kind":"inspect"}))?;
            let a = &state["attempt"];
            let record = if a["session"] == input.ticket.session && a["phase"] != "quiesced" && !a.is_null() {
                let generation = a["generation"].as_u64().ok_or("gate: recovered attempt generation missing")?;
                let attempt_id = a["attempt_id"].as_str().ok_or("gate: recovered attempt id missing")?;
                Record { owner: Ownership::Attempt { ticket: input.ticket, host: host.into(), generation, attempt_id: attempt_id.into() }, host: host.into(), url: cfg.url.clone(), observed_at: now_ms(), disposition: Disposition::Pending, process: None,
                    work: Work::UnknownWriter { reason: "Daemon restarted without a terminal process-group-empty receipt; retain writer ownership for kernel reconciliation".into() } }
            } else {
                Record { owner: Ownership::Reservation { ticket: input.ticket }, host: host.into(), url: cfg.url.clone(), observed_at: now_ms(), disposition: Disposition::Pending, process: None,
                    work: Work::Unstarted { reason: "Recovered a persisted reservation with no active owned attempt; reconcile before scheduling".into() } }
            };
            let record = journal::insert(&root.join("terminal"), record)?;
            recovered.push(Recovered::Final(record.owner.clone(), FinalWork::Journal(record)));
        }
    }
    if let Some(legacy) = stopped_outbox_root() {
        if let Ok(entries) = std::fs::read_dir(legacy) { for entry in entries.flatten() {
            if let Ok(bytes) = std::fs::read(entry.path()) { if let Ok(receipt) = serde_json::from_slice::<stopped_outbox::StoppedReceipt>(&bytes) {
                let ticket = Ticket { task_id: receipt.task_id.clone(), session: receipt.session.clone() };
                if receipt.ready_for_replay(now_ms()) && receipt.host == host && receipt.url == cfg.url && known.insert(ticket.clone()) {
                    let owner = Ownership::Attempt { ticket, host: host.into(), generation: receipt.generation, attempt_id: receipt.attempt_id.clone() };
                    recovered.push(Recovered::Final(owner, FinalWork::Legacy(receipt)));
                }
            } }
        } }
    }
    Ok(recovered)
}

pub(super) struct Controller { registry: Registry, admission: Admission, shared: Config, recovery: Recovery, last_snapshot: Instant,
    capacity_probe: Option<lifecycle::Job<Result<serde_json::Value, String>>>, next_capacity_probe: Instant,
    hygiene: Option<lifecycle::Job<()>>, next_hygiene: Instant }
impl Controller {
    pub fn new(cfg: &DispatchConfig, readiness: &GatewayReadiness, snap: &SharedSnapshot) -> Self {
        let shared = readiness.data.clone(); let preparing = shared.clone(); let finalizing = shared.clone(); let snap = snap.clone();
        let registry = Pipeline::new(cfg.max_sessions.max(1), cfg.max_sessions.clamp(1, 4), cfg.max_sessions.clamp(1, 4),
            move |input, cancel| prepare(&preparing, &snap, input, cancel), move |work, report| finalize(&finalizing, work, report));
        let admission = match root(cfg).and_then(|root| match std::fs::read(root.join("admission.json")) {
            Ok(bytes) => serde_json::from_slice::<String>(&bytes).map(Some).map_err(|e| format!("gate: admission journal corrupt; preserve unknown reservation: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }) {
            Ok(Some(id)) => Admission::Request { id },
            Ok(None) => Admission::Idle { until: Instant::now() },
            Err(reason) => Admission::Held { reason },
        };
        Self { registry, admission, shared, recovery: Recovery::Initial, last_snapshot: Instant::now(), capacity_probe: None, next_capacity_probe: Instant::now(), hygiene: None, next_hygiene: Instant::now() + Duration::from_secs(300) }
    }
    pub fn idle(&self) -> bool { self.registry.is_idle() && self.capacity_probe.is_none() && self.hygiene.is_none() && matches!(self.admission, Admission::Idle { .. }) && matches!(self.recovery, Recovery::Ready { .. }) }
    pub fn active(&self) -> usize { usize::from(!self.idle()) }
    pub fn controller_ready(&self) -> bool {
        self.capacity_probe.is_none() && self.hygiene.is_none() && matches!(self.admission, Admission::Idle { .. }) && matches!(self.recovery, Recovery::Ready { .. })
            && self.registry.handoff_ready(|running| running.worker.as_ref().is_some_and(|worker| !worker.stop.load(Ordering::SeqCst) && worker.reattachable.load(Ordering::SeqCst)))
    }
    pub fn tick(&mut self, snap: &SharedSnapshot, stop: bool, update: bool) -> Result<(), String> {
        if stop { self.registry.drain(); } else if update { self.registry.natural_drain(); } else { self.registry.resume_admission(); }
        self.registry.visit_running(|_, running, stopping| { if stopping {
            if let Some(worker) = &running.worker { worker.stop.store(true, Ordering::SeqCst); }
            else { running.execution.control.stop.store(true, Ordering::SeqCst); }
        } });
        let shared = self.shared.clone();
        self.registry.poll(|running| {
            if let Some(worker) = &running.worker { return worker.rx.try_recv().ok().map(FinalWork::Journal); }
            match running.rx.try_recv() {
            Ok(outcome) => {
                match record(&config(&shared), &running.task_id, &running.execution, &outcome, running.worktree.clone()) {
                    Ok(record) => Some(FinalWork::Active(record, running.execution.clone())),
                    Err(error) => { dlog(&running.task_id, &format!("terminal journal unavailable; retain running owner: {error}")); None },
                }
            },
            Err(TryRecvError::Disconnected) => {
                let outcome = opencode::RunOutcome { ok: false, stdout_tail: String::new(), stderr_tail: "transport result channel disconnected; proof required".into(), exit_code: None, timed_out: false, session_id: None };
                record(&config(&shared), &running.task_id, &running.execution, &outcome, running.worktree.clone()).ok().map(|r| FinalWork::Active(r, running.execution.clone()))
            },
            Err(TryRecvError::Empty) => None,
        } });
        let cfg = config(&self.shared);
        let recovery = std::mem::replace(&mut self.recovery, Recovery::Initial);
        self.recovery = match recovery {
            Recovery::Initial => { let shared = self.shared.clone(); let skip = self.registry.tickets();
                Recovery::Loading { job: lifecycle::Job::start(move || recover(&shared, skip)), initial: true } },
            Recovery::Ready { next } if next <= Instant::now() && self.hygiene.is_none() => { let shared = self.shared.clone(); let skip = self.registry.tickets();
                Recovery::Loading { job: lifecycle::Job::start(move || recover(&shared, skip)), initial: false } },
            Recovery::Retry { next, initial } if next <= Instant::now() => { let shared = self.shared.clone(); let skip = self.registry.tickets();
                Recovery::Loading { job: lifecycle::Job::start(move || recover(&shared, skip)), initial } },
            Recovery::Loading { mut job, initial } => match job.poll() {
                None => Recovery::Loading { job, initial },
                Some(Ok(Ok(records))) => {
                    for record in records { match record {
                        Recovered::Running(running) => {
                            let owner = running.worker.as_ref().expect("recovered running worker has an immutable owner").owner.clone();
                            if !self.registry.contains(owner.ticket()) { let _ = self.registry.restore_running(owner, running); }
                        },
                        Recovered::Final(owner, work) => if !self.registry.contains(owner.ticket()) { let _ = self.registry.restore_finalization(owner, work); },
                    } }
                    Recovery::Ready { next: Instant::now() + Duration::from_secs(30) }
                },
                Some(Ok(Err(reason))) | Some(Err(reason)) => {
                    if reason.contains("gate:") { Recovery::Held { reason } }
                    else { Recovery::Retry { next: Instant::now() + Duration::from_secs(5), initial } }
                },
            },
            other => other,
        };
        let recovered = matches!(self.recovery, Recovery::Ready { .. } | Recovery::Loading { initial: false, .. } | Recovery::Retry { initial: false, .. });
        let locally_ready = self.shared.lock().map(|d| matches!(&d.state, GatewayReadinessState::Ready(p) if p.observed.elapsed() < Duration::from_secs(60))).unwrap_or(false);
        if let Some(job) = &mut self.hygiene {
            if job.poll().is_some() { self.hygiene = None; self.next_hygiene = Instant::now() + Duration::from_secs(300); }
        }
        // Hygiene owns an idle local workspace barrier. Never sweep a tree
        // concurrently with preparation, capture, running or delivery.
        if !stop && !update && self.next_hygiene <= Instant::now() && self.idle() {
            let cfg = cfg.clone();
            self.hygiene = Some(lifecycle::Job::start(move || { let mut messages = Vec::new(); sweep_stale_worktrees(&cfg, &mut 0, &[], &mut messages); for message in messages { dlog("hygiene", &message); } }));
        }
        if let Some(job) = &mut self.capacity_probe {
            if let Some(result) = job.poll() {
                if let Err(error) | Ok(Err(error)) = result { dlog("gateway", &format!("priority-capacity request deferred: {error}")); }
                self.capacity_probe = None; self.next_capacity_probe = Instant::now() + Duration::from_secs(5);
            }
        }
        // Full fleets must still ask the hub to arrange safe recovery
        // preemption. This is bounded control work, never a local priority queue.
        if recovered && locally_ready && !stop && !update && !self.registry.can_admit() && self.capacity_probe.is_none() && self.next_capacity_probe <= Instant::now() {
            let cfg = cfg.clone();
            self.capacity_probe = Some(lifecycle::Job::start(move || execution_call(&cfg, "gateway", json!({"kind":"schedule","mode":"request_capacity"}))));
        }
        let admission = std::mem::replace(&mut self.admission, Admission::Held { reason: "admission transition".into() });
        self.admission = match admission {
            Admission::Idle { until } if recovered && locally_ready && self.hygiene.is_none() && !stop && !update && self.registry.can_admit() && until <= Instant::now() => {
                let id = format!("pipeline-reserve-{}-{}", std::process::id(), now_ms());
                Admission::Request { id }
            },
            Admission::Retry { id, until } if until > Instant::now() => Admission::Retry { id, until },
            pending @ (Admission::Request { .. } | Admission::Retry { .. }) if !recovered => pending,
            Admission::Request { id } | Admission::Retry { id, .. } => {
                let current = self.shared.clone(); let command_id = id.clone();
                Admission::Waiting { id, job: lifecycle::Job::start(move || reserve(&current, &command_id)) }
            },
            Admission::Waiting { id, mut job } => match job.poll() {
                None => Admission::Waiting { id, job },
                Some(Ok(Ok(AdmissionReply::Reserved { task_id, session, task }))) => Admission::Assigned(Input { ticket: Ticket { task_id, session }, task }),
                Some(Ok(Ok(AdmissionReply::ReservationPending { .. }))) => Admission::Retry { id, until: Instant::now() + Duration::from_secs(1) },
                Some(Ok(Ok(other))) => {
                    if let AdmissionReply::GatewayNotReady { reason } = other { dlog("gateway", &reason); }
                    Admission::Idle { until: Instant::now() + Duration::from_secs(cfg.poll_secs.min(5)) }
                },
                Some(Ok(Err(error))) | Some(Err(error)) => {
                    dlog("gateway", &format!("admission result unknown; retry SAME command identity: {error}"));
                    if error.contains("gate:") || error.contains("[rule:") { Admission::Held { reason: error } }
                    else { Admission::Retry { id, until: Instant::now() + Duration::from_secs(2) } }
                },
            },
            Admission::Assigned(input) => {
                if !recovered { Admission::Assigned(input) }
                else if stop || update {
                    let record = Record { owner: Ownership::Reservation { ticket: input.ticket.clone() }, host: cfg.label.clone().unwrap_or_default(), url: cfg.url.clone(), observed_at: now_ms(), disposition: Disposition::Pending, process: None, work: Work::Unstarted { reason: "Admission completed during runtime drain".into() } };
                    let _ = self.registry.restore_finalization(record.owner.clone(), FinalWork::Fresh(record));
                    Admission::Idle { until: Instant::now() }
                } else if self.registry.contains(&input.ticket) || self.registry.admit(input.ticket.clone(), input.clone()).is_ok() {
                    Admission::Idle { until: Instant::now() }
                } else { Admission::Assigned(input) }
            },
            other => other,
        };
        if self.last_snapshot.elapsed() >= Duration::from_secs(1) {
            let counts = self.registry.counts();
            let mut flights = Vec::new();
            self.registry.visit_running(|_, r, _| flights.push(InFlightView { task_id: r.task_id.clone(), task_title: r.task_title.clone(), started_ms: now_ms().saturating_sub(r.started.elapsed().as_millis() as u64), last_note: r.live_line() }));
            if let Ok(mut snapshot) = snap.lock() { snapshot.in_flight = flights; snapshot.lifecycle = Some(counts); }
            for (ticket, reason) in self.registry.held() { dlog(&ticket.task_id, &format!("lifecycle held with durable ownership: {reason}")); }
            if let Admission::Held { reason } = &self.admission { dlog("gateway", reason); }
            if let Recovery::Held { reason } = &self.recovery { dlog("gateway", reason); }
            self.last_snapshot = Instant::now();
        }
        Ok(())
    }
}

pub(super) fn run(cfg: DispatchConfig, stop: Arc<AtomicBool>, running: Arc<AtomicBool>, last_error: Arc<Mutex<Option<String>>>, snap: SharedSnapshot) -> Result<(), String> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("gateway home missing")?);
    std::fs::create_dir_all(home.join(".bridge")).map_err(|e| e.to_string())?;
    let lock = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(home.join(CONTROLLER_LOCK_FILE)).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("another gateway lifecycle controller already holds the local writer lock".into());
        }
    }
    if let Some(pid) = external_runner_pid() { return Err(format!("legacy gateway PID {pid} still exists; preserve its writers before adopting the lifecycle controller")); }
    running.store(true, Ordering::SeqCst);
    if let Ok(mut s) = snap.lock() {
        s.running = true; s.url = Some(cfg.url.clone()); s.workspace = cfg.ws.clone(); s.label = cfg.label.clone();
        s.agent = cfg.agent.clone(); s.workdir = Some(cfg.workdir.clone()); s.max_sessions = cfg.max_sessions; s.in_flight.clear();
    }
    let readiness = GatewayReadiness::start(&cfg);
    let mut controller = (cfg.role.as_deref() != Some("train")).then(|| Controller::new(&cfg, &readiness, &snap));
    let mut train_stop = Arc::new(AtomicBool::new(update_request().is_some()));
    let mut train = if update_request().is_none() { crate::train::spawn_daemon_leg(&cfg.url, &cfg.token, cfg.label.as_deref(), train_stop.clone()) } else { None };
    // One coalescing observability writer. Task-phase workers never overwrite
    // runner.json with a one-task approximation of the actual registry.
    let published = snap.clone();
    let publisher = LeaseMaintenance::start(Duration::from_secs(1), move || { write_runner_state(&published); true });
    let mut last_update_receipt = Instant::now() - Duration::from_secs(1);
    dlog("gateway", &format!("bounded lifecycle controller started: {} execution slots; preparation/finalization <=4 each", cfg.max_sessions));
    loop {
        let request = update_request();
        if let Some(controller) = &mut controller {
            if let Err(error) = controller.tick(&snap, stop.load(Ordering::SeqCst), request.is_some()) {
                dlog("gateway", &error);
                if let Ok(mut last) = last_error.lock() { *last = Some(error); }
            }
        }
        let active = controller.as_ref().map(Controller::active).unwrap_or(0);
        if let Some(request) = request {
            if last_update_receipt.elapsed() >= Duration::from_secs(1) {
            let adopting = request["worker_protocol"] == worker_session::PROTOCOL;
            let restart_ready = adopting && controller.as_ref().map(Controller::controller_ready).unwrap_or(true);
            if matches!(update_train_barrier(if restart_ready { 0 } else { active }, &train_stop, &mut train)?, UpdateTrainBarrier::Quiescent) {
                if restart_ready {
                    update_receipt("idle.json", &json!({"nonce":request["nonce"],"pid":std::process::id(),"phase":"controller_ready","worker_protocol":worker_session::PROTOCOL}));
                } else {
                    update_receipt("idle.json", &json!({"nonce":request["nonce"],"pid":std::process::id(),"phase":"idle"}));
                }
            }
            if readiness.data.lock().map(|d| match &d.state { GatewayReadinessState::Ready(p) => p.observed.elapsed() < Duration::from_secs(60), GatewayReadinessState::Connected { observed } => observed.elapsed() < Duration::from_secs(60), _ => false }).unwrap_or(false) {
                update_receipt("health.json", &json!({"pid":std::process::id(),"commit":option_env!("BRIDGE_BUILD_COMMIT").unwrap_or("unknown"),"observed_at":now_ms(),"phase":"ready"}));
            }
            last_update_receipt = Instant::now();
            }
        } else if train_stop.load(Ordering::SeqCst) && !stop.load(Ordering::SeqCst) {
            train_stop = Arc::new(AtomicBool::new(false));
            let current = config(&readiness.data);
            train = crate::train::spawn_daemon_leg(&current.url, &current.token, current.label.as_deref(), train_stop.clone());
        }
        if stop.load(Ordering::SeqCst) && active == 0 { break; }
        std::thread::sleep(Duration::from_millis(25));
    }
    train_stop.store(true, Ordering::SeqCst);
    if let Some(train) = train { let _ = train.join(); }
    publisher.stop();
    if let Ok(mut s) = snap.lock() { s.running = false; s.in_flight.clear(); }
    write_runner_state(&snap);
    drop(lock);
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{BufRead, Read, Write};
    use std::net::{TcpListener, TcpStream};
    pub(crate) struct Hub { url: String, stop: Arc<AtomicBool>, thread: Option<std::thread::JoinHandle<()>> }
    impl Hub {
        pub(crate) fn new(mut answer: impl FnMut(serde_json::Value) -> Option<serde_json::Value> + Send + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let stop = Arc::new(AtomicBool::new(false)); let stopped = stop.clone();
            let thread = std::thread::spawn(move || while !stopped.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else { std::thread::sleep(Duration::from_millis(1)); continue; };
                // BSD may inherit O_NONBLOCK from the listener. Partial HTTP
                // reads then looked like lost ACKs; make the fixture explicit.
                stream.set_nonblocking(false).unwrap();
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut length = 0;
                loop { let mut line = String::new(); if reader.read_line(&mut line).is_err() || line == "\r\n" || line.is_empty() { break; }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") { length = value.trim().parse().unwrap(); }
                }
                let mut body = vec![0; length]; if reader.read_exact(&mut body).is_err() { continue; }
                if body.is_empty() { continue; }
                let request = serde_json::from_slice(&body).unwrap();
                if let Some(value) = answer(request) {
                    let body = json!({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":serde_json::to_string(&value).unwrap()}]}}).to_string();
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                    let _ = stream.write_all(response.as_bytes());
                } else {
                    // The remote effect committed, but the proxy lost its ACK.
                    // A typed 503 avoids incidental TCP-RST timing in this test.
                    let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
            });
            Self { url, stop, thread: Some(thread) }
        }
    }
    impl Drop for Hub { fn drop(&mut self) { self.stop.store(true, Ordering::SeqCst); let _ = TcpStream::connect(self.url.trim_start_matches("http://")); if let Some(t) = self.thread.take() { let result = t.join(); if !std::thread::panicking() { result.unwrap(); } } } }
    pub(crate) fn fixture(hub: &Hub) -> (DispatchConfig, GatewayReadiness, SharedSnapshot) {
        let cfg: DispatchConfig = serde_json::from_value(json!({"url":hub.url,"token":"fixture-only","label":format!("pipeline-fixture-{}-{}",std::process::id(),hub.url.rsplit(':').next().unwrap()),"max_sessions":20})).unwrap();
        let label = format!("{}/worker", cfg.label.as_ref().unwrap());
        let ready = GatewayReadiness::with_probe(&cfg, Duration::from_secs(3600), move |_| Ok(WorkerCredential { label: label.clone(), secret: "fixture-only".into() }));
        (cfg, ready, Arc::new(Mutex::new(DispatchSnapshot::default())))
    }
    #[test]
    fn actual_controller_keeps_polling_while_admission_rpc_is_blocked() {
        let entered = Arc::new(AtomicBool::new(false)); let seen = entered.clone();
        let release = Arc::new(AtomicBool::new(false)); let released = release.clone();
        let hub = Hub::new(move |_| { seen.store(true, Ordering::SeqCst); let until = Instant::now() + Duration::from_secs(3);
            while !released.load(Ordering::SeqCst) && Instant::now() < until { std::thread::sleep(Duration::from_millis(1)); }
            Some(json!({"kind":"no_eligible_work"})) });
        let (cfg, ready, snap) = fixture(&hub);
        let mut controller = Controller::new(&cfg, &ready, &snap);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !entered.load(Ordering::SeqCst) { controller.tick(&snap, false, false).unwrap(); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(1)); }
        for _ in 0..30 {
            let start = Instant::now(); controller.tick(&snap, false, false).unwrap();
            assert!(start.elapsed() < Duration::from_millis(200), "controller blocked on admission I/O");
        }
        release.store(true, Ordering::SeqCst);
        while !controller.idle() { controller.tick(&snap, true, false).unwrap(); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(1)); }
        drop(controller); let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }
    #[test]
    fn offline_reservation_recovery_is_controller_fenced_read_only_by_default_and_exact() {
        let hub=Hub::new(|request| {
            assert_eq!(request["params"]["name"],"get_artefact","offline repair cannot replay a hub mutation");
            let id=request["params"]["arguments"]["id"].as_str().unwrap();
            assert!(matches!(id,"ended"|"owned"),"unknown writer/effect records must not enter reservation recovery");
            Some(json!({"id":id,"status":if id=="ended" {"blocked"} else {"in_progress"},"meta":{"session":"original"}}))
        });
        let (cfg,ready,_)=fixture(&hub);
        let record=|id:&str| Record { owner:Ownership::Reservation {ticket:Ticket {task_id:id.into(),session:"original".into()}},host:cfg.label.clone().unwrap(),url:cfg.url.clone(),observed_at:1,process:None,
            disposition:Disposition::Rejected {reason:"gate: historical cancellation held".into()},work:Work::Unstarted {reason:"never launched".into()} };
        let ended=record("ended");let owned=record("owned");
        let unknown=Record {owner:Ownership::Attempt {ticket:Ticket {task_id:"unknown".into(),session:"original".into()},host:cfg.label.clone().unwrap(),generation:1,attempt_id:"one".into()},
            work:Work::UnknownWriter {reason:"unknown effect".into()},..record("unknown")};
        let terminal=terminal_root(&cfg).unwrap();
        for record in [&ended,&owned,&unknown] {journal::insert(&terminal,record.clone()).unwrap();}
        let original=std::fs::read(terminal.join(ended.name())).unwrap();
        let unknown_bytes=std::fs::read(terminal.join(unknown.name())).unwrap();
        let newer=reservation_path(&cfg,&Ticket {task_id:"ended".into(),session:"new-owner".into()}).unwrap();
        journal::write_file(&newer,b"new owner data").unwrap();
        let lock_path=root(&cfg).unwrap().join("controller-test.lock");
        let lock=worker_session::Lock::acquire(&lock_path).unwrap().unwrap();
        assert!(reconcile_reservations_locked(&cfg,true,None,&lock_path).unwrap_err().contains("live controller lock is held"));
        drop(lock);
        let dry=reconcile_reservations_locked(&cfg,false,None,&lock_path).unwrap();
        assert_eq!(dry["eligible"].as_array().unwrap().len(),1);assert_eq!(dry["waiting"].as_array().unwrap().len(),1);assert_eq!(dry["protected"],1);
        assert_eq!(std::fs::read(terminal.join(ended.name())).unwrap(),original);
        let applied=reconcile_reservations_locked(&cfg,true,None,&lock_path).unwrap();
        assert_eq!(applied["eligible"][0]["applied"],true);
        assert!(!terminal.join(ended.name()).exists());assert!(terminal.join(owned.name()).exists());
        assert_eq!(std::fs::read(terminal.join(unknown.name())).unwrap(),unknown_bytes);
        assert_eq!(std::fs::read(root(&cfg).unwrap().join("reconciled-reservations").join(ended.name())).unwrap(),original);
        assert_eq!(std::fs::read(newer).unwrap(),b"new owner data");
        drop(ready);let _=std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    #[test]
    fn offline_reservation_recovery_rechecks_claim_after_archiving() {
        let reads=Arc::new(std::sync::atomic::AtomicUsize::new(0));let seen=reads.clone();
        let hub=Hub::new(move |request| {
            assert_eq!(request["params"]["name"],"get_artefact");
            let first=seen.fetch_add(1,Ordering::SeqCst)==0;
            Some(json!({"id":"changed","status":if first {"blocked"} else {"in_progress"},"meta":{"session":"original"}}))
        });
        let (cfg,ready,_)=fixture(&hub);
        let record=Record {owner:Ownership::Reservation {ticket:Ticket {task_id:"changed".into(),session:"original".into()}},host:cfg.label.clone().unwrap(),url:cfg.url.clone(),observed_at:1,process:None,
            disposition:Disposition::Rejected {reason:"gate: held".into()},work:Work::Unstarted {reason:"no writer".into()}};
        let path=journal::insert(&terminal_root(&cfg).unwrap(),record.clone()).unwrap();
        let before=std::fs::read(terminal_root(&cfg).unwrap().join(path.name())).unwrap();
        let result=reconcile_reservations_locked(&cfg,true,None,&root(&cfg).unwrap().join("controller-test.lock"));
        assert!(result.unwrap_err().contains("reservation still belongs"));
        assert_eq!(reads.load(Ordering::SeqCst),2);
        assert_eq!(std::fs::read(terminal_root(&cfg).unwrap().join(record.name())).unwrap(),before);
        drop(ready);let _=std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    #[test]
    fn held_unstarted_reservation_observes_release_without_replaying_cancel() {
        let released = Arc::new(AtomicBool::new(false)); let observed = released.clone();
        let cancels = Arc::new(std::sync::atomic::AtomicUsize::new(0)); let attempts = cancels.clone();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0)); let observations = reads.clone();
        let hub = Hub::new(move |request| {
            if request["params"]["name"] == "get_artefact" {
                observations.fetch_add(1, Ordering::SeqCst);
                return Some(json!({"id":"held-reservation","status":if observed.load(Ordering::SeqCst) { "blocked" } else { "in_progress" },"meta":{"session":"original-session"}}));
            }
            let args = &request["params"]["arguments"];
            assert_eq!(args["command"]["kind"], "cancel_start", "observation cannot begin/stop/finalize a writer or repeat other effects");
            attempts.fetch_add(1, Ordering::SeqCst);
            Some(json!({"kind":"held","reason":"existing writer must be reconciled"}))
        });
        let (cfg, ready, snap) = fixture(&hub);
        let ticket = Ticket { task_id:"held-reservation".into(),session:"original-session".into() };
        let record = Record { owner:Ownership::Reservation { ticket:ticket.clone() },url:cfg.url.clone(),host:cfg.label.clone().unwrap(),observed_at:1,
            disposition:Disposition::Pending,process:None,work:Work::Unstarted { reason:"prepare did not launch".into() } };
        journal::insert(&terminal_root(&cfg).unwrap(),record.clone()).unwrap();
        let mut controller = Controller::new(&cfg,&ready,&snap);
        controller.registry.restore_finalization(record.owner.clone(),FinalWork::Journal(record)).ok().unwrap();
        let started = Instant::now();
        let deadline = Instant::now()+Duration::from_secs(12);
        loop {
            controller.tick(&snap,false,true).unwrap();
            // Seeing the request at the server is not the finalizer's durable
            // completion. In loaded Linux CI, fsync can outlive a fixed sleep.
            let retained = journal::pending(&terminal_root(&cfg).unwrap(),cfg.label.as_ref().unwrap(),&cfg.url).unwrap();
            if retained.iter().any(|r| matches!(r.disposition,Disposition::Rejected { .. })) { break; }
            assert!(Instant::now()<deadline); std::thread::sleep(Duration::from_millis(1));
        }
        assert!(!controller.controller_ready(),"an unchanged claim cannot release the handoff barrier");
        assert_eq!(controller.registry.counts().charged,1);
        assert_eq!(cancels.load(Ordering::SeqCst),1);
        assert!(reads.load(Ordering::SeqCst) as u64<=1+started.elapsed().as_secs()/RESERVATION_OBSERVATION_INTERVAL.as_secs(),"a wait must be paced, not a foreground polling storm");
        assert!(matches!(journal::pending(&terminal_root(&cfg).unwrap(),cfg.label.as_ref().unwrap(),&cfg.url).unwrap()[0].disposition,Disposition::Rejected { .. }),"rollback builds must still understand the retained journal");
        released.store(true,Ordering::SeqCst);
        while !controller.controller_ready() {
            controller.tick(&snap,false,true).unwrap(); assert!(Instant::now()<deadline); std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(controller.registry.counts().charged,0);
        assert_eq!(cancels.load(Ordering::SeqCst),1,"the rejected cancellation must never be replayed");
        assert!(reads.load(Ordering::SeqCst)>=2);
        assert!(journal::pending(&terminal_root(&cfg).unwrap(),cfg.label.as_ref().unwrap(),&cfg.url).unwrap().is_empty());
        drop(controller); let _=std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    #[test]
    fn old_rejected_unstarted_reservation_recovers_read_only_and_preserves_other_work() {
        let hub=Hub::new(|request| {
            assert_eq!(request["params"]["name"],"get_artefact","a persisted rejected reservation may only observe new facts");
            Some(json!({"id":"old-reservation","status":"todo","meta":{}}))
        });
        let (cfg,ready,snap)=fixture(&hub);
        let ticket=Ticket { task_id:"old-reservation".into(),session:"old-session".into() };
        let record=Record { owner:Ownership::Reservation { ticket },host:cfg.label.clone().unwrap(),url:cfg.url.clone(),observed_at:1,process:None,
            disposition:Disposition::Rejected { reason:"old semantic cancellation hold".into() },work:Work::Unstarted { reason:"never launched".into() } };
        journal::insert(&terminal_root(&cfg).unwrap(),record.clone()).unwrap();
        let newer=reservation_path(&cfg,&Ticket { task_id:"old-reservation".into(),session:"new-session".into() }).unwrap();
        journal::write_file(&newer,b"new owner's reservation").unwrap();
        let worktree=root(&cfg).unwrap().join("preserved-wip"); journal::write_file(&worktree,b"unpublished work").unwrap();
        let mut controller=Controller::new(&cfg,&ready,&snap);
        controller.registry.restore_finalization(record.owner.clone(),FinalWork::Journal(record)).ok().unwrap();
        let deadline=Instant::now()+Duration::from_secs(3);
        while !controller.registry.is_idle() { controller.registry.poll(|_|None); assert!(Instant::now()<deadline); std::thread::sleep(Duration::from_millis(1)); }
        assert_eq!(std::fs::read(&newer).unwrap(),b"new owner's reservation");
        assert_eq!(std::fs::read(&worktree).unwrap(),b"unpublished work");
        assert!(journal::pending(&terminal_root(&cfg).unwrap(),cfg.label.as_ref().unwrap(),&cfg.url).unwrap().is_empty());
        drop(controller);let _=std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    #[test]
    fn rejected_unknown_attempt_never_becomes_reservation_observation() {
        let hub=Hub::new(|request| {
            assert_eq!(request["params"]["arguments"]["command"]["kind"],"receipt","unknown writer/effect cannot be turned into reservation cleanup");
            Some(json!({"kind":"receipt_missing"}))
        });
        let (cfg,ready,snap)=fixture(&hub);
        let record=Record { owner:Ownership::Attempt { ticket:Ticket { task_id:"unknown".into(),session:"session".into() },host:cfg.label.clone().unwrap(),generation:1,attempt_id:"unknown-one".into() },
            host:cfg.label.clone().unwrap(),url:cfg.url.clone(),observed_at:1,process:None,
            disposition:Disposition::Rejected { reason:"gate: unknown external effect".into() },work:Work::UnknownWriter { reason:"physical proof missing".into() } };
        journal::insert(&terminal_root(&cfg).unwrap(),record.clone()).unwrap();
        let before=std::fs::read(terminal_root(&cfg).unwrap().join(record.name())).unwrap();
        let mut controller=Controller::new(&cfg,&ready,&snap);
        controller.registry.restore_finalization(record.owner.clone(),FinalWork::Journal(record.clone())).ok().unwrap();
        let deadline=Instant::now()+Duration::from_secs(3);
        while controller.registry.counts().held==0 { controller.registry.poll(|_|None); assert!(Instant::now()<deadline); std::thread::sleep(Duration::from_millis(1)); }
        assert_eq!(controller.registry.counts().charged,1);
        assert!(!controller.controller_ready());
        assert_eq!(std::fs::read(terminal_root(&cfg).unwrap().join(record.name())).unwrap(),before);
        drop(controller);let _=std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    #[test]
    fn train_only_health_proves_connection_without_fabricating_worker_readiness() {
        let hub = Hub::new(|request| {
            assert_eq!(request["params"]["name"], "train_status");
            Some(json!({"lanes":[]}))
        });
        let (mut cfg, old, _) = fixture(&hub); drop(old); cfg.role = Some("train".into());
        let readiness = GatewayReadiness::start(&cfg);
        assert!(matches!(readiness.data.lock().unwrap().state, GatewayReadinessState::Connected { .. }));
        assert!(readiness.proof(&cfg).is_err(), "a train connection cannot authorize an agent launch");
    }
    #[test]
    fn actual_finalizer_recovers_captured_result_after_lost_ack_and_daemon_restart() {
        let ids = Arc::new(Mutex::new(Vec::<String>::new()));
        let host = Arc::new(Mutex::new(String::new())); let bound_host = host.clone(); let observed = ids.clone();
        let hub = Hub::new(move |request| {
            let args = &request["params"]["arguments"];
            if args["command"]["kind"] == "schedule" { return Some(json!({"kind":"no_eligible_work"})); }
            if args["command"]["kind"] == "stopped" { return Some(json!({"attempt":{"phase":"finalizing","writers":"process_group_empty","host":*bound_host.lock().unwrap(),"session":args["session"],"generation":1,"attempt_id":"captured-one"}})); }
            if args["command"]["kind"] == "receipt" {
                let ids = observed.lock().unwrap();
                return Some(if ids.is_empty() { json!({"kind":"receipt_missing"}) } else {
                    assert_eq!(args["command"]["target_command_id"], ids[0]);
                    json!({"kind":"receipt_found","result":{"attempt":{"phase":"quiesced","host":*bound_host.lock().unwrap(),"session":args["session"],"generation":1,"attempt_id":"captured-one"}}})
                });
            }
            assert_eq!(args["command"]["kind"], "finalize");
            let mut ids = observed.lock().unwrap(); ids.push(args["command_id"].as_str().unwrap().into());
            if ids.len() == 1 { return None; }
            Some(json!({"attempt":{"phase":"quiesced","host":*bound_host.lock().unwrap(),"session":args["session"],"generation":1,"attempt_id":"captured-one"}}))
        });
        let (cfg, ready, snap) = fixture(&hub); *host.lock().unwrap() = cfg.label.clone().unwrap();
        let owner = Ownership::Attempt { ticket: Ticket { task_id: "terminal-fixture".into(), session: "captured-session".into() }, host: cfg.label.clone().unwrap(), generation: 1, attempt_id: "captured-one".into() };
        let record = Record { owner: owner.clone(), url: cfg.url.clone(), host: cfg.label.clone().unwrap(), observed_at: 1, disposition: Disposition::Pending, process: None,
            work: Work::Stopped { outcome: Outcome { kind: OutcomeKind::Completed, exit_code: Some(0), stdout_tail: "the exact captured result survives restart".into(), stderr_tail: String::new() }, writers: WriterProof::ProcessGroupEmpty, worktree: None, step: Step::Stop } };
        journal::insert(&terminal_root(&cfg).unwrap(), record.clone()).unwrap();
        let mut first = Controller::new(&cfg, &ready, &snap);
        first.registry.restore_finalization(owner, FinalWork::Journal(record)).ok().unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop { first.registry.poll(|_| None);
            if ids.lock().unwrap().len() == 1 && first.registry.counts().delivering == 1 && !matches!(first.registry.counts().running, 1..) {
                // Wait until the failed network operation has yielded its retry.
                std::thread::sleep(Duration::from_millis(20)); first.registry.poll(|_| None); break;
            }
            assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(1));
        }
        drop(first); // injected daemon loss: journal, not the old memory, recovers
        let mut restored = Controller::new(&cfg, &ready, &snap);
        while !restored.idle() {
            restored.tick(&snap, true, false).unwrap(); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(1));
        }
        let ids = ids.lock().unwrap(); assert_eq!(ids.len(), 1, "known committed finalization is read back, never repeated as a new effect");
        assert!(journal::pending(&terminal_root(&cfg).unwrap(), cfg.label.as_ref().unwrap(), &cfg.url).unwrap().is_empty());
        drop(restored); let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }
    #[test]
    fn recovered_old_checkpoint_stage_reads_its_ack_without_touching_newer_work() {
        let host = Arc::new(Mutex::new(String::new())); let bound = host.clone();
        let hub = Hub::new(move |request| {
            let args = &request["params"]["arguments"];
            if args["command"]["kind"] == "schedule" { return Some(json!({"kind":"no_eligible_work"})); }
            assert_eq!(args["command"]["kind"], "receipt", "recovery must not recapture/push/checkpoint or mutate a newer generation");
            Some(json!({"kind":"receipt_found","result":{"task_status":"done","attempt":{"phase":"quiesced","host":*bound.lock().unwrap(),"session":"old-session","generation":1,"attempt_id":"old-one"}}}))
        });
        let (cfg, ready, snap) = fixture(&hub); *host.lock().unwrap() = cfg.label.clone().unwrap();
        let work = root(&cfg).unwrap().join("newer-work"); std::fs::create_dir_all(&work).unwrap(); std::fs::write(work.join("keep"), "newer generation's work").unwrap();
        let record = Record { owner: Ownership::Attempt { ticket: Ticket { task_id: "old-result".into(), session: "old-session".into() }, host: cfg.label.clone().unwrap(), generation: 1, attempt_id: "old-one".into() },
            host: cfg.label.clone().unwrap(), url: cfg.url.clone(), observed_at: 1, disposition: Disposition::Pending, process: None,
            work: Work::Stopped { outcome: Outcome { kind: OutcomeKind::Completed, exit_code: Some(0), stdout_tail: "original result".into(), stderr_tail: String::new() }, writers: WriterProof::ProcessGroupEmpty, worktree: Some(work.clone()), step: Step::Capture } };
        journal::insert(&terminal_root(&cfg).unwrap(), record).unwrap();
        let mut controller = Controller::new(&cfg, &ready, &snap); let deadline = Instant::now() + Duration::from_secs(3);
        while !controller.idle() { controller.tick(&snap, true, false).unwrap(); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(1)); }
        assert_eq!(std::fs::read_to_string(work.join("keep")).unwrap(), "newer generation's work");
        drop(controller); let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }
    #[cfg(unix)]
    #[test]
    fn actual_checkpoint_publication_releases_execution_charge_before_slow_git_io() {
        use std::os::unix::fs::PermissionsExt;
        let host = Arc::new(Mutex::new(String::new())); let bound = host.clone();
        let seen = Arc::new(Mutex::new(Vec::new())); let calls = seen.clone();
        let hub = Hub::new(move |request| {
            let args = &request["params"]["arguments"]; let kind = args["command"]["kind"].as_str().unwrap();
            calls.lock().unwrap().push(kind.to_string());
            if kind == "receipt" { return Some(json!({"kind":"receipt_missing"})); }
            if kind == "schedule" { return Some(json!({"kind":"no_eligible_work"})); }
            assert!(matches!(kind, "stopped" | "checkpoint" | "finalize"));
            if kind == "stopped" || kind == "finalize" { assert_eq!(args["command"]["writers"], "no_live_group_members"); }
            Some(json!({"attempt":{"phase":if kind == "finalize" { "quiesced" } else { "finalizing" },"writers":"no_live_group_members","host":*bound.lock().unwrap(),"session":"slow-session","generation":1,"attempt_id":"slow-one"}}))
        });
        let (cfg, ready, snap) = fixture(&hub); *host.lock().unwrap() = cfg.label.clone().unwrap();
        let sandbox = root(&cfg).unwrap().join("slow-git"); std::fs::create_dir_all(&sandbox).unwrap();
        let source = crate::checkpoint::tests::init(&sandbox);
        let checkpoint = crate::checkpoint::capture(&source, "slow-publication", 1, "Preserve actual WIP", vec![]).unwrap();
        let entered = sandbox.join("entered"); let release = sandbox.join("release");
        let hook = source.join(".git/hooks/pre-push");
        std::fs::write(&hook, format!("#!/bin/sh\n: > '{}'\nwhile [ ! -f '{}' ]; do sleep 0.01; done\n", entered.display(), release.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
        let record = Record { owner: Ownership::Attempt { ticket: Ticket { task_id: "slow-publication".into(), session: "slow-session".into() }, host: cfg.label.clone().unwrap(), generation: 1, attempt_id: "slow-one".into() },
            host: cfg.label.clone().unwrap(), url: cfg.url.clone(), observed_at: 1, disposition: Disposition::Pending, process: None,
            work: Work::Stopped { outcome: Outcome { kind: OutcomeKind::Completed, exit_code: Some(0), stdout_tail: "Captured result".into(), stderr_tail: String::new() }, writers: WriterProof::NoLiveGroupMembers, worktree: Some(source), step: Step::Publish { checkpoint } } };
        journal::insert(&terminal_root(&cfg).unwrap(), record.clone()).unwrap();
        let mut controller = Controller::new(&cfg, &ready, &snap);
        controller.registry.restore_finalization(record.owner.clone(), FinalWork::Journal(record)).ok().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !entered.exists() || controller.registry.counts().charged != 0 {
            controller.registry.poll(|_| None);
            if Instant::now() >= deadline { std::fs::write(&release, "release on failure").unwrap(); panic!("checkpoint job never reached blocking push"); }
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(controller.registry.counts().delivering, 1);
        assert!(controller.registry.can_admit(), "physical execution slots must refill before Git publication completes");
        assert!(!controller.idle(), "managed update must wait for the outstanding publication");
        for _ in 0..30 { let start = Instant::now(); controller.registry.poll(|_| None); assert!(start.elapsed() < Duration::from_millis(200)); }
        std::fs::write(release, "release").unwrap();
        while !controller.registry.is_idle() { controller.registry.poll(|_| None); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(1)); }
        let calls = seen.lock().unwrap(); let stopped = calls.iter().position(|s| s == "stopped").unwrap(); let checkpoint = calls.iter().position(|s| s == "checkpoint").unwrap(); let finalized = calls.iter().position(|s| s == "finalize").unwrap();
        assert!(stopped < checkpoint && checkpoint < finalized);
        drop(controller); let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }
}
