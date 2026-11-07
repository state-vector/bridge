//! A worker owns its transport and lease independently of the controller.
//! Controllers attach to the same immutable attempt, never spawn a replacement
//! from a conversation ID. Files are the reconnectable, fenced local protocol.
use super::*;
use super::attempt_journal::{self as journal, Record, Work, Outcome, OutcomeKind, Disposition, Step, WriterProof};
use super::lifecycle::{Ownership, Ticket};
use std::{fs, sync::mpsc};

pub const PROTOCOL: u32 = 1;

#[derive(Clone, Serialize, Deserialize)]
pub struct Agent {
    pub workdir: String, pub bin: String, pub backend: String,
    pub agent: Option<String>, pub model: String, pub prompt: String,
    pub resume: Option<String>, pub config: Option<String>, pub mode: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Spec {
    pub protocol: u32, pub owner: Ownership, pub cfg: DispatchConfig,
    pub title: String, pub worktree: Option<PathBuf>, pub scratch: Option<PathBuf>,
    pub started_at: u64, pub agent: Agent,
}
impl Spec {
    pub fn record(&self) -> Record {
        Record { owner: self.owner.clone(), host: self.cfg.label.clone().unwrap_or_default(), url: self.cfg.url.trim_end_matches('/').into(),
            observed_at: self.started_at, process: None, disposition: Disposition::Pending,
            work: Work::UnknownWriter { reason: "Independent worker owns launch/result reconciliation".into() } }
    }
    fn validate(&self) -> Result<(), String> {
        if self.protocol != PROTOCOL { return Err("gate: unsupported live-worker protocol".into()); }
        self.record().validate()?;
        if self.agent.workdir.is_empty() || self.agent.bin.is_empty() { return Err("gate: worker launch inputs missing".into()); }
        Ok(())
    }
    fn root(&self) -> Result<PathBuf, String> { Ok(gateway_pipeline::root(&self.cfg)?.join("workers").join(self.record().name().trim_end_matches(".json"))) }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum State {
    Running { protocol: u32, owner: Ownership, pid: u32, observed_at: u64, line: String },
    Finished { owner: Ownership },
}

pub(super) struct Lock(fs::File);
impl Lock {
    pub(super) fn acquire(path: &Path) -> Result<Option<Self>, String> {
        let mut options = fs::OpenOptions::new(); options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let file = options.open(path).map_err(|e| e.to_string())?;
        #[cfg(unix)] {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return if std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK) { Ok(None) } else { Err(std::io::Error::last_os_error().to_string()) };
            }
        }
        #[cfg(not(unix))] return Err("independent worker locking requires Unix".into());
        Ok(Some(Self(file)))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        #[cfg(unix)] { use std::os::fd::AsRawFd; unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN); } }
    }
}

pub fn supported() -> bool {
    // Separate systemd units survive controller service stop/restart, including
    // the default KillMode=control-group. Other hosts retain legacy safe drain.
    #[cfg(target_os = "linux")] { return PathBuf::from(format!("/run/user/{}/bus", unsafe { libc::getuid() })).exists(); }
    #[cfg(not(target_os = "linux"))] false
}

fn persist_spec(spec: &Spec) -> Result<PathBuf, String> {
    spec.validate()?;
    let root = spec.root()?; fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?; }
    let path = root.join("request.json");
    match fs::read(&path) {
        Ok(bytes) => {
            let old: Spec = serde_json::from_slice(&bytes).map_err(|e| format!("gate: worker manifest corrupt: {e}"))?;
            if serde_json::to_vec(&old).map_err(|e| e.to_string())? != serde_json::to_vec(spec).map_err(|e| e.to_string())? { return Err("gate: immutable worker launch input changed".into()); }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => journal::write_file(&path, &serde_json::to_vec(spec).map_err(|e| e.to_string())?)?,
        Err(e) => return Err(e.to_string()),
    }
    Ok(path)
}

