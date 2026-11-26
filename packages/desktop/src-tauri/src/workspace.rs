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
/// BR#19525 — cadence of the bounded admission sampler (see
/// `refresh_admission`): cheap enough to run while the slow reclaim pass
/// crawls, frequent enough that the 120s proof window never lapses on the
/// sampler alone.
pub(super) const ADMISSION_SAMPLE: Duration = Duration::from_secs(15);
const BATCH: usize = 4;
/// BR#14716 — the pressure drain width (see `reconcile`): a held admission
/// means the ladder owes the budget bytes; the fair 4-per-30s pass cannot
/// repay a 684-deep pending pile before the next generation of work arrives.
const PRESSURE_BATCH: usize = 64;
/// BR#14525 (owner ruling 2026-11-13) — NO git-pushed checkpoints: the
/// WORKTREE is the durability boundary for WIP. An interrupted generation's
/// worktree therefore stays adoptable (affinity) and reclaim-protected
/// (explicit retention policy) for this long after its last generation
/// activity. Age alone is never deletion authority: expiry ends the
/// preference/hold, the evidence fences still govern every removal.
const WORKTREE_TTL: Duration = Duration::from_secs(24 * 3600);
fn worktree_ttl() -> Duration {
    std::env::var("BRIDGE_WORKTREE_TTL_HOURS").ok().and_then(|v| v.parse::<u64>().ok())
        .map(|hours| Duration::from_secs(hours.saturating_mul(3600))).unwrap_or(WORKTREE_TTL)
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all="snake_case")]
enum CacheAuthority { ExclusiveAllocation, #[default] LegacyDiscovery }

/// BR#14525 — the outcome of the explicit retention decision for a released
/// worktree (see `retention`).
enum Retention {
    /// Nothing unpublished: a done tree — the ladder may reclaim it.
    Reclaim,
    /// Unpublished value inside the TTL, no pressure: stay Released as the
    /// adoptable value signal (no error, no ladder advance).
    Hold { signal: String },
    /// Unpublished value whose retention window ended (TTL or pressure):
    /// the task-liveness rule (BR#22672) decides the exit — an adoptable
    /// task converts this back to Hold (grace), a gone task receives the
    /// recorded discard receipt and the tree re-enters the ladder.
    Yield { signal: String },
}
/// BR#22672 — task-liveness verdict for an expired unpublished worktree.
enum TaskLiveness {
    /// The task is open and routable back to this host (no other claimant,
    /// or this record's own session): the tree stays adoptable value.
    Adoptable { status: String },
    /// The task closed, or another session's claim replaced this line: the
    /// value is stale by policy — recorded discard.
    Gone { reason: String },
    /// The liveness query failed (hub unreachable, view drift): never a
    /// licence to destroy — retain and retry next pass.
    Unknown { error: String },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Location {
    Managed { root: PathBuf },
    Legacy { root: PathBuf, task: Option<String> },
    AdoptedExecution { root: PathBuf, task: String },
    RepositoryCache { root: PathBuf, #[serde(default)] authority:CacheAuthority },
    GeneratedCache { root: PathBuf, #[serde(default, skip_serializing_if = "Option::is_none")] legacy_scope: Option<PathBuf> },
    OwnedDisposable { root: PathBuf, parent_id: String },
}
impl Location {
    fn root(&self) -> &Path { match self { Self::Managed { root } | Self::Legacy { root, .. } | Self::AdoptedExecution {root,..} | Self::RepositoryCache { root, .. } | Self::GeneratedCache { root, .. } | Self::OwnedDisposable {root,..} => root } }
    fn work(&self) -> PathBuf { match self { Self::Managed { root } => root.join("work"), _=>self.root().to_path_buf() } }
}

#[derive(Clone, Serialize, Deserialize)]
struct Snapshot { path: PathBuf }

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
    /// BR#14525 — last GENERATION activity on this allocation (ms epoch):
    /// written when a generation releases or adopts the workspace. The
    /// affinity and retention TTLs read this, never the owner's own pass
    /// cadence (`checked_at`). `0` (records predating the field) means
    /// unknown freshness: never adoptable, retention falls through to the
    /// evidence fences.
    #[serde(default)]
    last_activity_at: u64,
    /// BR#14525 — present while a released worktree is held by the explicit
    /// retention policy (unpublished WIP inside the TTL). The board-visible
    /// value signal: what the retained tree holds and why reclaim is
    /// deferred. Cleared when the tree is adopted or reclaims.
    #[serde(default)]
    retained_value: Option<String>,
    /// BR#14525 — set when a generation ADOPTED this allocation from a prior
    /// generation's record (re-keyed id, preserved directory). Relaxes the
    /// exact root-name validation to a parent-directory containment check:
    /// the worktree must never move (that would break its git worktree link).
    #[serde(default)]
    adopted_from: Option<String>,
    /// BR#22634/BR#22672 — recorded-reset receipt: when the tree's expired
    /// unpublished value had its retention end (task closed or re-claimed
    /// elsewhere), the owner recorded a durable DISCARD RECEIPT
    /// (`discards/<id>.json`: task, session, HEADs, local refs, stash tip,
    /// dirty inventory, ignored evidence, byte counts) and the tree
    /// re-entered the reclaim ladder. Nothing is published anywhere (git
    /// vetoed as the sink, BR#22656): the receipt is the reset BR#14525
    /// demands before any removal — knowledge preserved, bytes reclaimed.
    /// `reset_at`/`reset_reason` are the ledger's audit markers; the fences
    /// re-verify the receipt FILE by content at every removal step.
    #[serde(default)]
    reset_at: Option<u64>,
    #[serde(default)]
    reset_reason: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Removal { resource_id: String, bytes: u64, at: u64 }
/// BR#22672 — the durable discard receipt (see `Owner::discard_receipt`).
/// Written to `discards/<id>.json` BEFORE the ladder touches the tree; the
/// fences verify it by content (`reset_proof`). Bounded lists keep a
/// pathological tree from wedging the journal with its own inventory.
#[derive(Serialize)]
struct DiscardReceipt {
    resource_id: String,
    adopted_from: Option<String>,
    task: Option<String>,
    session: Option<String>,
    reason: String,
    at: u64,
    observed_bytes: u64,
    repositories: Vec<RepositoryInventory>,
}
#[derive(Serialize)]
struct RepositoryInventory {
    path: String,
    head: Option<String>,
    head_subject: Option<String>,
    dirty: usize,
    dirty_paths: Vec<String>,
    unpushed: Option<usize>,
    local_refs: Vec<LocalRef>,
    stash: Option<String>,
    ignored_evidence: Vec<String>,
}
#[derive(Serialize)]
struct LocalRef { reference: String, tip: String }

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
    /// BR#14716 — present iff the reclaim ladder is WEDGED: admission held and
    /// every record errored (zero can advance). The board/alarm must never
    /// read this state as "idle".
    pub wedge: Option<()>,
    /// BR#14716 — the first errored records' actual errors, so the wedge is
    /// first-hand diagnosable from `workspaces status` without trawling the
    /// per-record ledger.
    #[serde(default)]
    pub error_head: Vec<(String, String)>,
    /// BR#19525 — the admissible total from the LAST full inventory, cached
    /// so the bounded admission sampler never needs to re-measure with `du`.
    /// `None` means no full measurement has completed; the sampler fails
    /// closed on it.
    #[serde(default)]
    pub admissible_bytes: Option<u64>,
    /// BR#19525 — the preserved (errored/retained) bytes behind that total,
    /// cached for the sampler's Held reason.
    #[serde(default)]
    pub preserved_bytes: u64,
}

#[derive(Clone)]
pub(super) struct Owner { cfg: DispatchConfig, ledger: PathBuf, allocations: PathBuf }

/// A preparation holds its exact resource lock until launch intent is durable.
/// The persistent InUse state then protects it across controller/worker swaps.
pub(super) struct Allocation {
    pub root: PathBuf, pub work: PathBuf, pub checkout: Option<PathBuf>,
    /// BR#14525 — present when this allocation ADOPTED a prior generation's
    /// surviving worktree (after verified quiescence, inside the affinity
    /// TTL). The value is the inherited-state summary the dispatch prompt
    /// feeds the resume protocol, so the new generation is never blind.
    pub adopted: Option<String>,
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
    pub(super) fn inspection_paths(cfg: &DispatchConfig, task: &str) -> Result<Vec<PathBuf>, String> {
        let Ok(allocations) = PathBuf::from(&cfg.workdir).join("workspaces").canonicalize() else { return Ok(vec![]); };
        let ledger = gateway_pipeline::root(cfg)?.join("workspaces");
        if !ledger.exists() { return Ok(vec![]); }
        Self { cfg: cfg.clone(), ledger, allocations }.active_paths_for_task(task)
    }

    fn active_paths_for_task(&self, task: &str) -> Result<Vec<PathBuf>, String> {
        Ok(self.records()?.into_iter().filter_map(|record| {
            match (&record.location, &record.phase) {
                (Location::Managed { .. }, Phase::InUse { owner: Ownership::Attempt { ticket, .. } })
                    if ticket.task_id == task => Some(record.location.work()),
                (Location::AdoptedExecution { task: id, .. }, Phase::InUse { .. })
                    if id == task => Some(record.location.work()),
                _ => None,
            }
        }).collect())
    }

    pub fn open(cfg: &DispatchConfig) -> Result<Self, String> {
        let allocations = PathBuf::from(&cfg.workdir).join("workspaces");
        fs::create_dir_all(&allocations).map_err(|e| e.to_string())?;
        let allocations = allocations.canonicalize().map_err(|e| e.to_string())?;
        let ledger = gateway_pipeline::root(cfg)?.join("workspaces");
        fs::create_dir_all(&ledger).map_err(|e| e.to_string())?;
        let mut cfg = cfg.clone();
        cfg.workdir = allocations.parent().ok_or("workspace parent missing")?.to_string_lossy().into_owned();
        // BR#22634 — the journal recovery reserves: one at the lifecycle
        // root (records, status, removal receipts, reservations, terminal
        // stages) and one at the workdir root (sessions, allocation
        // scaffolding). Best effort by contract: an unfilled reserve only
        // degrades to the pre-reserve behaviour.
        journal::ensure_reserve(&gateway_pipeline::root(&cfg)?);
        journal::ensure_reserve(Path::new(&cfg.workdir));
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
            // BR#14525 — an adopted allocation preserves the ORIGINAL directory
            // (moving a git worktree breaks its link), so the exact id-derived
            // name check applies only to records that were never re-keyed.
            if record.adopted_from.is_none() {
                if *root != self.allocations.join(id) { return Err("workspace path escaped its allocation".into()); }
            } else if root.parent() != Some(self.allocations.as_path()) {
                return Err("workspace path escaped its allocation".into());
            }
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
        // BR#14525 — worktree affinity: a retry generation prefers to resume
        // in the SAME EXISTING worktree on this host instead of starting from
        // a clean checkout. Affinity is a PREFERENCE, never a pin: adoption
        // requires an adoptable prior record (see `adoptable`) and silently
        // falls back to a fresh allocation otherwise. Adoption flips the prior
        // record's ownership to this ticket AFTER verified quiescence (the
        // Released phase is only ever reached through the quiescence gate in
        // `recover_release`/`release`, so never two live generations share a
        // worktree) and preserves the directory — moving a git worktree would
        // break its worktree link, so the record is re-keyed, not the tree.
        if repo.is_some() {
            if let Some(allocation) = self.adopt(ticket)? {
                return Ok(allocation);
            }
        }
        let id = journal::stable_key(&[&ticket.task_id, &ticket.session]);
        let lock = self.lock(&id)?.ok_or("workspace is being reconciled; retry preparation")?;
        if self.contains(&id) { return Err("workspace allocation already exists; reconcile its original execution instead of reusing it".into()); }
        let root = self.allocations.join(&id);
        let record = Resource { version: 1, id: id.clone(), location: Location::Managed { root: root.clone() },
            phase: Phase::InUse { owner: Ownership::Reservation { ticket: ticket.clone() } }, observed_bytes: 0, checked_at: 0, retry_at: 0, error: None,
            last_activity_at: 0, retained_value: None, adopted_from: None, reset_at: None, reset_reason: None };
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
                phase: Phase::Cached { last_used_at: now_ms() }, observed_bytes: 0, checked_at: 0, retry_at: 0, error: None,
                last_activity_at: 0, retained_value: None, adopted_from: None, reset_at: None, reset_reason: None };
            // A partially retired cache must finish its old deletion before it
            // can be re-created. Never overwrite a removal intent.
            if self.contains(&cache_record.id) && !matches!(self.read(&cache_record.id)?.phase, Phase::Cached { .. } | Phase::Removed { .. }) {
                return Err("repository cache retirement is still pending".into());
            }
            self.save(&cache_record)?;
            let cache = ensure_repo_clone(&self.cfg.workdir, repo).map_err(|e| e.detail().to_string())?;
            // Unique per claim: an old finalizer can never remove a newer run's
            // directory or branch. Each claim starts at the repository default.
            git(&cache, &["worktree", "add", "--detach", work.to_str().ok_or("workspace path is not UTF-8")?, "origin/HEAD"])?;
            Some(work.clone())
        } else { None };
        Ok(Allocation { root, work, checkout, adopted: None, id, owner: self.clone(), _lock: lock })
    }
    /// BR#14525 — adopt a prior generation's surviving worktree for this task:
    /// same task, different (stopped) session, worktree-backed, released
    /// through the quiescence gate, and active within the affinity TTL. The
    /// most recently active candidate wins. Under the record locks the phase
    /// is re-verified (the atomic adopt-after-quiesce fence: a concurrent
    /// adopter or reconcile re-read loses), the ownership flips to this
    /// ticket's reservation, and the record re-keys onto this ticket's
    /// identity while the directory stays put. Returns the adopted allocation
    /// with an inherited-state summary for the dispatch prompt, or None when
    /// no candidate qualifies (fresh start — affinity is a preference).
    fn adopt(&self, ticket: &Ticket) -> Result<Option<Allocation>, String> {
        let now = now_ms();
        let ttl = worktree_ttl().as_millis() as u64;
        let candidate = self.records()?.into_iter().filter(|record| {
            let Location::Managed { root } = &record.location else { return false };
            let Phase::Released { owner } = &record.phase else { return false };
            let prior = owner.ticket();
            if prior.task_id != ticket.task_id || prior.session == ticket.session { return false; }
            if record.last_activity_at == 0 || now.saturating_sub(record.last_activity_at) > ttl { return false; }
            root.join("work/.git").exists()
        }).max_by_key(|record| record.last_activity_at);
        let Some(prior) = candidate else { return Ok(None) };
        let old_id = prior.id.clone();
        let new_id = journal::stable_key(&[&ticket.task_id, &ticket.session]);
        // Old-then-new acquisition order (the only multi-record lock this path
        // takes; reconcile and retire paths hold one record lock at a time, and
        // a same-ticket race re-reads the phase under the old lock).
        let Some(_old_lock) = self.lock(&old_id)? else { return Ok(None) };
        let Some(new_lock) = self.lock(&new_id)? else { return Ok(None) };
        let mut record = self.read(&old_id)?;
        // Re-verified under the locks: only a still-Released record adopts.
        if !matches!(record.phase, Phase::Released { .. }) { return Ok(None); }
        let work = record.location.work();
        let inherited = self.assess_inherited(&work)?;
        // The pre-adoption record is archived as the adoption receipt; the
        // live ledger keeps exactly one record for this allocation.
        let receipt = serde_json::to_vec(&Resource { phase: Phase::Removed { reclaimed_bytes: 0, at: now }, adopted_from: None, ..record.clone() }).map_err(|e| e.to_string())?;
        record.id = new_id.clone();
        record.adopted_from = Some(old_id.clone());
        record.phase = Phase::InUse { owner: Ownership::Reservation { ticket: ticket.clone() } };
        record.last_activity_at = now;
        record.retained_value = None;
        record.error = None;
        record.retry_at = 0;
        self.save(&record)?;
        journal::write_file(&self.archive_file(&old_id), &receipt)?;
        match fs::remove_file(self.file(&old_id)) { Ok(()) => {}, Err(e) if e.kind() == io::ErrorKind::NotFound => {}, Err(e) => return Err(e.to_string()) }
        #[cfg(unix)] fs::File::open(&self.ledger).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
        Ok(Some(Allocation { root: record.location.root().to_path_buf(), work: work.clone(), checkout: Some(work), adopted: Some(inherited), id: new_id, owner: self.clone(), _lock: new_lock }))
    }
    /// BR#14525 resume protocol (point 5) — first-hand assessment of an
    /// inherited worktree: dirty state and whether HEAD carries local commits
    /// the published branches do not contain. Local remote-tracking refs only
    /// (no network): a stale tracking ref can only over-report publication,
    /// which errs toward reclaiming a genuinely-published done tree, never
    /// toward destroying WIP.
    fn assess_inherited(&self, work: &Path) -> Result<String, String> {
        let status = git(work, &["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])?;
        let lines: Vec<&str> = status.lines().collect();
        let dirty = lines.len();
        let published = if dirty > 0 { true } else {
            git(work, &["for-each-ref", "--format=%(objectname)", "--contains", "HEAD", "refs/remotes/origin"])?.lines().count() > 0
        };
        let head = git(work, &["rev-parse", "--short", "HEAD"])?;
        Ok(format!("HEAD {head}, {dirty} uncommitted entr{}, local commits {}published; assess with git status + compile smoke and record the finding on the card before building",
            if dirty == 1 { "y" } else { "ies" }, if published { "" } else { "UN" }))
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
                // BR#14525 — the affinity/retention TTL starts at release.
                record.last_activity_at = now_ms();
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
        if self.status().is_ok_and(|status| matches!(status.admission, Admission::Held { .. })) {
            // Keep the normal fair pass, with one pressure slot for the
            // largest released allocation that can be checked now.
            let now = now_ms();
            if let Some((index, _)) = records.iter().enumerate()
                .filter(|(_, record)| record.observed_bytes > 0 && record.retry_at <= now
                    && matches!(&record.phase, Phase::Released { owner } if !protected.contains(owner.ticket())))
                .max_by_key(|(index, record)| (record.observed_bytes, std::cmp::Reverse(*index))) {
                records[..=index].rotate_right(1);
            }
        }
        let mut visited = 0;
        // BR#22634 — one record's failed journal save must not abort the
        // pass before `measure`: the status write is what re-proofs
        // admission and what surfaces the wedge to the hub. Observed live:
        // a full volume failed the FIRST record's save, `measure` never
        // ran, the status aged out and the sampler fenced dispatch on a
        // stale proof while every other visitable record went untouched.
        let mut save_failures = 0usize;
        let mut first_save_error: Option<String> = None;
        // BR#14716 — adaptive drain: under a held admission (pressure) the
        // fair BATCH=4 pass is a starvation generator — 684 pending records
        // at 4 per 30s pass is 8.5 hours to VISIT once, and any erroring
        // record re-arms a 30s retry, so a wedged hold never drains while
        // new ticks keep re-entering the same queue head. Under pressure the
        // pass widens (local FS ops are cheap; the 30s cadence stays) so the
        // ladder can actually clear in minutes.
        let batch = if self.status().is_ok_and(|status| matches!(status.admission, Admission::Held { .. })) { PRESSURE_BATCH } else { BATCH };
        // BR#14525 — pressure LRU visits DONE worktrees first: records already
        // carrying the retention value signal re-enter last, so pressure frees
        // published/finished trees before it even re-checks retained WIP (and
        // protected tickets — the currently dispatched task — are excluded
        // above regardless of order).
        if batch == PRESSURE_BATCH { records.sort_by_key(|record| record.retained_value.is_some()); }
        for old in &records {
            if matches!(old.phase, Phase::Removed { .. }) || old.retry_at > now_ms() { continue; }
            let ticket = match &old.phase { Phase::InUse { owner } | Phase::Released { owner } | Phase::Preserving { owner, .. } => Some(owner.ticket()), _ => None };
            if ticket.is_some_and(|t| protected.contains(t)) { continue; }
            if visited >= batch { break; }
            let Some(_lock) = self.lock(&old.id)? else { continue; };
            let mut record = self.read(&old.id)?;
            visited += 1;
            record.checked_at = now_ms();
            let result = self.advance(&mut record);
            match result {
                Ok(()) => { record.error = None; record.retry_at = 0; },
                Err(error) => { record.error = Some(error); record.retry_at = now_ms() + 30_000; },
            }
            if let Err(error) = self.save(&record) {
                save_failures += 1;
                if first_save_error.is_none() { first_save_error = Some(error) }
            }
        }
        let status = self.measure()?;
        if let Some(error) = first_save_error {
            // The pass advanced and the status is fresh; the failure is
            // surfaced for retry exactly as before, but AFTER measure.
            return Err(format!("workspace pass advanced with {save_failures} journal save failure(s); first: {error}"));
        }
        Ok(status)
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
            Phase::InUse { owner } => { self.recover_release(&owner)?; record.phase = Phase::Released { owner }; record.last_activity_at = now_ms(); record.retained_value = None; self.save(record)?; },
            Phase::LegacyUnproved => { legacy::prove(self, record)?; },
            _ => {},
        }
        // BR#14525 — the explicit reclaim policy (was silent GC destroying
        // WIP — BR#14126 lost four generations this way). A released worktree
        // holding unpublished value is retained BY POLICY, not by error churn:
        // within the TTL (and absent disk pressure) it stays Released as the
        // adoptable value signal for the next generation; past the TTL, or
        // under pressure, retention ends and the tree re-enters the ladder —
        // where the evidence fences still decide. Age alone is never deletion
        // authority; "reclaim on expiry" means the HOLD ends, never a silent
        // wipe of unique source.
        if let Phase::Released { .. } = &record.phase {
            // BR#22672 (human ruling on BR#22634): the end-state disposition
            // of an expired unpublished worktree is TASK-LIVENESS. While the
            // task is open and can still be routed back to this host — no
            // other claimant holds it, or the claim is this record's own
            // session — the tree stays the adoptable value signal (grace:
            // the affinity clock is refreshed so `adopt` can still re-key
            // it to a future claim here). Once the task closes, or another
            // session holds it, the value is stale by policy: it receives
            // the recorded reset (a durable discard receipt — BR#14525's
            // exit) and the tree re-enters the ladder. The hub being
            // unreachable is never a licence to destroy: retained, retried.
            let decision = match self.retention(record)? {
                Retention::Yield { signal } => match self.task_liveness(record) {
                    TaskLiveness::Adoptable { status } => {
                        record.last_activity_at = now_ms();
                        Retention::Hold { signal: format!("{signal}; task-liveness grace (BR#22672): task open ({status}), still routable to this host") }
                    },
                    TaskLiveness::Gone { reason } => Retention::Yield { signal: format!("{signal}; task-liveness gone: {reason}") },
                    TaskLiveness::Unknown { error } => return Err(format!("task liveness unavailable; worktree retained: {error}")),
                },
                decision => decision,
            };
            match decision {
                Retention::Reclaim => { record.retained_value = None; },
                Retention::Hold { signal } => {
                    // Holding the worktree's unpublished value never freezes
                    // its regenerable build cache: the disposable sweep
                    // (BR#14740 class) still runs this pass, journalled and
                    // byte-counted, while the retirement ladder below stays
                    // fenced. Unique ignored evidence still reports through
                    // the standard fence error.
                    record.retained_value = Some(signal);
                    legacy::no_readers(record.location.root(), self.reader_authority(record)?)?;
                    let mut paths = Vec::new();
                    repositories(&record.location.work(), &mut paths)?;
                    self.retire_disposable_children(record, &paths)?;
                    for path in &paths { unpreserved_ignored_inputs(path, false)?; }
                    return Ok(());
                },
                Retention::Yield { signal } => {
                    record.retained_value = Some(signal);
                    // BR#22634/BR#22672 — the recorded reset BR#14525 always
                    // demanded and never had (observed live as 1,670 retained
                    // records / 384 GiB filling the volume and
                    // ENOSPC-bricking the journal). With the task gone, the
                    // reset is a DURABLE DISCARD RECEIPT, not a publication —
                    // git is vetoed as the sink (BR#22656, human ruling). The
                    // owner records WHAT the tree held (task, session, HEADs,
                    // local refs, stash tip, dirty inventory, ignored
                    // evidence, bytes) to `discards/<id>.json`; the ladder
                    // then reclaims the bytes. The receipt file is the
                    // deletion authority, re-verified by content; a failed
                    // receipt write keeps the old contract: retained,
                    // retried next pass.
                    self.recorded_reset(record)?;
                    // Receipt recorded: fall through to the reclaim ladder.
                },
            }
        }
        // BR#22672 — a recorded reset (durable discard receipt on disk,
        // verified BY CONTENT, not by the ledger flag alone) is the explicit
        // authority BR#14525 requires. The value fences below guard exactly
        // what the receipt already captured — unpublished changes, refs
        // outside HEAD, ignored evidence, scratch inputs — so they stand
        // down for this tree. Live-writer and structural fences never
        // stand down.
        let discarded = self.reset_proof(record);
        if matches!(record.phase, Phase::Released { .. } | Phase::Preserving { .. }) {
            legacy::no_readers(record.location.root(),self.reader_authority(record)?)?;
            verify_layout(record, discarded)?;
            let mut paths = Vec::new();
            repositories(&record.location.work(), &mut paths)?;
            self.retire_disposable_children(record,&paths)?;
            for path in &paths { unpreserved_ignored_inputs(path, discarded)?; }
            // Non-Git scratch inputs are never silently thrown away. Empty
            // scratch and explicitly owned cache/tmp are disposable.
            if !discarded && uncovered_inputs(&record.location.work(), &paths)? { return Err("scratch contains unpublished non-Git inputs; preserve them before retirement".into()); }
            let snapshots = paths.into_iter().map(|path| Snapshot { path }).collect();
            record.phase = Phase::Reclaimable { snapshots }; self.save(record)?;
        }
        if let Phase::Reclaimable { snapshots } = &record.phase {
            legacy::no_readers(record.location.root(),self.reader_authority(record)?)?;
            verify_inputs(record,snapshots,discarded)?;
            for snapshot in snapshots {
                legacy::no_external_worktrees(&snapshot.path, record.location.root())?;
            }
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
                if let Location::GeneratedCache { legacy_scope: Some(scope), .. } = &record.location {
                    legacy::prove_cache_scope(self, scope)?;
                }
                verify_inputs(record,&snapshots,discarded)?;
                for snapshot in snapshots {
                    legacy::no_external_worktrees(&snapshot.path, record.location.root())?;
                    verify_published_source(&snapshot.path, discarded)?;
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
            if matches!(record.location, Location::GeneratedCache { legacy_scope: Some(_), .. }) {
                legacy::no_nested_mounts(&trash)?;
            }
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
    /// BR#14525 — one retention decision per released worktree: what does the
    /// tree hold, and does the explicit policy still protect it?
    fn retention(&self, record: &Resource) -> Result<Retention, String> {
        let work = record.location.work();
        if !work.join(".git").exists() { return Ok(Retention::Reclaim); }
        let status = git(&work, &["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])?;
        let dirty = status.lines().count();
        // Local remote-tracking refs only (no network): a stale tracking ref
        // can only over-report publication, erring toward reclaiming a
        // genuinely-published done tree, never toward destroying WIP. The
        // live `verify_published_source` fence still governs any removal.
        let published = if dirty > 0 { true } else {
            git(&work, &["for-each-ref", "--format=%(objectname)", "--contains", "HEAD", "refs/remotes/origin"])?.lines().count() > 0
        };
        if dirty == 0 && published { return Ok(Retention::Reclaim); }
        let signal = format!("unpublished worktree value (BR#14525 value signal): {dirty} uncommitted entries, local commits {}published", if published { "" } else { "UN" });
        let pressure = self.status().is_ok_and(|s| matches!(s.admission, Admission::Held { .. }));
        if pressure { return Ok(Retention::Yield { signal: format!("{signal}; yielding to disk pressure") }); }
        let ttl = worktree_ttl().as_millis() as u64;
        if record.last_activity_at == 0 || now_ms().saturating_sub(record.last_activity_at) > ttl {
            return Ok(Retention::Yield { signal: format!("{signal}; affinity/retention TTL expired") });
        }
        Ok(Retention::Hold { signal })
    }
    /// BR#22634/BR#22672 — the recorded reset for BR#14525's Yield contract
    /// (see the call site for the incident). The receipt is written BEFORE
    /// any ladder step touches the tree, on the deterministic path
    /// `discards/<id>.json`: idempotent, so a crash between the receipt
    /// write and the ledger save simply re-writes the same receipt next
    /// pass. A record already carrying `reset_at` passes straight through.
    /// `reset_proof` re-verifies the file by content for every fence that
    /// stands down — a ledger flag alone is never deletion authority.
    fn recorded_reset(&self, record: &mut Resource) -> Result<(), String> {
        if record.reset_at.is_some() { return Ok(()); }
        let receipt = self.discard_receipt(record)?;
        let bytes = serde_json::to_vec(&receipt).map_err(|e| e.to_string())?;
        journal::write_file(&self.discard_file(&record.id), &bytes)?;
        record.reset_at = Some(now_ms());
        record.reset_reason = Some(receipt.reason);
        // The hold ended: the knowledge now lives in the receipt, not the tree.
        record.retained_value = None;
        Ok(())
    }
    fn discard_file(&self, id: &str) -> PathBuf { self.ledger.join("discards").join(format!("{id}.json")) }
    /// BR#22672 — the fences' receipt check, BY CONTENT: `reset_at` on the
    /// record plus a receipt file on disk whose `resource_id` matches.
    fn reset_proof(&self, record: &Resource) -> bool {
        if record.reset_at.is_none() { return false; }
        fs::read(self.discard_file(&record.id)).ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|receipt| receipt["resource_id"] == record.id.as_str())
    }
    /// BR#22672 — task-liveness for a released worktree's value signal: can
    /// the hub still route this task back to the tree? Open and unclaimed
    /// (todo/blocked — this host can reserve it) or claimed by this record's
    /// own session (resume, or in_review rework on a bounce) means the tree
    /// is still the adoptable line. Closed (done/superseded) or claimed by
    /// a different session means the tree is stale by policy — recorded
    /// discard. The hub being unreachable (or the view drifting) is never
    /// a licence to destroy: Unknown, retained, retried next pass.
    fn task_liveness(&self, record: &Resource) -> TaskLiveness {
        let Phase::Released { owner } = &record.phase else {
            return TaskLiveness::Gone { reason: "record is not released; no task to route back".into() };
        };
        let ticket = owner.ticket();
        let card = match mcp_call_session_with_timeout(&self.cfg, &mut 0, "get_artefact",
            json!({"id":ticket.task_id,"view":"execution"}), None, Duration::from_secs(8)) {
            Ok(card) => card,
            Err(error) => return TaskLiveness::Unknown { error },
        };
        if card["id"] != ticket.task_id.as_str() || card["type"].as_str() != Some("task") {
            return TaskLiveness::Unknown { error: format!("task view drift for {}: not a task card", ticket.task_id) };
        }
        let status = card["status"].as_str().unwrap_or_default().to_string();
        match status.as_str() {
            "done" | "superseded" => TaskLiveness::Gone { reason: format!("task {} closed ({status})", ticket.task_id) },
            "todo" | "blocked" | "in_progress" | "in_review" => {
                let session = card["meta"]["session"].as_str().unwrap_or_default();
                if session.is_empty() || session == ticket.session {
                    TaskLiveness::Adoptable { status }
                } else {
                    TaskLiveness::Gone { reason: format!("task {} is {status} under session {session}; this worktree is not the live line", ticket.task_id) }
                }
            },
            _ => TaskLiveness::Unknown { error: format!("task {} has unrecognised status '{status}'", ticket.task_id) },
        }
    }
    /// BR#22672 — the discard receipt: the durable record of what an expired
    /// unpublished worktree held when its task could no longer route back.
    /// "Preserve the learnings, reclaim the bytes": enough inventory to know
    /// what was there (task, session, HEADs and subjects, local refs, stash
    /// tip, dirty file list, ignored evidence, sizes) without keeping the
    /// bytes or pushing anything into git. Lists are bounded so a pathological
    /// tree cannot wedge the journal with its own inventory.
    fn discard_receipt(&self, record: &Resource) -> Result<DiscardReceipt, String> {
        let (task, session) = match &record.phase {
            Phase::Released { owner } => { let ticket = owner.ticket(); (Some(ticket.task_id.clone()), Some(ticket.session.clone())) },
            _ => (None, None),
        };
        let mut repos = Vec::new();
        repositories(&record.location.work(), &mut repos)?;
        let mut inventories = Vec::new();
        for repository in &repos {
            let head = git(repository, &["rev-parse", "HEAD"]).ok().filter(|tip| !tip.is_empty());
            let head_subject = head.is_some().then(|| git(repository, &["log", "-1", "--format=%s"]).ok()).flatten();
            let status = git(repository, &["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]).unwrap_or_default();
            let dirty = status.lines().count();
            let dirty_paths = status.lines().take(200)
                // Porcelain v1 is two status columns + one space + path, but
                // the git() helper trims the whole output — the first line
                // can lose its leading status space. Slice from column 2 and
                // trim: correct for both shapes, best-effort for renames.
                .map(|line| line.get(2..).unwrap_or(line).trim().to_string()).collect();
            let unpushed = head.is_some().then(|| git(repository, &["rev-list", "--count", "HEAD", "--not", "--remotes"]).ok())
                .flatten().and_then(|count| count.trim().parse::<usize>().ok());
            let mut local_refs = Vec::new();
            if repository.join(".git").is_dir() {
                for reference in git(repository, &["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/tags/"])?.lines() {
                    let reference = reference.trim();
                    if reference.is_empty() || git(repository, &["merge-base", "--is-ancestor", reference, "HEAD"]).is_ok() { continue }
                    if let Ok(tip) = git(repository, &["rev-parse", reference]) {
                        local_refs.push(LocalRef { reference: reference.to_string(), tip });
                    }
                }
            }
            let stash = git(repository, &["rev-parse", "-q", "--verify", "refs/stash"]).ok().filter(|tip| !tip.is_empty());
            let ignored = git(repository, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).unwrap_or_default();
            let ignored_evidence = ignored.split('\0')
                .filter(|path| !path.is_empty() && !disposable(path.trim_end_matches('/').rsplit('/').next().unwrap_or("")))
                .take(50).map(|path| path.to_string()).collect();
            inventories.push(RepositoryInventory {
                path: repository.to_string_lossy().into_owned(), head, head_subject, dirty, dirty_paths, unpushed, local_refs, stash, ignored_evidence,
            });
        }
        Ok(DiscardReceipt {
            resource_id: record.id.clone(),
            adopted_from: record.adopted_from.clone(),
            task, session,
            reason: record.retained_value.clone().unwrap_or_else(|| "retention ended".into()),
            at: now_ms(),
            observed_bytes: record.observed_bytes,
            repositories: inventories,
        })
    }
    fn measure(&self) -> Result<Status, String> {
        let (budget, floor) = Self::budget_floor();
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
            let bundle = repository.join(".kb-bundle");
            if is_bridge_worker_bundle(repository, &bundle)? {
                paths.push(bundle);
            }
            let cli_target = repository.join("packages/cli/target");
            if is_bridge_cli_target(repository, &cli_target)? {
                paths.push(cli_target);
            }
        }
        for path in paths {
            if !path.exists() || fs::symlink_metadata(&path).map_err(|e|e.to_string())?.file_type().is_symlink() {continue;}
            let path=path.canonicalize().map_err(|e|e.to_string())?;
            let id=legacy::allocation_id("generated",&path)?;
            let _lock=self.lock(&id)?.ok_or("disposable child is being reconciled")?;
            let mut child=if self.file(&id).exists() {self.read(&id)?} else {
                Resource {version:1,id,location:Location::OwnedDisposable {root:path,parent_id:parent.id.clone()},phase:Phase::Reclaimable {snapshots:vec![]},observed_bytes:0,checked_at:now_ms(),retry_at:0,error:None,last_activity_at:0,retained_value:None,adopted_from:None,reset_at:None,reset_reason:None}
            };
            self.save(&child)?;self.advance(&mut child)?;self.save(&child)?;
        }
        Ok(())
    }
    /// BR#19525 — the single budget/floor resolution, shared by the full
    /// reconcile pass and the bounded admission sampler so the two can never
    /// disagree about what "held" means.
    fn budget_floor() -> (u64, u64) {
        let budget = std::env::var("BRIDGE_WORKSPACE_BUDGET_GIB").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(100).saturating_mul(GIB);
        (budget, Self::disk_floor_bytes())
    }
    /// BR#6992 — the workspace-volume floor half of budget_floor(), shared
    /// with the advertised gateway inventory: local admission and the
    /// hub-visible resource fence resolve the same knob, so a full volume can
    /// never read as a silently starved scheduler while admission holds.
    pub(super) fn disk_floor_bytes() -> u64 {
        std::env::var("BRIDGE_WORKSPACE_MIN_FREE_GIB").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(5).saturating_mul(GIB)
    }
    fn measure_with_limits(&self, budget_bytes: u64, floor: u64) -> Result<Status, String> {
        let records = self.records()?;
        let mut measured = HashMap::new();
        let mut positions = Vec::new();
        // BR#14739 — bytes in ERRORED resources are PRESERVED (retention rules
        // hold them: unpublished source, protected inputs, invisible readers).
        // They are outside the workspace owner's control and therefore outside
        // the admission budget: the budget gates owner-controllable GROWTH, the
        // floor gates real free disk. Counting preserved bytes against the
        // budget is the 2026-11-15 deadlock: ~100GB of a 100GiB budget was
        // legitimately-retained-by-policy (node_modules/.worktrees/layers
        // "source retained" classes), every pending record errored on a
        // preservation rule, so `owned >= budget` held admission forever while
        // reclamation could never free a byte — dispatch fully fenced with no
        // exit except ops raising the budget. Admission compares only
        // admissible (non-preserved) bytes; the disk floor remains the hard
        // safety either way.
        let mut preserved_bytes: u64 = 0;
        for record in &records {
            if matches!(record.phase, Phase::Removed { .. }) { continue; }
            let path = accounting_path(allocation_path(record));
            let bytes = match measured.entry(path.clone()) {
                std::collections::hash_map::Entry::Occupied(entry) => *entry.get(),
                std::collections::hash_map::Entry::Vacant(entry) => *entry.insert(disk_bytes(&path)?),
            };
            if record.error.is_some() { preserved_bytes = preserved_bytes.saturating_add(bytes); }
            if !matches!(record.location, Location::RepositoryCache { .. }) {
                positions.push(path);
            }
            if record.observed_bytes != bytes {
                if let Some(_lock) = self.lock(&record.id)? {
                    let mut current = self.read(&record.id)?;
                    if !matches!(current.phase, Phase::Removed { .. }) && current.observed_bytes != bytes {
                        current.observed_bytes = bytes;
                        self.save(&current)?;
                    }
                }
            }
        }
        let positions = minimal_roots(positions);
        let managed_bytes = positions.iter().map(|path| measured[path]).fold(0u64, u64::saturating_add);
        let repos=PathBuf::from(&self.cfg.workdir).join("repos");
        let repos=repos.canonicalize().unwrap_or(repos);
        let cache_bytes = disk_bytes(&repos)?;
        // Legacy worktrees nested in a cache are already in managed_bytes.
        let nested = positions.iter().filter(|path| path.starts_with(&repos))
            .map(|path| measured[path]).fold(0u64, u64::saturating_add);
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
        // BR#14739 — admission gates ADMISSIBLE growth only (see preserved_bytes
        // above): preserved resources cannot shrink under any amount of held
        // admission, so holding on their account is a pure deadlock, never a
        // control. The disk floor stays the hard safety.
        let admissible_bytes = managed_bytes.saturating_sub(preserved_bytes).saturating_add(cache_bytes).saturating_add(evidence_bytes);
        let admission = if admissible_bytes >= budget_bytes || available_bytes < floor {
            Admission::Held { reason: format!("workspace disk budget: {} bytes owned ({} preserved in errored/retained resources, {} admissible), {} cache, {} retained evidence, {} budget, {} available; reclamation continues", managed_bytes, preserved_bytes, managed_bytes.saturating_sub(preserved_bytes), cache_bytes, evidence_bytes, budget_bytes, available_bytes) }
        } else { Admission::Ready };
        // BR#14716 — the silent wedge: `retained == resources` (EVERY record
        // errored) with a held admission means the reclaim ladder cannot
        // advance at all — zero bytes can ever free while every pass errors
        // every record it visits. Observed live on the gateway: 695/695
        // records errored, pending 684, byte-identical status across hours,
        // and the ONLY trace was this same INFO reason string in the gateway
        // log — no per-record error ever surfaced, no alarm fired, the board
        // read "idle". Surface the head of the actual per-record errors on
        // the status (so `workspaces status` names WHY, first-hand) and
        // persist the wedge verdict alongside them.
        let errors: Vec<(String, String)> = records.iter().filter(|r| r.error.is_some())
            .map(|r| (r.id.clone(), r.error.clone().unwrap_or_default())).collect();
        let wedge = matches!(admission, Admission::Held { .. })
            && !errors.is_empty() && errors.len() == records.len();
        let status = Status { observed_at: now_ms(), last_reconciled_at: now_ms(), managed_bytes, cache_bytes, evidence_bytes,
            reclaimed_bytes,
            resources: records.len(), pending: records.iter().filter(|r| !matches!(r.phase, Phase::InUse { .. } | Phase::Removed { .. } | Phase::Cached { .. })).count(),
            retained: records.iter().filter(|r| r.error.is_some()).count(), budget_bytes, available_bytes, admission,
            wedge: wedge.then_some(()),
            error_head: errors.into_iter().take(10).collect(),
            admissible_bytes: Some(admissible_bytes),
            preserved_bytes };
        self.write_status(&status)?;
        // BR#22634 — refill the journal recovery reserves while the volume
        // is healthy (comfortably above the floor): a drained reserve is
        // what carried the journal writes through the last full-volume
        // wedge. Best effort by contract.
        if available_bytes > floor.saturating_add(journal::reserve_bytes()) {
            journal::ensure_reserve(&gateway_pipeline::root(&self.cfg)?);
            journal::ensure_reserve(Path::new(&self.cfg.workdir));
        }
        Ok(status)
    }
    /// BR#19525 — serialised status.json writer. The full inventory pass and
    /// the bounded admission sampler are both writers of this proof file, so
    /// both route through this best-effort lock (short retry, then an atomic
    /// write anyway — journal::write_file never tears).
    fn write_status(&self, status: &Status) -> Result<(), String> {
        let bytes = serde_json::to_vec(status).map_err(|e| e.to_string())?;
        for _ in 0..10 {
            if let Ok(Some(_guard)) = self.lock("status") {
                return journal::write_file(&self.ledger.join("status.json"), &bytes);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        journal::write_file(&self.ledger.join("status.json"), &bytes)
    }
    /// BR#19525 — bounded admission sampling, decoupled from the slow reclaim
    /// ladder. A full `reconcile` pass can run for minutes on a crowded
    /// workspace (`du` per record, up to 30s each) while dispatch only needs
    /// to know whether admission is still open. This re-proofs admission from
    /// the LAST full inventory plus a first-hand filesystem capacity check:
    /// it never re-measures with `du`, never advances the ladder and never
    /// takes a resource lock — the slow pass stays the sole reclamation
    /// owner. A stale, corrupt or missing proof, or a sampling failure, is an
    /// error — nothing is written and the old proof ages out, so admission
    /// fails closed exactly as before.
    pub fn refresh_admission(&self) -> Result<Status, String> {
        let (budget, floor) = Self::budget_floor();
        self.refresh_admission_with(budget, floor)
    }
    pub fn refresh_admission_with(&self, budget_bytes: u64, floor: u64) -> Result<Status, String> {
        let mut status: Status = serde_json::from_slice(&fs::read(self.ledger.join("status.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let Some(admissible_bytes) = status.admissible_bytes else {
            return Err("workspace inventory has not yet been measured; admission sampling unavailable".into());
        };
        status.available_bytes = available_bytes(&self.allocations)?;
        status.admission = if admissible_bytes >= budget_bytes || status.available_bytes < floor {
            Admission::Held { reason: format!("workspace disk budget: {} bytes owned ({} preserved in errored/retained resources, {} admissible), {} cache, {} retained evidence, {} budget, {} available; reclamation continues", status.managed_bytes, status.preserved_bytes, admissible_bytes.saturating_sub(status.cache_bytes).saturating_sub(status.evidence_bytes), status.cache_bytes, status.evidence_bytes, budget_bytes, status.available_bytes) }
        } else { Admission::Ready };
        // The record counters are re-derived cheaply from the journalled
        // records; byte totals stay as last fully measured.
        let records = self.records()?;
        let errors: Vec<(String, String)> = records.iter().filter(|r| r.error.is_some())
            .map(|r| (r.id.clone(), r.error.clone().unwrap_or_default())).collect();
        status.resources = records.len();
        status.pending = records.iter().filter(|r| !matches!(r.phase, Phase::InUse { .. } | Phase::Removed { .. } | Phase::Cached { .. })).count();
        status.retained = errors.len();
        status.wedge = (matches!(status.admission, Admission::Held { .. })
            && !errors.is_empty() && errors.len() == records.len()).then_some(());
        status.error_head = errors.into_iter().take(10).collect();
        status.observed_at = now_ms();
        self.write_status(&status)?;
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
fn accounting_path(path: &Path) -> PathBuf {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        path.to_path_buf()
    } else {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    }
}
fn minimal_roots(mut paths: Vec<PathBuf>) -> Vec<PathBuf> {
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
// The Bridge worker test command emits this ignored Wrangler dry-run output.
// Check the committed build declaration and the generated directory shape so
// arbitrary ignored inputs in the same workspace retain their existing fence.
fn is_bridge_worker_bundle(repository: &Path, bundle: &Path) -> Result<bool, String> {
    if !is_ignored_output(repository, bundle, ".kb-bundle")? {
        return Ok(false);
    }
    let Some(manifest) = git(repository, &["show", "HEAD:packages/worker/package.json"]).ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok()) else { return Ok(false); };
    if manifest["name"] != "bridge-worker"
        || !manifest["scripts"]["test"].as_str().is_some_and(|script| script.contains("wrangler deploy --dry-run --outdir ../../.kb-bundle")) {
        return Ok(false);
    }
    for entry in fs::read_dir(bundle).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file()
            || !matches!(entry.file_name().to_str(), Some("README.md" | "index.js" | "index.js.map")) {
            return Ok(false);
        }
    }
    Ok(bundle.join("index.js").is_file()
        && fs::read_to_string(bundle.join("README.md")).is_ok_and(|readme| {
            readme.starts_with("This folder contains the built output assets for the worker \"bridge\" generated at ")
        }))
}

fn is_ignored_output(repository: &Path, path: &Path, relative: &str) -> Result<bool, String> {
    if !path.is_dir() || path.canonicalize().map_err(|e| e.to_string())? != path
        || git(repository, &["check-ignore", "--", relative]).is_err() {
        return Ok(false);
    }
    Ok(git(repository, &["ls-files", "--", relative])?.is_empty())
}

// Cargo explicitly marks target directories as reproducible caches. Scope
// the nested allowance to the Bridge CLI's declared package path.
fn is_bridge_cli_target(repository: &Path, target: &Path) -> Result<bool, String> {
    if !is_ignored_output(repository, target, "packages/cli/target")?
        || !git(repository, &["show", "HEAD:packages/cli/Cargo.toml"]).is_ok_and(|manifest| {
            manifest.lines().any(|line| line.trim() == "name = \"bridge-cli\"")
        }) {
        return Ok(false);
    }
    Ok(legacy::cache_tag(target))
}

pub(super) fn unpreserved_ignored_inputs(path: &Path, discarded: bool) -> Result<(), String> {
    // BR#22672 — a recorded discard receipt already captured the ignored
    // inventory (paths and evidence class) before the ladder ran; this
    // value fence stands down for that tree.
    if discarded { return Ok(()); }
    let ignored=git(path,&["ls-files","--others","--ignored","--exclude-standard","--directory","-z"])?;
    // BR#14740 — recreatable caches are disposable BY CLASS, not by per-allocation
    // declaration: node_modules/target (the exact names `disposable()` sanctions
    // and `retire_disposable_children` journally removes) rebuild from committed
    // lockfiles — they are cache, never unique evidence. Fencing the whole
    // allocation on them is the 2026-11-15 gateway deadlock: ~100GB of a
    // 100GiB budget was node_modules/.worktrees/layers-class cache retained by
    // THIS check while the disk held 308GB free and dispatch starved. The
    // retention fence exists for unique evidence (.env, measurement outputs,
    // uncommitted source); a cache basename must never wedge the ladder.
    // `.worktrees/` and undeclared layers stay fenced below — unknowns are
    // evidence until proven otherwise.
    if let Some(input)=ignored.split('\0').find(|input| {
        !input.is_empty() && !disposable(input.trim_end_matches('/').rsplit('/').next().unwrap_or(""))
    }) {
        return Err(format!("ignored input is not a declared disposable allocation; source retained: {input}"));
    }
    Ok(())
}
fn verify_layout(record:&Resource,discarded:bool)->Result<(),String> {
    if let Location::Managed {root}=&record.location {
        // BR#22672 — layout drift fences WHAT the tree holds for the future;
        // a discard-bound tree has no future — the receipt is the authority.
        if discarded { return Ok(()); }
        for entry in fs::read_dir(root).map_err(|e|e.to_string())? {
            let entry=entry.map_err(|e|e.to_string())?;
            if !matches!(entry.file_name().to_str(),Some("work"|"tmp"|"cache"|"logs")) {return Err("workspace contains unregistered inputs outside its source directory; retained".into());}
        }
    }
    Ok(())
}
fn verify_published_source(path: &Path, discarded: bool) -> Result<(), String> {
    // BR#22672 — a recorded discard receipt already captured exactly what
    // this fence guards (local changes, refs outside HEAD, an unpublished
    // HEAD); the receipt is the explicit reset authority BR#14525 names.
    if discarded { return Ok(()); }
    if !git(path, &["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])?.is_empty() {
        return Err("workspace has local changes; source retained".into());
    }
    if path.join(".git").is_dir() {
        // A standalone clone's refs disappear with the directory.
        for tip in git(path, &["for-each-ref", "--format=%(objectname)", "refs/heads/", "refs/tags/", "refs/stash"])?.lines() {
            git(path, &["merge-base", "--is-ancestor", tip, "HEAD"])
                .map_err(|_| "workspace has local refs outside HEAD; source retained".to_string())?;
        }
    }
    let head = git(path, &["rev-parse", "HEAD"])?;
    let published_candidates = git(path, &["for-each-ref", "--contains", &head, "--format=%(objectname)", "refs/remotes/origin"])?;
    let candidates: std::collections::HashSet<_> = published_candidates.lines().collect();
    let remote = git(path, &["ls-remote", "--heads", "origin"])?;
    for line in remote.lines() {
        let Some((tip, reference)) = line.split_once('\t') else { continue; };
        if reference.starts_with("refs/heads/bridge-checkpoints/") { continue; }
        if tip == head || candidates.contains(tip) {
            return Ok(());
        }
    }
    Err("workspace HEAD is not reachable from a published branch; source retained".into())
}
fn verify_inputs(record:&Resource,snapshots:&[Snapshot],discarded:bool)->Result<(),String> {
    if let Location::OwnedDisposable { root, .. } = &record.location {
        if root.file_name().and_then(|name| name.to_str()) == Some(".kb-bundle")
            && !is_bridge_worker_bundle(root.parent().ok_or("worker bundle repository missing")?, root)? {
            return Err("worker bundle no longer matches the declared build output; retained".into());
        }
        if root.ends_with("packages/cli/target")
            && !is_bridge_cli_target(root.ancestors().nth(3).ok_or("CLI target repository missing")?, root)? {
            return Err("CLI target no longer matches the declared Cargo cache; retained".into());
        }
        return Ok(());
    }
    if let Location::GeneratedCache { root, legacy_scope } = &record.location {
        if legacy_scope.is_some() {
            if !legacy::is_nested_cache(root)? {
                return Err("legacy cache no longer matches its disposal proof".into());
            }
            legacy::no_nested_mounts(root)?;
        }
        return Ok(());
    }
    verify_layout(record,discarded)?;
    // BR#22672 — the discard receipt covers the unpublished value the
    // scratch/ignored fences guard; they stand down for this tree.
    if discarded { return Ok(()); }
    let paths:Vec<_>=snapshots.iter().map(|s|s.path.clone()).collect();
    if uncovered_inputs(&record.location.work(),&paths)? {return Err("new unpublished scratch inputs arrived before retirement; retained".into());}
    for snapshot in snapshots {unpreserved_ignored_inputs(&snapshot.path,false)?;}
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
/// Free bytes visible to unprivileged writers on the filesystem containing
/// `path` (BR#6992: shared by workspace admission and the advertised
/// inventory — one measurement, one floor, one truth).
pub(super) fn available_bytes(path: &Path) -> Result<u64, String> {
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
