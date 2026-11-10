//! Fence-scoped writer scan (BR#9843): the self-heal proof of last resort for
//! a charged attempt whose writer left neither a hub stop receipt nor a worker
//! manifest (the originating daemon crashed before either existed). The scan
//! is a same-UID /proc census keyed by the EXACT execution fence — every
//! spawned worker carries BRIDGE_TASK_ID / BRIDGE_EXECUTOR_SESSION /
//! BRIDGE_EXECUTION_FENCE in its environment (worker_session::launch), and a
//! systemd-unit worker additionally lives in a fence-named cgroup
//! (bridge-worker-<fence-token>.service). A complete census with no fence
//! match is kernel proof no writer of that fence lives; any visibility gap
//! HOLDS (fail closed). No lease, timer, title or note ever feeds this proof,
//! and nothing outside the exact fence is matched, stopped or released.
use super::lifecycle::Ownership;
use crate::transport::{GroupState, ProcessIdentity, stop_recovered};
#[cfg(any(target_os = "linux", test))]
use crate::transport::proc_stat;
use serde::Serialize;
use serde_json::json;
#[cfg(any(target_os = "linux", test))]
use std::collections::BTreeMap;
#[cfg(any(target_os = "linux", test))]
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

pub(super) const ENV_FENCE: &str = "BRIDGE_EXECUTION_FENCE";
pub(super) const ENV_TASK: &str = "BRIDGE_TASK_ID";
pub(super) const ENV_SESSION: &str = "BRIDGE_EXECUTOR_SESSION";
const WORKER_MARKER: &str = "bridge-worker-";
/// A no-match verdict is trusted only after two clean passes spaced wider than
/// a just-queued worker unit's fork/exec latency (BR#9843). Production keeps
/// the full spacing; test builds shrink it so the spacing sleep does not add
/// parallel load that squeezes the real-subprocess restart drills sharing the
/// suite (both passes still run).
pub(super) fn rescan_spacing() -> std::time::Duration {
    #[cfg(test)] { std::time::Duration::from_millis(20) }
    #[cfg(not(test))] { std::time::Duration::from_millis(750) }
}

/// The exact identity a census matches against. `fence` is the canonical
/// Ownership JSON — byte-identical to the BRIDGE_EXECUTION_FENCE value written
/// by worker_session::launch; `token` is the fence-named worker unit/manifest
/// token (the attempt record name minus ".json").
#[derive(Clone, Serialize)]
pub(super) struct ScanTarget {
    pub task_id: String,
    pub session: String,
    pub fence: String,
    pub token: String,
}
impl ScanTarget {
    pub fn new(owner: &Ownership, token: &str) -> Result<Self, String> {
        let Ownership::Attempt { ticket, .. } = owner else { return Err("fence scan requires an exact attempt fence".into()) };
        Ok(Self { task_id: ticket.task_id.clone(), session: ticket.session.clone(),
            fence: serde_json::to_string(owner).map_err(|e| e.to_string())?, token: token.to_string() })
    }
}

