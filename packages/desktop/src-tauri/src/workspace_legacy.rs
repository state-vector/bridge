//! Import old allocations into the same owner. Discovery is not deletion
//! authority: each imported resource must prove stopped ownership, no readers,
//! remotely preserved content and no dependent worktree before retirement.
use super::*;

#[derive(Clone,Copy)]
pub(super) enum ReaderAuthority { FencedAllocation, UnattributedLegacy }

pub(super) fn allocation_id(prefix: &str, path: &Path) -> Result<String, String> {
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        let metadata=fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        Ok(format!("{prefix}-{}",journal::stable_key(&[&path.to_string_lossy(),&metadata.dev().to_string(),&metadata.ino().to_string()])))
    }
    #[cfg(not(unix))] Err("legacy allocation identity requires Unix".into())
}

pub(super) fn adopt(owner: &Owner) -> Result<(), String> {
    #[cfg(not(test))]
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(test)]
    let home: Option<PathBuf> = None; // fixture inventory must never import the developer's work
    let mut paths: Vec<(PathBuf, Option<String>)> = collect_worktree_candidates(
        Path::new(&owner.cfg.workdir), home.as_deref(), &HashSet::new(), &owner.cfg.sweep_repos)
        .into_iter().map(|c| {
            let task = reverse_task_slug(&c.slug);
            (c.path, task.strip_prefix("BR#").filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())).map(|_| task.clone()))
        }).collect();
    if let Some(home) = &home {
        for entry in worktree_registry_load(home) { paths.push((PathBuf::from(entry.path), Some(entry.task))); }
    }
    // Old scratch and the actual historical TMPDIR are owned allocation roots,
    // not a recursive hunt through the human's home directory.
    let mut roots = vec![PathBuf::from(&owner.cfg.workdir).join("sessions")];
    if let Some(home) = &home { roots.push(home.join("opencode-tmp")); }
    for root in roots {
        let entries = match fs::read_dir(&root) { Ok(e) => e, Err(e) if e.kind() == io::ErrorKind::NotFound => continue, Err(e) => return Err(e.to_string()) };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_dir() && !entry.file_name().to_string_lossy().starts_with(".bridge-reclaim-") {
                // This exact basename is the retired runner's allocation
                // protocol, not a task-title guess. Other tmp names stay unbound.
                let name=entry.file_name().to_string_lossy().into_owned();
                let task=if root==PathBuf::from(&owner.cfg.workdir).join("sessions") {
                    name.strip_prefix("bridge-BR-").filter(|n|!n.is_empty()&&n.chars().all(|c|c.is_ascii_digit())).map(|n|format!("BR#{n}"))
                } else {None};
                paths.push((entry.path(), task));
            }
        }
    }
    paths.sort_by_key(|(path, task)| (path.components().count(), path.clone(), task.is_none()));
    let mut adopted: Vec<PathBuf> = Vec::new();
    for (path, task) in paths {
        if !path.exists() || path.starts_with(&owner.allocations) || path.file_name().is_some_and(|n| n.to_string_lossy().starts_with(".bridge-reclaim-")) || fs::symlink_metadata(&path).map_err(|e| e.to_string())?.file_type().is_symlink() { continue; }
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        if adopted.iter().any(|parent| path.starts_with(parent)) { continue; }
        adopted.push(path.clone());
        let id = allocation_id("legacy",&path)?;
        let Some(_lock) = owner.lock(&id)? else { continue; };
        if owner.file(&id).exists() { continue; }
        owner.save(&Resource { version: 1, id, location: Location::Legacy { root: path, task },
            phase: Phase::LegacyUnproved, observed_bytes: 0, checked_at: 0, retry_at: 0, error: None })?;
    }
    // Shared clones are explicit cache resources in the same ledger. Their
    // external worktrees/branches/readers must be clear before eviction.
    if let Ok(entries) = fs::read_dir(PathBuf::from(&owner.cfg.workdir).join("repos")) {
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            if !path.join(".git").is_dir() { continue; }
            let id = format!("cache-{}", journal::stable_key(&[&path.to_string_lossy()]));
            let Some(_lock) = owner.lock(&id)? else { continue; };
            if !owner.file(&id).exists() {
                owner.save(&Resource { version: 1, id, location: Location::RepositoryCache { root: path, authority:CacheAuthority::LegacyDiscovery },
                    phase: Phase::Cached { last_used_at: 0 }, observed_bytes: 0, checked_at: 0, retry_at: 0, error: None })?;
            }
        }
    }
    if let Ok(entries) = fs::read_dir(&owner.cfg.workdir) {
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            if !cache_tag(&path) { continue; }
            let path = path.canonicalize().map_err(|e| e.to_string())?;
            let id = allocation_id("generated",&path)?;
            let Some(_lock) = owner.lock(&id)? else { continue; };
            if !owner.file(&id).exists() {
                owner.save(&Resource { version:1, id, location:Location::GeneratedCache {root:path}, phase:Phase::LegacyUnproved,
                    observed_bytes:0, checked_at:0, retry_at:0, error:None })?;
            }
        }
    }
    Ok(())
}

