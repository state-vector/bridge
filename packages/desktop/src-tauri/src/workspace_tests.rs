use super::*;
use super::super::gateway_pipeline::tests::{Hub, fixture};

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!("bridge-owner-test-{}-{}-{}", std::process::id(), now_ms(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&root).unwrap(); Self(root)
    }
    fn owner(&self) -> Owner {
        // 127.0.0.1:1 refuses instantly — the liveness query must fail FAST
        // in tests that exercise the hub-unreachable path (and never stall
        // on DNS for .invalid-style hostnames).
        let cfg: DispatchConfig = serde_json::from_value(json!({"url":"http://127.0.0.1:1","label":"workspace-tests","workdir":self.0.join("disk")})).unwrap();
        let ledger = self.0.join("journal"); let allocations = self.0.join("disk/workspaces");
        fs::create_dir_all(&ledger).unwrap(); fs::create_dir_all(&allocations).unwrap();
        Owner { cfg, ledger, allocations: allocations.canonicalize().unwrap() }
    }
}
impl Drop for Sandbox { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn ticket(id: &str) -> Ticket { Ticket { task_id: id.into(), session: format!("session-{id}") } }
fn attempt(ticket: &Ticket) -> Ownership { Ownership::Attempt { ticket: ticket.clone(), host:"host".into(), generation:1, attempt_id:format!("attempt-{}",ticket.session) } }
fn released(owner: &Ownership) -> lifecycle::Released {
    let reply = match owner {
        Ownership::Reservation { ticket } => json!({"kind":"released","task_id":ticket.task_id}),
        Ownership::Attempt { ticket, host, generation, attempt_id } => json!({"attempt":{"host":host,"session":ticket.session,"generation":generation,"attempt_id":attempt_id,"phase":"quiesced"}}),
    };
    lifecycle::Released::from_hub(owner,&reply).unwrap()
}
fn ready(owner: &Owner) { owner.measure().unwrap(); }
fn assert_source_not_removed(owner:&Owner,id:&str,root:&Path) {
    assert!(root.exists());assert!(!matches!(owner.read(id).unwrap().phase,Phase::Removed { .. }));
    if let Ok(entries)=fs::read_dir(owner.ledger.join("removals")) {
        for entry in entries {
            let receipt:Removal=serde_json::from_slice(&fs::read(entry.unwrap().path()).unwrap()).unwrap();
            assert_ne!(receipt.resource_id,id,"retained source was counted as reclaimed");
        }
    }
}
fn configure(path: &Path, root: &Path) {
    for (key,value) in [("user.name","Workspace test".into()),("user.email","workspace@example.test".into()),("gpg.format","ssh".into()),("user.signingkey",root.join("signing").to_string_lossy().into_owned()),("gpg.ssh.program","/usr/bin/ssh-keygen".into())] {
        git(path,&["config","--local",key,&value]).unwrap();
    }
}

#[test]
fn inspection_uses_only_the_active_attempt_from_the_owner_ledger() {
    let sandbox = Sandbox::new();
    let owner = sandbox.owner();
    let wanted = ticket("BR#42");
    let other = ticket("BR#43");
    for (id, phase) in [
        ("active", Phase::InUse { owner: attempt(&wanted) }),
        ("released", Phase::Released { owner: attempt(&wanted) }),
        ("preparing", Phase::InUse { owner: Ownership::Reservation { ticket: wanted.clone() } }),
        ("other", Phase::InUse { owner: attempt(&other) }),
    ] {
        owner.save(&Resource {
            version: 1, id: id.into(), location: Location::Managed { root: owner.allocations.join(id) },
            phase, observed_bytes: 0, checked_at: 0, retry_at: 0, error: None, last_activity_at: 0, retained_value: None, adopted_from: None, reset_at: None, reset_reason: None, task_lineage: None,
        }).unwrap();
    }
    assert_eq!(owner.active_paths_for_task("BR#42").unwrap(), vec![owner.allocations.join("active/work")]);
    assert!(owner.active_paths_for_task("BR#44").unwrap().is_empty());
}

#[test]
fn nested_legacy_caches_are_discovered_without_adopting_unpublished_inputs() {
    let sandbox = Sandbox::new();
    let owner = sandbox.owner();
    let scratch = sandbox.0.canonicalize().unwrap().join("scratch");
    let repository = scratch.join("repo");
    let target = repository.join("target");
    let standalone = scratch.join("old-target");
    for path in [&target, &standalone] {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n").unwrap();
    }
    git(&repository, &["init"]).unwrap();
    fs::write(repository.join(".gitignore"), "target/\n").unwrap();
    fs::write(repository.join("draft"), "unpublished work").unwrap();
    fs::write(standalone.join(".rustc_info.json"), "{}").unwrap();
    legacy::adopt_nested_caches(&owner, &scratch).unwrap();
    assert_eq!(owner.records().unwrap().len(), 2);

    fs::write(target.join("input"), "tracked input").unwrap();
    git(&repository, &["add", "-f", "target/input"]).unwrap();
    assert!(!legacy::is_nested_cache(&target).unwrap());
    let launches = gateway_pipeline::root(&owner.cfg).unwrap().join("launches");
    fs::create_dir_all(&launches).unwrap();
    let launch = launches.join("active.json");
    let cache_id = legacy::allocation_id("generated", &standalone).unwrap();
    let mut cache = owner.read(&cache_id).unwrap();
    fs::write(&launch, json!({"scratch": scratch.parent().unwrap()}).to_string()).unwrap();
    assert!(owner.advance(&mut cache).unwrap_err().contains("active execution journal"));
    fs::write(&launch, json!({"cfg": {"workdir": scratch.parent().unwrap()}}).to_string()).unwrap();
    let status = owner.reconcile(&[]).unwrap();
    if standalone.exists() {
        // Other Linux test processes can temporarily deny /proc visibility.
        let retained = owner.read(&cache_id).unwrap();
        assert!(retained.error.as_deref().is_some_and(|error| error.contains("incomplete")),
            "unexpected cache hold: {:?}", retained.error);
        assert_eq!(status.reclaimed_bytes, 0);
    } else {
        assert!(status.reclaimed_bytes > 0);
    }
    assert!(target.join("input").exists());
    assert_eq!(fs::read_to_string(repository.join("draft")).unwrap(), "unpublished work");
}

#[test]
fn allocation_is_write_ahead_unique_per_claim_and_cannot_be_rebound_to_another_fence() {
    let sandbox=Sandbox::new(); let owner=sandbox.owner(); ready(&owner);
    let t=ticket("one"); let allocation=owner.allocate(&t,None).unwrap();
    let mut record=owner.read(&allocation.id).unwrap();
    assert!(matches!(record.phase,Phase::InUse {owner:Ownership::Reservation {..}}));
    allocation.bind(&attempt(&t)).unwrap();
    let mut other=attempt(&t); if let Ownership::Attempt {generation,..}=&mut other {*generation=2;}
    assert!(allocation.bind(&other).is_err());
    assert!(owner.allocate(&t,None).is_err());
    let root=allocation.root.clone(); drop(allocation);
    assert!(owner.allocate(&t,None).is_err(),"a new process cannot resurrect an old allocation");
    let next=Ticket {session:"next".into(),..t};
    assert_ne!(owner.allocate(&next,None).unwrap().root,root);
    record=owner.read(&journal::stable_key(&["one","session-one"])).unwrap();
    assert!(matches!(record.phase,Phase::InUse {owner:Ownership::Attempt {generation:1,..}}));
}

#[test]
fn clean_published_source_and_build_bytes_are_reclaimed_while_twenty_jobs_stay_active() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let t=ticket("retired");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    fs::write(a.root.join("cache/cargo/object"),vec![7u8;1024*1024]).unwrap();
    a.bind(&attempt(&t)).unwrap();let root=a.root.clone();drop(a);
    owner.release(&released(&attempt(&t))).unwrap();
    let mut protected=Vec::new();
    for n in 0..21 {
        let t=ticket(&format!("active-or-held-{n}"));let a=owner.allocate(&t,None).unwrap();
        fs::write(a.work.join("active-input"),"keep this writer's data").unwrap();protected.push(t);
    }
    let changing=owner.allocations.join(journal::stable_key(&[&protected[0].task_id,&protected[0].session])).join("tmp/rotating-build-file");
    let stop=Arc::new(AtomicBool::new(false));let stopped=stop.clone();
    let writer=std::thread::spawn(move || while !stopped.load(Ordering::SeqCst) {let _=fs::write(&changing,vec![3u8;4096]);let _=fs::remove_file(&changing);});
    let before=disk_bytes(&owner.allocations).unwrap();
    let status=owner.reconcile(&protected).unwrap();
    stop.store(true,Ordering::SeqCst);writer.join().unwrap();
    assert!(!root.exists(),"retired workspace was not physically removed: {}",owner.report().unwrap());
    assert!(status.reclaimed_bytes>=1024*1024);
    assert!(disk_bytes(&owner.allocations).unwrap()<before);
    for t in &protected {assert!(owner.allocations.join(journal::stable_key(&[&t.task_id,&t.session])).join("work/active-input").exists());}
    let restarted=sandbox.owner();assert_eq!(restarted.reconcile(&protected).unwrap().reclaimed_bytes,status.reclaimed_bytes,"restart double-counted deletion");
}

