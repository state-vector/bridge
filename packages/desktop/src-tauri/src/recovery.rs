//! Fact/command adapter for the ONE independent recovery supervisor. No retry,
//! restart, installation or task-completion policy belongs in this module.
use super::*;

#[derive(Serialize)]
#[serde(tag="kind",rename_all="snake_case")]
enum Boundary { ControllerOnly { pid:u32, nonce:String }, Busy { reason:String } }

pub(super) fn command(cfg:&DispatchConfig,args:&[String])->Result<serde_json::Value,String> {
    match args.first().map(String::as_str) {
        Some("boundary") if args.len()==4 => {
            let pid=args[1].parse::<u32>().map_err(|_|"Invalid controller PID")?;
            serde_json::to_value(boundary(cfg,pid,&args[2],&args[3])?).map_err(|e|e.to_string())
        },
        Some("inspect" | "reconcile") => {
            let mut apply=false;let mut task=None;
            for arg in &args[1..] {
                if arg=="--apply" && args[0]=="reconcile" && !apply {apply=true;}
                else if arg.strip_prefix("BR#").is_some_and(|id|id.parse::<u64>().is_ok()) && task.is_none() {task=Some(arg.as_str());}
                else {return Err("usage: bridge recovery inspect [BR#task] | reconcile [--apply] [BR#task]".into());}
            }
            gateway_pipeline::reconcile(cfg,apply,task)
        },
        _=>Err("usage: bridge recovery inspect | reconcile [--apply] | boundary <pid> <nonce> <commit>".into()),
    }
}

fn boundary(_cfg:&DispatchConfig,pid:u32,nonce:&str,commit:&str)->Result<Boundary,String> {
    #[cfg(target_os="linux")]
    {
        let home=PathBuf::from(std::env::var_os("HOME").ok_or("Gateway home missing")?);
        let request:serde_json::Value=serde_json::from_slice(&std::fs::read(home.join(".bridge/update/request.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        if pid<=1 || nonce.is_empty() || request["nonce"]!=nonce || request["worker_protocol"]!=worker_session::PROTOCOL {
            return Err("Exact supervisor request/worker protocol required".into());
        }
        let proc=PathBuf::from(format!("/proc/{pid}"));
        let env=std::fs::read(proc.join("environ")).map_err(|e|e.to_string())?;
        if !env.split(|b|*b==0).any(|v|v==b"BRIDGE_MANAGED_UPDATES=1") {return Err("Controller does not honor managed admission holds".into());}
        let mut probe=Command::new(proc.join("exe"));probe.arg("build-info");
        let out=run_with_timeout(probe,10)?;
        let info:serde_json::Value=serde_json::from_slice(&out.stdout).map_err(|e|e.to_string())?;
        if !out.status.success() || info["commit"]!=commit || info["worker_protocol"]!=worker_session::PROTOCOL {return Err("Original managed build/protocol changed".into());}
        let text=std::fs::read_to_string(proc.join("cgroup")).map_err(|e|e.to_string())?;
        let group=text.lines().find_map(|line|line.strip_prefix("0::")).ok_or("Unified kernel cgroup required")?;
        if !group.ends_with("/bridge.service") {return Err("PID is not in the original bridge service".into());}
        let path=PathBuf::from("/sys/fs/cgroup").join(group.trim_start_matches('/'));
        frozen_boundary(&path,pid,nonce)
    }
    #[cfg(not(target_os="linux"))]
    {let _=(pid,nonce,commit);Err("Original Linux/systemd kernel boundary required".into())}
}

#[cfg(any(target_os="linux",test))]
fn frozen_boundary(path:&Path,pid:u32,nonce:&str)->Result<Boundary,String> {
    let frozen=std::fs::read_to_string(path.join("cgroup.events")).map_err(|e|e.to_string())?.lines().any(|line|line.split_whitespace().eq(["frozen","1"]));
    let members=worker_session::kernel_group_members(path)?;
    if frozen && members==vec![pid] {Ok(Boundary::ControllerOnly {pid,nonce:nonce.into()})}
    else {Ok(Boundary::Busy {reason:"Controller group is not frozen and empty of child/effect processes".into()})}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_boundary_requires_real_empty_descendant_census() {
        let root=std::env::temp_dir().join(format!("bridge-boundary-{}-{}",std::process::id(),now_ms()));
        journal_file(&root.join("cgroup.events"),b"populated 1\nfrozen 1\n");
        journal_file(&root.join("cgroup.procs"),b"123\n");
        assert!(matches!(frozen_boundary(&root,123,"n").unwrap(),Boundary::ControllerOnly {..}));
        journal_file(&root.join("child/cgroup.procs"),b"456\n");
        assert!(matches!(frozen_boundary(&root,123,"n").unwrap(),Boundary::Busy {..}));
        std::fs::remove_file(root.join("child/cgroup.procs")).unwrap();
        assert!(frozen_boundary(&root,123,"n").is_err(),"visibility gaps cannot be quiescence");
        std::fs::remove_dir(root.join("child")).unwrap();
        journal_file(&root.join("cgroup.events"),b"frozen 0\n");
        assert!(matches!(frozen_boundary(&root,123,"n").unwrap(),Boundary::Busy {..}));
        let _=std::fs::remove_dir_all(root);
    }
    fn journal_file(path:&Path,bytes:&[u8]) {super::super::attempt_journal::write_file(path,bytes).unwrap();}
}
