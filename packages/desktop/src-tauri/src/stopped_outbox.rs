//! Persist actual process-group-empty observations before network finalization.
//! Never infer stopped writers from expiry, or resolve/checkpoint external work.
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}};

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Delivery { Finalizing { owner_pid: u32 }, Pending { retry_after: u64 }, Rejected { reason: String } }

#[derive(Clone, Serialize, Deserialize)]
pub struct StoppedReceipt {
    pub host: String,
    pub url: String,
    pub task_id: String,
    pub session: String,
    pub generation: u64,
    pub attempt_id: String,
    pub observed_at: u64,
    command_id: String,
    delivery: Delivery,
}
impl StoppedReceipt {
    pub fn ready_for_replay(&self, now: u64) -> bool {
        match self.delivery {
            Delivery::Pending { retry_after } => retry_after <= now,
            Delivery::Finalizing { owner_pid } => process_absent(owner_pid),
            Delivery::Rejected { .. } => false,
        }
    }
    pub fn capture(host: &str, url: &str, task_id: &str, session: &str, generation: u64, attempt_id: &str, observed_at: u64, group_empty: bool) -> Result<Self, String> {
        if !group_empty || host.is_empty() || generation == 0 || attempt_id.is_empty() {
            return Err("no process-group-empty proof; retain capacity".into());
        }
        Ok(Self { host: host.into(), url: url.trim_end_matches('/').into(), task_id: task_id.into(), session: session.into(),
            generation, attempt_id: attempt_id.into(), observed_at,
            command_id: format!("stopped-outbox-v1-{task_id}-{generation}-{attempt_id}"), delivery: Delivery::Finalizing { owner_pid: std::process::id() } })
    }
    pub fn request(&self) -> serde_json::Value {
        serde_json::json!({"id":self.task_id,"session":self.session,"runner_protocol":"worker-ready-v2",
            "command_id":self.command_id,"command":{"kind":"quiesce","generation":self.generation,
                "attempt_id":self.attempt_id,"writers":"process_group_empty"}})
    }
    fn name(&self) -> String {
        // Hash is a filename, never authority: compare the entire saved fence.
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        (&self.host, &self.url, &self.task_id, &self.session, self.generation, &self.attempt_id).hash(&mut hash);
        format!("{:016x}.json", hash.finish())
    }
}
fn write(path: &Path, receipt: &StoppedReceipt) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!("{}-{}.tmp", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let result = (|| -> Result<(), String> {
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(receipt).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        #[cfg(unix)] fs::File::open(path.parent().ok_or("outbox parent missing")?).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(tmp); }
    result
}
pub fn persist(root: &Path, receipt: &StoppedReceipt) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = root.join(receipt.name());
    if path.exists() {
        let previous: StoppedReceipt = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if previous.request() != receipt.request() || previous.host != receipt.host || previous.url != receipt.url {
            return Err("stopped receipt filename collision; existing proof retained".into());
        }
        return Ok(path);
    }
    write(&path, receipt)?;
    Ok(path)
}
pub fn retained(root:&Path,receipt:&StoppedReceipt)->bool {
    // Legacy filename hashes were compiler-dependent. Match the full saved
    // receipt, never infer continuation authority from a filename.
    fs::read_dir(root).ok().is_some_and(|entries|entries.filter_map(Result::ok).any(|entry|
        fs::read(entry.path()).ok().and_then(|bytes|serde_json::from_slice::<StoppedReceipt>(&bytes).ok()).is_some_and(|saved|
            saved.host==receipt.host && saved.url==receipt.url && saved.request()==receipt.request())))
}
pub fn deliver(path: &Path, receipt: &StoppedReceipt, now: u64, mut send: impl FnMut(&StoppedReceipt) -> Result<(), String>) -> Result<(), String> {
    match send(receipt) {
        Ok(()) => { fs::remove_file(path).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }).map_err(|e| e.to_string())?; Ok(()) }
        Err(error) => {
            let mut retained = receipt.clone();
            retained.delivery = if error.contains("gate:") || error.contains("[rule:") {
                Delivery::Rejected { reason: error.clone() }
            } else { Delivery::Pending { retry_after: now + 60_000 } };
            write(path, &retained)?;
            Err(error)
        }
    }
}
pub fn flush(root: &Path, host: &str, url: &str, now: u64, mut send: impl FnMut(&StoppedReceipt) -> Result<(), String>) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else { return vec![] };
    let mut ready = Vec::new();
    for entry in entries.flatten() {
        if entry.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let receipt = fs::read(entry.path()).map_err(|e| e.to_string()).and_then(|bytes| serde_json::from_slice::<StoppedReceipt>(&bytes).map_err(|e| e.to_string()));
        if let Ok(receipt) = receipt {
            let ready_now = match receipt.delivery {
                Delivery::Pending { retry_after } => retry_after <= now,
                // Never race an in-progress checkpoint publication. If its
                // daemon dies, the already-captured stopped proof survives;
                // local work stays retained and host affinity still gates move.
                Delivery::Finalizing { owner_pid } => process_absent(owner_pid),
                Delivery::Rejected { .. } => false,
            };
            if receipt.host == host && receipt.url == url.trim_end_matches('/') && ready_now {
                ready.push((entry.path(), receipt));
            }
        }
    }
    ready.sort_by_key(|(_, receipt)| receipt.observed_at);
    ready.into_iter().take(4).map(|(path, receipt)| {
        match deliver(&path, &receipt, now, &mut send) {
            Ok(()) => format!("{} generation {} stopped-writer receipt delivered; capacity reconciled", receipt.task_id, receipt.generation),
            Err(error) => format!("{} stopped-writer receipt retained: {error}", receipt.task_id),
        }
    }).collect()
}