#[test]
fn unreachable_origin_and_dirty_source_never_count_as_reclaimed() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let t=ticket("publish-failure");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&t)).unwrap();let id=a.id.clone();let root=a.root.clone();let work=a.work.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    git(&work,&["remote","set-url","origin",sandbox.0.join("unavailable.git").to_str().unwrap()]).unwrap();
    let status=owner.reconcile(&[]).unwrap();assert_source_not_removed(&owner,&id,&root);
    let mut record=owner.read(&id).unwrap();assert!(record.error.is_some());
    git(&work,&["remote","set-url","origin",source.to_str().unwrap()]).unwrap();
    fs::write(work.join("tracked"),"newer unpublished work").unwrap();
    record.retry_at=0;owner.save(&record).unwrap();
    assert_eq!(owner.reconcile(&[]).unwrap().reclaimed_bytes,status.reclaimed_bytes);assert_source_not_removed(&owner,&id,&root);assert!(fs::read_to_string(work.join("tracked")).unwrap().contains("newer"));
}

#[test]
fn interrupted_deletion_retries_only_the_tombstone_and_preserves_reused_original_path() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let t=ticket("crash");let a=owner.allocate(&t,None).unwrap();let id=a.id.clone();let root=a.root.clone();drop(a);
    let trash=root.parent().unwrap().join(format!(".bridge-reclaim-{id}"));
    fs::write(root.join("tmp/large"),vec![1u8;512*1024]).unwrap();let bytes=disk_bytes(&root).unwrap();fs::rename(&root,&trash).unwrap();
    let mut record=owner.read(&id).unwrap();record.phase=Phase::Deleting {operation_id:"fixture-crash-removal".into(),bytes_before:bytes,repositories:vec![],trash:trash.clone()};owner.save(&record).unwrap();
    fs::create_dir_all(&root).unwrap();fs::write(root.join("new-owner"),"never remove me").unwrap();
    let restarted=sandbox.owner();assert!(restarted.reconcile(&[]).unwrap().reclaimed_bytes>=512*1024);
    assert!(!trash.exists());assert_eq!(fs::read_to_string(root.join("new-owner")).unwrap(),"never remove me");
}

#[cfg(unix)]
#[test]
fn budget_counts_aliased_nested_allocations_once() {
    let sandbox = Sandbox::new();
    let owner = sandbox.owner();
    let repos = PathBuf::from(&owner.cfg.workdir).join("repos");
    let cache = repos.join("cached-clone");
    let allocation = cache.join("legacy-worktree");
    let nested = allocation.join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(cache.join("cache-data"), vec![1u8; 64 * 1024]).unwrap();
    fs::write(nested.join("managed-data"), vec![2u8; 128 * 1024]).unwrap();
    let alias = sandbox.0.join("cache-alias");
    std::os::unix::fs::symlink(&cache, &alias).unwrap();

    for (id, root) in [
        ("physical", allocation.clone()),
        ("alias", alias.join("legacy-worktree")),
        ("nested", nested),
    ] {
        owner.save(&Resource {
            version: 1, id: id.into(), location: Location::Legacy { root, task: None },
            phase: Phase::LegacyUnproved, observed_bytes: 0, checked_at: 0, retry_at: 0, error: None, last_activity_at: 0, retained_value: None, adopted_from: None, reset_at: None, reset_reason: None, task_lineage: None,
        }).unwrap();
    }
    let allocation_bytes = disk_bytes(&allocation).unwrap();
    let status = owner.measure().unwrap();
    assert_eq!(status.managed_bytes, allocation_bytes);
    assert_eq!(status.cache_bytes, disk_bytes(&repos).unwrap() - allocation_bytes);
    assert_eq!(owner.read("alias").unwrap().observed_bytes, allocation_bytes);
}

#[test]
fn scratch_inputs_outside_nested_repositories_are_retained_and_budget_blocks_growth() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let t=ticket("scratch");let a=owner.allocate(&t,None).unwrap();fs::write(a.work.join("unpublished-plan"),"keep").unwrap();
    let id=a.id.clone();let root=a.root.clone();drop(a);owner.release(&released(&Ownership::Reservation {ticket:t})).unwrap();
    owner.reconcile(&[]).unwrap();assert_source_not_removed(&owner,&id,&root);assert_eq!(fs::read_to_string(root.join("work/unpublished-plan")).unwrap(),"keep");assert!(owner.read(&id).unwrap().error.unwrap().contains("non-Git"));
    let held=owner.measure_with_limits(1,0).unwrap();assert!(matches!(held.admission,Admission::Held {..}));
    assert!(owner.allocate(&ticket("new-allocation"),None).is_err());
}

#[test]
fn a_real_open_descriptor_prevents_retirement_and_an_independent_pass_can_retry() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let t=ticket("reader");let a=owner.allocate(&t,None).unwrap();fs::write(a.root.join("tmp/open"),vec![0u8;8192]).unwrap();
    let file=fs::File::open(a.root.join("tmp/open")).unwrap();let root=a.root.clone();let id=a.id.clone();drop(a);owner.release(&released(&Ownership::Reservation {ticket:t})).unwrap();
    assert_eq!(owner.reconcile(&[]).unwrap().reclaimed_bytes,0);assert!(root.exists());drop(file);
    let mut r=owner.read(&id).unwrap();r.retry_at=0;owner.save(&r).unwrap();
    assert!(owner.reconcile(&[]).unwrap().reclaimed_bytes>0);assert!(!root.exists());
}

#[test]
fn controller_reconciles_unrelated_disk_with_a_held_execution_during_update_drain() {
    let hub=Hub::new(|request| match request["params"]["arguments"]["command"]["kind"].as_str() {
        Some("writer_receipt")=>Some(json!({"kind":"writer_receipt_missing"})),
        _=>Some(json!({"kind":"no_eligible_work"})),
    });
    let (cfg,ready,snap)=fixture(&hub);let owner=Owner::open(&cfg).unwrap();owner.measure().unwrap();
    let held=super::super::attempt_journal::Record {owner:Ownership::Attempt {ticket:ticket("unknown-writer"),host:cfg.label.clone().unwrap(),generation:1,attempt_id:"unknown-attempt".into()},host:cfg.label.clone().unwrap(),url:cfg.url.clone(),observed_at:now_ms(),process:None,disposition:super::super::attempt_journal::Disposition::Pending,work:super::super::attempt_journal::Work::Unproven {outcome:super::super::attempt_journal::Outcome {kind:super::super::attempt_journal::OutcomeKind::Completed,exit_code:None,stdout_tail:"captured result retained without writer proof".into(),stderr_tail:String::new(),acp_prompt_observed_at: None, acp_parent_prompt_observed_at: None, acp_parent_teardown_observed_at: None, cause: None, background_yield: None},worktree:None}};
    journal::insert(&gateway_pipeline::terminal_root(&cfg).unwrap(),held).unwrap();
    let mut controller=super::super::gateway_pipeline::Controller::new(&cfg,&ready,&snap);
    let deadline=Instant::now()+Duration::from_secs(60);
    while controller.held_for_test()==0 {controller.tick(&snap,false,true).unwrap();assert!(Instant::now()<deadline,"fixture never reached a real held execution");std::thread::sleep(Duration::from_millis(5));}
    let t=ticket("reclaim");let a=owner.allocate(&t,None).unwrap();let root=a.root.clone();drop(a);owner.release(&released(&Ownership::Reservation {ticket:t})).unwrap();
    controller.force_workspace_pass();
    while root.exists() { controller.tick(&snap,false,true).unwrap();assert!(Instant::now()<deadline,"update drain starved workspace retirement");std::thread::sleep(Duration::from_millis(5)); }
    assert_eq!(controller.held_for_test(),1,"maintenance must not resolve or discard unknown writers");
    drop(controller);drop(ready);let _=fs::remove_dir_all(gateway_pipeline::root(&cfg).unwrap());
}

