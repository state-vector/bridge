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
    /// Typed provider provenance (BR#8821). Serialized only when present so
    /// older hubs/recovery paths parse unchanged records identically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<crate::transport::ProviderCause> }
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
            if let Step::Publish { checkpoint } | Step::Register { checkpoint } = step {
                let Ownership::Attempt { generation, .. } = self.owner else { unreachable!() };
                let slug: String = self.ticket().task_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
                if !checkpoint.remote_ref.starts_with(&format!("refs/heads/bridge-checkpoints/{slug}/{generation}/")) {
                    return Err("gate: checkpoint publication is not bound to this task/generation".into());
                }
            }
        }
        Ok(())
    }
    pub fn name(&self) -> String {
        let (kind, generation, attempt) = match &self.owner {
            Ownership::Reservation { .. } => ("reservation", "0".into(), ""),
            Ownership::Attempt { generation, attempt_id, .. } => ("attempt", generation.to_string(), attempt_id.as_str()),
        };
        format!("{}.json", stable_key(&[&self.url, &self.host, kind, &self.ticket().task_id, &self.ticket().session, &generation, attempt]))
    }
    pub fn command_id(&self, stage: &str) -> String { format!("attempt-journal-v1-{}-{stage}", self.name()) }
    pub fn ticket(&self) -> &Ticket { self.owner.ticket() }
}

pub fn save(root: &Path, record: &Record) -> Result<(), String> {
    write_file(&root.join(record.name()), &serde_json::to_vec(record).map_err(|e| e.to_string())?)
}
pub fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let root = path.parent().ok_or("journal parent missing")?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}-{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    let mut options = fs::OpenOptions::new(); options.create_new(true).write(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let result = (|| -> Result<(), String> {
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        #[cfg(unix)] fs::File::open(root).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(tmp); }
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