fn cache_tag(path: &Path) -> bool {
    fs::read(path.join("CACHEDIR.TAG")).is_ok_and(|bytes| bytes.starts_with(b"Signature: 8a477f597d28d172789f06886806bc55"))
}

pub(super) fn prove(owner: &Owner, resource: &mut Resource) -> Result<(), String> {
    let (root, task) = match &resource.location { Location::Legacy { root, task } => (root.clone(), task.clone()), Location::RepositoryCache { root, .. } | Location::GeneratedCache { root } => (root.clone(), None), _ => return Err("legacy resource location missing".into()) };
    if !root.exists() {
        resource.phase = Phase::Removed { reclaimed_bytes: 0, at: now_ms() };
        return Ok(());
    }
    // A pending launch/result or unknown effect protects its exact path even
    // when a historical task has been moved/closed by another session.
    for directory in ["launches", "terminal", "workers"] {
        let directory = gateway_pipeline::root(&owner.cfg)?.join(directory);
        if journal_references(&directory, &root)? { return Err("legacy workspace is referenced by an active execution journal".into()); }
    }
    if matches!(resource.location, Location::GeneratedCache { .. }) {
        no_readers(&root,ReaderAuthority::UnattributedLegacy)?;
        if !cache_tag(&root) { return Err("generated cache lost its disposal marker; retained".into()); }
        resource.phase = Phase::Reclaimable { snapshots:vec![] };
        return owner.save(resource);
    }
    let mut adopted_execution=None;
    let retirement = if let Some(task) = &task {
        let state = execution_call(&owner.cfg, task, json!({"kind":"inspect"}))?;
        let a = &state["attempt"];
        if !a.is_null() && a["phase"] != "quiesced" { return Err("legacy execution writers are not confirmed stopped".into()); }
        if state["operations"].as_array().is_none_or(|ops| ops.iter().any(|o| matches!(o["state"].as_str(), Some("prepared" | "outcome_unknown")))) { return Err("legacy workspace has unresolved operation evidence".into()); }
        if !matches!(state["handoff"]["phase"].as_str(), Some("none" | "returned")) { return Err("legacy workspace belongs to a protected local handoff".into()); }
        let card = mcp_call(&owner.cfg, &mut 0, "get_artefact", json!({"id":task}))?;
        if !matches!(card["status"].as_str(), Some("done" | "superseded" | "todo" | "in_review" | "blocked")) { return Err("legacy workspace still has a claimed executor".into()); }
        if !a.is_null() && a["host"].as_str()==owner.cfg.label.as_deref() {
            let confirmed=Ownership::Attempt {ticket:Ticket {task_id:task.clone(),session:a["session"].as_str().filter(|s|!s.is_empty()).ok_or("legacy stop receipt lacks session")?.into()},host:a["host"].as_str().unwrap().into(),generation:a["generation"].as_u64().filter(|g|*g>0).ok_or("legacy stop receipt lacks generation")?,attempt_id:a["attempt_id"].as_str().filter(|s|!s.is_empty()).ok_or("legacy stop receipt lacks attempt")?.into()};
            lifecycle::Released::from_hub(&confirmed,&state)?;
            adopted_execution=Some(task.clone());
            confirmed
        } else {Ownership::Reservation { ticket: Ticket { task_id: task.clone(), session: resource.id.clone() } }}
    } else {
        // Unknown provenance is never a licence to destroy unpublished work.
        // Clean, remotely reachable repositories can be checkpointed; dirty
        // legacy inputs remain explicit retained resources in the disk budget.
        let mut repos = Vec::new(); repositories(&root, &mut repos)?;
        for repo in repos {
            if !git(&repo, &["status", "--porcelain"])?.is_empty() || git(&repo, &["branch", "-r", "--contains", "HEAD"])?.is_empty() {
                return Err("unattributed legacy source is dirty/unpublished; retained for preservation".into());
            }
        }
        Ownership::Reservation { ticket: Ticket { task_id: format!("workspace-{}", resource.id), session: resource.id.clone() } }
    };
    let authority=if adopted_execution.is_some() {ReaderAuthority::FencedAllocation} else {owner.reader_authority(resource)?};
    no_readers(&root,authority)?;
    if let Some(task)=adopted_execution {resource.location=Location::AdoptedExecution {root,task};}
    resource.phase = Phase::Released { owner: retirement };
    owner.save(resource)
}