#[test]
fn repository_cache_is_owned_but_cannot_be_evicted_until_its_last_worktree_is_preserved() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);let t=ticket("cache-user");
    let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    let cache=repo_cache_path(&owner.cfg.workdir,source.to_str().unwrap());
    let cache_id=format!("cache-{}",journal::stable_key(&[&cache.to_string_lossy()]));
    let mut r=owner.read(&cache_id).unwrap();r.phase=Phase::Cached {last_used_at:0};owner.save(&r).unwrap();
    a.bind(&attempt(&t)).unwrap();drop(a);
    owner.reconcile(&[t.clone()]).unwrap();assert!(cache.exists(),"cache with a live dependent worktree was removed");
    owner.release(&released(&attempt(&t))).unwrap();owner.reconcile(&[]).unwrap();
    let mut r=owner.read(&cache_id).unwrap();r.retry_at=0;owner.save(&r).unwrap();
    owner.reconcile(&[]).unwrap();assert!(!cache.exists(),"unused cache did not converge to retirement: {}",owner.report().unwrap());
}

#[test]
fn legacy_unknown_operations_are_retained_without_publishing_or_removing_source() {
    let hub=Hub::new(|request| {
        assert_eq!(request["params"]["arguments"]["command"]["kind"],"inspect");
        Some(json!({"attempt":null,"operations":[{"state":"outcome_unknown"}],"handoff":{"phase":"none"}}))
    });
    let (cfg,ready,_)=fixture(&hub);let owner=Owner::open(&cfg).unwrap();
    let root=PathBuf::from(&cfg.workdir).join("legacy");fs::create_dir_all(&root).unwrap();fs::write(root.join("evidence"),"do not replay or delete").unwrap();
    let id=legacy::allocation_id("legacy",&root).unwrap();
    owner.save(&Resource {version:1,id:id.clone(),location:Location::Legacy {root:root.clone(),task:Some("BR#123".into())},phase:Phase::LegacyUnproved,observed_bytes:0,checked_at:0,retry_at:0,error:None,last_activity_at:0,retained_value:None,adopted_from:None,reset_at:None,reset_reason:None,task_lineage:None}).unwrap();
    assert_eq!(owner.reconcile(&[]).unwrap().reclaimed_bytes,0);assert!(root.join("evidence").exists());
    assert!(owner.read(&id).unwrap().error.unwrap().contains("operation evidence"));
    drop(ready);let _=fs::remove_dir_all(gateway_pipeline::root(&cfg).unwrap());
}

#[test]
fn an_acknowledged_old_workspace_retires_after_restart_without_inspecting_or_mutating_a_new_attempt() {
    let t=ticket("old");let returned=attempt(&t);
    let hub=Hub::new(move |request| {
        assert_eq!(request["params"]["arguments"]["command"]["kind"],"receipt");
        assert!(request["params"]["arguments"]["command"]["target_command_id"].as_str().unwrap().ends_with("-finalize"));
        let Ownership::Attempt {ticket,host,generation,attempt_id}=&returned else {unreachable!()};
        Some(json!({"kind":"receipt_found","result":{"attempt":{"host":host,"session":ticket.session,"generation":generation,"attempt_id":attempt_id,"phase":"quiesced"}}}))
    });
    let (mut cfg,readiness,_)=fixture(&hub);let sandbox=Sandbox::new();cfg.workdir=sandbox.0.join("disk").to_string_lossy().into_owned();cfg.label=Some("host".into());
    let mut owner=sandbox.owner();owner.cfg=cfg.clone();ready(&owner);
    let a=owner.allocate(&t,None).unwrap();fs::write(a.root.join("tmp/old-output"),vec![4u8;8192]).unwrap();a.bind(&attempt(&t)).unwrap();let root=a.root.clone();drop(a);
    // Crash occurred after the server committed finalize but before local
    // release. The new task generation is deliberately absent from the reply.
    assert!(owner.reconcile(&[]).unwrap().reclaimed_bytes>0);assert!(!root.exists());
    drop(readiness);let _=fs::remove_dir_all(gateway_pipeline::root(&cfg).unwrap());
}

#[test]
fn a_legacy_standalone_build_cache_is_adopted_from_its_standard_disposal_marker() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let cache=PathBuf::from(&owner.cfg.workdir).join("old-standalone-target");fs::create_dir_all(&cache).unwrap();
    fs::write(cache.join("CACHEDIR.TAG"),"Signature: 8a477f597d28d172789f06886806bc55\n# Cargo cache\n").unwrap();
    fs::write(cache.join("compiled-object"),vec![5u8;512*1024]).unwrap();
    let status=owner.reconcile(&[]).unwrap();
    if cache.exists() {
        // Observe the decision made by this exact pass. A separate pre-probe
        // races short-lived non-dumpable test processes and is not authority.
        assert_eq!(status.reclaimed_bytes,0);
        assert!(owner.records().unwrap().iter().any(|r|r.error.as_ref().is_some_and(|error|error.contains("incomplete"))));
    } else {
        assert!(status.reclaimed_bytes>=512*1024);
    }
}

#[test]
fn disk_pressure_visits_one_released_allocation_before_the_legacy_backlog() {
    let sandbox = Sandbox::new();
    let owner = sandbox.owner();
    ready(&owner);
    for i in 0..BATCH {
        let id = format!("legacy-{i}");
        let path = sandbox.0.join(&id);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("unpublished-input"), "keep this").unwrap();
        owner.save(&Resource {
            version: 1, id, location: Location::Legacy { root: path, task: None },
            phase: Phase::LegacyUnproved, observed_bytes: 0, checked_at: 0, retry_at: 0, error: None, last_activity_at: 0, retained_value: None, adopted_from: None, reset_at: None, reset_reason: None, task_lineage: None,
        }).unwrap();
    }
    let t = ticket("released-under-pressure");
    let a = owner.allocate(&t, None).unwrap();
    fs::write(a.root.join("cache/build-object"), vec![7u8; 256 * 1024]).unwrap();
    let root = a.root.clone();
    let id = a.id.clone();
    drop(a);
    owner.release(&released(&Ownership::Reservation { ticket: t })).unwrap();
    let mut record = owner.read(&id).unwrap();
    record.checked_at = now_ms();
    owner.save(&record).unwrap();
    assert!(matches!(owner.measure_with_limits(1, 0).unwrap().admission, Admission::Held { .. }));

    owner.reconcile(&[]).unwrap();
    assert!(!root.exists());
    // BR#14716 — under a held admission the pass is PRESSURE_BATCH wide (the
    // fair 4-per-30s width starved a 684-deep pending pile), so every legacy
    // record is visited this pass: each errors on its unpublished input and
    // is PRESERVED — the invariant this test pins is the released allocation
    // reclaimed first + no input silently discarded, not the visit width.
    let checked = (0..BATCH).filter(|i| owner.read(&format!("legacy-{i}")).unwrap().checked_at > 0).count();
    assert_eq!(checked, BATCH);
    for i in 0..BATCH {
        assert_eq!(fs::read_to_string(sandbox.0.join(format!("legacy-{i}/unpublished-input"))).unwrap(), "keep this");
    }
}

