//! The gateway's sole disk owner. Allocation is write-ahead; retirement is a
//! durable job, not a task-status/age heuristic. All mutations take the same
//! per-resource lock, including preparation and restart reconciliation.
use super::*;
use super::attempt_journal as journal;
use super::lifecycle::{Ownership, Ticket};
use std::{fs, io};

#[path = "workspace_legacy.rs"]
mod legacy;

const GIB: u64 = 1024 * 1024 * 1024;
pub(super) const INTERVAL: Duration = Duration::from_secs(30);
const BATCH: usize = 4;

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all="snake_case")]
enum CacheAuthority { ExclusiveAllocation, #[default] LegacyDiscovery }

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Location {
    Managed { root: PathBuf },
    Legacy { root: PathBuf, task: Option<String> },
    AdoptedExecution { root: PathBuf, task: String },
    RepositoryCache { root: PathBuf, #[serde(default)] authority:CacheAuthority },
    GeneratedCache { root: PathBuf },
    OwnedDisposable { root: PathBuf, parent_id: String },
}
impl Location {
    fn root(&self) -> &Path { match self { Self::Managed { root } | Self::Legacy { root, .. } | Self::AdoptedExecution {root,..} | Self::RepositoryCache { root, .. } | Self::GeneratedCache { root } | Self::OwnedDisposable {root,..} => root } }
    fn work(&self) -> PathBuf { match self { Self::Managed { root } => root.join("work"), _=>self.root().to_path_buf() } }
}

#[derive(Clone, Serialize, Deserialize)]
struct Snapshot { path: PathBuf, checkpoint: crate::checkpoint::Checkpoint }

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum Phase {
    Cached { last_used_at: u64 },
    InUse { owner: Ownership },
    LegacyUnproved,
    Released { owner: Ownership },
    Preserving { owner: Ownership, snapshots: Vec<Snapshot> },
    Reclaimable { snapshots: Vec<Snapshot> },
    Removing { operation_id: String, bytes_before: u64, repositories: Vec<PathBuf>, snapshots: Vec<Snapshot>, trash: PathBuf },
    Deleting { operation_id: String, bytes_before: u64, repositories: Vec<PathBuf>, trash: PathBuf },
    Removed { reclaimed_bytes: u64, at: u64 },
}

#[derive(Clone, Serialize, Deserialize)]
struct Resource {
    version: u32, id: String, location: Location, phase: Phase,
    observed_bytes: u64, checked_at: u64, retry_at: u64, error: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Removal { resource_id: String, bytes: u64, at: u64 }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Admission {
    Ready,
    Held { reason: String },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Status {
    pub observed_at: u64, pub last_reconciled_at: u64,
    pub managed_bytes: u64, pub cache_bytes: u64, pub evidence_bytes: u64, pub reclaimed_bytes: u64,
    pub resources: usize, pub pending: usize, pub retained: usize,
    pub budget_bytes: u64, pub available_bytes: u64, pub admission: Admission,
}

#[derive(Clone)]
pub(super) struct Owner { cfg: DispatchConfig, ledger: PathBuf, allocations: PathBuf }

/// A preparation holds its exact resource lock until launch intent is durable.
/// The persistent InUse state then protects it across controller/worker swaps.
pub(super) struct Allocation {
    pub root: PathBuf, pub work: PathBuf, pub checkout: Option<PathBuf>,
    id: String, owner: Owner, _lock: worker_session::Lock,
}
impl Allocation {
    pub fn bind(&self, owner: &Ownership) -> Result<(), String> {
        let mut record = self.owner.read(&self.id)?;
        match &record.phase {
            Phase::InUse { owner: old @ Ownership::Reservation { .. } } if old.ticket() == owner.ticket() => {},
            Phase::InUse { owner: old } if old == owner => return Ok(()),
            _ => return Err("workspace no longer belongs to this preparation".into()),
        }
        record.phase = Phase::InUse { owner: owner.clone() };
        self.owner.save(&record)
    }
    pub fn environment(&self) -> Vec<(String, String)> {
        environment(&self.root)
    }
}

pub(super) fn environment(root: &Path) -> Vec<(String, String)> {
    [("TMPDIR", "tmp"), ("TMP", "tmp"), ("TEMP", "tmp"),
        ("CARGO_TARGET_DIR", "cache/cargo"), ("npm_config_cache", "cache/npm"),
        ("XDG_CACHE_HOME", "cache/xdg"), ("BRIDGE_WORKSPACE_ROOT", "")]
        .iter().map(|(key, path)| ((*key).into(), root.join(path).to_string_lossy().into_owned())).collect()
}

impl Owner {
    pub fn open(cfg: &DispatchConfig) -> Result<Self, String> {
        let allocations = PathBuf::from(&cfg.workdir).join("workspaces");
        fs::create_dir_all(&allocations).map_err(|e| e.to_string())?;
        let allocations = allocations.canonicalize().map_err(|e| e.to_string())?;
        let ledger = gateway_pipeline::root(cfg)?.join("workspaces");
        fs::create_dir_all(&ledger).map_err(|e| e.to_string())?;
        let mut cfg = cfg.clone();
        cfg.workdir = allocations.parent().ok_or("workspace parent missing")?.to_string_lossy().into_owned();
        Ok(Self { cfg, ledger, allocations })
    }
    fn file(&self, id: &str) -> PathBuf { self.ledger.join(format!("{id}.json")) }
    fn archive_file(&self,id:&str)->PathBuf {self.ledger.join("archive").join(format!("{id}.json"))}
    fn contains(&self,id:&str)->bool {self.file(id).exists()||self.archive_file(id).exists()}
    fn lock(&self, id: &str) -> Result<Option<worker_session::Lock>, String> {
        worker_session::Lock::acquire(&self.ledger.join(format!("{id}.lock")))
    }
    fn read(&self, id: &str) -> Result<Resource, String> {
        let bytes=match fs::read(self.file(id)) {Ok(bytes)=>bytes,Err(error) if error.kind()==io::ErrorKind::NotFound=>fs::read(self.archive_file(id)).map_err(|e|e.to_string())?,Err(error)=>return Err(error.to_string())};
        let record: Resource = serde_json::from_slice(&bytes).map_err(|e| format!("workspace journal corrupt: {e}"))?;
        if record.version != 1 || record.id != id { return Err("workspace journal identity/version mismatch".into()); }
        if let Location::Managed { root } = &record.location {
            if *root != self.allocations.join(id) { return Err("workspace path escaped its allocation".into()); }
        }
        Ok(record)
    }
    fn save(&self, record: &Resource) -> Result<(), String> {
        if matches!(record.phase,Phase::Removed { .. }) {
            journal::write_file(&self.archive_file(&record.id),&serde_json::to_vec(record).map_err(|e|e.to_string())?)?;
            match fs::remove_file(self.file(&record.id)) {Ok(())=>{},Err(e) if e.kind()==io::ErrorKind::NotFound=>{},Err(e)=>return Err(e.to_string())}
            #[cfg(unix)] fs::File::open(&self.ledger).and_then(|f|f.sync_all()).map_err(|e|e.to_string())?;
            Ok(())
        } else {journal::write_file(&self.file(&record.id), &serde_json::to_vec(record).map_err(|e| e.to_string())?)}
    }
    fn records(&self) -> Result<Vec<Resource>, String> {
        let mut result = Vec::new();
        for entry in fs::read_dir(&self.ledger).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") || path.file_stem().and_then(|e| e.to_str()) == Some("status") { continue; }
            result.push(self.read(path.file_stem().and_then(|p| p.to_str()).ok_or("workspace filename invalid")?)?);
        }
        Ok(result)
    }
    pub fn status(&self) -> Result<Status, String> {
        serde_json::from_slice(&fs::read(self.ledger.join("status.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }
    pub fn admission(&self) -> Admission {
        match self.status() {
            Ok(status) if now_ms().saturating_sub(status.observed_at) < 120_000 => status.admission,
            _ => Admission::Held { reason: "workspace owner is measuring disk/reconciling its durable inventory".into() },
        }
    }
    pub fn environment_for(&self, ticket: &Ticket) -> Result<Vec<(String, String)>, String> {
        let id = journal::stable_key(&[&ticket.task_id, &ticket.session]);
        if !self.contains(&id) { return Ok(vec![]); }
        let record = self.read(&id)?;
        match record.phase {
            Phase::InUse { owner } if owner.ticket() == ticket => Ok(environment(record.location.root())),
            _ => Err("workspace is not available for execution".into()),
        }
    }
    pub fn allocate(&self, ticket: &Ticket, repo: Option<&str>) -> Result<Allocation, String> {
        if let Admission::Held { reason } = self.admission() { return Err(reason); }
        let id = journal::stable_key(&[&ticket.task_id, &ticket.session]);
        let lock = self.lock(&id)?.ok_or("workspace is being reconciled; retry preparation")?;
        if self.contains(&id) { return Err("workspace allocation already exists; reconcile its original execution instead of reusing it".into()); }
        let root = self.allocations.join(&id);
        let record = Resource { version: 1, id: id.clone(), location: Location::Managed { root: root.clone() },
            phase: Phase::InUse { owner: Ownership::Reservation { ticket: ticket.clone() } }, observed_bytes: 0, checked_at: 0, retry_at: 0, error: None };
        self.save(&record)?; // intent precedes every directory and Git write
        for path in ["work", "tmp", "logs", "cache/cargo", "cache/npm", "cache/xdg"] { fs::create_dir_all(root.join(path)).map_err(|e| e.to_string())?; }
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&root,fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?; }
        let work = root.join("work");
        let checkout = if let Some(repo) = repo {
            let cache_path = repo_cache_path(&self.cfg.workdir, repo);
            let cache_id = format!("cache-{}", journal::stable_key(&[&cache_path.to_string_lossy()]));
            let _cache_lock = self.lock(&cache_id)?.ok_or("repository cache is being reclaimed; retry preparation")?;
            let authority=if self.contains(&cache_id) {
                let previous=self.read(&cache_id)?;
                match (previous.phase,previous.location) {
                    (Phase::Cached { .. },Location::RepositoryCache {authority,..})=>authority,
                    (Phase::Removed { .. },_) if !cache_path.exists()=>CacheAuthority::ExclusiveAllocation,
                    (Phase::Removed { .. },_)=>CacheAuthority::LegacyDiscovery,
                    _=>return Err("repository cache retirement is still pending".into()),
                }
            } else if cache_path.exists() {CacheAuthority::LegacyDiscovery} else {CacheAuthority::ExclusiveAllocation};
            let cache_record = Resource { version: 1, id: cache_id, location: Location::RepositoryCache { root: cache_path, authority },
                phase: Phase::Cached { last_used_at: now_ms() }, observed_bytes: 0, checked_at: 0, retry_at: 0, error: None };
            // A partially retired cache must finish its old deletion before it
            // can be re-created. Never overwrite a removal intent.
            if self.contains(&cache_record.id) && !matches!(self.read(&cache_record.id)?.phase, Phase::Cached { .. } | Phase::Removed { .. }) {
                return Err("repository cache retirement is still pending".into());
            }
            self.save(&cache_record)?;
            let cache = ensure_repo_clone(&self.cfg.workdir, repo).map_err(|e| e.detail().to_string())?;
            // Unique per claim: an old finalizer can never remove a newer run's
            // directory or branch. Restoration comes from the hub checkpoint.
            git(&cache, &["worktree", "add", "--detach", work.to_str().ok_or("workspace path is not UTF-8")?, "origin/HEAD"])?;
            Some(work.clone())
        } else { None };
        Ok(Allocation { root, work, checkout, id, owner: self.clone(), _lock: lock })
    }
    pub fn release(&self, receipt: &lifecycle::Released) -> Result<(), String> {
        let owner = receipt.owner();
        let id = journal::stable_key(&[&owner.ticket().task_id, &owner.ticket().session]);
        if !self.file(&id).exists() { return Ok(()); } // pre-owner legacy record
        let _lock = self.lock(&id)?.ok_or("workspace preparation still owns its lock")?;
        let mut record = self.read(&id)?;
        match &record.phase {
            Phase::InUse { owner: expected } if expected == owner => {
                record.phase = Phase::Released { owner: owner.clone() }; record.retry_at = 0;
                self.save(&record)
            },
            Phase::InUse { .. } => Err("workspace release does not match its exact owner".into()),
            _ => Ok(()), // durable retirement is idempotent
        }
    }
    pub fn output_path(&self, ticket: &Ticket) -> Result<Option<PathBuf>, String> {
        let id = journal::stable_key(&[&ticket.task_id, &ticket.session]);
        if !self.contains(&id) { return Ok(None); }
        let record = self.read(&id)?;
        if !matches!(&record.phase, Phase::InUse { owner } if owner.ticket() == ticket) { return Err("workspace no longer owns worker output".into()); }
        Ok(Some(record.location.root().join("logs/output.jsonl")))
    }
    fn recover_release(&self, owner: &Ownership) -> Result<(), String> {
        // An immutable original-fence ACK covers this unique old allocation
        // even when the task has already started a newer execution elsewhere.
        if matches!(owner, Ownership::Attempt { .. }) && gateway_pipeline::workspace_release_receipt(&self.cfg, owner)?.is_some() { return Ok(()); }
        let ticket = owner.ticket();
        let state = execution_request(&self.cfg, &ticket.task_id, &ticket.session, &format!("workspace-inspect-{}", now_ms()), json!({"kind":"inspect"}))?;
        if state["operations"].as_array().is_none_or(|ops| ops.iter().any(|op| matches!(op["state"].as_str(), Some("prepared" | "outcome_unknown")))) { return Err("workspace has unresolved external-operation evidence".into()); }
        match owner {
            Ownership::Reservation { .. } => {
                let card = mcp_call(&self.cfg, &mut 0, "get_artefact", json!({"id":ticket.task_id}))?;
                lifecycle::Released::reservation_reconciled(owner, &card)?;
                // Reservation alone never proves no process. Any launch intent
                // for this ticket retains the allocation until exact delivery.
                let launches = gateway_pipeline::workspace_launch_exists(&self.cfg, ticket)?;
                if launches { return Err("workspace launch intent still needs exact writer reconciliation".into()); }
            },
            Ownership::Attempt { host, generation, attempt_id, .. } => {
                let a = &state["attempt"];
                if a["host"] != *host || a["session"] != ticket.session || a["generation"] != *generation || a["attempt_id"] != *attempt_id || a["phase"] != "quiesced" {
                    return Err("workspace retains unconfirmed execution; expiry is not writer proof".into());
                }
            },
        }
        Ok(())
    }
    /// One bounded fair pass; busy/held tickets only exclude their own paths.
    /// This is called by the gateway during both normal work and update drain.
    pub fn reconcile(&self, protected: &[Ticket]) -> Result<Status, String> {
        legacy::adopt(self)?;
        let mut records = self.records()?;
        records.sort_by_key(|r| (r.checked_at, std::cmp::Reverse(r.observed_bytes), r.id.clone()));
        let mut visited = 0;
        for old in &records {
            if matches!(old.phase, Phase::Removed { .. }) || old.retry_at > now_ms() { continue; }
            let ticket = match &old.phase { Phase::InUse { owner } | Phase::Released { owner } | Phase::Preserving { owner, .. } => Some(owner.ticket()), _ => None };
            if ticket.is_some_and(|t| protected.contains(t)) { continue; }
            if visited >= BATCH { break; }
            let Some(_lock) = self.lock(&old.id)? else { continue; };
            let mut record = self.read(&old.id)?;
            visited += 1;
            record.checked_at = now_ms();
            let result = self.advance(&mut record);
            match result {
                Ok(()) => { record.error = None; record.retry_at = 0; },
                Err(error) => { record.error = Some(error); record.retry_at = now_ms() + 30_000; },
            }
            self.save(&record)?;
        }
        self.measure()
    }
    fn advance(&self, record: &mut Resource) -> Result<(), String> {
        if matches!(record.phase,Phase::Removed { .. }) {return Ok(());}
        let original_is_owned = match &record.phase {
            Phase::Deleting { .. } => false,
            Phase::Removing { trash, .. } => !trash.exists(),
            _ => true,
        };
        if original_is_owned {
            let prefix = match &record.location { Location::Legacy { .. } | Location::AdoptedExecution { .. }=>Some("legacy"),Location::GeneratedCache { .. } | Location::OwnedDisposable { .. }=>Some("generated"),_=>None };
            if let Some(prefix)=prefix {
                if !record.location.root().exists() || legacy::allocation_id(prefix,record.location.root())?!=record.id {
                    // A recycled legacy pathname is a new allocation, imported
                    // under its new inode identity. Never use the old receipt.
                    record.phase=Phase::Removed {reclaimed_bytes:0,at:now_ms()};
                    return self.save(record);
                }
            }
        }
        match record.phase.clone() {
            Phase::Cached { last_used_at } => {
                let pressure = self.status().is_ok_and(|s| matches!(s.admission, Admission::Held { .. }));
                if !pressure && now_ms().saturating_sub(last_used_at) < 3_600_000 { return Ok(()); }
                legacy::no_external_worktrees(record.location.root(), record.location.root())?;
                // A cache cannot discard an unrelated local branch, even if
                // its checked-out HEAD is remotely published.
                for head in git(record.location.root(), &["for-each-ref", "--format=%(objectname)", "refs/heads/"])?.lines() {
                    git(record.location.root(), &["merge-base", "--is-ancestor", head, "HEAD"])?;
                }
                record.phase = Phase::LegacyUnproved; self.save(record)?;
                legacy::prove(self, record)?;
            },
            Phase::InUse { owner } => { self.recover_release(&owner)?; record.phase = Phase::Released { owner }; self.save(record)?; },
            Phase::LegacyUnproved => { legacy::prove(self, record)?; },
            _ => {},
        }
        if let Phase::Released { owner } = record.phase.clone() {
            legacy::no_readers(record.location.root(),self.reader_authority(record)?)?;
            verify_layout(record)?;
            let mut paths = Vec::new();
            repositories(&record.location.work(), &mut paths)?;
            self.retire_disposable_children(record,&paths)?;
            for path in &paths { unpreserved_ignored_inputs(path)?; }
            // Non-Git scratch inputs are never silently thrown away. Empty
            // scratch and explicitly owned cache/tmp are disposable.
            if uncovered_inputs(&record.location.work(), &paths)? { return Err("scratch contains uncheckpointed non-Git inputs; preserve them before retirement".into()); }
            let generation = match owner { Ownership::Attempt { generation, .. } => generation, _ => 0 };
            let mut snapshots = Vec::new();
            for path in paths {
                let checkpoint = crate::checkpoint::capture(&path, &owner.ticket().task_id, generation,
                    "Workspace owner preserved stopped execution; restore this checkpoint to resume.", vec![std::env::consts::OS.into(), std::env::consts::ARCH.into()])?;
                snapshots.push(Snapshot { path, checkpoint });
            }
            record.phase = Phase::Preserving { owner, snapshots }; self.save(record)?;
        }
        if let Phase::Preserving { snapshots, .. } = record.phase.clone() {
            for snapshot in &snapshots { crate::checkpoint::publish_captured(&snapshot.path, &snapshot.checkpoint)?; }
            record.phase = Phase::Reclaimable { snapshots }; self.save(record)?;
        }
        if let Phase::Reclaimable { snapshots } = &record.phase {
            legacy::no_readers(record.location.root(),self.reader_authority(record)?)?;
            verify_inputs(record,snapshots)?;
            for snapshot in snapshots {
                if !crate::checkpoint::matches_working_tree(&snapshot.path, &snapshot.checkpoint)? { return Err("newer local inputs differ from the verified checkpoint; retained".into()); }
                crate::checkpoint::verify_published(&snapshot.path, &snapshot.checkpoint)?;
                legacy::no_external_worktrees(&snapshot.path, record.location.root())?;
            }
            // The source receipt outlives the local allocation and its terminal
            // delivery WAL. Scratch/nested-repo checkpoints remain discoverable.
            journal::write_file(&self.ledger.join("checkpoints").join(format!("{}.json", record.id)),
                &serde_json::to_vec(snapshots).map_err(|e| e.to_string())?)?;
            let repositories = snapshots.iter().filter(|s| s.path.join(".git").is_file()).map(|s| PathBuf::from(worktree_owner(&s.path, &s.path.to_string_lossy()))).collect();
            let root = record.location.root();
            let trash = root.parent().ok_or("workspace root parent missing")?.join(format!(".bridge-reclaim-{}", record.id));
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos().to_string();
            record.phase = Phase::Removing { operation_id:journal::stable_key(&[&record.id,&nonce]), bytes_before: disk_bytes(root)?, repositories, snapshots: snapshots.clone(), trash };
            self.save(record)?; // restart resumes deletion, never re-publishes
        }
        if let Phase::Removing { operation_id, bytes_before, repositories, snapshots, trash } = record.phase.clone() {
            if !trash.exists() {
                legacy::no_readers(record.location.root(),self.reader_authority(record)?)?;
                verify_inputs(record,&snapshots)?;
                for snapshot in snapshots {
                    if !crate::checkpoint::matches_working_tree(&snapshot.path, &snapshot.checkpoint)? { return Err("newer local inputs arrived before retirement rename; retained".into()); }
                }
                if record.location.root().exists() {
                    fs::rename(record.location.root(), &trash).map_err(|e| e.to_string())?;
                    #[cfg(unix)] fs::File::open(trash.parent().unwrap()).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
                }
            }
            record.phase = Phase::Deleting { operation_id, bytes_before, repositories, trash }; self.save(record)?;
        }
        if let Phase::Deleting { operation_id, bytes_before, repositories, trash } = record.phase.clone() {
            // A newly created directory at the original path is never touched.
            // Only the journalled atomic-rename destination is ours to delete.
            legacy::no_readers(&trash,self.reader_authority(record)?)?;
            remove_tree(&trash)?;
            if trash.exists() { return Err("workspace removal incomplete; retry retained".into()); }
            for repository in repositories { let _ = git(&repository, &["worktree", "prune"]); }
            let receipt = self.ledger.join("removals").join(format!("{operation_id}.json"));
            if receipt.exists() {
                let old:Removal=serde_json::from_slice(&fs::read(&receipt).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                if old.resource_id!=record.id || old.bytes!=bytes_before {return Err("workspace removal receipt changed; retained for reconciliation".into());}
            } else {
                journal::write_file(&receipt,&serde_json::to_vec(&Removal {resource_id:record.id.clone(),bytes:bytes_before,at:now_ms()}).map_err(|e| e.to_string())?)?;
            }
            record.observed_bytes = 0;
            record.phase = Phase::Removed { reclaimed_bytes: bytes_before, at: now_ms() };
        }
        Ok(())
    }
    fn measure(&self) -> Result<Status, String> {
        let budget = std::env::var("BRIDGE_WORKSPACE_BUDGET_GIB").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(100).saturating_mul(GIB);
        let floor = std::env::var("BRIDGE_WORKSPACE_MIN_FREE_GIB").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(5).saturating_mul(GIB);
        self.measure_with_limits(budget, floor)
    }
    fn reader_authority(&self,record:&Resource)->Result<legacy::ReaderAuthority,String> {
        match &record.location {
            // These paths were granted only to fenced executions, or to the
            // repository cache's locked provisioning/dependency protocol. An
            // unrelated non-dumpable daemon is not another workspace owner.
            Location::Managed { .. } | Location::RepositoryCache {authority:CacheAuthority::ExclusiveAllocation,..} | Location::AdoptedExecution { .. }=>Ok(legacy::ReaderAuthority::FencedAllocation),
            Location::OwnedDisposable {parent_id,..}=>{
                let parent=self.read(parent_id)?;
                if matches!(parent.location,Location::OwnedDisposable { .. }) {return Err("disposable parent is not an execution allocation".into());}
                if matches!(parent.phase,Phase::InUse { .. }|Phase::Cached { .. }|Phase::LegacyUnproved) {return Err("disposable allocation's original owner is not released".into());}
                self.reader_authority(&parent)
            },
            _=>Ok(legacy::ReaderAuthority::UnattributedLegacy),
        }
    }
    fn retire_disposable_children(&self, parent: &Resource, repositories: &[PathBuf]) -> Result<(), String> {
        // Disposable allocations can retire even when valuable source must be
        // retained (for example an ignored .env or unique measurement output).
        // They use this same journal/state machine, including crash receipts.
        for old in self.records()? {
            if old.id==parent.id || !matches!(old.location,Location::OwnedDisposable { .. }) || !old.location.root().starts_with(parent.location.root()) || matches!(old.phase,Phase::Removed { .. }) {continue;}
            let _lock=self.lock(&old.id)?.ok_or("disposable child still has a workspace owner")?;
            let mut child=self.read(&old.id)?;self.advance(&mut child)?;self.save(&child)?;
        }
        let mut paths=Vec::new();
        if let Location::Managed {root}=&parent.location {paths.extend([root.join("cache"),root.join("tmp"),root.join("logs")]);}
        for repository in repositories {
            for name in ["target","node_modules"] {
                let path=repository.join(name);
                if path.is_dir() && git(repository,&["check-ignore","--",name]).is_ok() {paths.push(path);}
            }
        }
        for path in paths {
            if !path.exists() || fs::symlink_metadata(&path).map_err(|e|e.to_string())?.file_type().is_symlink() {continue;}
            // Allocation scaffolding (cache/tmp/logs) holds no content until a
            // build runs. A file-less tree has nothing to preserve and no
            // bytes worth a receipt; recording it would count empty
            // directories as reclaimed disk on every released workspace.
            if !tree_has_files(&path) {continue;}
            let path=path.canonicalize().map_err(|e|e.to_string())?;
            let id=legacy::allocation_id("generated",&path)?;
            let _lock=self.lock(&id)?.ok_or("disposable child is being reconciled")?;
            let mut child=if self.file(&id).exists() {self.read(&id)?} else {
                Resource {version:1,id,location:Location::OwnedDisposable {root:path,parent_id:parent.id.clone()},phase:Phase::Reclaimable {snapshots:vec![]},observed_bytes:0,checked_at:now_ms(),retry_at:0,error:None}
            };
            self.save(&child)?;self.advance(&mut child)?;self.save(&child)?;
        }
        Ok(())
    }
    fn measure_with_limits(&self, budget_bytes: u64, floor: u64) -> Result<Status, String> {
        let records = self.records()?;
        let mut positions=Vec::new();
        for record in &records {
            let path = allocation_path(record);
            let bytes=if matches!(record.phase,Phase::Removed { .. }) {0} else {disk_bytes(path)?};
            if !matches!(record.phase,Phase::Removed { .. }) && !matches!(record.location, Location::RepositoryCache { .. }) { positions.push(path.to_path_buf()); }
            if let Some(_lock)=self.lock(&record.id)? {
                let mut current=self.read(&record.id)?;
                current.observed_bytes=bytes;
                self.save(&current)?;
            }
        }
        let positions=minimal_roots(positions);
        let mut managed_bytes:u64=0;
        for path in &positions {managed_bytes=managed_bytes.saturating_add(disk_bytes(path)?);}
        let repos=PathBuf::from(&self.cfg.workdir).join("repos");
        let repos=repos.canonicalize().unwrap_or(repos);
        let cache_bytes = disk_bytes(&repos)?;
        // Legacy worktrees nested in a cache are already in managed_bytes.
        let mut nested:u64=0;
        for path in positions.iter().filter(|path|path.starts_with(&repos)) {nested=nested.saturating_add(disk_bytes(path)?);}
        let cache_bytes = cache_bytes.saturating_sub(nested);
        let journal=gateway_pipeline::root(&self.cfg)?;
        let evidence_bytes = disk_bytes(&journal)?;
        let overlap=if Path::new(&self.cfg.workdir).starts_with(&journal) {disk_bytes(Path::new(&self.cfg.workdir))?} else {0};
        let evidence_bytes=evidence_bytes.saturating_sub(overlap);
        let mut reclaimed_bytes:u64=0;
        if let Ok(entries)=fs::read_dir(self.ledger.join("removals")) {
            for entry in entries {
                let path=entry.map_err(|e| e.to_string())?.path();
                let removal:Removal=serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                reclaimed_bytes=reclaimed_bytes.saturating_add(removal.bytes);
            }
        }
        let available_bytes = available_bytes(&self.allocations)?;
        let admission = if managed_bytes.saturating_add(cache_bytes).saturating_add(evidence_bytes) >= budget_bytes || available_bytes < floor {
            Admission::Held { reason: format!("workspace disk budget: {} bytes owned, {} cache, {} retained evidence, {} budget, {} available; reclamation continues", managed_bytes, cache_bytes, evidence_bytes, budget_bytes, available_bytes) }
        } else { Admission::Ready };
        let status = Status { observed_at: now_ms(), last_reconciled_at: now_ms(), managed_bytes, cache_bytes, evidence_bytes,
            reclaimed_bytes,
            resources: records.len(), pending: records.iter().filter(|r| !matches!(r.phase, Phase::InUse { .. } | Phase::Removed { .. } | Phase::Cached { .. })).count(),
            retained: records.iter().filter(|r| r.error.is_some()).count(), budget_bytes, available_bytes, admission };
        journal::write_file(&self.ledger.join("status.json"), &serde_json::to_vec(&status).map_err(|e| e.to_string())?)?;
        Ok(status)
    }
    pub fn report(&self) -> Result<serde_json::Value, String> {
        let mut checkpoints = serde_json::Map::new();
        if let Ok(entries) = fs::read_dir(self.ledger.join("checkpoints")) {
            for entry in entries {
                let path = entry.map_err(|e| e.to_string())?.path();
                let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                checkpoints.insert(path.file_stem().ok_or("checkpoint receipt filename missing")?.to_string_lossy().into_owned(), value);
            }
        }
        Ok(json!({"status":self.status().ok(),"resources":self.records()?,"checkpoints":checkpoints}))
    }
}

fn git(path: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git"); cmd.current_dir(path).args(args).env("GIT_TERMINAL_PROMPT", "0");
    let out = run_with_timeout(cmd, 40)?;
    if !out.status.success() { return Err(format!("workspace Git {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr))); }
    Ok(String::from_utf8_lossy(&out.stdout).trim().into())
}
fn allocation_path(record:&Resource)->&Path {
    match &record.phase {
        Phase::Deleting {trash,..}=>trash,
        Phase::Removing {trash,..} if trash.exists()=>trash,
        _=>record.location.root(),
    }
}
fn minimal_roots(paths:Vec<PathBuf>)->Vec<PathBuf> {
    let mut paths:Vec<_>=paths.into_iter().map(|path| {
        if fs::symlink_metadata(&path).is_ok_and(|m|m.file_type().is_symlink()) {path} else {path.canonicalize().unwrap_or(path)}
    }).collect();
    paths.sort_by_key(|path|(path.components().count(),path.clone()));
    let mut result:Vec<PathBuf>=Vec::new();
    for path in paths {if !result.iter().any(|root|path.starts_with(root)) {result.push(path);}}
    result
}
fn disposable(name: &str) -> bool { matches!(name, "target" | "node_modules" | ".git") }
fn repositories(path: &Path, result: &mut Vec<PathBuf>) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    if path.join(".git").exists() { result.push(path.to_path_buf()); }
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !disposable(&entry.file_name().to_string_lossy()) && entry.file_type().map_err(|e| e.to_string())?.is_dir() { repositories(&entry.path(), result)?; }
    }
    Ok(())
}
fn uncovered_inputs(path: &Path, repositories: &[PathBuf]) -> Result<bool, String> {
    if !path.exists() { return Ok(false); }
    if repositories.iter().any(|repo| path.starts_with(repo)) { return Ok(false); }
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            if uncovered_inputs(&entry.path(), repositories)? { return Ok(true); }
        } else { return Ok(true); }
    }
    Ok(false)
}
/// Any read failure counts as content: a child is only skipped when its
/// emptiness is proven, never assumed.
fn tree_has_files(path: &Path) -> bool {
    let Ok(entries) = fs::read_dir(path) else { return true };
    for entry in entries {
        let Ok(entry) = entry else { return true };
        match entry.file_type() {
            Ok(t) if t.is_dir() => if tree_has_files(&entry.path()) { return true; },
            Ok(_) => return true,
            Err(_) => return true,
        }
    }
    false
}
fn unpreserved_ignored_inputs(path: &Path) -> Result<(), String> {
    let ignored=git(path,&["ls-files","--others","--ignored","--exclude-standard","--directory","-z"])?;
    if let Some(input)=ignored.split('\0').find(|input| !input.is_empty()) {
        return Err(format!("ignored input is not a declared disposable allocation; source retained: {input}"));
    }
    Ok(())
}
fn verify_layout(record:&Resource)->Result<(),String> {
    if let Location::Managed {root}=&record.location {
        for entry in fs::read_dir(root).map_err(|e|e.to_string())? {
            let entry=entry.map_err(|e|e.to_string())?;
            if !matches!(entry.file_name().to_str(),Some("work"|"tmp"|"cache"|"logs")) {return Err("workspace contains unregistered inputs outside its source directory; retained".into());}
        }
    }
    Ok(())
}
fn verify_inputs(record:&Resource,snapshots:&[Snapshot])->Result<(),String> {
    if matches!(record.location,Location::GeneratedCache { .. } | Location::OwnedDisposable { .. }) {return Ok(());}
    verify_layout(record)?;
    let paths:Vec<_>=snapshots.iter().map(|s|s.path.clone()).collect();
    if uncovered_inputs(&record.location.work(),&paths)? {return Err("new uncheckpointed scratch inputs arrived before retirement; retained".into());}
    for snapshot in snapshots {unpreserved_ignored_inputs(&snapshot.path)?;}
    Ok(())
}
fn remove_tree(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Ok(metadata) if metadata.file_type().is_symlink() => Err("workspace root became a symlink; retained".into()),
        Ok(_) => fs::remove_dir_all(path).map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    }
}
fn disk_bytes(path: &Path) -> Result<u64, String> {
    if !path.exists() { return Ok(0); }
    let mut command = Command::new("du"); command.args(["-sk"]).arg(path);
    let output = run_with_timeout(command, 30)?;
    if !output.status.success() {
        // Active builds unlink temporary files during inventory. Their vanished
        // bytes are expendable and the captured total is conservative. Any
        // permission/I/O/other error still makes admission fail closed.
        let error=String::from_utf8_lossy(&output.stderr);
        if error.trim().is_empty() || !error.lines().all(|line| line.to_ascii_lowercase().contains("no such file or directory")) {
            return Err(format!("workspace disk inventory failed: {error}"));
        }
    }
    String::from_utf8_lossy(&output.stdout).split_whitespace().next().and_then(|n| n.parse::<u64>().ok()).map(|n| n.saturating_mul(1024)).ok_or("workspace disk inventory malformed".into())
}
fn available_bytes(path: &Path) -> Result<u64, String> {
    #[cfg(unix)] {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let path = CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 { return Err(io::Error::last_os_error().to_string()); }
        let stat = unsafe { stat.assume_init() };
        Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
    }
    #[cfg(not(unix))] Err("workspace filesystem capacity is unavailable".into())
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;