#[derive(Clone, Serialize)]
pub(super) struct MatchedWriter { pub pid: u32, pub group: u32, pub identity: ProcessIdentity, pub via: &'static str }

pub(super) enum FenceScan {
    /// Live processes positively identified as this exact fence's writer.
    Live(Vec<MatchedWriter>),
    /// Complete readable same-UID census with zero fence matches: kernel
    /// proof of absence. `scanned` counts classified same-UID entries.
    Absent { scanned: usize },
    /// Visibility gap or ambiguity. Never discharge on this.
    Hold(String),
}

enum Class { Match(&'static str), NotOurs, Sibling, Unreadable }
#[cfg(any(target_os = "linux", test))]
struct Fact { pid: u32, uid: u32, group: u32, start_ticks: u64, class: Class }

/// One census pass over a /proc-shaped tree. Foreign-UID processes are
/// provably not ours and never block a proof; same-UID entries must be fully
/// classifiable or the whole scan holds. (The parser needs Linux procfs stat
/// layout; tests supply fixture trees in the same shape.)
#[cfg(any(target_os = "linux", test))]
pub(super) fn scan(proc_root: &Path, self_uid: u32, boot_id: &str, target: &ScanTarget) -> FenceScan {
    let entries = match std::fs::read_dir(proc_root) {
        Ok(entries) => entries,
        Err(error) => return FenceScan::Hold(format!("kernel process census unavailable: {error}")),
    };
    let our_unit = format!("{WORKER_MARKER}{}", target.token);
    let mut facts: Vec<Fact> = Vec::new();
    let mut scanned = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) { continue; }
        let Ok(pid) = name.parse::<u32>() else { continue };
        let dir = entry.path();
        let stat = match std::fs::read_to_string(dir.join("stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue, // transient exit
            Err(error) => return FenceScan::Hold(format!("kernel facts for pid {pid} unreadable: {error}")),
        };
        let Some((_, group, start_ticks)) = proc_stat(&stat) else {
            return FenceScan::Hold(format!("kernel facts for pid {pid} unparseable"));
        };
        let status = match std::fs::read_to_string(dir.join("status")) {
            Ok(status) => status,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return FenceScan::Hold(format!("uid facts for pid {pid} unreadable: {error}")),
        };
        let Some(uid) = effective_uid(&status) else {
            return FenceScan::Hold(format!("uid facts for pid {pid} unparseable"));
        };
        // World-readable cgroup path: a systemd worker's unit name embeds the
        // full fence token, positively identifying the fence even when the
        // environment is ptrace-protected.
        let cgroup = match std::fs::read_to_string(dir.join("cgroup")) {
            Ok(text) => Some(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return FenceScan::Hold(format!("cgroup facts for pid {pid} unreadable: {error}")),
        };
        let unit = cgroup.as_deref().and_then(|text| text.split_whitespace()
            .map(|line| line.rsplit('/').find(|part| part.starts_with(WORKER_MARKER))).flatten().next());
        if uid != self_uid {
            // Provably another owner — unless the kernel places it inside this
            // exact fence's unit, which this scan could never legally stop.
            if unit.as_deref() == Some(our_unit.as_str()) {
                return FenceScan::Hold(format!("pid {pid} of another owner sits inside this exact fence's unit; refusing to discharge"));
            }
            continue;
        }
        scanned += 1;
        facts.push(Fact { pid, uid, group, start_ticks, class: classify(&dir, target, unit.as_deref(), &our_unit) });
    }
    verdict(&facts, scanned, boot_id)
}

#[cfg(any(target_os = "linux", test))]
fn classify(dir: &Path, target: &ScanTarget, unit: Option<&str>, our_unit: &str) -> Class {
    match std::fs::read(dir.join("environ")) {
        Ok(bytes) => {
            let variable = |key: &str| bytes.split(|b| *b == 0).filter_map(|entry| {
                let entry = std::str::from_utf8(entry).ok()?;
                let (name, value) = entry.split_once('=')?;
                (name == key).then_some(value)
            }).next();
            let (task, session, fence) = (variable(ENV_TASK), variable(ENV_SESSION), variable(ENV_FENCE));
            if task == Some(target.task_id.as_str()) && session == Some(target.session.as_str()) && fence == Some(target.fence.as_str()) {
                Class::Match("environ")
            } else if task == Some(target.task_id.as_str()) || session == Some(target.session.as_str()) || fence == Some(target.fence.as_str()) {
                // Carries this task/session/fence marker without the exact
                // triple: a sibling attempt's writer, never matchable here.
                Class::Sibling
            } else { Class::NotOurs } // foreign bridge writer or plain process
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Class::NotOurs, // exited mid-scan
        Err(_) => match unit {
            // Kernel-positive fence identification independent of ptrace.
            Some(unit) if unit == our_unit => Class::Match("cgroup"),
            Some(unit) if unit.starts_with(WORKER_MARKER) => Class::NotOurs, // another fence's worker
            _ => match std::fs::read(dir.join("cmdline")) {
                // The worker binary's argv carries the fence-named manifest path.
                Ok(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    if text.split(['\0', ' ']).any(|part| part.contains(&target.token)) { Class::Match("cmdline") }
                    else if text.contains("internal-worker") || text.contains(WORKER_MARKER) { Class::NotOurs }
                    else { Class::Unreadable } // cannot prove it is not ours
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Class::NotOurs,
                Err(_) => Class::Unreadable,
            },
        },
    }
}

/// Turn the census into a verdict. Any unclassifiable same-UID entry or
/// sibling-writer marker holds; a fenced stop signals a whole process GROUP,
/// so it is scoped only when every census-known member of that group belongs
/// to this exact fence.
#[cfg(any(target_os = "linux", test))]
fn verdict(facts: &[Fact], scanned: usize, boot_id: &str) -> FenceScan {
    for fact in facts {
        match &fact.class {
            Class::Unreadable => return FenceScan::Hold(format!("same-uid pid {} cannot be proved outside this fence's writer identity; refusing to discharge", fact.pid)),
            Class::Sibling => return FenceScan::Hold(format!("pid {} carries this task/session with a different fence; never discharge across a sibling writer", fact.pid)),
            _ => {},
        }
    }
    let mut groups: BTreeMap<u32, Vec<&Fact>> = BTreeMap::new();
    for fact in facts { groups.entry(fact.group).or_default().push(fact); }
    let mut matches = Vec::new();
    for fact in facts {
        let Class::Match(via) = &fact.class else { continue };
        if !groups.get(&fact.group).is_some_and(|members| members.iter().all(|member| matches!(&member.class, Class::Match(_)))) {
            return FenceScan::Hold(format!("process group {} of matched pid {} mixes fence and non-fence members; refusing unscoped stop", fact.group, fact.pid));
        }
        matches.push(MatchedWriter { pid: fact.pid, group: fact.group,
            identity: ProcessIdentity::Linux { group: fact.group, start_ticks: fact.start_ticks, boot_id: boot_id.into() }, via });
    }
    if matches.is_empty() { FenceScan::Absent { scanned } } else { FenceScan::Live(matches) }
}

#[cfg(any(target_os = "linux", test))]
fn effective_uid(status: &str) -> Option<u32> {
    status.lines().find(|line| line.starts_with("Uid:"))?
        .split_whitespace().nth(2)?.parse().ok()
}

/// Production census entry point. Resolves the live kernel tree (and the
/// scanning identity); test builds may substitute a fixture tree rooted under
/// this gateway's lifecycle directory (`fake-proc`), keeping concurrent tests
/// fully isolated instead of sharing mutable global state.
pub(super) fn scan_live(cfg: &super::DispatchConfig, target: &ScanTarget) -> FenceScan {
    #[cfg(any(target_os = "linux", test))]
    {
        #[cfg(test)]
        if let Some(fake) = test_proc_root(cfg) {
            let uid = unsafe { libc::getuid() };
            let boot_id = std::fs::read_to_string(fake.join("sys/kernel/random/boot_id")).unwrap_or_default().trim().to_string();
            return scan(&fake, uid, &boot_id, target);
        }
        #[cfg(target_os = "linux")]
        return {
            let uid = unsafe { libc::getuid() };
            let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap_or_default().trim().to_string();
            scan(Path::new("/proc"), uid, &boot_id, target)
        };
        #[cfg(all(not(target_os = "linux"), test))]
        return FenceScan::Hold("Fence-scoped writer proof requires Linux /proc or a test fixture".into());
    }
    #[cfg(not(any(target_os = "linux", test)))]
    { let _ = (cfg, target); FenceScan::Hold("Fence-scoped writer proof requires Linux /proc".into()) }
}

#[cfg(test)]
fn test_proc_root(cfg: &super::DispatchConfig) -> Option<PathBuf> {
    let fake = super::gateway_pipeline::root(cfg).ok()?.join("fake-proc");
    fake.is_dir().then_some(fake)
}

/// Fenced-stop live matches through the normal transport path and prove every
/// matched group quiesced. Returns the surviving writer proof (the weakest
/// across groups) plus evidence, or an error explaining why the proof is not
/// yet available (retry/hold).
pub(super) fn stop_matches(matches: &[MatchedWriter]) -> Result<(super::attempt_journal::WriterProof, serde_json::Value), String> {
    let mut stopped = Vec::new();
    let mut weakest = super::attempt_journal::WriterProof::ProcessGroupEmpty;
    for matched in matches {
        let state = stop_recovered(&matched.identity);
        let Some(proof) = super::attempt_journal::WriterProof::observed(state) else {
            return Err(match state {
                GroupState::Live => format!("Exact recovered process group {} is still stopping; retry physical proof", matched.group),
                _ => format!("gate: recovered group {} visibility cannot prove stopped writers", matched.group),
            });
        };
        if matches!(proof, super::attempt_journal::WriterProof::NoLiveGroupMembers) { weakest = proof; }
        stopped.push(json!({"pid": matched.pid, "group": matched.group, "via": matched.via, "state": format!("{state:?}").to_lowercase()}));
    }
    Ok((weakest, json!({ "stopped": stopped })))
}