#[test]
fn unique_ignored_evidence_survives_while_its_disposable_build_cache_is_reclaimed() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);let t=ticket("ignored-evidence");
    let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    fs::write(a.work.join(".gitignore"),".quality/\n").unwrap();fs::create_dir_all(a.work.join(".quality")).unwrap();
    fs::write(a.work.join(".quality/results"),"unique measurement evidence").unwrap();
    fs::write(a.root.join("cache/cargo/object"),vec![9u8;2*1024*1024]).unwrap();
    a.bind(&attempt(&t)).unwrap();let root=a.root.clone();let id=a.id.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    let status=owner.reconcile(&[]).unwrap();assert!(status.reclaimed_bytes>=2*1024*1024);
    assert!(!root.join("cache").exists());assert_eq!(fs::read_to_string(root.join("work/.quality/results")).unwrap(),"unique measurement evidence");
    assert!(owner.read(&id).unwrap().error.unwrap().contains("ignored input"));
}

#[test]
fn bridge_build_output_reclamation_preserves_drafts_and_unknown_inputs() {
    let sandbox = Sandbox::new();
    let owner = sandbox.owner();
    ready(&owner);
    let source = crate::checkpoint::tests::init(&sandbox.0);
    fs::create_dir_all(source.join("packages/worker")).unwrap();
    fs::create_dir_all(source.join("packages/cli")).unwrap();
    fs::write(source.join("packages/cli/Cargo.toml"), "[package]\nname = \"bridge-cli\"\n").unwrap();
    fs::write(source.join(".gitignore"), ".kb-bundle/\n.quality/\npackages/cli/target/\n").unwrap();
    fs::write(source.join("packages/worker/package.json"), r#"{"name":"bridge-worker","scripts":{"test":"wrangler deploy --dry-run --outdir ../../.kb-bundle"}}"#).unwrap();
    git(&source, &["add", ".gitignore", "packages/worker/package.json", "packages/cli/Cargo.toml"]).unwrap();
    git(&source, &["commit", "-m", "Declare the reproducible worker output"]).unwrap();

    for case in ["generated", "extra-input", "staged-input"] {
        let t = ticket(&format!("worker-bundle-{case}"));
        let a = owner.allocate(&t, Some(source.to_str().unwrap())).unwrap();
        let work = a.work.clone();
        let bundle = work.join(".kb-bundle");
        let target = work.join("packages/cli/target");
        fs::create_dir_all(&target).unwrap();
        if case != "extra-input" {
            fs::write(target.join("CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n").unwrap();
        }
        fs::write(target.join("build-output"), "reproducible only if the cache is marked").unwrap();
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join("README.md"), r#"This folder contains the built output assets for the worker "bridge" generated at 2026-11-09T09:00:00Z."#).unwrap();
        fs::write(bundle.join("index.js"), vec![b'x'; 128 * 1024]).unwrap();
        if case == "extra-input" {
            fs::write(bundle.join("handwritten-note"), "unique input").unwrap();
        }
        if case == "staged-input" {
            git(&work, &["add", "--force", ".kb-bundle/index.js", "packages/cli/target/build-output"]).unwrap();
            fs::write(bundle.join("index.js"), "unpublished edits to a staged input").unwrap();
        }
        fs::create_dir_all(work.join(".quality")).unwrap();
        fs::write(work.join(".quality/results"), "unique evidence").unwrap();
        let owner_attempt = attempt(&t);
        a.bind(&owner_attempt).unwrap();
        drop(a);
        owner.release(&released(&owner_attempt)).unwrap();
        owner.reconcile(&[]).unwrap();
        assert_eq!(bundle.exists(), case != "generated");
        assert_eq!(target.exists(), case != "generated");
        assert_eq!(fs::read_to_string(work.join(".quality/results")).unwrap(), "unique evidence");
        if case == "extra-input" {
            assert_eq!(fs::read_to_string(bundle.join("handwritten-note")).unwrap(), "unique input");
        }
        if case == "staged-input" {
            assert_eq!(fs::read_to_string(bundle.join("index.js")).unwrap(), "unpublished edits to a staged input");
        }
    }
}

#[test]
fn ignored_evidence_arriving_before_removal_is_rechecked() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);let t=ticket("late-ignored");
    let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    fs::write(a.work.join(".gitignore"),".secret-output\n").unwrap();
    fs::write(a.work.join(".secret-output"),"new unique evidence").unwrap();
    let id=a.id.clone();let root=a.root.clone();let work=a.work.clone();drop(a);
    let mut record=owner.read(&id).unwrap();record.phase=Phase::Reclaimable {snapshots:vec![Snapshot {path:work}]};owner.save(&record).unwrap();
    assert_eq!(owner.reconcile(&[]).unwrap().reclaimed_bytes,0);
    assert_eq!(fs::read_to_string(root.join("work/.secret-output")).unwrap(),"new unique evidence");
    assert!(owner.read(&id).unwrap().error.unwrap().contains("ignored input"));
}

#[test]
fn completed_resource_history_is_cold_and_cannot_resurrect_a_claim() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let t=ticket("completed");let a=owner.allocate(&t,None).unwrap();let id=a.id.clone();let root=a.root.clone();drop(a);
    owner.release(&released(&Ownership::Reservation {ticket:t.clone()})).unwrap();owner.reconcile(&[]).unwrap();
    assert!(!root.exists());assert!(!owner.file(&id).exists());assert!(owner.archive_file(&id).exists());
    let before=fs::read(owner.archive_file(&id)).unwrap();
    for n in 0..256 {
        let name=format!("historical-{n}");
        owner.save(&Resource {version:1,id:name,location:Location::Legacy {root:sandbox.0.join("gone"),task:None},phase:Phase::Removed {reclaimed_bytes:0,at:1},observed_bytes:0,checked_at:0,retry_at:0,error:None,last_activity_at:0,retained_value:None,adopted_from:None,reset_at:None,reset_reason:None,task_lineage:None}).unwrap();
    }
    assert!(owner.records().unwrap().is_empty(),"completed history must not be scanned/rewritten as active work");
    owner.reconcile(&[]).unwrap();assert_eq!(fs::read(owner.archive_file(&id)).unwrap(),before);
    assert!(owner.allocate(&t,None).is_err(),"archival cannot grant a second use of an old claim");
    assert!(matches!(owner.read(&id).unwrap().phase,Phase::Removed { .. }));
}

#[cfg(target_os="linux")]
#[test]
fn an_unrelated_real_non_dumpable_daemon_does_not_own_a_released_execution_workspace() {
    use std::io::BufRead;
    struct Daemon(std::process::Child);
    impl Drop for Daemon {fn drop(&mut self) {let _=self.0.kill();let _=self.0.wait();}}
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let mut daemon=Daemon(Command::new("python3").args(["-c","import ctypes,time; assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0; print('ready',flush=True); time.sleep(60)"])
        .current_dir(&sandbox.0).stdout(std::process::Stdio::piped()).spawn().unwrap());
    let mut ready_line=String::new();std::io::BufReader::new(daemon.0.stdout.take().unwrap()).read_line(&mut ready_line).unwrap();assert_eq!(ready_line.trim(),"ready");
    let t=ticket("fenced-with-private-daemon");let a=owner.allocate(&t,None).unwrap();fs::write(a.root.join("tmp/object"),vec![2u8;8192]).unwrap();
    a.bind(&attempt(&t)).unwrap();let root=a.root.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    assert!(owner.reconcile(&[]).unwrap().reclaimed_bytes>=8192);assert!(!root.exists());
    assert!(daemon.0.try_wait().unwrap().is_none(),"reconciliation must not stop the unrelated daemon");
}