pub fn launch(spec: Spec, cancel: Option<Arc<AtomicBool>>) -> Result<InFlight, String> {
    let path = persist_spec(&spec)?;
    if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        let _ = unlaunched(&spec, "Preparation cancelled before independent process creation".into());
        return attach_with_stop(spec, cancel);
    }
    let mut command = Command::new("systemd-run");
    command.args(["--user", "--quiet", "--collect", "--service-type=exec", "--property=Restart=no", "--property=KillMode=control-group"])
        .arg(format!("--property=EnvironmentFile=-{}/.bridge/env", std::env::var("HOME").map_err(|e| e.to_string())?))
        .arg(format!("--setenv=PATH={}", std::env::var("PATH").unwrap_or_default()))
        .arg(format!("--setenv=BRIDGE_TASK_ID={}", spec.owner.ticket().task_id))
        .arg(format!("--setenv=BRIDGE_EXECUTOR_SESSION={}", spec.owner.ticket().session))
        .arg(format!("--setenv=BRIDGE_EXECUTION_FENCE={}", serde_json::to_string(&spec.owner).map_err(|e| e.to_string())?))
        .arg(format!("--property=RuntimeMaxSec={}", spec.cfg.timeout_mins.saturating_mul(60).saturating_add(180)))
        .arg(format!("--unit=bridge-worker-{}", spec.record().name().trim_end_matches(".json")))
        .arg(std::env::current_exe().map_err(|e| e.to_string())?).arg("internal-worker").arg(&path);
    // An ambiguous systemd response must not launch a second writer. The unit
    // name and worker lock are stable; retain the attempt and observe its WAL.
    match run_with_timeout(command, 10) {
        Ok(out) if out.status.success() => {},
        result => dlog(&spec.owner.ticket().task_id, &format!("worker launch awaiting exact unit reconciliation: {}", match result { Ok(out) => String::from_utf8_lossy(&out.stderr).into_owned(), Err(e) => e })),
    }
    attach_with_stop(spec, cancel)
}

pub struct Handle {
    pub owner: Ownership,
    pub rx: mpsc::Receiver<Record>, pub stop: Arc<AtomicBool>,
    pub reattachable: Arc<AtomicBool>, detached: Arc<AtomicBool>,
}
impl Drop for Handle { fn drop(&mut self) { self.detached.store(true, Ordering::SeqCst); } }

