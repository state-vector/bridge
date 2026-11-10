//! Production adapter for the single local lifecycle registry. Blocking work
//! lives only in bounded preparation/finalization/admission jobs.
use super::*;
use super::attempt_journal::{self as journal, Disposition, Outcome, OutcomeKind, Record, Step, Work, WriterProof};
use super::lifecycle::{self, Ownership, Prepared, Finished, Pipeline, Reporter, Released, Ticket, WriterReceipt};

#[derive(Clone, Serialize, Deserialize)]
struct Task { id: String, title: String, body_md: String, project: String, meta: serde_json::Value, roles: Vec<String> }
#[derive(Clone, Serialize, Deserialize)]
struct Input { ticket: Ticket, task: Option<Task> }
enum FinalWork { Active(Record, ExecutionRuntime), Fresh(Record), Journal(Record), Observe(Record), Legacy(stopped_outbox::StoppedReceipt) }
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
/// Recovery may prove no launch only while the journal is still preparing.
pub(super) fn arm_launch(cfg: &DispatchConfig, task: &str, generation: u64, attempt_id: &str, worktree: Option<PathBuf>, cancel: Option<Arc<AtomicBool>>, stage: LaunchStage) -> Result<crate::transport::RunControl, String> {
    let record = Record { owner: Ownership::Attempt { ticket: Ticket { task_id: task.into(), session: claim_session(cfg, task) }, host: cfg.label.clone().ok_or("gateway host missing")?, generation, attempt_id: attempt_id.into() },
        host: cfg.label.clone().unwrap(), url: cfg.url.trim_end_matches('/').into(), observed_at: now_ms(), disposition: Disposition::Pending,
        process: None, work: Work::UnknownWriter { reason: "Launch intent persisted; process/result proof must be reconciled".into() } };
    let launch_root = root(cfg)?.join("launches");
    // Worktree location is retained alongside intent even if transport never
    // returns. The writer/result record replaces this only after physical proof.
    let path = launch_root.join(record.name());
    let intent = match std::fs::read(&path) {
        Ok(bytes) => {
            let existing: Launch = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if existing.record.owner != record.owner || !matches!(existing.stage, LaunchStage::MayHaveLaunched) {
                return Err("gate: existing launch journal is outside the worker fence".into());
            }
            existing
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let intent = Launch { record, worktree, stage };
            journal::write_file(&path, &serde_json::to_vec(&intent).map_err(|e| e.to_string())?)?;
            intent
        },
        Err(error) => return Err(error.to_string()),
    };
    let environment = workspace::Owner::open(cfg)?.environment_for(&intent.record.owner.ticket())?;
    Ok(crate::transport::RunControl::with_cancel(cancel).with_environment(environment).observe_launch(move |process| {
        let mut launched = intent.clone(); launched.stage = LaunchStage::MayHaveLaunched; launched.record.process = Some(process);
        journal::write_file(&launch_root.join(launched.record.name()), &serde_json::to_vec(&launched).map_err(|e| e.to_string())?)
    }))
}
#[derive(Clone, Serialize, Deserialize)]
struct Launch {
    record: Record,
    worktree: Option<PathBuf>,
    #[serde(default)]
    stage: LaunchStage,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum LaunchStage {
    Preparing,
    #[default]
    MayHaveLaunched,
}

impl Launch {
    fn unstarted_work(&self, reason: String) -> Option<Work> {
        if !matches!(self.stage, LaunchStage::Preparing) || self.record.process.is_some() { return None; }
        Some(Work::Stopped {
            outcome: Outcome { kind: OutcomeKind::Interrupted, exit_code: None, stdout_tail: String::new(), stderr_tail: reason, cause: None },
            writers: WriterProof::ProcessGroupEmpty,
            worktree: self.worktree.clone(),
            step: Step::Stop,
        })
    }
}

/// Write-ahead begin identity (BR#9843). Persisted and fsynced BEFORE the hub
/// begin call: the client-chosen attempt id (echoed verbatim by the hub) and
/// the worktree are then durable across a crash between begin and the
/// post-begin launch journal. Recovery upgrades such a reservation to an
/// honest unproven record with the original worktree instead of a faceless
/// UnknownWriter charge, and the fence-scoped scan discharges it with kernel
/// proof. Nothing but the exact-fence evidence ever releases capacity.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct BeginIntent {
    ticket: Ticket, host: String, url: String,
    expected_attempt: String,
    #[serde(default)]
    worktree: Option<PathBuf>,
    at: u64,
}
fn begin_intent_path(cfg: &DispatchConfig, ticket: &Ticket) -> Result<PathBuf, String> {
    Ok(root(cfg)?.join("begin-intents").join(format!("{}.json", journal::stable_key(&[&ticket.task_id, &ticket.session]))))
}
pub(super) fn persist_begin_intent(cfg: &DispatchConfig, task: &str, session: &str, expected_attempt: &str, worktree: Option<PathBuf>) -> Result<(), String> {
    let intent = BeginIntent { ticket: Ticket { task_id: task.into(), session: session.into() },
        host: cfg.label.clone().ok_or("gateway host missing")?, url: cfg.url.trim_end_matches('/').into(),
        expected_attempt: expected_attempt.into(), worktree, at: now_ms() };
    journal::write_file(&begin_intent_path(cfg, &intent.ticket)?, &serde_json::to_vec(&intent).map_err(|e| e.to_string())?)
}
fn begin_intent(cfg: &DispatchConfig, ticket: &Ticket) -> Result<Option<BeginIntent>, String> {
    match std::fs::read(begin_intent_path(cfg, ticket)?) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).map_err(|e| format!("gate: begin intent unreadable; preserve ownership: {e}"))?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
pub(super) fn remove_begin_intent(cfg: &DispatchConfig, task: &str, session: &str) -> Result<(), String> {
    let ticket = Ticket { task_id: task.into(), session: session.into() };
    std::fs::remove_file(begin_intent_path(cfg, &ticket)?).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }).map_err(|e| e.to_string())
}

pub(super) fn cross_launch_boundary(cfg: &DispatchConfig, task: &str, generation: u64, attempt_id: &str) -> Result<(), String> {
    let ticket = Ticket { task_id: task.into(), session: claim_session(cfg, task) };
    let host = cfg.label.clone().ok_or("gateway host missing")?;
    let owner = Ownership::Attempt { ticket, host: host.clone(), generation, attempt_id: attempt_id.into() };
    let root = root(cfg)?.join("launches");
    let mut launch: Launch = serde_json::from_slice(&std::fs::read(root.join(journal::record_name(cfg.url.trim_end_matches('/'), &host, &owner))).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if launch.record.owner != owner || !matches!(launch.stage, LaunchStage::Preparing) {
        return Err("gate: launch journal is outside the original preparation fence".into());
    }
    launch.stage = LaunchStage::MayHaveLaunched;
    journal::write_file(&root.join(launch.record.name()), &serde_json::to_vec(&launch).map_err(|e| e.to_string())?)
}
fn launches_for(cfg: &DispatchConfig, ticket: &Ticket) -> Result<Vec<Launch>, String> {
    let root = root(cfg)?.join("launches");
    let entries = match std::fs::read_dir(root) { Ok(entries) => entries, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()), Err(e) => return Err(e.to_string()) };
    let mut launches = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        let launch: Launch = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if launch.record.ticket() == ticket {
            launch.record.validate()?;
            if launch.record.host != cfg.label.as_deref().unwrap_or_default() || launch.record.url != cfg.url.trim_end_matches('/') {
                return Err("gate: launch journal belongs to another originating host/hub".into());
            }
            launches.push(launch);
        }
    }
    Ok(launches)
}
pub(super) fn workspace_launch_exists(cfg: &DispatchConfig, ticket: &Ticket) -> Result<bool, String> {
    Ok(!launches_for(cfg, ticket)?.is_empty())
}
pub(super) fn workspace_release_receipt(cfg: &DispatchConfig, owner: &Ownership) -> Result<Option<Released>, String> {
    let record = Record { owner: owner.clone(), host: cfg.label.clone().ok_or("gateway host missing")?, url: cfg.url.trim_end_matches('/').into(), observed_at: now_ms(),
        disposition: Disposition::Pending, process: None, work: Work::UnknownWriter { reason: "Read-only original workspace-finalization receipt lookup".into() } };
    record.validate()?;
    let ticket = owner.ticket();
    let reply = execution_request(cfg, &ticket.task_id, &ticket.session, &record.command_id("workspace-lookup"), json!({"kind":"receipt","target_command_id":record.command_id("finalize")}))?;
    if reply["kind"] == "receipt_found" { Ok(Some(Released::from_hub(owner, &reply["result"])?)) } else { Ok(None) }
}
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
        exit_code: result.exit_code, stdout_tail: result.stdout_tail.clone(), stderr_tail: result.stderr_tail.clone(), cause: result.cause.clone() };
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
            // The preparation journal owns the exact fence even if the hub
            // is unreachable. Crossing the launch boundary requires proof
            // from the worker, including when launch itself returns an error.
            if let Ok(launches) = launches_for(&cfg, &ticket) {
                if let [launch] = launches.as_slice() {
                    let work = launch.unstarted_work("Gateway stopped during preparation before a writer could launch".into());
                    let mut record = launch.record.clone();
                    let owner = record.owner.clone();
                    if let Some(work) = work {
                        record.work = work;
                        return Prepared::Finalize { owner, value: FinalWork::Fresh(record) };
                    }
                    // The independent writer still owns publication of its
                    // terminal WAL. An observer must not occupy that path.
                    return Prepared::Finalize { owner, value: FinalWork::Observe(record) };
                }
                // A live preparation that never wrote a launch intent has
                // not invoked either transport. This also covers a lost begin ACK.
                if launches.is_empty() {
                    if let Ok(state) = execution_request(&cfg, &ticket.task_id, &ticket.session, &format!("prepare-inspect-{}", now_ms()), json!({"kind":"inspect"})) {
                        let a = &state["attempt"];
                        if a["session"] == ticket.session && a["host"].as_str() == cfg.label.as_deref() {
                            if let (Some(generation), Some(attempt_id)) = (a["generation"].as_u64(), a["attempt_id"].as_str()) {
                                let owner = Ownership::Attempt { ticket: ticket.clone(), host: cfg.label.clone().unwrap(), generation, attempt_id: attempt_id.into() };
                                let record = Record { owner: owner.clone(), host: cfg.label.clone().unwrap(), url: cfg.url.trim_end_matches('/').into(), observed_at: now_ms(), disposition: Disposition::Pending, process: None,
                                    work: Work::Stopped { outcome: Outcome { kind: OutcomeKind::Interrupted, exit_code: None, stdout_tail: String::new(), stderr_tail: reason.clone(), cause: None }, writers: WriterProof::ProcessGroupEmpty, worktree: None, step: Step::Stop } };
                                return Prepared::Finalize { owner, value: FinalWork::Fresh(record) };
                            }
                        }
                    }
                }
            }
            let record = Record { owner: owner.clone(), host: cfg.label.clone().unwrap_or_default(), url: cfg.url.trim_end_matches('/').into(), observed_at: now_ms(), disposition: Disposition::Pending, process: None, work: Work::Unstarted { reason } };
            Prepared::Finalize { owner, value: FinalWork::Fresh(record) }
        },
    }
}