#[test]
fn admission_sampling_reproofs_a_stale_proof_from_the_cached_inventory_without_touching_records() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let t=ticket("sampled");let a=owner.allocate(&t,None).unwrap();fs::write(a.work.join("active-input"),"keep").unwrap();
    a.bind(&attempt(&t)).unwrap();let id=a.id.clone();drop(a);
    owner.reconcile(&[]).unwrap();
    let cached=owner.status().unwrap();assert!(cached.admissible_bytes.is_some());
    let record_before=owner.read(&id).unwrap();
    // BR#19262 live shape: the full pass (du per record) crawls for minutes
    // while dispatch keeps asking; the only proof on disk ages past the 120s
    // window and the owner holds admission with 107 GiB actually free. The
    // bounded sampler must refresh the proof from the cached inventory alone.
    let mut stale=cached.clone();stale.observed_at=now_ms().saturating_sub(121_000);stale.admission=Admission::Held { reason:"aged out".into() };
    journal::write_file(&owner.ledger.join("status.json"),&serde_json::to_vec(&stale).unwrap()).unwrap();
    assert!(matches!(owner.admission(),Admission::Held {..}),"the aged proof must hold first (precondition)");
    let sampled=owner.refresh_admission_with(u64::MAX,0).unwrap();
    assert!(matches!(sampled.admission,Admission::Ready));
    assert!(now_ms().saturating_sub(sampled.observed_at)<5_000,"sampling must produce a fresh proof");
    assert_eq!(sampled.admissible_bytes,cached.admissible_bytes,"the sampler reuses the last full inventory, it never re-measures");
    assert_eq!(sampled.budget_bytes,cached.budget_bytes);
    assert_eq!(serde_json::to_value(owner.read(&id).unwrap()).unwrap(),serde_json::to_value(record_before).unwrap(),"sampling is not a ladder step: the in-use record is untouched");
    assert!(matches!(owner.admission(),Admission::Ready),"a fresh proof reopens admission");
}

#[test]
fn admission_sampling_fails_closed_and_never_fabricates_a_proof() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();
    // No proof at all: the sampler cannot conjure an inventory out of nothing.
    assert!(owner.refresh_admission_with(u64::MAX,0).is_err());
    ready(&owner);
    let path=owner.ledger.join("status.json");
    let mut legacy:serde_json::Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    legacy.as_object_mut().unwrap().remove("admissible_bytes");
    fs::write(&path,legacy.to_string()).unwrap();
    let error=owner.refresh_admission_with(u64::MAX,0).unwrap_err();
    assert!(error.contains("not yet been measured"),"{error}");
    // A corrupt proof fails closed too — and in EVERY failure the previous
    // proof file is left exactly as it was.
    fs::write(&path,b"{").unwrap();
    assert!(owner.refresh_admission_with(u64::MAX,0).is_err());
    assert_eq!(fs::read(&path).unwrap(),b"{");
}

#[test]
fn admission_sampling_holds_under_genuine_pressure_but_never_advances_the_reclaim_ladder() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let t=ticket("pressured");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    fs::write(a.root.join("cache/object"),vec![7u8;64*1024]).unwrap();
    a.bind(&attempt(&t)).unwrap();drop(a);
    owner.release(&released(&attempt(&t))).unwrap();
    let baseline=owner.reconcile(&[]).unwrap();
    assert!(matches!(baseline.admission,Admission::Ready),"fixture precondition: an empty workspace is admissible");
    let t2=ticket("pending");let b=owner.allocate(&t2,Some(source.to_str().unwrap())).unwrap();configure(&b.work,&sandbox.0);
    fs::write(b.root.join("cache/other"),vec![3u8;32*1024]).unwrap();
    b.bind(&attempt(&t2)).unwrap();let id2=b.id.clone();let root2=b.root.clone();drop(b);
    owner.release(&released(&attempt(&t2))).unwrap();
    // Genuine pressure: a one-byte budget holds admission on the cached
    // inventory while the disk floor holds independently of it. (The held
    // proof also pauses new allocations — the sampler gates them exactly like
    // the full pass does.)
    let held=owner.refresh_admission_with(1,0).unwrap();
    let Admission::Held { reason }=&held.admission else { panic!("expected held under a one-byte budget") };
    assert!(reason.contains("reclamation continues"),"{reason}");
    assert!(matches!(owner.refresh_admission_with(u64::MAX,u64::MAX).unwrap().admission,Admission::Held {..}),"the disk floor is a hard safety independent of the budget");
    // The sampler is not a reclamation owner: a pending retirement survives
    // it byte-for-byte, with no removal receipt written behind the ladder's
    // back.
    assert!(root2.exists(),"sampling must not retire a pending resource");
    assert!(!matches!(owner.read(&id2).unwrap().phase,Phase::Removed { .. }));
    assert!(fs::read_dir(owner.ledger.join("removals")).map(|entries| entries.filter_map(|e| e.ok()).all(|e| {
        let receipt:Removal=serde_json::from_slice(&fs::read(e.path()).unwrap()).unwrap();
        receipt.resource_id!=id2
    })).unwrap_or(true),"no removal receipt may be written by sampling");
    assert!(matches!(owner.status().unwrap().admission,Admission::Held {..}));
    // The full reconcile pass remains the sole ladder owner.
    owner.reconcile(&[]).unwrap();
    assert!(!root2.exists());
    assert!(matches!(owner.read(&id2).unwrap().phase,Phase::Removed { .. }));
}

// BR#14525 — worktree affinity: a retry generation adopts the SAME EXISTING
// worktree of its task's prior (quiesced, released, in-TTL) generation, with
// the inherited state assessed for the resume protocol; the re-keyed record
// preserves the directory (moving a git worktree breaks its link).
#[test]
fn affinity_adopts_a_quiesced_prior_worktree_and_assesses_inherited_state() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let first=Ticket { task_id:"BR#42".into(), session:"gen-1".into() };
    let a=owner.allocate(&first,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    let root=a.root.clone();let work=a.work.clone();
    a.bind(&attempt(&first)).unwrap();drop(a);
    fs::write(work.join("tracked"),"generation-1 WIP\n").unwrap();
    owner.release(&released(&attempt(&first))).unwrap();
    // The dirty released tree is held by the explicit retention policy, not
    // error churn: stays Released as the adoptable value signal.
    owner.reconcile(&[]).unwrap();
    let old_id=journal::stable_key(&[&first.task_id,&first.session]);
    let record=owner.read(&old_id).unwrap();
    assert!(matches!(record.phase,Phase::Released { .. }));
    assert!(record.retained_value.as_deref().is_some_and(|s| s.contains("unpublished worktree value")),"value signal missing: {:?}",record.retained_value);
    assert!(record.error.is_none(),"retention is policy, not error churn");
    assert!(fs::read_to_string(work.join("tracked")).unwrap().contains("generation-1"));
    // The next generation adopts in place.
    let second=Ticket { task_id:"BR#42".into(), session:"gen-2".into() };
    let b=owner.allocate(&second,Some(source.to_str().unwrap())).unwrap();
    assert_eq!(b.root,root,"adoption must resume the SAME worktree");
    assert!(b.adopted.as_deref().is_some_and(|s| s.contains("uncommitted")),"resume prompt needs the inherited assessment: {:?}",b.adopted);
    assert_eq!(journal::stable_key(&[&second.task_id,&second.session]),b.id);
    let adopted=owner.read(&b.id).unwrap();
    assert!(matches!(adopted.phase,Phase::InUse {owner:Ownership::Reservation {ref ticket,..}} if ticket.session=="gen-2"));
    assert_eq!(adopted.adopted_from.as_deref(),Some(old_id.as_str()));
    assert!(!owner.file(&old_id).exists(),"the re-keyed record must not keep its old live file");
    let receipt:Resource=serde_json::from_slice(&fs::read(owner.archive_file(&old_id)).unwrap()).unwrap();
    assert!(matches!(receipt.phase,Phase::Removed { .. }),"the pre-adoption record survives as the adoption receipt");
    // The adoption binds to the new generation's attempt and the WIP survives.
    b.bind(&attempt(&second)).unwrap();
    assert!(fs::read_to_string(work.join("tracked")).unwrap().contains("generation-1"));
    assert_eq!(owner.active_paths_for_task("BR#42").unwrap(),vec![work.clone()]);
}