pub fn attach(spec: Spec) -> Result<InFlight, String> {
    attach_with_stop(spec, None)
}
fn attach_with_stop(spec: Spec, cancelled: Option<Arc<AtomicBool>>) -> Result<InFlight, String> {
    spec.validate()?;
    let root = spec.root()?;
    let live = Arc::new(Mutex::new(String::new())); let observed = live.clone();
    let completed = Arc::new(AtomicBool::new(false)); let finished = completed.clone();
    let stop = cancelled.unwrap_or_else(|| Arc::new(AtomicBool::new(false))); let requested = stop.clone();
    let detached = Arc::new(AtomicBool::new(false)); let left = detached.clone();
    let reattachable = Arc::new(AtomicBool::new(false)); let ready = reattachable.clone();
    let (tx, rx) = mpsc::channel(); let request = spec.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(45);
        while !left.load(Ordering::SeqCst) {
            let result_path = gateway_pipeline::terminal_root(&request.cfg).map(|r| r.join(request.record().name()));
            if let Ok(Some(record)) = result_path.and_then(|p| read_record(&p)) {
                if record.owner == request.owner { ready.store(false, Ordering::SeqCst); let _ = tx.send(record); finished.store(true, Ordering::SeqCst); return; }
            }
            if requested.load(Ordering::SeqCst) {
                let _ = journal::write_file(&root.join("stop.json"), &serde_json::to_vec(&request.owner).unwrap());
            }
            let state = fs::read(root.join("state.json")).ok().and_then(|b| serde_json::from_slice::<State>(&b).ok());
            let owns_lock = matches!(Lock::acquire(&root.join("worker.lock")), Ok(None));
            let alive = match state {
                Some(State::Running { protocol, owner, pid, observed_at, line }) if protocol == PROTOCOL && owner == request.owner && pid > 1 && owns_lock && now_ms().saturating_sub(observed_at) < 5_000 => {
                    if let Ok(mut last) = observed.lock() { *last = line; } true
                }, _ => false,
            };
            ready.store(alive, Ordering::SeqCst);
            if !owns_lock && Instant::now() > deadline {
                // A dead worker is not proof that its agent descendants stopped.
                let launch = gateway_pipeline::launch_record(&request.cfg, &request.record());
                let mut record = request.record();
                record.process = launch.and_then(|r| r.process);
                if record.process.is_some() { record.work = Work::Unproven { outcome: Outcome { kind: OutcomeKind::ResultUnavailable, exit_code: None, stdout_tail: String::new(), stderr_tail: "Independent worker exited without a durable result; preserve/check kernel identity before continuation".into() }, worktree: request.worktree.clone() }; }
                if let Ok(root) = gateway_pipeline::terminal_root(&request.cfg) { let _ = journal::insert(&root, record.clone()); }
                let _ = tx.send(record); finished.store(true, Ordering::SeqCst); return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
    let Ownership::Attempt { generation, attempt_id, .. } = &spec.owner else { return Err("gate: worker adoption requires an exact attempt".into()); };
    Ok(InFlight { task_id: spec.owner.ticket().task_id.clone(), task_title: spec.title, completed,
        role_work: false, started: Instant::now() - Duration::from_millis(now_ms().saturating_sub(spec.started_at)), last_note: String::new(),
        worktree: spec.worktree, scratch: spec.scratch, pr_url: None, rx: mpsc::channel().1, live,
        execution: ExecutionRuntime { generation: *generation, attempt_id: attempt_id.clone(), control: Arc::new(crate::transport::RunControl::default()), maintenance: None, last_checkpoint: Instant::now() },
        worker: Some(Handle { owner: spec.owner.clone(), rx, stop, reattachable, detached }) })
}

fn read_record(path: &Path) -> Result<Option<Record>, String> {
    match fs::read(path) {
        Ok(bytes) => { let record: Record = serde_json::from_slice(&bytes).map_err(|e| format!("gate: worker result corrupt: {e}"))?; record.validate()?; Ok(Some(record)) },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None), Err(e) => Err(e.to_string()),
    }
}

pub fn discover(cfg: &DispatchConfig, skip: &[Ticket]) -> Result<Vec<InFlight>, String> {
    let root = gateway_pipeline::root(cfg)?.join("workers");
    let entries = match fs::read_dir(root) { Ok(entries) => entries, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]), Err(e) => return Err(e.to_string()) };
    let mut result = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !path.is_dir() { continue; }
        let bytes = match fs::read(path.join("request.json")) {
            Ok(bytes) => bytes,
            // A crash before manifest publication is still owned by the
            // existing launch/reservation WAL. Do not freeze every other task.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        let spec: Spec = serde_json::from_slice(&bytes).map_err(|e| format!("gate: worker manifest corrupt: {e}"))?;
        spec.validate()?;
        if spec.root()? != path || spec.cfg.url.trim_end_matches('/') != cfg.url.trim_end_matches('/') || spec.cfg.label != cfg.label { return Err("gate: worker belongs to another host/hub".into()); }
        if skip.contains(spec.owner.ticket()) { continue; }
        // Retired manifests are evidence, not new jobs. Never re-adopt an old
        // attempt after its immutable terminal delivery has been archived.
        if gateway_pipeline::terminal_root(cfg)?.join("archive").join(spec.record().name()).exists() { continue; }
        result.push(attach(spec)?);
    }
    Ok(result)
}