fn journal_references(directory: &Path, root: &Path) -> Result<bool, String> {
    let entries = match fs::read_dir(directory) { Ok(e) => e, Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false), Err(e) => return Err(e.to_string()) };
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.file_name().and_then(|s| s.to_str()) == Some("archive") { continue; }
        if path.is_dir() { if journal_references(&path, root)? { return Ok(true); } }
        else if path.extension().and_then(|s| s.to_str()) == Some("json") {
            let value: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            if references(&value, root) { return Ok(true); }
        }
    }
    Ok(false)
}
fn references(value: &serde_json::Value, root: &Path) -> bool {
    match value {
        serde_json::Value::String(path) if path.starts_with('/') => Path::new(path).starts_with(root),
        serde_json::Value::Array(values) => values.iter().any(|v| references(v, root)),
        serde_json::Value::Object(values) => values.values().any(|v| references(v, root)),
        _ => false,
    }
}

pub(super) fn no_external_worktrees(repository: &Path, root: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    for line in git(repository, &["worktree", "list", "--porcelain"])?.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            // A linked tree depends on its owning clone, not vice versa.
            let path = Path::new(path).canonicalize().unwrap_or_else(|_| PathBuf::from(path));
            if repository.join(".git").is_dir() && !path.starts_with(&root) { return Err("repository still owns an external worktree; retained".into()); }
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn proc_entry_disappeared(error: &io::Error) -> bool {
    // A PID can exit between enumerating /proc and reading its entries.
    matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH))
}

#[cfg(all(test, unix))]
#[test]
fn proc_entry_disappearance_only_accepts_vanished_entries() {
    assert!(proc_entry_disappeared(&io::Error::from_raw_os_error(libc::ENOENT)));
    assert!(proc_entry_disappeared(&io::Error::from_raw_os_error(libc::ESRCH)));
    for errno in [libc::EACCES, libc::EPERM, libc::EIO] {
        assert!(!proc_entry_disappeared(&io::Error::from_raw_os_error(errno)));
    }
}