// BR#14525 — affinity is a PREFERENCE, never a pin: past the TTL the tree is
// no longer adoptable and a fresh allocation starts elsewhere; the retained
// tree's hold ends (never a silent wipe — the fences still govern removal).
#[test]
fn expired_affinity_starts_fresh_and_ends_the_retention_hold() {
    let sandbox=Sandbox::new();let mut owner=sandbox.owner();
    let hub=Hub::new(|request| if request["params"]["name"]=="get_artefact" {
        Some(json!({"id":"BR#42","type":"task","status":"done","meta":{}}))
    } else { None });
    owner.cfg.url=hub.url.clone();
    ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let first=Ticket { task_id:"BR#42".into(), session:"gen-1".into() };
    let a=owner.allocate(&first,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    let root=a.root.clone();let work=a.work.clone();
    a.bind(&attempt(&first)).unwrap();drop(a);
    fs::write(work.join("tracked"),"stale WIP\n").unwrap();
    owner.release(&released(&attempt(&first))).unwrap();
    let old_id=journal::stable_key(&[&first.task_id,&first.session]);
    let mut record=owner.read(&old_id).unwrap();
    record.last_activity_at=now_ms().saturating_sub(worktree_ttl().as_millis() as u64).saturating_sub(1);
    owner.save(&record).unwrap();
    let second=Ticket { task_id:"BR#42".into(), session:"gen-2".into() };
    let b=owner.allocate(&second,Some(source.to_str().unwrap())).unwrap();
    assert_ne!(b.root,root,"expired affinity must fall back to a fresh worktree");
    assert!(b.adopted.is_none());
    // BR#22672: the expired hold ends through the recorded reset — the task
    // is closed, so the stale tree is discarded WITH a receipt. The deletion
    // authority is the receipt (age alone never was authority); what the
    // receipt records is exactly the WIP the old fences used to retain.
    owner.reconcile(&[]).unwrap();
    let expired=owner.read(&old_id).unwrap();
    assert!(matches!(expired.phase,Phase::Removed { .. }),"expired affinity with a closed task is discarded");
    assert!(expired.retained_value.is_none(),"the retention signal ended");
    assert!(expired.reset_at.is_some(),"the recorded reset is the hold's exit");
    let receipt:serde_json::Value=serde_json::from_slice(&fs::read(owner.ledger.join("discards").join(format!("{old_id}.json"))).unwrap()).unwrap();
    assert!(receipt["repositories"][0]["dirty_paths"].as_array().is_some_and(|paths| paths.iter().any(|p| p.as_str().is_some_and(|p| p.ends_with("tracked")))),"the discarded WIP is recorded in the receipt, not silently lost");
}

// BR#14525 — a clean, published done tree reclaims immediately (task done),
// while a dirty tree inside the TTL stays adoptable; adoption clears the
// value signal as the next generation takes over.
#[test]
fn done_trees_reclaim_while_dirty_trees_stay_adoptable_until_taken() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let done=Ticket { task_id:"BR#90".into(), session:"gen-1".into() };
    let a=owner.allocate(&done,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&done)).unwrap();
    let done_root=a.root.clone();drop(a);
    owner.release(&released(&attempt(&done))).unwrap();
    let dirty=Ticket { task_id:"BR#91".into(), session:"gen-1".into() };
    let b=owner.allocate(&dirty,Some(source.to_str().unwrap())).unwrap();configure(&b.work,&sandbox.0);
    let dirty_root=b.root.clone();let dirty_work=b.work.clone();
    b.bind(&attempt(&dirty)).unwrap();drop(b);
    fs::write(dirty_work.join("tracked"),"precious WIP\n").unwrap();
    owner.release(&released(&attempt(&dirty))).unwrap();
    owner.reconcile(&[]).unwrap();
    assert!(!done_root.exists(),"a clean published done tree is not retained by policy");
    assert!(dirty_root.exists(),"a dirty tree inside the TTL is the adoptable value");
    let next=Ticket { task_id:"BR#91".into(), session:"gen-2".into() };
    let c=owner.allocate(&next,Some(source.to_str().unwrap())).unwrap();
    assert_eq!(c.root,dirty_root);
    let adopted=owner.read(&c.id).unwrap();
    assert!(adopted.retained_value.is_none(),"adoption clears the value signal");
}

#[test]
fn recorded_discard_frees_expired_unpublished_trees_when_the_task_closed() {
    let sandbox=Sandbox::new();let mut owner=sandbox.owner();
    let hub=Hub::new(|request| if request["params"]["name"]=="get_artefact" {
        Some(json!({"id":"br22634-discard","type":"task","status":"done","meta":{}}))
    } else { None });
    owner.cfg.url=hub.url.clone();
    ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let t=ticket("br22634-discard");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&t)).unwrap();let id=a.id.clone();let root=a.root.clone();let work=a.work.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    fs::write(work.join("tracked"),"unique unpublished value").unwrap();
    let mut record=owner.read(&id).unwrap();record.last_activity_at=1;owner.save(&record).unwrap();
    // Task closed on the hub (BR#22672: recorded discard): the durable
    // receipt is BR#14525's reset — the ladder reclaims the bytes, nothing
    // is published anywhere, and the receipt remembers what was lost.
    owner.reconcile(&[]).unwrap();
    let record=owner.read(&id).unwrap();
    assert!(matches!(record.phase,Phase::Removed { .. }),"expired tree with a closed task was reclaimed");
    assert!(record.reset_at.is_some(),"recorded-reset marker missing");
    assert!(record.reset_reason.as_deref().unwrap_or("").contains("closed"),"reset reason carries the liveness verdict");
    assert!(!root.exists(),"allocation root removed");
    let receipt:serde_json::Value=serde_json::from_slice(&fs::read(owner.ledger.join("discards").join(format!("{id}.json"))).unwrap()).unwrap();
    assert_eq!(receipt["resource_id"],id.as_str());
    assert_eq!(receipt["task"],"br22634-discard");
    assert_eq!(receipt["session"],format!("session-br22634-discard"));
    let inventory=&receipt["repositories"][0];
    assert!(inventory["dirty_paths"].as_array().is_some_and(|paths| paths.iter().any(|p| p.as_str().is_some_and(|p| p.ends_with("tracked")))),"receipt inventory lists the lost WIP file: {receipt}");
    assert!(inventory["head"].as_str().is_some(),"receipt records the HEAD the tree died on");
    // The value fences stood down BY CONTENT: the receipt exists, matches the
    // record, and is the only reason the removal could proceed.
    assert!(owner.reset_proof(&record),"reset proof verifies the receipt file");
    let mut stale=record.clone();stale.id="other".into();
    assert!(!owner.reset_proof(&stale),"a receipt for another resource is not deletion authority");
}

#[test]
fn task_liveness_grace_retains_expired_trees_while_the_task_is_open_and_routable() {
    let sandbox=Sandbox::new();let mut owner=sandbox.owner();
    let hub=Hub::new(|request| if request["params"]["name"]=="get_artefact" {
        Some(json!({"id":"br22634-grace","type":"task","status":"todo","meta":{}}))
    } else { None });
    owner.cfg.url=hub.url.clone();
    ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let t=ticket("br22634-grace");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&t)).unwrap();let id=a.id.clone();let root=a.root.clone();let work=a.work.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    fs::write(work.join("tracked"),"adoptable WIP").unwrap();
    let mut record=owner.read(&id).unwrap();record.last_activity_at=1;owner.save(&record).unwrap();
    // BR#22672 grace: the TTL expired, but the task is open and unclaimed —
    // it can still be routed back to this host, so the tree stays the
    // adoptable value signal (no error, no discard, clock refreshed).
    owner.reconcile(&[]).unwrap();
    let record=owner.read(&id).unwrap();
    assert!(root.exists(),"open task: the expired tree is retained by grace");
    assert!(record.retained_value.as_deref().unwrap_or("").contains("task-liveness grace"),"grace signal recorded");
    assert!(record.last_activity_at>1,"grace refreshes the affinity clock so adoption can still re-key the tree");
    assert!(record.error.is_none(),"grace is a policy hold, not an error");
    assert!(record.reset_at.is_none(),"no discard receipt while the task can route back");
    // The routing proof: a NEW claim on this task adopts the SAME worktree.
    let next=Ticket { task_id:"br22634-grace".into(), session:"gen-2".into() };
    let c=owner.allocate(&next,Some(source.to_str().unwrap())).unwrap();
    assert_eq!(c.root,root,"a new claim routes back to the retained worktree");
}