pub fn command(cfg: &DispatchConfig, stop: bool, task: Option<&str>) -> Result<serde_json::Value, String> {
    let root = gateway_pipeline::root(cfg)?.join("workers");
    let entries = match fs::read_dir(&root) { Ok(entries) => entries, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({"workers":[]})), Err(e) => return Err(e.to_string()) };
    let mut workers = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        let spec: Spec = serde_json::from_slice(&fs::read(path.join("request.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        spec.validate()?;
        if spec.root()? != path || spec.cfg.label != cfg.label || spec.cfg.url.trim_end_matches('/') != cfg.url.trim_end_matches('/') { return Err("gate: worker scope mismatch".into()); }
        if task.is_some_and(|id| id != spec.owner.ticket().task_id) { continue; }
        if stop { journal::write_file(&path.join("stop.json"), &serde_json::to_vec(&spec.owner).map_err(|e| e.to_string())?)?; }
        let state = fs::read(path.join("state.json")).ok().and_then(|b| serde_json::from_slice::<State>(&b).ok());
        let locked = matches!(Lock::acquire(&path.join("worker.lock")), Ok(None));
        workers.push(json!({"owner":spec.owner,"state":state,"worker_lock_held":locked,"stop_requested":stop}));
    }
    Ok(json!({"workers":workers,"note":if stop { "Fenced stop requested; writer quiescence still requires the worker result/host proof" } else { "Local supervised-worker observations; hub slot/lease state remains authoritative" }}))
}

pub fn retire(cfg: &DispatchConfig, record: &Record) -> Result<(), String> {
    let root = gateway_pipeline::root(cfg)?.join("workers").join(record.name().trim_end_matches(".json"));
    if !root.exists() { return Ok(()); }
    let Some(_lock) = Lock::acquire(&root.join("worker.lock"))? else { return Err("Independent worker is completing its terminal WAL; retry retirement".into()); };
    let archive = gateway_pipeline::root(cfg)?.join("workers-archive");
    fs::create_dir_all(&archive).map_err(|e| e.to_string())?;
    fs::rename(&root, archive.join(record.name().trim_end_matches(".json"))).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn entry(path: &Path) -> Result<(), String> {
    let mut spec: Spec = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    spec.validate()?;
    if path.canonicalize().map_err(|e| e.to_string())? != spec.root()?.join("request.json").canonicalize().map_err(|e| e.to_string())? { return Err("gate: worker manifest location does not match its owner".into()); }
    let cfg = DispatchConfig::resolve().ok_or("worker credential unavailable")?;
    if cfg.url.trim_end_matches('/') != spec.cfg.url.trim_end_matches('/') || cfg.label != spec.cfg.label { return Err("gate: worker credential scope changed".into()); }
    spec.cfg.token = cfg.token;
    execute(spec)
}

fn execute(spec: Spec) -> Result<(), String> {
    execute_every(spec, Duration::from_secs(20))
}
fn execute_every(spec: Spec, lease_interval: Duration) -> Result<(), String> {
    let root = spec.root()?;
    let Some(_lock) = Lock::acquire(&root.join("worker.lock"))? else { return Ok(()); };
    #[cfg(all(target_os = "linux", not(test)))] {
        let unit = format!("/bridge-worker-{}.service", spec.record().name().trim_end_matches(".json"));
        let groups = fs::read_to_string("/proc/self/cgroup").map_err(|e| e.to_string())?;
        if !groups.lines().any(|line| line.rsplit(':').next().is_some_and(|group| group.ends_with(&unit))) { return Err("gate: worker must run in its independent exact systemd unit".into()); }
    }
    if gateway_pipeline::terminal_root(&spec.cfg)?.join(spec.record().name()).exists() || gateway_pipeline::terminal_root(&spec.cfg)?.join("archive").join(spec.record().name()).exists() { return Ok(()); }
    if root.join("started.json").exists() { return Err("gate: this worker already executed; reconcile its result/descendants, never relaunch the same fence".into()); }
    let ticket = spec.owner.ticket();
    remember_claim_session(&spec.cfg, &ticket.task_id, &ticket.session);
    let Ownership::Attempt { generation, attempt_id, host, .. } = &spec.owner else { return Err("gate: worker needs an attempt fence".into()); };
    // Inspect cannot extend a lease. Renew through the original exact fence
    // before granting a fresh local monotonic deadline; retry the SAME command
    // if its response is lost. No begin/new generation is issued on adoption.
    let mut renewed = Err("worker lease renewal unavailable".to_string());
    for _ in 0..3 {
        renewed = execution_request(&spec.cfg, &ticket.task_id, &ticket.session, &spec.record().command_id("worker-start-poll"), json!({"kind":"poll","generation":generation,"attempt_id":attempt_id}));
        if renewed.as_ref().err().is_none_or(|error| !retryable_execution_error(error)) { break; }
        std::thread::sleep(Duration::from_millis(200));
    }
    let state = match renewed { Ok(state) => state, Err(error) => return unlaunched(&spec, error) };
    if let Err(error) = RemoteExecution::parse(state.clone()) { return unlaunched(&spec, error); }
    let a = &state["attempt"];
    if a["generation"] != *generation || a["attempt_id"] != *attempt_id || a["host"] != *host || a["session"] != ticket.session || a["phase"] != "running" || a["lease_until"].as_u64().unwrap_or(0) < now_ms().saturating_add(90_000) { return unlaunched(&spec, "gate: worker no longer owns its live exact execution fence".into()); }
    journal::write_file(&root.join("started.json"), &serde_json::to_vec(&spec.owner).unwrap())?;
    EXECUTION_FENCES.get_or_init(Default::default).lock().unwrap().insert(ticket.task_id.clone(), (*generation, attempt_id.clone()));
    let control = match gateway_pipeline::arm_launch(&spec.cfg, &ticket.task_id, *generation, attempt_id, spec.worktree.clone(), None) { Ok(control) => control, Err(error) => return unlaunched(&spec, error) };
    let mut runtime = ExecutionRuntime { generation: *generation, attempt_id: attempt_id.clone(), control: Arc::new(control), maintenance: None, last_checkpoint: Instant::now() };
    runtime.control.grant_lease();
    let live = Arc::new(Mutex::new(String::new())); runtime.start_maintenance_every(&spec.cfg, &ticket.task_id, live.clone(), lease_interval);
    let published = live.clone(); let stop = runtime.control.clone(); let owner = spec.owner.clone(); let status_root = root.clone();
    let output_path = workspace::Owner::open(&spec.cfg)?.output_path(ticket)?.unwrap_or_else(|| root.join("output.jsonl"));
    let mut previous = String::new();
    let status = move || {
        if let Ok(bytes) = fs::read(status_root.join("stop.json")) {
            if serde_json::from_slice::<Ownership>(&bytes).ok().as_ref() == Some(&owner) { stop.stop.store(true, Ordering::SeqCst); }
        }
        let line = published.lock().map(|s| s.clone()).unwrap_or_default();
        if !line.is_empty() && line != previous {
            let persisted = (|| -> std::io::Result<()> {
                use std::io::Write;
                // Workspace output is expendable and bounded; exact terminal
                // results/operation receipts remain in the durable journal.
                let truncate = fs::metadata(&output_path).map(|m| m.len() >= 4 * 1024 * 1024).unwrap_or(false);
                let mut options = fs::OpenOptions::new(); options.create(true).write(true).append(!truncate).truncate(truncate);
                #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
                let mut file = options.open(&output_path)?;
                writeln!(file, "{}", json!({"at":now_ms(),"line":line}))?; file.sync_data()
            })();
            if persisted.is_err() { stop.stop.store(true, Ordering::SeqCst); }
            else { previous = line.clone(); }
        }
        let state = State::Running { protocol: PROTOCOL, owner: owner.clone(), pid: std::process::id(), observed_at: now_ms(), line };
        if journal::write_file(&status_root.join("state.json"), &serde_json::to_vec(&state).unwrap()).is_err() { stop.stop.store(true, Ordering::SeqCst); }
        true
    };
    let publisher = LeaseMaintenance::start(Duration::from_secs(1), status); publisher.wake();
    if fs::read(root.join("stop.json")).ok().and_then(|bytes| serde_json::from_slice::<Ownership>(&bytes).ok()).as_ref() == Some(&spec.owner) { runtime.control.stop.store(true, Ordering::SeqCst); }
    let out = opencode::run_task(&spec.agent.workdir, &spec.agent.bin, opencode::Backend::parse(Some(&spec.agent.backend)), spec.agent.agent.as_deref(), Some(&spec.agent.model), &spec.agent.prompt,
        Duration::from_secs(spec.cfg.timeout_mins * 60), Some(&format!("bridge-{}", ticket.task_id)), spec.agent.resume.as_deref(), spec.agent.config.as_deref(), spec.agent.mode.as_deref(), Some(live), Some(runtime.control.clone()));
    runtime.stop_maintenance(); publisher.stop();
    loop {
        match gateway_pipeline::capture(&spec.cfg, &ticket.task_id, &runtime, &out, spec.worktree.clone()) {
            Ok(_) => break,
            Err(error) => { dlog(&ticket.task_id, &format!("terminal WAL unavailable; independent worker retains its result and ownership: {error}")); std::thread::sleep(Duration::from_secs(1)); },
        }
    }
    if opencode::Backend::parse(Some(&spec.agent.backend)) == opencode::Backend::Kiro { if let Some(id) = out.session_id { save_session_id(&ticket.task_id, &id); } }
    journal::write_file(&root.join("state.json"), &serde_json::to_vec(&State::Finished { owner: spec.owner.clone() }).unwrap())?;
    // Credentials/prompt are no longer needed once the terminal WAL is durable.
    // Retain the immutable manifest until finalization archives this attempt.
    Ok(())
}

fn unlaunched(spec: &Spec, reason: String) -> Result<(), String> {
    // This branch is reached only before the transport is called while holding
    // the never-before-executed worker lock. It is actual no-child proof.
    let mut record = spec.record();
    record.work = Work::Stopped { outcome: Outcome { kind: OutcomeKind::Interrupted, exit_code: None, stdout_tail: String::new(), stderr_tail: reason.clone() },
        writers: WriterProof::ProcessGroupEmpty, worktree: spec.worktree.clone(), step: Step::Stop };
    journal::insert(&gateway_pipeline::terminal_root(&spec.cfg)?, record)?;
    Err(reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use super::super::gateway_pipeline::tests::{Hub, fixture};

    fn child(which: &str, path: &Path) -> Command {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", which, "--ignored", "--nocapture"]).env("BRIDGE_WORKER_FIXTURE", path);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(unix)] { use std::os::unix::process::CommandExt; cmd.process_group(0); }
        cmd
    }
    fn fixture_spec(path: &Path) -> Spec {
        let mut spec: Spec = serde_json::from_slice(&fs::read(path).unwrap()).unwrap(); spec.cfg.token = "fixture-only".into(); spec
    }
    #[test]
    #[ignore = "subprocess entry invoked by the real controller restart drill"]
    fn worker_process_entry() {
        let path = PathBuf::from(std::env::var_os("BRIDGE_WORKER_FIXTURE").unwrap());
        execute_every(fixture_spec(&path), Duration::from_millis(200)).unwrap();
    }
    #[test]
    #[ignore = "subprocess controller entry invoked by the real restart drill"]
    fn controller_process_entry() {
        let path = PathBuf::from(std::env::var_os("BRIDGE_WORKER_FIXTURE").unwrap());
        let spec = fixture_spec(&path);
        let _worker = child("dispatch::worker_session::tests::worker_process_entry", &path).spawn().unwrap();
        let ticks = spec.root().unwrap().join("ticks");
        let view = attach(spec).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !view.worker.as_ref().unwrap().reattachable.load(Ordering::SeqCst) || !ticks.exists() { assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10)); }
        if std::env::var("BRIDGE_WORKER_FIXTURE_ABRUPT").as_deref() == Ok("1") {
            fs::write(ticks.with_file_name("controller-ready"), "ready").unwrap();
            while Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
        }
        // Returning exits the actual controller process and all of its reader
        // threads. The separately grouped worker keeps the transport and lease.
    }
    struct Sandbox(PathBuf);
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::write(self.0.join("release"), "release");
            let until = Instant::now() + Duration::from_secs(3);
            while matches!(Lock::acquire(&self.0.join("worker.lock")), Ok(None)) && Instant::now() < until { std::thread::sleep(Duration::from_millis(20)); }
            if !matches!(Lock::acquire(&self.0.join("worker.lock")), Ok(None)) { let _ = fs::remove_dir_all(&self.0); }
        }
    }
    #[cfg(unix)]
    #[test]
    fn real_controller_exit_adopts_same_live_worker_continuous_lease_and_one_result() {
        restart_drill(false);
    }
    #[cfg(unix)]
    #[test]
    fn real_acp_session_survives_controller_exit_without_new_session_or_prompt() {
        restart_drill(true);
    }
    #[test]
    fn spent_worker_fence_and_expired_startup_lease_never_launch_an_agent() {
        for spent in [true, false] {
            let host = Arc::new(Mutex::new(String::new())); let bound = host.clone();
            let hub = Hub::new(move |request| {
                assert!(!spent, "a spent fence must fail before any renewal or agent launch");
                let args = &request["params"]["arguments"];
                assert_eq!(args["command"]["kind"], "poll");
                Some(json!({"policy_version":1,"attempt":{"phase":"running","host":*bound.lock().unwrap(),"session":"old-session","generation":1,"attempt_id":"spent-one","lease_until":now_ms()-1},"messages":[]}))
            });
            let (cfg, _, _) = fixture(&hub); *host.lock().unwrap() = cfg.label.clone().unwrap();
            let spec = Spec { protocol:PROTOCOL, owner:Ownership::Attempt { ticket:Ticket { task_id:"spent-worker".into(),session:"old-session".into() },host:cfg.label.clone().unwrap(),generation:1,attempt_id:"spent-one".into() }, cfg:cfg.clone(),title:"never launch".into(),worktree:None,scratch:None,started_at:now_ms(),
                agent:Agent { workdir:".".into(),bin:"must-not-execute".into(),backend:"opencode".into(),agent:None,model:"fixture".into(),prompt:"fixture".into(),resume:None,config:None,mode:Some("stdio".into()) } };
            persist_spec(&spec).unwrap(); let root=spec.root().unwrap(); let _sandbox=Sandbox(root.clone());
            if spent { journal::write_file(&root.join("started.json"), &serde_json::to_vec(&spec.owner).unwrap()).unwrap(); }
            let error = execute_every(spec.clone(), Duration::from_millis(200)).unwrap_err();
            assert!(error.contains(if spent { "already executed" } else { "live exact execution fence" }));
            let terminal = gateway_pipeline::terminal_root(&cfg).unwrap().join(spec.record().name());
            assert_eq!(terminal.exists(), !spent, "never fabricate no-writer proof for a previously executed fence");
            if !spent { assert!(!root.join("started.json").exists()); }
            let _ = fs::remove_dir_all(gateway_pipeline::root(&cfg).unwrap());
        }
    }
    #[test]
    fn incomplete_manifest_publication_does_not_freeze_unrelated_recovery() {
        let hub = Hub::new(|_| panic!("discovery cannot manufacture a lease or launch"));
        let (cfg, _, _) = fixture(&hub);
        let scope = gateway_pipeline::root(&cfg).unwrap();
        let partial = scope.join("workers/partial-publication"); fs::create_dir_all(&partial).unwrap();
        assert!(discover(&cfg, &[]).unwrap().is_empty(), "uncommitted manifests remain in launch-intent recovery");
        fs::write(partial.join("request.json"), "{}").unwrap();
        assert!(discover(&cfg, &[]).err().unwrap().contains("gate: worker manifest corrupt"), "committed corrupt identities must remain fail-closed");
        let _ = fs::remove_dir_all(scope);
    }
    #[cfg(unix)]
    fn restart_drill(acp: bool) {
        use std::os::unix::fs::PermissionsExt;
        let host = Arc::new(Mutex::new(String::new())); let bound = host.clone();
        let calls = Arc::new(Mutex::new(Vec::<String>::new())); let observed = calls.clone();
        let hub = Hub::new(move |request| {
            let args = &request["params"]["arguments"]; let kind = args["command"]["kind"].as_str().unwrap(); observed.lock().unwrap().push(kind.into());
            if kind == "receipt" { return Some(json!({"kind":"receipt_missing"})); }
            if kind == "schedule" { return Some(json!({"kind":"no_eligible_work"})); }
            assert!(matches!(kind, "inspect" | "poll" | "stopped" | "finalize"), "adoption must not begin a new generation or repeat agent work: {kind}");
            Some(json!({"policy_version":1,"attempt":{"phase":match kind { "stopped" => "finalizing", "finalize" => "quiesced", _ => "running" },
                "host":*bound.lock().unwrap(),"session":"adopt-session","generation":1,"attempt_id":"one-live-worker","lease_until":now_ms()+120_000,"writers":args["command"]["writers"]},"messages":[],"task_status":"todo"}))
        });
        let (cfg, readiness, snap) = fixture(&hub); *host.lock().unwrap() = cfg.label.clone().unwrap();
        let mut spec = Spec { protocol: PROTOCOL, owner: Ownership::Attempt { ticket: Ticket { task_id: "adopt-live".into(), session: "adopt-session".into() }, host: cfg.label.clone().unwrap(), generation: 1, attempt_id: "one-live-worker".into() },
            cfg: cfg.clone(), title: "same running session".into(), worktree: None, scratch: None, started_at: now_ms(),
            agent: Agent { workdir: String::new(), bin: String::new(), backend: "opencode".into(), agent: None, model: "fixture".into(), prompt: "fixture".into(), resume: None, config: None, mode: Some(if acp { "acp" } else { "stdio" }.into()) } };
        let root = spec.root().unwrap(); fs::create_dir_all(&root).unwrap(); let _sandbox = Sandbox(root.clone());
        let agent = root.join("agent.sh");
        let script = if acp { r#"#!/usr/bin/env python3
import json, pathlib, sys, time
root = pathlib.Path.cwd()
def send(value):
    print(json.dumps(value), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if method == 'session/new':
        with (root / 'starts').open('a') as output: output.write('start\n')
        send({'jsonrpc':'2.0','id':request['id'],'result':{'sessionId':'original-acp-session'}})
    elif method == 'session/prompt':
        for i in range(200):
            if (root / 'release').exists(): break
            with (root / 'ticks').open('a') as output: output.write('x')
            send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'original-acp-session','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':f'worker tick {i}'}}}})
            time.sleep(0.05)
        send({'jsonrpc':'2.0','id':request['id'],'result':{'stopReason':'end_turn'}})
    elif method == 'initialize':
        send({'jsonrpc':'2.0','id':request['id'],'result':{'protocolVersion':1}})
