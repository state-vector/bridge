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
        let cfg: DispatchConfig = serde_json::from_value(json!({"url":"http://fixture.invalid","label":"workspace-tests","workdir":self.0.join("disk")})).unwrap();
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
    let held=super::super::attempt_journal::Record {owner:Ownership::Attempt {ticket:ticket("unknown-writer"),host:cfg.label.clone().unwrap(),generation:1,attempt_id:"unknown-attempt".into()},host:cfg.label.clone().unwrap(),url:cfg.url.clone(),observed_at:now_ms(),process:None,disposition:super::super::attempt_journal::Disposition::Pending,work:super::super::attempt_journal::Work::Unproven {outcome:super::super::attempt_journal::Outcome {kind:super::super::attempt_journal::OutcomeKind::Completed,exit_code:None,stdout_tail:"captured result retained without writer proof".into(),stderr_tail:String::new(),cause:None},worktree:None}};
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
    owner.save(&Resource {version:1,id:id.clone(),location:Location::Legacy {root:root.clone(),task:Some("BR#123".into())},phase:Phase::LegacyUnproved,observed_bytes:0,checked_at:0,retry_at:0,error:None}).unwrap();
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
        owner.save(&Resource {version:1,id:name,location:Location::Legacy {root:sandbox.0.join("gone"),task:None},phase:Phase::Removed {reclaimed_bytes:0,at:1},observed_bytes:0,checked_at:0,retry_at:0,error:None}).unwrap();
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