#[test]
fn a_foreign_claim_discards_the_stale_worktree() {
    let sandbox=Sandbox::new();let mut owner=sandbox.owner();
    let hub=Hub::new(|request| if request["params"]["name"]=="get_artefact" {
        Some(json!({"id":"br22634-foreign","type":"task","status":"in_progress","meta":{"session":"dispatch-elsewhere"}}))
    } else { None });
    owner.cfg.url=hub.url.clone();
    ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let t=ticket("br22634-foreign");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&t)).unwrap();let id=a.id.clone();let root=a.root.clone();let work=a.work.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    fs::write(work.join("tracked"),"stale WIP").unwrap();
    let mut record=owner.read(&id).unwrap();record.last_activity_at=1;owner.save(&record).unwrap();
    // BR#22672: another machine picked the task up — this worktree is not
    // the live line, so it is marked for deletion (with the receipt).
    owner.reconcile(&[]).unwrap();
    let record=owner.read(&id).unwrap();
    assert!(matches!(record.phase,Phase::Removed { .. }),"a foreign claim discards the stale tree");
    assert!(record.reset_reason.as_deref().unwrap_or("").contains("not the live line"),"reset reason names the foreign claim");
    assert!(!root.exists(),"allocation root removed");
}

#[test]
fn hub_unreachability_never_discards_expired_wip() {
    let sandbox=Sandbox::new();let owner=sandbox.owner(); // 127.0.0.1:1: refused instantly
    ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let t=ticket("br22634-unreachable");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&t)).unwrap();let id=a.id.clone();let root=a.root.clone();let work=a.work.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    fs::write(work.join("tracked"),"unpublished").unwrap();
    let mut record=owner.read(&id).unwrap();record.last_activity_at=1;owner.save(&record).unwrap();
    // The liveness verdict is UNKNOWN when the hub cannot answer: the
    // worktree is retained (the error surfaces for retry), never discarded
    // on a failed probe.
    owner.reconcile(&[]).unwrap();
    let record=owner.read(&id).unwrap();
    assert!(record.error.as_deref().unwrap_or("").contains("task liveness unavailable"),"liveness failure surfaces on the record");
    assert!(record.reset_at.is_none(),"no receipt without a liveness verdict");
    assert_source_not_removed(&owner,&id,&root);
}

// BR#22672 — the pile's measured mass was NOT git-dirty trees: retention is
// porcelain-blind to ignored evidence, so clean+published trees carrying
// unique ignored files route Reclaim → ladder → fence refusal forever. The
// value-fence gate is their exit: refusal + expired + closed task → the
// receipt (which inventories exactly that ignored evidence) waives the fence.
#[test]
fn ignored_evidence_records_a_discard_receipt_when_the_task_closed() {
    let sandbox=Sandbox::new();let mut owner=sandbox.owner();
    let hub=Hub::new(|request| if request["params"]["name"]=="get_artefact" {
        Some(json!({"id":"br22672-ignored","type":"task","status":"done","meta":{}}))
    } else { None });
    owner.cfg.url=hub.url.clone();
    ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    // A committed ignore rule: the work tree reads CLEAN to porcelain while
    // carrying unique ignored evidence — the host pile's exact shape (650
    // records / 148 GiB porcelain-blind to their own evidence).
    fs::write(source.join(".gitignore"),".env\n").unwrap();
    git(&source,&["add",".gitignore"]).unwrap();
    git(&source,&["commit","-m","Declare local env evidence ignored"]).unwrap();
    let t=ticket("br22672-ignored");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&t)).unwrap();let id=a.id.clone();let root=a.root.clone();let work=a.work.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    // Ignored evidence: invisible to porcelain, not disposable by class.
    fs::write(work.join(".env"),"unique local secret evidence").unwrap();
    let mut record=owner.read(&id).unwrap();record.last_activity_at=1;owner.save(&record).unwrap();
    owner.reconcile(&[]).unwrap();
    let record=owner.read(&id).unwrap();
    assert!(matches!(record.phase,Phase::Removed { .. }),"ignored-evidence tree with a closed task is discarded, not wedged at the fence");
    assert!(record.reset_at.is_some(),"the gate wrote the recorded reset");
    assert!(!root.exists(),"allocation root removed");
    let receipt:serde_json::Value=serde_json::from_slice(&fs::read(owner.ledger.join("discards").join(format!("{id}.json"))).unwrap()).unwrap();
    assert_eq!(receipt["task"],"br22672-ignored","receipt attributes the discard to the task");
    assert!(receipt["repositories"][0]["ignored_evidence"].as_array().is_some_and(|paths| paths.iter().any(|p| p.as_str().is_some_and(|p| p.ends_with(".env")))),"the ignored evidence is preserved in the receipt: {:?}",receipt);
}

#[test]
fn the_value_fence_gate_graces_an_open_task_with_ignored_evidence() {
    let sandbox=Sandbox::new();let mut owner=sandbox.owner();
    let hub=Hub::new(|request| if request["params"]["name"]=="get_artefact" {
        Some(json!({"id":"br22672-gate-grace","type":"task","status":"todo","meta":{}}))
    } else { None });
    owner.cfg.url=hub.url.clone();
    ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    // Committed ignore rule: porcelain-clean tree carrying ignored evidence
    // (the fence refusal class the gate routes at arm 1).
    fs::write(source.join(".gitignore"),".env\n").unwrap();
    git(&source,&["add",".gitignore"]).unwrap();
    git(&source,&["commit","-m","Declare local env evidence ignored"]).unwrap();
    let t=ticket("br22672-gate-grace");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&t)).unwrap();let id=a.id.clone();let root=a.root.clone();let work=a.work.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    fs::write(work.join(".env"),"adoptable ignored evidence").unwrap();
    let mut record=owner.read(&id).unwrap();record.last_activity_at=1;owner.save(&record).unwrap();
    // The fence refused an EXPIRED tree, but the task is open and routable:
    // grace, not a receipt — the same BR#22672 ruling, applied at the gate.
    owner.reconcile(&[]).unwrap();
    let record=owner.read(&id).unwrap();
    assert!(root.exists(),"open task: the gate holds the refused tree by grace");
    assert!(record.retained_value.as_deref().unwrap_or("").contains("task-liveness grace"),"gate grace signal recorded: {:?}",record.retained_value);
    assert!(record.last_activity_at>1,"the gate refreshes the affinity clock");
    assert!(record.error.is_none(),"grace is a policy hold, not an error: {:?}",record.error);
    assert!(record.reset_at.is_none(),"no receipt while the task can route back");
}

// BR#22672 — retention must SEE local refs outside HEAD (the 570-record
// Removing pile was exactly this class passing the shallow check).
#[test]
fn local_refs_outside_head_are_a_retention_signal() {
    let sandbox=Sandbox::new();let mut owner=sandbox.owner();
    let hub=Hub::new(|request| if request["params"]["name"]=="get_artefact" {
        Some(json!({"id":"br22672-refs","type":"task","status":"done","meta":{}}))
    } else { None });
    owner.cfg.url=hub.url.clone();
    ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let t=ticket("br22672-refs");let a=owner.allocate(&t,None).unwrap();
    let id=a.id.clone();let root=a.root.clone();let work=a.work.clone();drop(a);
    owner.release(&released(&Ownership::Reservation {ticket:t})).unwrap();
    // A standalone clone — the stuck pile's legacy shape: .git is a
    // directory, so the tree's local refs die with it. Clean porcelain,
    // published HEAD, but a side ref the ladder's fence refuses — and
    // retention now sees it too.
    fs::remove_dir_all(&work).unwrap();
    git(&sandbox.0,&["clone",source.to_str().unwrap(),work.to_str().unwrap()]).unwrap();
    configure(&work,&sandbox.0);
    let tree=git(&work,&["rev-parse","HEAD^{tree}"]).unwrap();
    let side=git(&work,&["commit-tree",&tree,"-m","side work"]).unwrap();
    git(&work,&["update-ref","refs/heads/side",&side]).unwrap();
    let mut record=owner.read(&id).unwrap();record.last_activity_at=1;owner.save(&record).unwrap();
    owner.reconcile(&[]).unwrap();
    let record=owner.read(&id).unwrap();
    assert!(matches!(record.phase,Phase::Removed { .. }),"local-refs tree with a closed task is discarded through the Yield path");
    let receipt:serde_json::Value=serde_json::from_slice(&fs::read(owner.ledger.join("discards").join(format!("{id}.json"))).unwrap()).unwrap();
    assert!(receipt["repositories"][0]["local_refs"].as_array().is_some_and(|refs| refs.iter().any(|r| r["reference"]=="refs/heads/side")),"the side ref is preserved in the receipt");
    assert!(!root.exists(),"allocation root removed");
}