fn process_absent(pid: u32) -> bool {
    #[cfg(unix)] {
        if pid <= 1 || pid > i32::MAX as u32 { return false; }
        // Permission errors and PID reuse both retain the receipt, fail closed.
        return unsafe { libc::kill(pid as i32, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    }
    #[cfg(not(unix))] { let _ = pid; false }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, StoppedReceipt) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!("bridge-outbox-test-{}-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        (root, StoppedReceipt::capture("host", "https://hub", "BR#1", "original-session", 2, "123-456", 100, true).unwrap())
    }
    #[test]
    fn stopped_outbox_survives_restart_and_lost_response_with_same_fence_and_command() {
        let (root, receipt) = fixture();
        let path = persist(&root, &receipt).unwrap();
        let request = receipt.request();
        assert!(flush(&root, "host", "https://hub", 100, |_| panic!("checkpoint is still finalizing")).is_empty());
        let failure = deliver(&path, &receipt, 200, |_| Err("bridge 503; response lost".into()));
        assert_eq!(failure.unwrap_err(), "bridge 503; response lost");
        let restored: StoppedReceipt = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(matches!(restored.delivery, Delivery::Pending { retry_after: 60_200 }), "{}", String::from_utf8(fs::read(&path).unwrap()).unwrap());
        assert!(flush(&root, "host", "https://hub", 59_000, |_| panic!("backoff ignored")).is_empty());
        let delivered = flush(&root, "host", "https://hub", 61_000, |restored| { assert_eq!(restored.request(), request); Ok(()) });
        assert_eq!(delivered.len(), 1);
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stopped_outbox_never_attests_unproven_writers_or_another_host_and_stops_on_gate_rejection() {
        let (root, receipt) = fixture();
        assert!(StoppedReceipt::capture("host", "https://hub", "BR#1", "s", 2, "a", 1, false).is_err());
        let path = persist(&root, &receipt).unwrap();
        assert!(flush(&root, "other", "https://hub", 100, |_| panic!("foreign host")).is_empty());
        assert!(flush(&root, "host", "https://other", 100, |_| panic!("foreign hub")).is_empty());
        assert!(deliver(&path, &receipt, 100, |_| Err("gate: attempt fenced".into())).is_err());
        assert!(flush(&root, "host", "https://hub", 1_000_000, |_| panic!("semantic retry")).is_empty());
        assert!(path.exists(), "rejected evidence is retained for diagnosis");
        fs::remove_dir_all(root).unwrap();
    }
}