// The old capture path rejected ENOENT before the hub could finalize.
// The fresh-attempt policy no longer needs that worktree. Match only that
// historical rejection and keep its original outcome and writer proof.
fn legacy_missing_capture(record: &Record, reason: &str) -> bool {
    let Work::Stopped { outcome, worktree: Some(path), step: Step::Capture, .. } = &record.work else { return false; };
    if !matches!(outcome.kind, OutcomeKind::ResultUnavailable) { return false; }
    let missing = std::io::Error::from_raw_os_error(libc::ENOENT);
    reason == format!("gate: checkpoint worktree unavailable at {}: {missing}; retained journal requires workspace reconciliation", path.display())
        && std::fs::symlink_metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
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
                let task = mcp_call(&cfg, &mut 0, "get_artefact", json!({"id":ticket.task_id,"view":"execution"}))?;
                report.released(Released::reservation_reconciled(&record.owner, &task)?); return Ok(());
            }
            return Err("gate: terminal journal disappeared without a matching immutable ACK; ownership retained".into());
        }
        // Persisted stage is always the source of recovery, including after a
        // lost response. Every mutating RPC uses its original deterministic ID.
        record = journal::insert(&root, record.clone())?;
        if let Disposition::Rejected { reason } = &record.disposition {
            if !legacy_missing_capture(&record, reason) { return Err(reason.clone()); }
        }
        if let Work::Unproven { outcome, worktree } = record.work.clone() {
            let process = record.process.as_ref().ok_or("gate: launch identity unavailable; retain owner for original-host reconciliation")?;
            let state = crate::transport::stop_recovered(process);
            let writers = WriterProof::observed(state).ok_or_else(|| if state == crate::transport::GroupState::Live { "Exact recovered process group is still stopping; retry physical proof" } else { "gate: recovered group identity/visibility cannot prove stopped writers" }.to_string())?;
            record.work = Work::Stopped { outcome, writers, worktree, step: Step::Stop };
            journal::save(&root, &record)?;
        }
        if let Work::Stopped { outcome, writers, worktree, step: Step::Stop | Step::Capture | Step::Publish { .. } | Step::Register { .. } } = record.work.clone() {
            let Ownership::Attempt { generation, attempt_id, .. } = &record.owner else { return Err("gate: stopped journal has no attempt fence".into()); };
            let ticket = record.ticket();
            let bounded = bounded_outcome(&outcome);
            let reply = execution_request(&cfg, &ticket.task_id, &ticket.session, &record.command_id("stopped"),
                json!({"kind":"stopped","generation":generation,"attempt_id":attempt_id,"writers":writers,"outcome":bounded}))?;
            report.released(Released::from_hub(&record.owner, &reply)?);
            // Finalize has always followed the hub's stopped receipt. Persist
            // that boundary so a delivery failure resumes at finalize.
            record.work = Work::Stopped { outcome, writers, worktree, step: Step::Finalize };
            record.disposition = Disposition::Pending;
            journal::save(&root, &record)?;
        }
        loop {
            match record.work.clone() {
                Work::Unproven { .. } | Work::UnknownWriter { .. } => return Err("gate: no process-group-empty proof; retain outcome and capacity for host reconciliation".into()),
                Work::Unstarted { .. } => {
                    let ticket = record.ticket().clone();
                    let task = mcp_call(&cfg, &mut 0, "get_artefact", json!({"id":ticket.task_id,"view":"execution"}))?;
                    let released = match Released::reservation_reconciled(&record.owner, &task) {
                        Ok(receipt) => receipt,
                        Err(_) => {
                            let reply = execution_request(&cfg, &ticket.task_id, &ticket.session, &record.command_id("cancel-start"),
                                json!({"kind":"cancel_start","writers":"not_launched","retained_work":true}))?;
                            if reply["kind"] == "held" { return Err(format!("gate: startup cancellation held: {}", reply["reason"])); }
                            Released::from_hub(&record.owner, &reply)?
                        },
                    };
                    workspace::Owner::open(&cfg)?.release(&released)?;
                    report.released(released);
                    remove_reservation(&cfg, record.ticket())?;
                    journal::remove(&root, &record)?;
                    return Ok(());
                },
                Work::Stopped { outcome, writers, worktree, step } => {
                    let Ownership::Attempt { generation, attempt_id, .. } = &record.owner else { return Err("gate: stopped journal has no attempt fence".into()); };
                    let ticket = record.ticket().clone();
                    let next = match step {
                        Step::Stop | Step::Capture | Step::Publish { .. } | Step::Register { .. } => unreachable!("stopped receipt must precede finalization"),
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
                            workspace::Owner::open(&cfg)?.release(&Released::from_hub(&record.owner, &reply)?)?;
                            remove_reservation(&cfg, record.ticket())?;
                            remove_launch(&cfg, &record)?;
                            let ticket = record.ticket();
                            let _ = remove_begin_intent(&cfg, &ticket.task_id, &ticket.session)?;
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
    // The typed cause survives bounding: its sanitized fields are already
    // bounded at classification time, so provenance reaches the hub intact.
    Outcome { kind: outcome.kind.clone(), exit_code: outcome.exit_code, stdout_tail: tail_bytes(&outcome.stdout_tail, 16_000), stderr_tail: tail_bytes(&outcome.stderr_tail, 8_000), cause: outcome.cause.clone() }
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
    let task = mcp_call(cfg, &mut 0, "get_artefact", json!({"id":record.ticket().task_id,"view":"execution"}))?;
    Released::reservation_reconciled(&record.owner, &task)
}

fn writer_observable(record: &Record) -> bool {
    matches!(record.owner, Ownership::Attempt { .. }) && match &record.work {
        Work::UnknownWriter { .. } => true,
        Work::Unproven { outcome, .. } => matches!(outcome.kind, OutcomeKind::ResultUnavailable),
        // A captured real result still owns its result delivery.
        _ => false,
    }
}

fn writer_release(cfg: &DispatchConfig, record: &Record) -> Result<(Released, WriterReceipt), String> {
    let receipt = writer_lookup(cfg, record)?;
    Ok((Released::from_writer_receipt(&record.owner, &receipt)?, receipt))
}
fn writer_lookup(cfg: &DispatchConfig, record: &Record) -> Result<WriterReceipt, String> {
    record.validate()?;
    if !writer_observable(record) || record.url != cfg.url.trim_end_matches('/')
        || cfg.label.as_deref() != Some(record.host.as_str()) { return Err("Stopped-job observation has the wrong original scope".into()); }
    let Ownership::Attempt { generation, attempt_id, ticket, .. } = &record.owner else { unreachable!() };
    let receipt: WriterReceipt = serde_json::from_value(execution_request(cfg, &ticket.task_id, &ticket.session,
        &record.command_id("writer-lookup"), json!({"kind":"writer_receipt","generation":generation,"attempt_id":attempt_id}))?)
        .map_err(|e| format!("Stopped-job receipt format changed; preserve ownership: {e}"))?;
    Ok(receipt)
}

fn retire_proved_writer(cfg: &DispatchConfig, record: &Record, receipt: &WriterReceipt) -> Result<(), String> {
    Released::from_writer_receipt(&record.owner, receipt)?;
    let terminal = terminal_root(cfg)?;
    let path = terminal.join(record.name());
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::read(terminal.join("archive").join(record.name())).map_err(|e| e.to_string())?,
        Err(e) => return Err(e.to_string()),
    };
    let saved: Record = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    saved.validate()?;
    if saved.owner != record.owner || saved.host != record.host || saved.url != record.url || !writer_observable(&saved) {
        return Err("Saved result changed; preserve it for normal delivery".into());
    }
    let launch_path = root(cfg)?.join("launches").join(saved.name());
    let launch = match std::fs::read_to_string(&launch_path) {
        Ok(raw) => Some(raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let proof_path = root(cfg)?.join("reconciled-writer-proofs").join(record.name());
    if !proof_path.exists() {
        journal::write_file(&proof_path, &serde_json::to_vec(&json!({"record":saved,"launch_record":launch,"receipt":receipt})).map_err(|e| e.to_string())?)?;
    }
    writer_release(cfg, &saved)?; // proof and authority rechecked immediately before cleanup
    if path.exists() && std::fs::read(&path).map_err(|e| e.to_string())? != raw { return Err("Saved result changed during recovery; preserve it".into()); }
    worker_session::retire(cfg, &saved)?; // an actual live worker lock still prevents retirement
    remove_launch(cfg, &saved)?;
    let ticket = saved.ticket();
    let _ = remove_begin_intent(cfg, &ticket.task_id, &ticket.session)?;
    journal::remove(&terminal, &saved)?; // keeps the complete original record in archive
    // Reservations are keyed only by task/session, not generation. Do not
    // remove one here: a newer attempt may use the same session. Its existing
    // unstarted-reservation observer owns that separate, fresh decision.
    Ok(())
}

fn observe_record(shared: &Config, record: Record, report: Reporter) -> Finished<FinalWork> {
    let cfg = config(shared);
    // Reload the actual record rather than discarding a late captured result.
    let record = match terminal_root(&cfg).and_then(|root| match std::fs::read(root.join(record.name())) {
        Ok(raw) => serde_json::from_slice::<Record>(&raw).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(record.clone()),
        Err(e) => Err(e.to_string()),
    }) {
        Ok(current) if current.owner == record.owner => current,
        _ => return Finished::Held { value: FinalWork::Observe(record), reason: "Saved job identity changed; preserve ownership".into() },
    };
    if !writer_observable(&record) && !reservation_observable(&record) { return Finished::Retry { value: FinalWork::Journal(record), after: Duration::ZERO }; }
    match reconcile_record(&cfg, &record, true) {
        Ok(Some(released)) => { report.released(released); Finished::Complete },
        Ok(None) => Finished::Retry { value: FinalWork::Journal(record), after: Duration::ZERO },
        Err(_) => {
            // Give a recent writer time to publish its result promptly. Old
            // evidence gaps still recheck automatically, at a cadence that
            // leaves room for live worker polls and final result delivery.
            let after = if writer_observable(&record) && now_ms().saturating_sub(record.observed_at) >= 60_000 {
                Duration::from_secs(30)
            } else {
                RESERVATION_OBSERVATION_INTERVAL
            };
            Finished::Retry { value: FinalWork::Observe(record), after }
        },
    }
}

/// The live finalizer and the supervisor's fenced offline step use this SAME
/// reconciliation implementation. No independent cleanup authority exists.
fn reconcile_record(cfg: &DispatchConfig, record: &Record, apply: bool) -> Result<Option<Released>, String> {
    record.validate()?;
    if reservation_observable(record) {
        let released = reservation_release(cfg, record)?;
        if apply {
            let terminal = terminal_root(cfg)?;
            let original = std::fs::read(terminal.join(record.name())).map_err(|e| e.to_string())?;
            let archive = root(cfg)?.join("reconciled-reservations").join(record.name());
            if !archive.exists() { journal::write_file(&archive, &original)?; }
            reservation_release(cfg, record)?;
            if std::fs::read(terminal.join(record.name())).map_err(|e| e.to_string())? != original { return Err("Saved reservation changed during reconciliation".into()); }
            remove_reservation(cfg, record.ticket())?;
            journal::remove(&terminal, record)?;
        }
        return Ok(Some(released));
    }
    match writer_lookup(cfg, record)? {
        receipt @ WriterReceipt::WriterReceiptFound { .. } => {
            let released = Released::from_writer_receipt(&record.owner, &receipt)?;
            if apply { retire_proved_writer(cfg, record, &receipt)?; }
            return Ok(Some(released));
        },
        WriterReceipt::WriterReceiptHeld { reason } => return Err(reason),
        WriterReceipt::WriterReceiptMissing => {},
    }
    // A vanished transport result is not success. Capture that exact truth,
    // with kernel proof and the original worktree, into the NORMAL stopped →
    // stopped → finalize path. No synthesized finalize ACK or lease inference.
    let Ownership::Attempt { generation, attempt_id, .. } = &record.owner else { return Err("Original attempt required".into()) };
    if !root(cfg)?.join("workers").join(record.name().trim_end_matches(".json")).join("request.json").exists() {
        // BR#9843: neither a hub writer receipt nor a worker manifest exists —
        // the originating daemon crashed before its stop receipt and before/
        // without a manifest. Discharge on kernel fence proof or hold; never
        // an error wall the observe loop retries into forever.
        return self_heal_release(cfg, record, apply);
    }
    let state = execution_request(cfg, &record.ticket().task_id, &record.ticket().session,
        &record.command_id("reconcile-inspect"), json!({"kind":"inspect"}))?;
    let a = &state["attempt"];
    if a["host"] != record.host || a["session"] != record.ticket().session || a["generation"] != *generation
        || a["attempt_id"] != *attempt_id || a["phase"] != "stopping" || state["handoff"]["phase"] != "none"
        || state["operations"].as_array().is_none_or(|ops| ops.iter().any(|op| matches!(op["state"].as_str(), Some("prepared" | "outcome_unknown")))) {
        return Err("Original stopping fence, retained-work authority or outside-action proof is missing".into());
    }
    worker_session::with_stopped_worker(cfg, record, apply, |worktree| {
        if apply {
            let terminal = terminal_root(cfg)?;
            let saved = match std::fs::read(terminal.join(record.name())) {
                Ok(original) => {
                    let saved: Record = serde_json::from_slice(&original).map_err(|e| e.to_string())?;
                    if !writer_observable(&saved) || saved.owner != record.owner { return Err("A real result arrived; preserve normal delivery".into()); }
                    let archive = root(cfg)?.join("reconciled-writer-proofs").join(record.name());
                    if !archive.exists() { journal::write_file(&archive, &original)?; }
                    saved
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => record.clone(),
                Err(error) => return Err(error.to_string()),
            };
            let outcome = match &saved.work {
                Work::Unproven { outcome, .. } => outcome.clone(),
                _ => Outcome { kind: OutcomeKind::ResultUnavailable, exit_code: None, stdout_tail: String::new(), stderr_tail: "Original worker stopped without a captured result; original work retained".into(), cause: None },
            };
            let worktree = match &saved.work { Work::Unproven { worktree: Some(path), .. } => Some(path.clone()), _ => worktree };
            journal::save(&terminal, &Record { work: Work::Stopped { outcome, writers: WriterProof::NoLiveGroupMembers, worktree, step: Step::Stop }, disposition: Disposition::Pending, ..saved })?;
        }
        Ok(None)
    })
}

/// BR#9843 self-heal: the charged attempt has neither a hub writer receipt nor
/// a worker manifest. The only lawful local discharges are kernel facts from a
/// fence-scoped same-UID /proc census (writer_scan): a live exact-fence match
/// is fenced-stopped through the normal transport path; a complete readable
/// census with no match proves the writer absent and delivers an honest
/// ResultUnavailable through the normal stopped→finalize path. Any visibility
/// gap holds. Never infer from lease expiry, time or titles; never touch a
/// newer attempt; no hub protocol change, no privilege.
fn self_heal_release(cfg: &DispatchConfig, record: &Record, apply: bool) -> Result<Option<Released>, String> {
    let Ownership::Attempt { generation, attempt_id, ticket, .. } = &record.owner else { return Err("Original attempt required".into()) };
    let state = execution_request(cfg, &ticket.task_id, &ticket.session,
        &record.command_id("reconcile-inspect"), json!({"kind":"inspect"}))?;
    let attempt = &state["attempt"];
    if attempt["host"] != record.host || attempt["session"] != ticket.session || attempt["generation"] != *generation
        || attempt["attempt_id"] != *attempt_id
        || !matches!(attempt["phase"].as_str(), Some("running" | "restoring" | "stopping"))
        || state["handoff"]["phase"] != "none"
        || state["operations"].as_array().is_none_or(|ops| ops.iter().any(|op| matches!(op["state"].as_str(), Some("prepared" | "outcome_unknown")))) {
        return Err("Original live fence, retained-work authority or outside-action proof is missing".into());
    }
    let target = writer_scan::ScanTarget::new(&record.owner, record.name().trim_end_matches(".json"))?;
    let first = writer_scan::scan_live(cfg, &target);
    let verdict = match first {
        live @ writer_scan::FenceScan::Live(_) => live,
        absent @ writer_scan::FenceScan::Absent { .. } => {
            // Two clean passes spaced past fork/exec of a just-queued worker
            // unit before kernel absence is trusted.
            std::thread::sleep(writer_scan::rescan_spacing());
            match writer_scan::scan_live(cfg, &target) {
                writer_scan::FenceScan::Absent { .. } => absent,
                other => other,
            }
        },
        hold @ writer_scan::FenceScan::Hold(_) => hold,
    };
    let (writers, evidence) = match verdict {
        writer_scan::FenceScan::Hold(reason) => return Err(format!("gate: fence-scoped writer scan cannot prove identity: {reason}")),
        writer_scan::FenceScan::Live(matches) => {
            if !apply { return Ok(None); }
            let (writers, stopped) = writer_scan::stop_matches(&matches)?;
            (writers, json!({"result":"live","stopped":stopped["stopped"],"at":now_ms()}))
        },
        writer_scan::FenceScan::Absent { scanned } => {
            if !apply { return Ok(None); }
            (WriterProof::NoLiveGroupMembers, json!({"result":"absent","scanned":scanned,"at":now_ms()}))
        },
    };
    let outcome = if evidence["result"] == "live" {
        Outcome { kind: OutcomeKind::ResultUnavailable, exit_code: None, stdout_tail: String::new(),
            stderr_tail: "Fenced stop of an orphaned live writer matched by the exact execution fence; its uncaptured result is unavailable; original work retained".into(), cause: None }
    } else {
        Outcome { kind: OutcomeKind::ResultUnavailable, exit_code: None, stdout_tail: String::new(),
            stderr_tail: format!("Daemon restart left no manifest or receipt; a complete same-UID /proc census ({} entries) found no process matching the exact execution fence; the writer is kernel-proved absent; original work retained", evidence["scanned"]), cause: None }
    };
    let terminal = terminal_root(cfg)?;
    let launch_path = root(cfg)?.join("launches").join(record.name());
    let launch_record = match std::fs::read_to_string(&launch_path) {
        Ok(raw) => Some(raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let saved = match std::fs::read(terminal.join(record.name())) {
        Ok(original) => {
            let saved: Record = serde_json::from_slice(&original).map_err(|e| e.to_string())?;
            if !writer_observable(&saved) || saved.owner != record.owner { return Err("A real result arrived; preserve normal delivery".into()); }
            saved
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => record.clone(),
        Err(e) => return Err(e.to_string()),
    };
    // Archive the scan evidence exactly like the receipt apply path — before
    // the journal is mutated, and never over existing proof.
    let archive = root(cfg)?.join("reconciled-writer-proofs").join(record.name());
    if !archive.exists() { journal::write_file(&archive, &serde_json::to_vec(&json!({"record":saved,"launch_record":launch_record,"scan":evidence})).map_err(|e| e.to_string())?)?; }
    // Preserve any saved unproven outcome/worktree; never synthesize a result.
    let outcome = match &saved.work { Work::Unproven { outcome, .. } => outcome.clone(), _ => outcome };
    let worktree = match &saved.work {
        Work::Unproven { worktree: Some(path), .. } => Some(path.clone()),
        _ => begin_intent(cfg, record.ticket()).ok().flatten().and_then(|intent| intent.worktree),
    };
    journal::save(&terminal, &Record { work: Work::Stopped { outcome, writers, worktree, step: Step::Stop }, disposition: Disposition::Pending, ..saved })?;
    let ticket = record.ticket();
    let _ = remove_begin_intent(cfg, &ticket.task_id, &ticket.session);
    Ok(None)
}

pub(super) fn reconcile(cfg: &DispatchConfig, apply: bool, task: Option<&str>) -> Result<serde_json::Value, String> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("gateway home missing")?);
    reconcile_locked(cfg, apply, task, &home.join(CONTROLLER_LOCK_FILE))
}
fn reconcile_locked(cfg: &DispatchConfig, apply: bool, task: Option<&str>, lock_path: &Path) -> Result<serde_json::Value, String> {
    let _lock = if apply { Some(worker_session::Lock::acquire(lock_path)?.ok_or("gate: live controller lock is held; recovery supervisor owns the handoff")?) } else { None };
    let terminal = terminal_root(cfg)?;
    let host = cfg.label.as_deref().ok_or("gateway host missing")?;
    let records = journal::pending(&terminal, host, cfg.url.trim_end_matches('/'))?;
    let mut eligible = Vec::new(); let mut waiting = Vec::new(); let mut protected = 0;
    for record in records {
        if task.is_some_and(|task| task != record.ticket().task_id) { continue; }
        if !reservation_observable(&record) && !writer_observable(&record) {
            if matches!(record.work, Work::Unproven { .. }) { waiting.push(json!({"owner":record.owner,"reason":"Captured result still needs physical writer proof"})); }
            protected += 1; continue;
        }
        match reconcile_record(cfg, &record, apply) {
            Ok(_) => {
                eligible.push(json!({"owner":record.owner,"applied":apply}));
            },
            Err(error) => waiting.push(json!({"owner":record.owner,"reason":error})),
        }
    }
    Ok(json!({"kind":"reconciliation","apply":apply,"eligible":eligible,"waiting":waiting,"protected":protected,
        "note":"One fenced reconciliation path; original results and worktrees are conserved. No task is declared complete."}))
}

fn finalize(shared: &Config, work: FinalWork, report: Reporter) -> Finished<FinalWork> {
    let work = match work { FinalWork::Active(record, runtime) => { runtime.stop_maintenance(); FinalWork::Fresh(record) }, other => other };
    match work {
        FinalWork::Active(_, _) => unreachable!(),
        FinalWork::Observe(record) => observe_record(shared, record, report),
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
        if writer_observable(&record) { return observe_record(shared, record, report); }
        // Older builds persisted this wait as a terminal Rejected disposition.
        // Migrate only provably unstarted reservations to observation-only work;
        // all attempts, process identities and unknown effects retain their gate.
        if reservation_observable(&record) && matches!(record.disposition, Disposition::Rejected { .. }) {
            return observe_record(shared, record, report);
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
                        return Finished::Retry { value: FinalWork::Observe(record), after: RESERVATION_OBSERVATION_INTERVAL };
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
            let unstarted = launch.unstarted_work("Gateway stopped during preparation before a writer could launch".into());
            let mut record = launch.record; record.validate()?;
            if record.host != host || record.url != cfg.url { return Err("gate: launch journal belongs to another originating host/hub".into()); }
            if !known.insert(record.ticket().clone()) { continue; }
            let ticket = record.ticket();
            let state = execution_request(&cfg, &ticket.task_id, &ticket.session, &format!("recover-launch-{}", now_ms()), json!({"kind":"inspect"}))?;
            let Ownership::Attempt { generation, attempt_id, .. } = &record.owner else { return Err("gate: launch intent has no attempt fence".into()); };
            record.work = if state["terminal"]["generation"] == *generation && state["terminal"]["attempt_id"] == *attempt_id {
                Work::Stopped { outcome: serde_json::from_value(state["terminal"]["outcome"].clone()).map_err(|e| format!("gate: recovered terminal outcome drift: {e}"))?,
                    writers: serde_json::from_value(state["terminal"]["writers"].clone()).map_err(|e| format!("gate: recovered writer proof drift: {e}"))?, worktree: launch.worktree, step: Step::Stop }
            } else if let Some(work) = unstarted {
                work
            } else {
                Work::Unproven { outcome: Outcome { kind: OutcomeKind::ResultUnavailable, exit_code: None, stdout_tail: String::new(), stderr_tail: "Daemon restarted before capturing the transport result; inspect existing receipts and preserved work before continuing".into(), cause: None }, worktree: launch.worktree }
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
                let attempt_id = a["attempt_id"].as_str().ok_or("gate: recovered attempt id missing")?.to_string();
                // Write-ahead begin identity (BR#9843): this daemon issued this
                // begin (the durable pre-begin intent names the exact echoed
                // attempt id) but the launch journal was never written — no
                // writer can have crossed the launch boundary. Retain the
                // worktree and an honest unproven result for the fence-scoped
                // kernel discharge instead of a faceless UnknownWriter.
                let identified = begin_intent(&cfg, &input.ticket).ok().flatten()
                    .filter(|intent| intent.host == host && intent.url == cfg.url.trim_end_matches('/') && intent.expected_attempt == attempt_id);
                Record { owner: Ownership::Attempt { ticket: input.ticket, host: host.into(), generation, attempt_id }, host: host.into(), url: cfg.url.clone(), observed_at: now_ms(), disposition: Disposition::Pending, process: None,
                    work: if let Some(intent) = identified {
                        Work::Unproven { outcome: Outcome { kind: OutcomeKind::ResultUnavailable, exit_code: None, stdout_tail: String::new(), stderr_tail: "Daemon restarted after begin before the launch journal existed; no writer crossed the launch boundary; original work retained".into(), cause: None }, worktree: intent.worktree }
                    } else {
                        Work::UnknownWriter { reason: "Daemon restarted without a terminal process-group-empty receipt; retain writer ownership for kernel reconciliation".into() }
                    } }
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
    workspace_job: Option<lifecycle::Job<Result<workspace::Status, String>>>, next_workspace: Instant,
    disk_admission: workspace::Admission, disk_observed: Instant,
    reported_attention:std::collections::HashSet<(String,String)> }
impl Controller {
    #[cfg(test)]
    pub(crate) fn force_workspace_pass(&mut self) { self.next_workspace = Instant::now(); }
    #[cfg(test)]
    pub(crate) fn held_for_test(&self) -> usize { self.registry.counts().held }
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
        Self { registry, admission, shared, recovery: Recovery::Initial, last_snapshot: Instant::now(), capacity_probe: None, next_capacity_probe: Instant::now(), workspace_job: None, next_workspace: Instant::now(), disk_admission: workspace::Admission::Held { reason: "workspace inventory not yet reconciled".into() }, disk_observed:Instant::now(), reported_attention:Default::default() }
    }
    pub fn idle(&self) -> bool { self.registry.is_idle() && self.capacity_probe.is_none() && self.workspace_job.is_none() && matches!(self.admission, Admission::Idle { .. }) && matches!(self.recovery, Recovery::Ready { .. }) }
    pub fn active(&self) -> usize { usize::from(!self.idle()) }
    pub fn controller_ready(&self) -> bool {
        let cfg=config(&self.shared);
        self.capacity_probe.is_none() && self.workspace_job.is_none() && matches!(self.admission, Admission::Idle { .. }) && matches!(self.recovery, Recovery::Ready { .. })
            && self.registry.handoff_ready(|running| running.worker.as_ref().is_some_and(|worker| !worker.stop.load(Ordering::SeqCst) && worker.reattachable.load(Ordering::SeqCst)),
                |owner,value,stop| durable_handoff(&cfg,owner,value,stop))
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
                let outcome = opencode::RunOutcome { ok: false, stdout_tail: String::new(), stderr_tail: "transport result channel disconnected; proof required".into(), exit_code: None, timed_out: false, session_id: None, cause: None };
                record(&config(&shared), &running.task_id, &running.execution, &outcome, running.worktree.clone()).ok().map(|r| FinalWork::Active(r, running.execution.clone()))
            },
            Err(TryRecvError::Empty) => None,
        } });
        let cfg = config(&self.shared);
        let recovery = std::mem::replace(&mut self.recovery, Recovery::Initial);
        self.recovery = match recovery {
            Recovery::Initial => { let shared = self.shared.clone(); let skip = self.registry.tickets();
                Recovery::Loading { job: lifecycle::Job::start(move || recover(&shared, skip)), initial: true } },
            Recovery::Ready { next } if next <= Instant::now() => { let shared = self.shared.clone(); let skip = self.registry.tickets();
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
        if let Some(job) = &mut self.workspace_job {
            if let Some(result) = job.poll() {
                match result {
                    Ok(Ok(status)) => {
                        self.disk_admission = status.admission.clone();
                        self.disk_observed = Instant::now();
                        dlog("workspace", &serde_json::to_string(&status).unwrap_or_default());
                        if let Ok(mut snapshot) = snap.lock() { snapshot.workspaces = Some(status); }
                    },
                    Ok(Err(error)) | Err(error) => {
                        self.disk_admission = workspace::Admission::Held { reason: error.clone() };
                        dlog("workspace", &format!("reconciliation incomplete; retained for retry: {error}"));
                    },
                }
                self.workspace_job = None; self.next_workspace = Instant::now() + workspace::INTERVAL;
            }
        }
        // Disk ownership is per workspace, not a global idle barrier. Held
        // jobs/update drain cannot starve reclamation of unrelated allocations.
        if self.next_workspace <= Instant::now() && self.workspace_job.is_none() {
            let cfg = cfg.clone();
            let protected = self.registry.tickets();
            self.workspace_job = Some(lifecycle::Job::start(move || workspace::Owner::open(&cfg)?.reconcile(&protected)));
        }
        let disk_ready = matches!(self.disk_admission, workspace::Admission::Ready) && self.disk_observed.elapsed()<Duration::from_secs(120);
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
            Admission::Idle { until } if recovered && locally_ready && disk_ready && !stop && !update && self.registry.can_admit() && until <= Instant::now() => {
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
            let mut attention=std::collections::HashSet::new();
            for (ticket, reason) in self.registry.held() { attention.insert((ticket.task_id.clone(),format!("lifecycle held with durable ownership: {reason}"))); }
            if let Admission::Held { reason } = &self.admission { attention.insert(("gateway".into(),reason.clone())); }
            if let Recovery::Held { reason } = &self.recovery { attention.insert(("gateway".into(),reason.clone())); }
            // Display deduplication only; this set never supplies eligibility,
            // process proof or a recovery decision.
            for (scope,reason) in attention.difference(&self.reported_attention) {dlog(scope,reason);}
            self.reported_attention=attention;
            self.last_snapshot = Instant::now();
        }
        Ok(())
    }
}

fn durable_handoff(cfg:&DispatchConfig,owner:&Ownership,value:&FinalWork,stop:bool)->bool {
    match value {
        FinalWork::Fresh(record)|FinalWork::Journal(record)|FinalWork::Observe(record)=>{
            let Ok(root)=terminal_root(cfg) else {return false};
            for path in [root.join(record.name()),root.join("archive").join(record.name())] {
                let saved=std::fs::read(path).ok().and_then(|bytes|serde_json::from_slice::<Record>(&bytes).ok());
                if let Some(saved)=saved {
                    if saved.validate().is_ok() && &saved.owner==owner && saved.host==cfg.label.as_deref().unwrap_or("") && saved.url==cfg.url.trim_end_matches('/')
                        && (!stop || matches!(saved.work,Work::Stopped {..}|Work::Unstarted {..})) {return true;}
                }
            }
            false
        },
        FinalWork::Legacy(receipt)=>!stop && matches!(owner,Ownership::Attempt {ticket,host,generation,attempt_id}
            if ticket.task_id==receipt.task_id && ticket.session==receipt.session && host==&receipt.host && *generation==receipt.generation && attempt_id==&receipt.attempt_id)
            && cfg.label.as_deref()==Some(receipt.host.as_str()) && cfg.url.trim_end_matches('/')==receipt.url
            && stopped_outbox_root().is_some_and(|root|stopped_outbox::retained(&root,receipt)),
        FinalWork::Active(_,_)=>false,
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
    let startup_request = update_request();
    let commit = option_env!("BRIDGE_BUILD_COMMIT").unwrap_or("unknown");
    let startup_cause = match &startup_request {
        Some(UpdateRequest::Handoff { target: Some(target), .. }) if target == commit => "managed upgrade restart",
        Some(UpdateRequest::Handoff { .. }) => "managed handoff in progress",
        _ => "service start",
    };
    let mut previous_request = None;
    dlog("gateway", &format!(
        "Gateway controller started: version {}, commit {}, PID {}, {} execution slots ({startup_cause})",
        env!("CARGO_PKG_VERSION"), commit, std::process::id(), cfg.max_sessions
    ));
    loop {
        let request = update_request();
        if request != previous_request {
            if let Some(UpdateRequest::Handoff { source, target, .. }) = &request {
                dlog("gateway", &format!("Managed upgrade handoff: {} → {}",
                    source.as_deref().unwrap_or("unknown"), target.as_deref().unwrap_or("unknown")));
            } else if request.is_none() {
                dlog("gateway", "Managed upgrade handoff ended");
            }
            readiness.maintenance.wake();
            previous_request = request.clone();
        }
        if let Some(controller) = &mut controller {
            if let Err(error) = controller.tick(&snap, stop.load(Ordering::SeqCst), request.is_some()) {
                dlog("gateway", &error);
                if let Ok(mut last) = last_error.lock() { *last = Some(error); }
            }
        }
        let active = controller.as_ref().map(Controller::active).unwrap_or(0);
        if let Some(request) = request {
            if last_update_receipt.elapsed() >= Duration::from_secs(1) {
            if let UpdateRequest::Handoff { nonce, mode, .. } = &request {
            let adopting = matches!(mode,UpdateHandoff::AdoptWorkerV1);
            let restart_ready = adopting && controller.as_ref().map(Controller::controller_ready).unwrap_or(true);
            if matches!(update_train_barrier(if restart_ready { 0 } else { active }, &train_stop, &mut train)?, UpdateTrainBarrier::Quiescent) {
                if restart_ready {
                    update_receipt("idle.json", &json!({"nonce":nonce,"pid":std::process::id(),"phase":"controller_ready","worker_protocol":worker_session::PROTOCOL}));
                } else {
                    update_receipt("idle.json", &json!({"nonce":nonce,"pid":std::process::id(),"phase":"idle"}));
                }
            }
            }
            if readiness.data.lock().map(|d| d.state.connection_fresh(Duration::from_secs(60))).unwrap_or(false) {
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
    #[test]
    fn durable_job_wait_can_handoff_without_releasing_charge_or_losing_unknown_work() {
        let hub=Hub::new(|_|Some(json!({"kind":"writer_receipt_held","reason":"outside action unknown"})));
        let (cfg,ready,snap)=fixture(&hub);
        let record=Record {owner:Ownership::Attempt {ticket:Ticket {task_id:"durable-wait".into(),session:"original".into()},host:cfg.label.clone().unwrap(),generation:1,attempt_id:"one".into()},
            host:cfg.label.clone().unwrap(),url:cfg.url.clone(),observed_at:1,process:None,disposition:Disposition::Rejected {reason:"outside action unknown".into()},work:Work::UnknownWriter {reason:"protected".into()}};
        let mut controller=Controller::new(&cfg,&ready,&snap);
        controller.recovery=Recovery::Ready {next:Instant::now()+Duration::from_secs(300)};
        controller.registry.restore_finalization(record.owner.clone(),FinalWork::Journal(record.clone())).ok().unwrap();
        assert!(!controller.controller_ready(),"an in-memory result cannot be handed off");
        journal::insert(&terminal_root(&cfg).unwrap(),record.clone()).unwrap();
        let before=std::fs::read(terminal_root(&cfg).unwrap().join(record.name())).unwrap();
        assert!(controller.controller_ready(),"durable job ownership is not an active controller writer");
        assert_eq!(controller.registry.counts().charged,1,"handoff must not release uncertain execution capacity");
        controller.registry.drain();
        assert!(!controller.controller_ready(),"an undelivered explicit stop remains a barrier");
        assert_eq!(std::fs::read(terminal_root(&cfg).unwrap().join(record.name())).unwrap(),before);
        drop(controller);drop(ready);let _=std::fs::remove_dir_all(root(&cfg).unwrap());
    }
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
        let mut cfg: DispatchConfig = serde_json::from_value(json!({"url":hub.url,"token":"fixture-only","label":format!("pipeline-fixture-{}-{}",std::process::id(),hub.url.rsplit(':').next().unwrap()),"max_sessions":20})).unwrap();
        cfg.workdir = root(&cfg).unwrap().join("disk").to_string_lossy().into_owned();
        let label = format!("{}/worker", cfg.label.as_ref().unwrap());
        let ready = GatewayReadiness::with_probe(&cfg, Duration::from_secs(3600), move |_| Ok(WorkerCredential { label: label.clone(), secret: "fixture-only".into() }));
        (cfg, ready, Arc::new(Mutex::new(DispatchSnapshot::default())))
    }

    fn writer_proof_reply(owner: &Ownership) -> serde_json::Value {
        let Ownership::Attempt { ticket, host, generation, attempt_id } = owner else { panic!("attempt required") };
        json!({"kind":"writer_receipt_found","task_id":ticket.task_id,"command_id":"actual-physical-proof","source":"quiesce",
            "proof":{"host":host,"session":ticket.session,"generation":generation,"attempt_id":attempt_id,"phase":"quiesced","writers":"process_group_empty"}})
    }

    #[test]
    fn historical_writer_proof_releases_only_old_unknown_ownership_and_keeps_all_evidence() {
        let proof = Arc::new(Mutex::new(json!({"kind":"writer_receipt_missing"}))); let response = proof.clone();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0)); let seen = reads.clone();
        let hub = Hub::new(move |request| {
            // BR#9843: a missing receipt now probes the live fence before the
            // kernel scan; an unconfirmable fence keeps the charge held.
            if request["params"]["arguments"]["command"]["kind"] == "inspect" { return Some(json!({})); }
            assert_eq!(request["params"]["arguments"]["command"]["kind"],"writer_receipt","recovery may only observe canonical stop proof");
            seen.fetch_add(1,Ordering::SeqCst); Some(response.lock().unwrap().clone())
        });
        let (cfg,ready,snap) = fixture(&hub);
        let terminal = terminal_root(&cfg).unwrap();
        let wip = root(&cfg).unwrap().join("retained-work"); journal::write_file(&wip,b"unpublished work").unwrap();
        let ticket = Ticket {task_id:"old-task".into(),session:"old-session".into()};
        let record = Record {owner:Ownership::Attempt {ticket:ticket.clone(),host:cfg.label.clone().unwrap(),generation:1,attempt_id:"old-attempt".into()},
            host:cfg.label.clone().unwrap(),url:cfg.url.clone(),observed_at:now_ms(),process:None,disposition:Disposition::Rejected {reason:"old missing proof".into()},
            work:Work::Unproven {outcome:Outcome {kind:OutcomeKind::ResultUnavailable,exit_code:None,stdout_tail:"original captured tail".into(),stderr_tail:"original transport loss".into(),cause:None},worktree:Some(wip.clone())}};
        journal::insert(&terminal,record.clone()).unwrap();
        let launch_path=root(&cfg).unwrap().join("launches").join(record.name());
        let launch=serde_json::to_vec(&Launch {record:record.clone(),worktree:Some(wip.clone()),stage:LaunchStage::MayHaveLaunched}).unwrap();
        journal::write_file(&launch_path,&launch).unwrap();
        let original = std::fs::read(terminal.join(record.name())).unwrap();
        let reservation = reservation_path(&cfg,&ticket).unwrap(); journal::write_file(&reservation,b"newer attempt with the SAME session").unwrap();
        let mut controller=Controller::new(&cfg,&ready,&snap);
        controller.registry.restore_finalization(record.owner.clone(),FinalWork::Journal(record.clone())).ok().unwrap();
        let deadline=Instant::now()+Duration::from_secs(12);
        while reads.load(Ordering::SeqCst)==0 {controller.registry.poll(|_|None);assert!(Instant::now()<deadline);std::thread::sleep(Duration::from_millis(1));}
        assert_eq!(controller.registry.counts().charged,1,"missing proof cannot release a writer");
        assert_eq!(std::fs::read(terminal.join(record.name())).unwrap(),original);
        *proof.lock().unwrap()=writer_proof_reply(&record.owner);
        while !controller.registry.is_idle() {controller.registry.poll(|_|None);assert!(Instant::now()<deadline);std::thread::sleep(Duration::from_millis(1));}
        assert_eq!(controller.registry.counts().charged,0);
        assert!(!terminal.join(record.name()).exists());
        assert_eq!(std::fs::read(terminal.join("archive").join(record.name())).unwrap(),original);
        assert_eq!(std::fs::read(&wip).unwrap(),b"unpublished work");
        assert_eq!(std::fs::read(reservation).unwrap(),b"newer attempt with the SAME session");
        let archived:serde_json::Value=serde_json::from_slice(&std::fs::read(root(&cfg).unwrap().join("reconciled-writer-proofs").join(record.name())).unwrap()).unwrap();
        assert_eq!(archived["record"]["work"]["outcome"]["stdout_tail"],"original captured tail");
        assert_eq!(archived["receipt"]["kind"],"writer_receipt_found");
        assert_eq!(archived["launch_record"].as_str().unwrap().as_bytes(),launch);
        assert!(!launch_path.exists());
        drop(controller);drop(ready);let _=std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    #[test]
    fn stopped_recovery_is_locked_dry_by_default_and_preserves_newer_or_unproved_work() {
        let owner=Arc::new(Mutex::new(None::<Ownership>));let expected=owner.clone();
        let hub=Hub::new(move |request| {
            let c=&request["params"]["arguments"]["command"];
            // BR#9843: a missing receipt now probes the live fence before the
            // kernel scan; an unconfirmable fence keeps the record waiting.
            if c["kind"]=="inspect" { return Some(json!({})); }
            assert_eq!(c["kind"],"writer_receipt","offline recovery cannot replay a mutation");
            Some(match c["generation"].as_u64().unwrap() {
                1=>writer_proof_reply(expected.lock().unwrap().as_ref().unwrap()),
                3=>json!({"kind":"writer_receipt_held","reason":"outside action result unknown"}),
                _=>json!({"kind":"writer_receipt_missing"}),
            })
        });
        let (cfg,ready,_)=fixture(&hub);let terminal=terminal_root(&cfg).unwrap();
        let record=|generation|Record {owner:Ownership::Attempt {ticket:Ticket {task_id:"same-task".into(),session:"same-session".into()},host:cfg.label.clone().unwrap(),generation,attempt_id:format!("attempt-{generation}")},
            host:cfg.label.clone().unwrap(),url:cfg.url.clone(),observed_at:generation,process:None,disposition:Disposition::Rejected {reason:"retained".into()},work:Work::UnknownWriter {reason:"old uncertain writer".into()}};
        let old=record(1);*owner.lock().unwrap()=Some(old.owner.clone());
        let newer=record(2);let uncertain=record(3);
        let captured=Record {work:Work::Unproven {outcome:Outcome {kind:OutcomeKind::Completed,exit_code:Some(0),stdout_tail:"real result still needs delivery".into(),stderr_tail:String::new(),cause:None},worktree:Some(root(&cfg).unwrap().join("captured-work"))},..record(4)};
        for r in [&old,&newer,&uncertain,&captured] {journal::insert(&terminal,r.clone()).unwrap();}
        let bytes=|r:&Record|std::fs::read(terminal.join(r.name())).unwrap();
        let old_bytes=bytes(&old);let newer_bytes=bytes(&newer);let uncertain_bytes=bytes(&uncertain);let captured_bytes=bytes(&captured);
        let lock_path=root(&cfg).unwrap().join("test-controller.lock");
        let lock=worker_session::Lock::acquire(&lock_path).unwrap().unwrap();
        assert!(reconcile_locked(&cfg,true,None,&lock_path).unwrap_err().contains("live controller lock"));drop(lock);
        let dry=reconcile_locked(&cfg,false,None,&lock_path).unwrap();
        assert_eq!(dry["eligible"].as_array().unwrap().len(),1);assert_eq!(dry["waiting"].as_array().unwrap().len(),3);assert_eq!(dry["protected"],1);
        assert_eq!(bytes(&old),old_bytes);assert!(!root(&cfg).unwrap().join("reconciled-writer-proofs").exists());
        let worker_root=root(&cfg).unwrap().join("workers").join(old.name().trim_end_matches(".json"));
        journal::write_file(&worker_root.join("retained-output"),b"live worker's result").unwrap();
        let live_worker=worker_session::Lock::acquire(&worker_root.join("worker.lock")).unwrap().unwrap();
        assert!(reconcile_locked(&cfg,true,None,&lock_path).unwrap()["waiting"].as_array().unwrap().iter().any(|v|v["reason"].as_str().is_some_and(|s|s.contains("Independent worker"))));
        assert_eq!(bytes(&old),old_bytes);assert!(worker_root.exists());drop(live_worker);
        let applied=reconcile_locked(&cfg,true,None,&lock_path).unwrap();assert_eq!(applied["eligible"][0]["applied"],true);
        assert_eq!(std::fs::read(terminal.join("archive").join(old.name())).unwrap(),old_bytes);
        assert_eq!(bytes(&newer),newer_bytes);assert_eq!(bytes(&uncertain),uncertain_bytes);assert_eq!(bytes(&captured),captured_bytes);
        assert!(reconcile_locked(&cfg,true,None,&lock_path).unwrap()["eligible"].as_array().unwrap().is_empty(),"repeat cannot replay a write or discard protected records");
        drop(ready);let _=std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    #[test]
    fn stopped_recovery_rechecks_authority_before_archiving_the_active_record() {
        let owner=Arc::new(Mutex::new(None::<Ownership>));let expected=owner.clone();
        let reads=Arc::new(std::sync::atomic::AtomicUsize::new(0));let seen=reads.clone();
        let hub=Hub::new(move |_|Some(if seen.fetch_add(1,Ordering::SeqCst)==0 {writer_proof_reply(expected.lock().unwrap().as_ref().unwrap())} else {json!({"kind":"writer_receipt_missing"})}));
        let (cfg,ready,_)=fixture(&hub);let terminal=terminal_root(&cfg).unwrap();
        let record=Record {owner:Ownership::Attempt {ticket:Ticket {task_id:"old-task".into(),session:"old-session".into()},host:cfg.label.clone().unwrap(),generation:1,attempt_id:"one".into()},
            host:cfg.label.clone().unwrap(),url:cfg.url.clone(),observed_at:1,process:None,disposition:Disposition::Rejected {reason:"old failure".into()},work:Work::UnknownWriter {reason:"unknown".into()}};
        *owner.lock().unwrap()=Some(record.owner.clone());journal::insert(&terminal,record.clone()).unwrap();
        let before=std::fs::read(terminal.join(record.name())).unwrap();
        assert!(!reconcile_locked(&cfg,true,None,&root(&cfg).unwrap().join("test.lock")).unwrap()["waiting"].as_array().unwrap().is_empty());
        assert_eq!(reads.load(Ordering::SeqCst),2);assert_eq!(std::fs::read(terminal.join(record.name())).unwrap(),before);
        drop(ready);let _=std::fs::remove_dir_all(root(&cfg).unwrap());
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
    fn recovery_finalizes_only_launches_that_never_crossed_the_boundary() {
        let hub = Hub::new(|request| {
            let command = &request["params"]["arguments"]["command"];
            match command["kind"].as_str().unwrap() {
                "schedule" => Some(json!({"kind":"no_eligible_work"})),
                "inspect" => Some(json!({})),
                other => panic!("recovery should only inspect the hub, got {other}"),
            }
        });
        let (cfg, ready, _) = fixture(&hub);
        let task = "preparation-fixture";
        let session = claim_session(&cfg, task);
        arm_launch(&cfg, task, 1, "before-boundary", None, None, LaunchStage::Preparing).unwrap();
        let recovered = recover(&ready.data, Vec::new()).unwrap();
        assert!(matches!(recovered.as_slice(), [Recovered::Final(_, FinalWork::Journal(record))]
            if matches!(record.work, Work::Stopped { writers: WriterProof::ProcessGroupEmpty, .. })));
        let terminal = terminal_root(&cfg).unwrap();
        std::fs::remove_dir_all(terminal).unwrap();
        assert_eq!(claim_session(&cfg, task), session);
        cross_launch_boundary(&cfg, task, 1, "before-boundary").unwrap();
        // The independent worker arms its transport again after the parent
        // starts the unit. This must never rewind the launch boundary.
        arm_launch(&cfg, task, 1, "before-boundary", None, None, LaunchStage::MayHaveLaunched).unwrap();
        let recovered = recover(&ready.data, Vec::new()).unwrap();
        assert!(matches!(recovered.as_slice(), [Recovered::Final(_, FinalWork::Journal(record))]
            if matches!(record.work, Work::Unproven { .. })));
        let launch = launches_for(&cfg, &Ticket { task_id: task.into(), session }).unwrap().pop().unwrap();
        let mut legacy = serde_json::to_value(launch).unwrap();
        legacy.as_object_mut().unwrap().remove("stage");
        assert!(serde_json::from_value::<Launch>(legacy).unwrap().unstarted_work(String::new()).is_none());
        drop(ready);
        let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    #[test]
    fn offline_reservation_recovery_is_controller_fenced_read_only_by_default_and_exact() {
        let hub=Hub::new(|request| {
            if request["params"]["name"]=="execution" {
                assert_eq!(request["params"]["arguments"]["command"]["kind"],"writer_receipt");
                return Some(json!({"kind":"writer_receipt_held","reason":"Unknown outside action"}));
            }
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
        assert!(reconcile_locked(&cfg,true,None,&lock_path).unwrap_err().contains("live controller lock is held"));
        drop(lock);
        let dry=reconcile_locked(&cfg,false,None,&lock_path).unwrap();
        assert_eq!(dry["eligible"].as_array().unwrap().len(),1);assert_eq!(dry["waiting"].as_array().unwrap().len(),2);
        assert_eq!(std::fs::read(terminal.join(ended.name())).unwrap(),original);
        let applied=reconcile_locked(&cfg,true,None,&lock_path).unwrap();
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
        let result=reconcile_locked(&cfg,true,None,&root(&cfg).unwrap().join("controller-test.lock"));
        assert!(result.unwrap()["waiting"].as_array().unwrap().iter().any(|v|v["reason"].as_str().is_some_and(|s|s.contains("reservation still belongs"))));
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
                assert_eq!(request["params"]["arguments"]["view"], "execution");
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
        assert!(!controller.registry.is_idle(),"an unchanged claim cannot retire job ownership");
        assert_eq!(controller.registry.counts().charged,1);
        assert_eq!(cancels.load(Ordering::SeqCst),1);
        assert!(reads.load(Ordering::SeqCst) as u64<=1+started.elapsed().as_secs()/RESERVATION_OBSERVATION_INTERVAL.as_secs(),"a wait must be paced, not a foreground polling storm");
        assert!(matches!(journal::pending(&terminal_root(&cfg).unwrap(),cfg.label.as_ref().unwrap(),&cfg.url).unwrap()[0].disposition,Disposition::Rejected { .. }),"rollback builds must still understand the retained journal");
        released.store(true,Ordering::SeqCst);
        while controller.registry.counts().charged>0 {
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
        let reads=Arc::new(std::sync::atomic::AtomicUsize::new(0));let seen=reads.clone();
        let hub=Hub::new(move |request| {
            assert_eq!(request["params"]["arguments"]["command"]["kind"],"writer_receipt","unknown writer/effect cannot be turned into reservation cleanup");
            seen.fetch_add(1,Ordering::SeqCst);
            Some(json!({"kind":"writer_receipt_held","reason":"outside action result unknown"}))
        });
        let (cfg,ready,snap)=fixture(&hub);
        let record=Record { owner:Ownership::Attempt { ticket:Ticket { task_id:"unknown".into(),session:"session".into() },host:cfg.label.clone().unwrap(),generation:1,attempt_id:"unknown-one".into() },
            host:cfg.label.clone().unwrap(),url:cfg.url.clone(),observed_at:now_ms(),process:None,
            disposition:Disposition::Rejected { reason:"gate: unknown external effect".into() },work:Work::UnknownWriter { reason:"physical proof missing".into() } };
        journal::insert(&terminal_root(&cfg).unwrap(),record.clone()).unwrap();
        let before=std::fs::read(terminal_root(&cfg).unwrap().join(record.name())).unwrap();
        let mut controller=Controller::new(&cfg,&ready,&snap);
        controller.registry.restore_finalization(record.owner.clone(),FinalWork::Journal(record.clone())).ok().unwrap();
        let deadline=Instant::now()+Duration::from_secs(12);
        while reads.load(Ordering::SeqCst)<2 { controller.registry.poll(|_|None); assert!(Instant::now()<deadline); std::thread::sleep(Duration::from_millis(1)); }
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
        finalizer_recovers_after_lost_ack(false);
    }

    #[test]
    fn legacy_missing_capture_finalizes_after_lost_ack_without_replaying() {
        finalizer_recovers_after_lost_ack(true);
    }

    fn finalizer_recovers_after_lost_ack(legacy_missing: bool) {
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
            if legacy_missing {
                assert_eq!(args["command"]["outcome"]["kind"], "result_unavailable");
                assert_eq!(args["command"]["outcome"]["stdout_tail"], "the exact captured result survives restart");
            }
            let mut ids = observed.lock().unwrap(); ids.push(args["command_id"].as_str().unwrap().into());
            if ids.len() == 1 { return None; }
            Some(json!({"attempt":{"phase":"quiesced","host":*bound_host.lock().unwrap(),"session":args["session"],"generation":1,"attempt_id":"captured-one"}}))
        });
        let (cfg, ready, snap) = fixture(&hub); *host.lock().unwrap() = cfg.label.clone().unwrap();
        let owner = Ownership::Attempt { ticket: Ticket { task_id: "terminal-fixture".into(), session: "captured-session".into() }, host: cfg.label.clone().unwrap(), generation: 1, attempt_id: "captured-one".into() };
        let record = Record { owner: owner.clone(), url: cfg.url.clone(), host: cfg.label.clone().unwrap(), observed_at: 1, disposition: Disposition::Pending, process: None,
            work: Work::Stopped { outcome: Outcome { kind: OutcomeKind::Completed, exit_code: Some(0), stdout_tail: "the exact captured result survives restart".into(), stderr_tail: String::new(), cause: None }, writers: WriterProof::ProcessGroupEmpty, worktree: None, step: Step::Stop } };
        let record = if legacy_missing {
            let path = root(&cfg).unwrap().join("missing-old-worktree");
            let missing = std::io::Error::from_raw_os_error(libc::ENOENT);
            let reason = format!("gate: checkpoint worktree unavailable at {}: {missing}; retained journal requires workspace reconciliation", path.display());
            let mut record = record;
            record.disposition = Disposition::Rejected { reason: reason.clone() };
            if let Work::Stopped { outcome, worktree, step, .. } = &mut record.work {
                outcome.kind = OutcomeKind::ResultUnavailable;
                outcome.exit_code = None;
                *worktree = Some(path);
                *step = Step::Capture;
            }
            assert!(legacy_missing_capture(&record, &reason));
            assert!(!legacy_missing_capture(&record, "gate: unknown external effect"));
            record
        } else { record };
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
        let pending = journal::pending(&terminal_root(&cfg).unwrap(), cfg.label.as_ref().unwrap(), &cfg.url).unwrap();
        assert_eq!(pending.len(), 1);
        assert!(matches!(pending[0].work, Work::Stopped { step: Step::Finalize, .. }),
            "a failed finalize must preserve the acknowledged stopped boundary");
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
            work: Work::Stopped { outcome: Outcome { kind: OutcomeKind::Completed, exit_code: Some(0), stdout_tail: "original result".into(), stderr_tail: String::new(), cause: None }, writers: WriterProof::ProcessGroupEmpty, worktree: Some(work.clone()), step: Step::Capture } };
        journal::insert(&terminal_root(&cfg).unwrap(), record).unwrap();
        let mut controller = Controller::new(&cfg, &ready, &snap); let deadline = Instant::now() + Duration::from_secs(3);
        while !controller.idle() { controller.tick(&snap, true, false).unwrap(); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(1)); }
        assert_eq!(std::fs::read_to_string(work.join("keep")).unwrap(), "newer generation's work");
        drop(controller); let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    // ---- BR#9843: fence-scoped writer self-heal ---------------------------

    fn fake_proc(cfg: &DispatchConfig) -> PathBuf {
        let root = root(cfg).unwrap().join("fake-proc");
        std::fs::create_dir_all(root.join("sys/kernel/random")).unwrap();
        std::fs::write(root.join("sys/kernel/random/boot_id"), "fixture-boot-id\n").unwrap();
        root
    }
    fn fake_uid() -> u32 { unsafe { libc::getuid() } }
    /// One /proc-shaped census entry. `environ_dir` makes environ unreadable
    /// (a directory read fails on every platform, root included).
    fn fake_entry(root: &Path, pid: u32, uid: u32, env: Option<&str>, cmdline: &str, unit: Option<&str>, environ_dir: bool) {
        let dir = root.join(pid.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stat"), format!("{pid} (fixture) S 1 {pid} {pid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 77 0 0")).unwrap();
        std::fs::write(dir.join("status"), format!("Name:\tfixture\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n")).unwrap();
        std::fs::write(dir.join("cmdline"), cmdline.replace(' ', "\0")).unwrap();
        let unit_path = unit.map(|unit| format!("/user.slice/user-{uid}.slice/user@{uid}.service/{unit}")).unwrap_or_else(|| "/user.slice".into());
        std::fs::write(dir.join("cgroup"), format!("0::{unit_path}\n")).unwrap();
        if environ_dir { std::fs::create_dir_all(dir.join("environ")).unwrap(); }
        else { std::fs::write(dir.join("environ"), format!("{}\0", env.unwrap_or(""))).unwrap(); }
    }
    fn fence_env(owner: &Ownership) -> String {
        format!("BRIDGE_TASK_ID={}\0BRIDGE_EXECUTOR_SESSION={}\0BRIDGE_EXECUTION_FENCE={}",
            owner.ticket().task_id, owner.ticket().session, serde_json::to_string(owner).unwrap())
    }
    fn unclaimed_record(cfg: &DispatchConfig, task: &str, generation: u64) -> Record {
        Record { owner: Ownership::Attempt { ticket: Ticket { task_id: task.into(), session: "original".into() }, host: cfg.label.clone().unwrap(), generation, attempt_id: format!("attempt-{generation}") },
            host: cfg.label.clone().unwrap(), url: cfg.url.clone(), observed_at: 1, process: None,
            disposition: Disposition::Rejected { reason: "crashed before stop receipt".into() },
            work: Work::UnknownWriter { reason: "Daemon restarted without a terminal process-group-empty receipt".into() } }
    }
    fn inspect_state(owner: &Ownership, phase: &str) -> serde_json::Value {
        let Ownership::Attempt { ticket, host, generation, attempt_id } = owner else { panic!("attempt required") };
        json!({"attempt":{"phase":phase,"host":host,"session":ticket.session,"generation":generation,"attempt_id":attempt_id},"handoff":{"phase":"none"},"operations":[]})
    }
    fn fence_reply(owner: &Ownership, phase: &str, writers: &serde_json::Value) -> serde_json::Value {
        let Ownership::Attempt { ticket, host, generation, attempt_id } = owner else { panic!("attempt required") };
        json!({"attempt":{"phase":phase,"host":host,"session":ticket.session,"generation":generation,"attempt_id":attempt_id,"writers":writers}})
    }

    // 1. Crashed-runner record + live exact-fence process -> fenced stop,
    //    stopped→finalize delivered, reservation/journal retired.
    #[test]
    fn fence_scan_live_orphan_is_fenced_stopped_then_finalized() {
        let owner = Arc::new(Mutex::new(None::<Ownership>));
        let calls = Arc::new(Mutex::new(Vec::<String>::new())); let observed = calls.clone();
        let bound = owner.clone();
        let hub = Hub::new(move |request| {
            let command = &request["params"]["arguments"]["command"];
            match command["kind"].as_str().unwrap() {
                "schedule" => Some(json!({"kind":"no_eligible_work"})),
                "writer_receipt" => Some(json!({"kind":"writer_receipt_missing"})),
                "inspect" => Some(inspect_state(bound.lock().unwrap().as_ref().unwrap(), "running")),
                "stopped" | "finalize" => {
                    observed.lock().unwrap().push(command["kind"].as_str().unwrap().into());
                    Some(fence_reply(&bound.lock().unwrap().clone().unwrap(), if command["kind"] == "stopped" { "finalizing" } else { "quiesced" }, &command["writers"]))
                },
                "receipt" => Some(json!({"kind":"receipt_missing"})),
                other => panic!("self-heal must not repeat effects, got {other}"),
            }
        });
        let (cfg, ready, snap) = fixture(&hub);
        let record = unclaimed_record(&cfg, "orphan-live", 1);
        *owner.lock().unwrap() = Some(record.owner.clone());
        let proc = fake_proc(&cfg);
        fake_entry(&proc, 3900001, fake_uid(), Some(&fence_env(&record.owner)), "/usr/bin/bridge internal-worker fixture", None, false);
        let ticket = record.ticket().clone();
        let terminal = terminal_root(&cfg).unwrap();
        journal::insert(&terminal, record.clone()).unwrap();
        let reservation = reservation_path(&cfg, &ticket).unwrap();
        journal::write_file(&reservation, b"persisted reservation").unwrap();
        let mut controller = Controller::new(&cfg, &ready, &snap);
        controller.registry.restore_finalization(record.owner.clone(), FinalWork::Journal(record.clone())).ok().unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !controller.registry.is_idle() { controller.registry.poll(|_| None); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(1)); }
        assert_eq!(controller.registry.counts().charged, 0, "the fence-scoped stop must release the immortal charge");
        assert_eq!(*calls.lock().unwrap(), vec!["stopped".to_string(), "finalize".to_string()], "delivery rides the normal stopped→finalize path");
        assert!(journal::pending(&terminal, cfg.label.as_deref().unwrap(), &cfg.url).unwrap().is_empty());
        let archived: Record = serde_json::from_slice(&std::fs::read(terminal.join("archive").join(record.name())).unwrap()).unwrap();
        assert_eq!(archived.owner, record.owner, "the delivered record is archived, not discarded");
        let evidence: serde_json::Value = serde_json::from_slice(&std::fs::read(root(&cfg).unwrap().join("reconciled-writer-proofs").join(record.name())).unwrap()).unwrap();
        assert_eq!(evidence["record"]["work"]["kind"], "unknown_writer", "the original crashed-runner record is preserved as scan evidence");
        assert_eq!(evidence["scan"]["stopped"][0]["pid"], 3900001);
        assert_eq!(evidence["scan"]["stopped"][0]["via"], "environ");
        assert!(!reservation.exists(), "finalization retires the persisted reservation");
        drop(controller); drop(ready); let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    // 2. Complete readable census with no match -> NoLiveGroupMembers proof,
    //    honest ResultUnavailable, saved outcome/worktree preserved.
    #[test]
    fn complete_census_absence_discharges_and_preserves_captured_work() {
        let owner = Arc::new(Mutex::new(None::<Ownership>));
        let stopped = Arc::new(Mutex::new(Vec::<serde_json::Value>::new())); let seen = stopped.clone();
        let bound = owner.clone();
        let hub = Hub::new(move |request| {
            let command = &request["params"]["arguments"]["command"];
            match command["kind"].as_str().unwrap() {
                "schedule" => Some(json!({"kind":"no_eligible_work"})),
                "writer_receipt" => Some(json!({"kind":"writer_receipt_missing"})),
                "inspect" => Some(inspect_state(bound.lock().unwrap().as_ref().unwrap(), "stopping")),
                "stopped" => { seen.lock().unwrap().push(command.clone()); Some(fence_reply(&bound.lock().unwrap().clone().unwrap(), "finalizing", &command["writers"])) },
                "finalize" => Some(fence_reply(&bound.lock().unwrap().clone().unwrap(), "quiesced", &command["writers"])),
                "receipt" => Some(json!({"kind":"receipt_missing"})),
                other => panic!("unexpected effect {other}"),
            }
        });
        let (cfg, ready, snap) = fixture(&hub);
        let mut record = unclaimed_record(&cfg, "orphan-absent", 4);
        record.work = Work::Unproven { outcome: Outcome { kind: OutcomeKind::ResultUnavailable, exit_code: None, stdout_tail: "original captured tail".into(), stderr_tail: "original transport loss".into(), cause: None },
            worktree: Some(root(&cfg).unwrap().join("retained-work")) };
        *owner.lock().unwrap() = Some(record.owner.clone());
        let wip = root(&cfg).unwrap().join("retained-work"); journal::write_file(&wip, b"unpublished work").unwrap();
        let proc = fake_proc(&cfg);
        fake_entry(&proc, 3900011, fake_uid().wrapping_add(4242), Some("PATH=/bin"), "compiler --job", None, false); // foreign owner: provably not ours
        fake_entry(&proc, 3900012, fake_uid(), None, "/bin/sleep 60", None, false); // same uid, unrelated, readable
        let other_task = Ownership::Attempt { ticket: Ticket { task_id: "another-task".into(), session: "another-session".into() }, host: "h".into(), generation: 9, attempt_id: "nine".into() };
        fake_entry(&proc, 3900013, fake_uid(), Some(&fence_env(&other_task)), "bridge internal-worker other", None, false); // another fence's worker
        let terminal = terminal_root(&cfg).unwrap();
        journal::insert(&terminal, record.clone()).unwrap();
        let mut controller = Controller::new(&cfg, &ready, &snap);
        controller.registry.restore_finalization(record.owner.clone(), FinalWork::Journal(record.clone())).ok().unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !controller.registry.is_idle() { controller.registry.poll(|_| None); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(1)); }
        assert_eq!(controller.registry.counts().charged, 0, "kernel-proved absence must release the charge");
        let stopped = stopped.lock().unwrap();
        assert_eq!(stopped[0]["writers"], "no_live_group_members");
        assert_eq!(stopped[0]["outcome"]["stdout_tail"], "original captured tail", "the saved unproven outcome is preserved, never synthesized");
        drop(stopped);
        assert_eq!(std::fs::read(&wip).unwrap(), b"unpublished work");
        let evidence: serde_json::Value = serde_json::from_slice(&std::fs::read(root(&cfg).unwrap().join("reconciled-writer-proofs").join(record.name())).unwrap()).unwrap();
        assert_eq!(evidence["scan"]["result"], "absent");
        assert_eq!(evidence["scan"]["scanned"], 2, "every readable same-uid entry backs the proof (foreign-owner entries are provably not ours)");
        drop(controller); drop(ready); let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    // 3. An unreadable same-UID entry holds (fail closed); an env-blind entry
    //    kernel-provably inside ANOTHER fence's unit never blocks the proof.
    #[test]
    fn unreadable_same_uid_census_holds_fail_closed() {
        let owner = Arc::new(Mutex::new(None::<Ownership>));
        let bound = owner.clone();
        let hub = Hub::new(move |request| {
            let command = &request["params"]["arguments"]["command"];
            match command["kind"].as_str().unwrap() {
                "writer_receipt" => Some(json!({"kind":"writer_receipt_missing"})),
                "inspect" => Some(inspect_state(bound.lock().unwrap().as_ref().unwrap(), "running")),
                other => panic!("a hold must not stop or finalize anything, got {other}"),
            }
        });
        let (cfg, ready, _) = fixture(&hub);
        let record = unclaimed_record(&cfg, "orphan-hold", 2);
        *owner.lock().unwrap() = Some(record.owner.clone());
        let proc = fake_proc(&cfg);
        fake_entry(&proc, 3900021, fake_uid(), None, "/bin/sleep 60", None, true); // environ unreadable, no bridge markers
        let terminal = terminal_root(&cfg).unwrap();
        journal::insert(&terminal, record.clone()).unwrap();
        let before = std::fs::read(terminal.join(record.name())).unwrap();
        let lock = root(&cfg).unwrap().join("test.lock");
        let held = reconcile_locked(&cfg, true, None, &lock).unwrap();
        assert!(held["waiting"].as_array().unwrap().iter().any(|v| v["reason"].as_str().is_some_and(|s| s.contains("cannot be proved outside this fence"))), "unreadable same-uid evidence must hold");
        assert_eq!(std::fs::read(terminal.join(record.name())).unwrap(), before, "a hold writes nothing");
        assert!(!root(&cfg).unwrap().join("reconciled-writer-proofs").exists());
        // The same env-blind entry, kernel-cgroup-provable as another fence's
        // worker, is provably not ours — the census may then discharge.
        let entry = proc.join("3900021");
        std::fs::remove_dir_all(entry.join("environ")).unwrap();
        std::fs::write(entry.join("cgroup"), "0::/user.slice/bridge-worker-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service\n").unwrap();
        let applied = reconcile_locked(&cfg, true, None, &lock).unwrap();
        assert_eq!(applied["eligible"].as_array().unwrap().len(), 1);
        let saved: Record = serde_json::from_slice(&std::fs::read(terminal.join(record.name())).unwrap()).unwrap();
        assert!(matches!(saved.work, Work::Stopped { writers: WriterProof::NoLiveGroupMembers, .. }));
        drop(ready); let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    // 4. A sibling writer marker (our task/session, different fence) never
    //    matches and never releases.
    #[test]
    fn sibling_fence_marker_never_matches_or_releases() {
        let owner = Arc::new(Mutex::new(None::<Ownership>));
        let bound = owner.clone();
        let hub = Hub::new(move |request| {
            let command = &request["params"]["arguments"]["command"];
            match command["kind"].as_str().unwrap() {
                "writer_receipt" => Some(json!({"kind":"writer_receipt_missing"})),
                "inspect" => Some(inspect_state(bound.lock().unwrap().as_ref().unwrap(), "running")),
                other => panic!("a sibling fence must not be touched, got {other}"),
            }
        });
        let (cfg, ready, _) = fixture(&hub);
        let record = unclaimed_record(&cfg, "orphan-sibling", 1);
        *owner.lock().unwrap() = Some(record.owner.clone());
        let mut sibling = record.owner.clone();
        if let Ownership::Attempt { generation, .. } = &mut sibling { *generation = 2; }
        let proc = fake_proc(&cfg);
        fake_entry(&proc, 3900031, fake_uid(), Some(&fence_env(&sibling)), "bridge internal-worker sibling", None, false);
        let terminal = terminal_root(&cfg).unwrap();
        journal::insert(&terminal, record.clone()).unwrap();
        let before = std::fs::read(terminal.join(record.name())).unwrap();
        let result = reconcile_locked(&cfg, true, None, &root(&cfg).unwrap().join("test.lock")).unwrap();
        assert!(result["waiting"].as_array().unwrap().iter().any(|v| v["reason"].as_str().is_some_and(|s| s.contains("different fence"))));
        assert_eq!(std::fs::read(terminal.join(record.name())).unwrap(), before);
        drop(ready); let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    // 5. The hub's current attempt is newer — an old fence never discharges
    //    against it.
    #[test]
    fn newer_hub_attempt_is_untouched_by_an_old_fence_discharge() {
        let current = Arc::new(Mutex::new(None::<Ownership>));
        let bound = current.clone();
        let hub = Hub::new(move |request| {
            let command = &request["params"]["arguments"]["command"];
            match command["kind"].as_str().unwrap() {
                "writer_receipt" => Some(json!({"kind":"writer_receipt_missing"})),
                "inspect" => Some(inspect_state(bound.lock().unwrap().as_ref().unwrap(), "running")),
                other => panic!("an old fence must not stop or finalize a newer attempt, got {other}"),
            }
        });
        let (cfg, ready, _) = fixture(&hub);
        let record = unclaimed_record(&cfg, "orphan-old", 1);
        let mut newer = record.owner.clone();
        if let Ownership::Attempt { generation, attempt_id, .. } = &mut newer { *generation = 2; attempt_id.clear(); attempt_id.push_str("attempt-2"); }
        *current.lock().unwrap() = Some(newer);
        let terminal = terminal_root(&cfg).unwrap();
        journal::insert(&terminal, record.clone()).unwrap();
        let before = std::fs::read(terminal.join(record.name())).unwrap();
        let result = reconcile_locked(&cfg, true, None, &root(&cfg).unwrap().join("test.lock")).unwrap();
        assert!(result["waiting"].as_array().unwrap().iter().any(|v| v["reason"].as_str().is_some_and(|s| s.contains("fence"))));
        assert_eq!(std::fs::read(terminal.join(record.name())).unwrap(), before);
        assert!(!root(&cfg).unwrap().join("reconciled-writer-proofs").exists());
        drop(ready); let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }

    // 6. Write-ahead identity: every crash window around begin leaves the
    //    daemon able to self-identify the attempt.
    #[test]
    fn write_ahead_begin_intent_covers_every_crash_window() {
        let live: Arc<Mutex<std::collections::BTreeMap<String, serde_json::Value>>> = Arc::new(Mutex::new(Default::default()));
        let observed = live.clone();
        let hub = Hub::new(move |request| {
            let args = &request["params"]["arguments"];
            assert_eq!(args["command"]["kind"], "inspect", "recovery may only observe");
            Some(observed.lock().unwrap().get(args["id"].as_str().unwrap()).cloned().unwrap_or(json!({"attempt":null})))
        });
        let (cfg, ready, _) = fixture(&hub);
        let ticket = |task: &str| Ticket { task_id: task.into(), session: "original".into() };
        // (a) crash between the intent write and begin: no live attempt at all.
        persist_begin_intent(&cfg, "before-begin", "original", "attempt-before", None).unwrap();
        journal::write_file(&reservation_path(&cfg, &ticket("before-begin")).unwrap(), &serde_json::to_vec(&Input { ticket: ticket("before-begin"), task: None }).unwrap()).unwrap();
        // (b) crash between begin and the launch journal: intent matches the
        // live echoed attempt and carries the worktree.
        let worktree = root(&cfg).unwrap().join("intent-work");
        persist_begin_intent(&cfg, "after-begin", "original", "attempt-after", Some(worktree.clone())).unwrap();
        journal::write_file(&reservation_path(&cfg, &ticket("after-begin")).unwrap(), &serde_json::to_vec(&Input { ticket: ticket("after-begin"), task: None }).unwrap()).unwrap();
        live.lock().unwrap().insert("after-begin".into(), json!({"attempt":{"session":"original","phase":"running","generation":7,"attempt_id":"attempt-after"}}));
        // (c) a live attempt this daemon never began: stays fail-closed.
        persist_begin_intent(&cfg, "foreign-begin", "original", "attempt-mismatch", None).unwrap();
        journal::write_file(&reservation_path(&cfg, &ticket("foreign-begin")).unwrap(), &serde_json::to_vec(&Input { ticket: ticket("foreign-begin"), task: None }).unwrap()).unwrap();
        live.lock().unwrap().insert("foreign-begin".into(), json!({"attempt":{"session":"original","phase":"running","generation":2,"attempt_id":"attempt-live"}}));
        let recovered = recover(&ready.data, Vec::new()).unwrap();
        let record_for = |task: &str| recovered.iter().find_map(|item| match item {
            Recovered::Final(_, FinalWork::Journal(record)) if record.ticket().task_id == task => Some(record.clone()),
            _ => None,
        }).unwrap_or_else(|| panic!("recovery must journal {task}"));
        assert!(matches!(record_for("before-begin").work, Work::Unstarted { .. }), "no begin -> the reservation reconciliation path");
        let identified = record_for("after-begin");
        match &identified.work {
            Work::Unproven { outcome, worktree: Some(path) } => {
                assert_eq!(*path, worktree, "the intent's worktree is preserved for the kernel discharge");
                assert!(matches!(outcome.kind, OutcomeKind::ResultUnavailable));
                assert!(outcome.stderr_tail.contains("launch boundary"), "the outcome is honest about what is and is not known");
            },
            _ => panic!("an identified begin must retain an honest unproven result"),
        }
        let Ownership::Attempt { generation, .. } = &identified.owner else { panic!("fence required") };
        assert_eq!(*generation, 7);
        assert!(matches!(record_for("foreign-begin").work, Work::UnknownWriter { .. }), "an attempt this daemon never began stays fail-closed");
        drop(ready); let _ = std::fs::remove_dir_all(root(&cfg).unwrap());
    }
}