"#.to_string() } else { format!("#!/bin/sh\nprintf 'start\\n' >> '{0}/starts'\ni=0\nwhile [ ! -f '{0}/release' ] && [ $i -lt 200 ]; do printf x >> '{0}/ticks'; printf 'worker tick\\n'; i=$((i+1)); sleep 0.05; done\n", root.display()) };
        fs::write(&agent, script).unwrap();
        fs::set_permissions(&agent, fs::Permissions::from_mode(0o700)).unwrap();
        spec.agent.workdir = root.to_string_lossy().into(); spec.agent.bin = agent.to_string_lossy().into();
        let path = persist_spec(&spec).unwrap();
        let mut launch = child("dispatch::worker_session::tests::controller_process_entry", &path);
        if acp { launch.env("BRIDGE_WORKER_FIXTURE_ABRUPT", "1"); }
        let mut first_controller = launch.spawn().unwrap();
        if acp {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !root.join("controller-ready").exists() { assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10)); }
            first_controller.kill().unwrap();
            assert!(!first_controller.wait().unwrap().success(), "ACP drill must actually kill the controller process");
        } else {
            assert!(first_controller.wait().unwrap().success(), "first real controller could not hand off its worker");
        }
        let before = fs::read(root.join("ticks")).unwrap().len();
        let first_state: State = serde_json::from_slice(&fs::read(root.join("state.json")).unwrap()).unwrap();
        let State::Running { pid: original_worker, .. } = first_state else { panic!("worker already stopped") };
        let polls_before = calls.lock().unwrap().iter().filter(|k| k.as_str() == "poll").count();
        std::thread::sleep(Duration::from_millis(500));
        assert!(fs::read(root.join("ticks")).unwrap().len() > before, "controller exit stopped actual agent work");
        assert!(calls.lock().unwrap().iter().filter(|k| k.as_str() == "poll").count() > polls_before, "controller exit stopped actual lease renewal");
        let mut second = gateway_pipeline::Controller::new(&cfg, &readiness, &snap);
        let deadline = Instant::now() + Duration::from_secs(12);
        while !second.controller_ready() { second.tick(&snap, false, true).unwrap(); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10)); }
        assert!(!second.idle(), "controller-ready is not a false empty-worker claim");
        let State::Running { pid, .. } = serde_json::from_slice::<State>(&fs::read(root.join("state.json")).unwrap()).unwrap() else { panic!("worker stopped during adoption") };
        assert_eq!(pid, original_worker, "adoption must preserve the exact running worker process");
        assert!(child("dispatch::worker_session::tests::worker_process_entry", &path).status().unwrap().success());
        assert_eq!(fs::read_to_string(root.join("starts")).unwrap().lines().count(), 1, "duplicate attachment launched a second writer");
        second.tick(&snap, true, true).unwrap();
        assert!(!second.controller_ready(), "an explicit stop cannot be abandoned during an update handoff before durable delivery");
        // An actual operator stop still propagates to the adopted worker,
        // whereas the controller-only update above did not interrupt it.
        while !second.idle() { second.tick(&snap, true, false).unwrap(); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10)); }
        let terminal = gateway_pipeline::terminal_root(&cfg).unwrap().join("archive").join(spec.record().name());
        let record: Record = serde_json::from_slice(&fs::read(terminal).unwrap()).unwrap();
        assert!(matches!(record.work, Work::Stopped { outcome: Outcome { kind: OutcomeKind::Interrupted, .. }, .. }));
        assert!(gateway_pipeline::root(&cfg).unwrap().join("workers-archive").join(spec.record().name().trim_end_matches(".json")).join("output.jsonl").exists(), "live updates must survive controller loss on disk");
        assert_eq!(calls.lock().unwrap().iter().filter(|k| k.as_str() == "finalize").count(), 1);
        drop(second); let _ = fs::remove_dir_all(gateway_pipeline::root(&cfg).unwrap());
    }
}