// BR#22672 — records already inside the ladder (the live Removing pile)
// lost their owner with the Released phase. The lineage captured at release
// keeps the gate's liveness query and the receipt's attribution working.
#[test]
fn a_mid_ladder_record_routes_through_its_lineage() {
    let sandbox=Sandbox::new();let mut owner=sandbox.owner();
    let hub=Hub::new(|request| if request["params"]["name"]=="get_artefact" {
        Some(json!({"id":"br22672-lineage","type":"task","status":"done","meta":{}}))
    } else { None });
    owner.cfg.url=hub.url.clone();
    ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let t=ticket("br22672-lineage");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&t)).unwrap();let id=a.id.clone();let root=a.root.clone();let work=a.work.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    fs::write(work.join("tracked"),"mid-ladder unpublished value").unwrap();
    // Force the record into the ladder, past Released, as the stuck pile is.
    let mut record=owner.read(&id).unwrap();
    record.phase=Phase::Reclaimable { snapshots: vec![Snapshot { path: work.clone() }] };
    record.last_activity_at=1;
    assert!(record.task_lineage.is_some(),"release captured the task lineage");
    owner.save(&record).unwrap();
    owner.reconcile(&[]).unwrap();
    let record=owner.read(&id).unwrap();
    assert!(matches!(record.phase,Phase::Removed { .. }),"the fence refusal routed through the gate to a receipt");
    assert!(record.reset_reason.as_deref().unwrap_or("").contains("task-liveness gone"),"the gate's reset reason carries the verdict");
    let receipt:serde_json::Value=serde_json::from_slice(&fs::read(owner.ledger.join("discards").join(format!("{id}.json"))).unwrap()).unwrap();
    assert_eq!(receipt["task"],"br22672-lineage","the receipt attributes via the lineage, not the phase");
    assert!(receipt["repositories"][0]["dirty_paths"].as_array().is_some_and(|paths| paths.iter().any(|p| p.as_str().is_some_and(|p| p.ends_with("tracked")))),"the dirty inventory is preserved");
    assert!(!root.exists(),"allocation root removed");
}

// BR#22634 — measured on the gateway: 1,179 never-visited records sat at
// the head of the fair LRU (checked_at=0 sorted FIRST) while 1,632 aged
// records waited behind them, so live dispatch's fresh turnover starved
// the backlog and the pile could only drain at the ENOSPC brink. A record
// with no visit history is NEWEST, not oldest: the aged, actionable
// backlog gets the visit budget.
#[test]
fn the_fair_pass_visits_the_aged_backlog_before_never_visited_records() {
    let sandbox=Sandbox::new();let mut owner=sandbox.owner();
    let hub=Hub::new(|request| if request["params"]["name"]=="get_artefact" {
        let id=request["params"]["arguments"]["id"].as_str().unwrap_or("").to_string();
        Some(json!({"id":id,"type":"task","status":"done","meta":{}}))
    } else { None });
    owner.cfg.url=hub.url.clone();
    ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let mut ids=Vec::new();
    for n in 0..4 {
        let t=ticket(&format!("br22634-fair-{n}"));let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
        a.bind(&attempt(&t)).unwrap();let id=a.id.clone();let work=a.work.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
        fs::write(work.join("tracked"),"aged expired value").unwrap();
        let mut record=owner.read(&id).unwrap();record.last_activity_at=1;record.checked_at=1;owner.save(&record).unwrap();
        ids.push(id);
    }
    // The fresh record: released moments ago, never visited.
    let fresh=ticket("br22634-fresh");let a=owner.allocate(&fresh,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&fresh)).unwrap();let fresh_id=a.id.clone();drop(a);owner.release(&released(&attempt(&fresh))).unwrap();
    owner.reconcile(&[]).unwrap();
    // The aged, expired, closed-task records drained this pass — the
    // visit budget reached the backlog, not the turnover.
    for id in &ids {
        let record=owner.read(id).unwrap();
        assert!(matches!(record.phase,Phase::Removed { .. }),"aged expired record {id} drained this pass");
    }
    // The fresh record was not visited while aged work waited.
    let record=owner.read(&fresh_id).unwrap();
    assert_eq!(record.checked_at,0,"never-visited records are newest, not oldest");
    assert!(matches!(record.phase,Phase::Released { .. }),"the fresh record stays released and unassessed");
}

// Pre-lineage ladder records (the existing stuck pile) have no ticket to
// consult: liveness is UNKNOWN at the gate and the refusal stands — the
// conservative exit, never a blind discard.
#[test]
fn pre_lineage_ladder_records_stay_retained() {
    let sandbox=Sandbox::new();let mut owner=sandbox.owner();
    let hub=Hub::new(|request| if request["params"]["name"]=="get_artefact" {
        Some(json!({"id":"br22672-pre","type":"task","status":"done","meta":{}}))
    } else { None });
    owner.cfg.url=hub.url.clone();
    ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let t=ticket("br22672-pre");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&t)).unwrap();let id=a.id.clone();let root=a.root.clone();let work=a.work.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    fs::write(work.join("tracked"),"pre-lineage unpublished value").unwrap();
    let mut record=owner.read(&id).unwrap();
    record.phase=Phase::Reclaimable { snapshots: vec![Snapshot { path: work.clone() }] };
    record.last_activity_at=1;
    record.task_lineage=None; // the pre-existing pile shape
    owner.save(&record).unwrap();
    owner.reconcile(&[]).unwrap();
    let record=owner.read(&id).unwrap();
    assert!(record.error.as_deref().unwrap_or("").contains("no task lineage"),"the conservative exit surfaces the missing lineage");
    assert!(record.reset_at.is_none(),"no receipt without a routable task identity");
    assert_source_not_removed(&owner,&id,&root);
}

#[test]
fn a_failed_record_save_still_leaves_a_fresh_status_proof() {
    let sandbox=Sandbox::new();let owner=sandbox.owner();ready(&owner);
    let source=crate::checkpoint::tests::init(&sandbox.0);
    let t=ticket("br22634-save-failure");let a=owner.allocate(&t,Some(source.to_str().unwrap())).unwrap();configure(&a.work,&sandbox.0);
    a.bind(&attempt(&t)).unwrap();let id=a.id.clone();let work=a.work.clone();drop(a);owner.release(&released(&attempt(&t))).unwrap();
    git(&work,&["remote","set-url","origin",sandbox.0.join("unavailable.git").to_str().unwrap()]).unwrap();
    fs::write(work.join("tracked"),"unpublished").unwrap();
    let mut record=owner.read(&id).unwrap();record.last_activity_at=1;owner.save(&record).unwrap();
    let before=owner.status().unwrap().observed_at;
    // BR#22634 incident shape: the record's journal save hits a full volume
    // (no reserve to draw). The pass must still run `measure` so admission
    // is re-proved and the sampler keeps dispatch unfenced.
    *super::super::attempt_journal::FAIL_FIRST_WRITE.lock().unwrap()=Some(owner.ledger.join(format!("{id}.json")));
    assert!(owner.reconcile(&[]).is_err(),"the failed journal save surfaces after measure");
    assert!(owner.status().unwrap().observed_at>before,"measure re-proved admission after the failed save");
    *super::super::attempt_journal::FAIL_FIRST_WRITE.lock().unwrap()=None;
}