pub(super) fn no_readers(root: &Path, authority: ReaderAuthority) -> Result<(), String> {
    if !root.exists() { return Ok(()); }
    if fs::symlink_metadata(root).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("workspace root is a symlink; retained".into()); }
    #[cfg(target_os = "linux")] {
        use std::os::unix::fs::MetadataExt;
        let uid=fs::metadata(root).map_err(|e|e.to_string())?.uid();
        for process in fs::read_dir("/proc").map_err(|e| e.to_string())? {
            let process = process.map_err(|e| e.to_string())?.path();
            if !process.file_name().is_some_and(|p| p.to_string_lossy().chars().all(|c| c.is_ascii_digit())) { continue; }
            let metadata = match fs::metadata(&process) { Ok(m) => m, Err(e) if proc_entry_disappeared(&e) => continue, Err(e) => return Err(e.to_string()) };
            if metadata.uid() != uid { continue; }
            // Exited processes can remain as zombies while their parent reaps
            // them. Linux denies their ptrace-gated cwd/exe links, but their
            // kernel state proves they cannot hold files or perform writes.
            let stat=match fs::read_to_string(process.join("stat")) {Ok(raw)=>raw,Err(e) if proc_entry_disappeared(&e)=>continue,Err(e)=>return Err(format!("workspace process state incomplete at {}: {e}",process.display()))};
            let state=crate::transport::proc_stat(&stat).ok_or_else(||format!("workspace process state malformed at {}",process.display()))?.0;
            if matches!(state,'Z'|'X') {continue;}
            for link in ["cwd", "exe"] {
                match fs::read_link(process.join(link)) {
                    Ok(path) if path.starts_with(root) => return Err(format!("workspace is held by process {}", process.display())),
                    Ok(_) => {}, Err(e) if proc_entry_disappeared(&e) => {},
                    Err(e) if e.kind()==io::ErrorKind::PermissionDenied && matches!(authority,ReaderAuthority::FencedAllocation)=>{},
                    Err(e) => return Err(format!("workspace process visibility incomplete at {}/{} (state {state}): {e}",process.display(),link)),
                }
            }
            // A compiler can be between opens while still owning its target
            // directory. Its declared environment/argv and mapped files count
            // as readers too; checking only cwd/fds would miss that interval.
            for name in ["cmdline", "environ"] {
                let bytes = match fs::read(process.join(name)) { Ok(b) => b, Err(e) if proc_entry_disappeared(&e) => continue, Err(e) if e.kind()==io::ErrorKind::PermissionDenied && matches!(authority,ReaderAuthority::FencedAllocation)=>continue, Err(e) => return Err(format!("workspace process scope incomplete: {e}")) };
                for value in bytes.split(|b| *b == 0) {
                    let value = String::from_utf8_lossy(value);
                    let path = value.split_once('=').map(|(_, value)| value).unwrap_or(&value);
                    if path.starts_with('/') && Path::new(path).starts_with(root) { return Err(format!("workspace is declared by process {}", process.display())); }
                }
            }
            match fs::read_to_string(process.join("maps")) {
                Ok(maps) if maps.lines().filter_map(|line| line.split_whitespace().nth(5)).any(|path| path.starts_with('/') && Path::new(path).starts_with(root)) => return Err(format!("workspace is mapped by process {}", process.display())),
                Ok(_) => {}, Err(e) if proc_entry_disappeared(&e) => {}, Err(e) if e.kind()==io::ErrorKind::PermissionDenied && matches!(authority,ReaderAuthority::FencedAllocation)=>{}, Err(e) => return Err(format!("workspace mapping visibility incomplete: {e}")),
            }
            let descriptors = match fs::read_dir(process.join("fd")) { Ok(fd) => fd, Err(e) if proc_entry_disappeared(&e) => continue, Err(e) if e.kind()==io::ErrorKind::PermissionDenied && matches!(authority,ReaderAuthority::FencedAllocation)=>continue, Err(e) => return Err(format!("workspace FD visibility incomplete: {e}")) };
            for fd in descriptors {
                let fd = fd.map_err(|e| e.to_string())?;
                match fs::read_link(fd.path()) {
                    Ok(path) if path.starts_with(root) => return Err(format!("workspace has an open process descriptor: {}", fd.path().display())),
                    Ok(_) => {}, Err(e) if proc_entry_disappeared(&e) => {}, Err(e) if e.kind()==io::ErrorKind::PermissionDenied && matches!(authority,ReaderAuthority::FencedAllocation)=>{}, Err(e) => return Err(e.to_string()),
                }
            }
        }
        Ok(())
    }
    #[cfg(target_os = "macos")] {
        use std::os::unix::fs::MetadataExt;
        let _=authority;
        let uid=fs::metadata(root).map_err(|e|e.to_string())?.uid();
        // lsof's kernel inventory is expensive when multiple test controllers
        // probe at once. The real gateway has one owner; keep that same bound
        // here and restrict observation to this Unix user's readers.
        static PROBE: Mutex<()> = Mutex::new(());
        let _probe = PROBE.lock().map_err(|_| "workspace reader probe poisoned")?;
        let mut command = Command::new("lsof"); command.args(["-nP", "-t", "-a", "-u", &uid.to_string(), "+D"]).arg(root);
        let output = run_with_timeout(command, 10)?;
        if output.status.code() == Some(1) && output.stdout.is_empty() && output.stderr.is_empty() { Ok(()) }
        else { Err("workspace still has readers or process visibility is incomplete".into()) }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))] Err("workspace process visibility is unavailable".into())
}
