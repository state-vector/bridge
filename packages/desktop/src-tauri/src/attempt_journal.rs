//! One write-ahead terminal journal: result + proof + immutable checkpoint +
//! exact replay request. Recovery never reconstructs outcomes from stdout files.
use super::lifecycle::{Ownership, Ticket};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}};

/// Version-stable, length-delimited FNV-1a/128 identity. Standard-library Hash
/// output is not a persistence contract across compiler/platform upgrades.
pub fn stable_key(parts: &[&str]) -> String {
    let mut hash = 0x6c62272e07bb014262b821756295c58du128;
    for part in parts {
        for byte in (part.len() as u64).to_le_bytes().iter().chain(part.as_bytes()) {
            hash = (hash ^ u128::from(*byte)).wrapping_mul(0x1000000000000000000013bu128);
        }
    }
    format!("{hash:032x}")
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeKind { Completed, Interrupted, Failed, TimedOut, ResultUnavailable }
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriterProof { ProcessGroupEmpty, NoLiveGroupMembers }
impl WriterProof {
    pub fn observed(state: crate::transport::GroupState) -> Option<Self> {
        match state { crate::transport::GroupState::Empty => Some(Self::ProcessGroupEmpty), crate::transport::GroupState::ZombiesOnly => Some(Self::NoLiveGroupMembers), _ => None }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Outcome { pub kind: OutcomeKind, pub exit_code: Option<i32>, pub stdout_tail: String, pub stderr_tail: String,
    // Replay an in-flight journal from an older runner byte-for-byte.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_prompt_observed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_parent_prompt_observed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_parent_teardown_observed_at: Option<u64>,
    /// Typed provider provenance (BR#8821). Serialized only when present so
    /// older hubs/recovery paths parse unchanged records identically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<crate::transport::ProviderCause>,
    /// GH#481: end-of-turn background yield — the agent ended its turn with
    /// processes still live in the runner's process group. Serialized only
    /// when present; an absent field is a drained turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_yield: Option<crate::transport::BackgroundYield> }
#[derive(Clone, Serialize, Deserialize)]
pub struct TerminalReceipt { pub generation: u64, pub attempt_id: String, pub outcome: Outcome }

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum Step {
    Stop,
    Capture,
    Publish { checkpoint: crate::checkpoint::Checkpoint },
    Register { checkpoint: crate::checkpoint::Checkpoint },
    Finalize,
    FinalizeCoordination { checkpoint: crate::checkpoint::Checkpoint },
    Acknowledged { reply: serde_json::Value },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Work {
    Stopped { outcome: Outcome, writers: WriterProof, worktree: Option<PathBuf>, step: Step },
    Unstarted { reason: String },
    Unproven { outcome: Outcome, worktree: Option<PathBuf> },
    UnknownWriter { reason: String },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Disposition { Pending, Rejected { reason: String } }
#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    pub owner: Ownership, pub url: String, pub host: String,
    pub observed_at: u64, pub work: Work, pub disposition: Disposition,
    #[serde(default)]
    pub process: Option<crate::transport::ProcessIdentity>,
}
impl Record {
    pub fn validate(&self) -> Result<(), String> {
        if self.ticket().task_id.is_empty() || self.ticket().session.is_empty() || self.host.is_empty() || self.url.is_empty() { return Err("gate: terminal journal identity missing".into()); }
        match (&self.owner, &self.work) {
            (Ownership::Reservation { .. }, Work::Unstarted { .. }) => {},
            (Ownership::Attempt { host, generation, attempt_id, .. }, work) if host == &self.host && *generation > 0 && !attempt_id.is_empty() && !matches!(work, Work::Unstarted { .. }) => {},
            _ => return Err("gate: terminal journal phase does not match its owner/fence".into()),
        }
        if let Work::Stopped { worktree, step, .. } = &self.work {
            if matches!(step, Step::Capture | Step::Publish { .. } | Step::Register { .. }) && worktree.is_none() { return Err("gate: checkpoint journal has no worktree".into()); }
            // BR#14525: checkpoints are LOCAL commits in the surviving worktree —
            // the worktree is the durability boundary; no published-ref binding.
            if let Step::Publish { checkpoint } | Step::Register { checkpoint } = step {
                if checkpoint.commit.is_empty() || checkpoint.tree.is_empty() {
                    return Err("gate: checkpoint journal is missing its local commit/tree".into());
                }
            }
        }
        Ok(())
    }
    pub fn name(&self) -> String {
        record_name(&self.url, &self.host, &self.owner)
    }
    pub fn command_id(&self, stage: &str) -> String { format!("attempt-journal-v1-{}-{stage}", self.name()) }
    pub fn ticket(&self) -> &Ticket { self.owner.ticket() }
}

pub fn record_name(url: &str, host: &str, owner: &Ownership) -> String {
        let (kind, generation, attempt) = match owner {
            Ownership::Reservation { .. } => ("reservation", "0".into(), ""),
            Ownership::Attempt { generation, attempt_id, .. } => ("attempt", generation.to_string(), attempt_id.as_str()),
        };
        let ticket = owner.ticket();
        format!("{}.json", stable_key(&[url, host, kind, &ticket.task_id, &ticket.session, &generation, attempt]))
}

pub fn save(root: &Path, record: &Record) -> Result<(), String> {
    write_file(&root.join(record.name()), &serde_json::to_vec(record).map_err(|e| e.to_string())?)
}
/// BR#22634 — the journal recovery reserve. Every workspace-owner mutation
/// (record phase transitions, status proofs, removal receipts, terminal
/// stages, attempt journals) funnels through `write_file`; on a full volume
/// each of those writes fails with ENOSPC, so the journal that authorizes
/// the reclamation which would refill the volume becomes unwritable —
/// observed live on the gateway: 0 bytes free, every reconcile pass dying on
/// its first `save`, "reclamation continues" while nothing could ever be
/// reclaimed. The reserve breaks that deadlock by construction: the owner
/// preallocates real blocks beside its ledger, and any journal write that
/// hits ENOSPC draws from the nearest reserve and retries once. The reserve
/// is refilled by the workspace owner while the volume is healthy.
const RESERVE_NAME: &str = ".journal-reserve.bin";
pub fn reserve_bytes() -> u64 {
    // Test binaries take a token 64 KiB default: the reserve is real
    // preallocated disk, and ~50 sandbox owners zero-filling 32 MiB each
    // starves the suite's real-controller timing tests under full parallel
    // load (observed: two 60s-deadline tests failing only in the whole-suite
    // run, green in isolation and green on the pre-change base). The
    // reserve MECHANISM is size-independent; the journal unit tests
    // exercise real sizes via `ensure_reserve_sized`.
    if cfg!(test) {
        std::env::var("BRIDGE_JOURNAL_RESERVE_MIB").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0)
            .saturating_mul(1024 * 1024).max(64 * 1024)
    } else {
        std::env::var("BRIDGE_JOURNAL_RESERVE_MIB").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(16)
            .saturating_mul(1024 * 1024)
    }
}
fn is_storage_full(error: &str) -> bool {
    // ENOSPC stringifies identically on the gateway's Linux and on macOS
    // dev/test hosts: "No space left on device (os error 28)". A false
    // positive costs one harmless (possibly empty) reserve draw.
    error.contains("os error 28") || error.contains("No space left on device")
}
fn draw_from_reserve(path: &Path) -> bool {
    // Walk up from the target journal to find the owning reserve (the
    // workspace owner keeps one at its lifecycle root and one at its
    // workdir root, so every journal family under either tree is covered).
    // Draw is idempotent and lock-free: concurrent writers race to
    // truncate the same file; a loser's retry simply fails again and the
    // write errors exactly as before — never worse.
    let Some(mut dir) = path.parent().map(Path::to_path_buf) else { return false };
    for _ in 0..4 {
        let reserve = dir.join(RESERVE_NAME);
        if let Ok(file) = fs::File::options().read(true).write(true).open(&reserve) {
            if file.set_len(0).is_ok() { let _ = file.sync_all(); return true; }
        }
        if !dir.pop() { break }
    }
    false
}
/// Best-effort (re)fill of the recovery reserve at `root`. Filling writes
/// real zero blocks — a sparse hole reserves nothing — through a temp file,
/// so a mid-fill failure (tight disk) never shrinks an existing reserve.
/// Never fails its caller: an unfilled reserve only means the next ENOSPC
/// draw finds nothing and the write errors exactly as before.
pub fn ensure_reserve(root: &Path) { ensure_reserve_sized(root, reserve_bytes()) }
/// Test-shaped variant with an explicit size (the env-tunable default is
/// not safe to mutate from parallel tests). Compiled unconditionally:
/// `ensure_reserve` itself calls it, so gating it behind cfg(test) breaks
/// the production lib build (test builds activate cfg(test) and mask it).
pub(crate) fn ensure_reserve_sized(root: &Path, want: u64) {
    let path = root.join(RESERVE_NAME);
    if want == 0 { return }
    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) >= want { return }
    let tmp = path.with_extension(format!("reserve-{}.tmp", std::process::id()));
    let Ok(mut file) = fs::File::create(&tmp) else { return };
    // 64 KiB stack chunks: a 4 MiB buffer would overflow small worker and
    // test threads; 256 iterations is nothing.
    let zero = [0u8; 64 * 1024];
    let mut remaining = want;
    while remaining > 0 {
        let chunk = remaining.min(zero.len() as u64) as usize;
        if file.write_all(&zero[..chunk]).is_err() { let _ = fs::remove_file(&tmp); return }
        remaining -= chunk as u64;
    }
    if file.sync_all().is_ok() && fs::rename(&tmp, &path).is_ok() { return }
    let _ = fs::remove_file(&tmp);
}
/// Test seam for the ENOSPC retry path: when armed with a path, the next
/// `write_file` targeting exactly that path fails its first attempt with a
/// real ENOSPC message. Path-scoped so parallel tests never cross-fire.
#[cfg(test)]
pub(crate) static FAIL_FIRST_WRITE: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

pub fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let root = path.parent().ok_or("journal parent missing")?.to_path_buf();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}-{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    let write_once = |tmp: &Path| -> Result<(), String> {
        #[cfg(test)]
        {
            let mut armed = FAIL_FIRST_WRITE.lock().unwrap();
            if armed.as_deref() == Some(path) { *armed = None; return Err("No space left on device (os error 28)".into()) }
        }
        let mut options = fs::OpenOptions::new(); options.create_new(true).write(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(tmp, path).map_err(|e| e.to_string())?;
        #[cfg(unix)] fs::File::open(&root).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
        Ok(())
    };
    let result = write_once(&tmp);
    // BR#22634 — ENOSPC is recoverable through the reserve: remove the
    // failed temp, draw the preallocated blocks, retry once.
    let result = match result {
        Err(error) if is_storage_full(&error) => {
            let _ = fs::remove_file(&tmp);
            if draw_from_reserve(path) { write_once(&tmp) } else { Err(error) }
        }
        other => other,
    };
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result
}
pub fn insert(root: &Path, record: Record) -> Result<Record, String> {
    record.validate()?;
    let path = root.join(record.name());
    match fs::read(&path) {
        Ok(bytes) => {
            let previous: Record = serde_json::from_slice(&bytes).map_err(|e| format!("gate: invalid terminal journal; retain owner: {e}"))?;
            previous.validate()?;
            if previous.owner != record.owner || previous.url != record.url || previous.host != record.host {
                return Err("terminal journal collision; existing evidence retained".into());
            }
            Ok(previous)
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => { save(root, &record)?; Ok(record) },
        Err(e) => Err(e.to_string()),
    }
}
pub fn pending(root: &Path, host: &str, url: &str) -> Result<Vec<Record>, String> {
    let entries = match fs::read_dir(root) { Ok(entries) => entries, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]), Err(error) => return Err(error.to_string()) };
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        match fs::read(entry.path()).map_err(|e| e.to_string()).and_then(|bytes| serde_json::from_slice::<Record>(&bytes).map_err(|e| e.to_string())) {
            Ok(record) if record.host == host && record.url == url => { record.validate()?; result.push(record); },
            Ok(_) => return Err("gate: terminal journal scope changed; evidence retained".into()),
            Err(error) => return Err(format!("gate: terminal journal unreadable; evidence retained: {error}")),
        }
    }
    result.sort_by_key(|r| r.observed_at);
    Ok(result)
}
pub fn remove(root: &Path, record: &Record) -> Result<(), String> {
    // Completion retires the active job, not its captured evidence. Keep the
    // immutable full local result after the hub ACK (whose tail is bounded).
    let archive = root.join("archive");
    fs::create_dir_all(&archive).map_err(|e| e.to_string())?;
    fs::rename(root.join(record.name()), archive.join(record.name()))
        .or_else(|e| if e.kind() == std::io::ErrorKind::NotFound && archive.join(record.name()).exists() { Ok(()) } else { Err(e) }).map_err(|e| e.to_string())?;
    #[cfg(unix)] { fs::File::open(root).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?; fs::File::open(archive).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?; }
    Ok(())
}

#[cfg(test)]
mod br22634_tests {
    use super::*;
    fn scratch() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("br22634-journal-{}-{}", std::process::id(), SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn enospc_write_survives_through_the_reserve() {
        let dir = scratch();
        ensure_reserve_sized(&dir, 64 * 1024);
        let reserve = dir.join(RESERVE_NAME);
        assert!(fs::metadata(&reserve).unwrap().len() >= 64 * 1024, "reserve holds real preallocated blocks");
        let target = dir.join("records/record.json");
        *FAIL_FIRST_WRITE.lock().unwrap() = Some(target.clone());
        write_file(&target, br#"{"ok":true}"#).unwrap();
        assert_eq!(fs::read(&target).unwrap(), br#"{"ok":true}"#);
        assert_eq!(fs::metadata(&reserve).unwrap().len(), 0, "the full-volume write drew the reserve");
        ensure_reserve_sized(&dir, 64 * 1024);
        assert!(fs::metadata(&reserve).unwrap().len() >= 64 * 1024, "reserve refilled while healthy");
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn enospc_without_reserve_fails_exactly_as_before() {
        let dir = scratch();
        let target = dir.join("records/record.json");
        *FAIL_FIRST_WRITE.lock().unwrap() = Some(target.clone());
        assert!(write_file(&target, br#"{"ok":true}"#).is_err());
        assert!(!target.exists(), "no torn file left behind");
        let _ = fs::remove_dir_all(&dir);
    }
}
