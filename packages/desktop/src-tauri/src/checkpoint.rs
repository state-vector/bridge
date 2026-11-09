//! Portable Git checkpoints. A private index snapshots tracked + non-ignored
//! untracked inputs without staging, switching branches or changing HEAD.
//! Remote publication/readback is mandatory. Failure preserves the local tree.
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub repo: String,
    pub remote_ref: String,
    pub commit: String,
    pub tree: String,
    pub base: String,
    pub environment: Vec<String>,
    pub next: String,
    pub tests: Vec<serde_json::Value>,
}

fn git(path: &Path, args: &[&str], index: Option<&Path>) -> Result<String, String> {
    // A missing cwd is a gate-class prerequisite failure, not a git error: the
    // workspace was moved/removed, so nothing git-flavoured can be true here.
    // The "gate:" prefix routes this to finalize()'s reject+hold disposition
    // instead of the short retry path.
    if !path.is_dir() {
        return Err(format!(
            "gate: checkpoint prerequisite failed: worktree cwd missing: {} — the workspace directory was moved or removed; restore it (or start a fresh workspace) before this task can checkpoint again",
            path.display()
        ));
    }
    let mut cmd = Command::new("git");
    cmd.current_dir(path).args(args).env("GIT_TERMINAL_PROMPT", "0");
    if let Some(index) = index { cmd.env("GIT_INDEX_FILE", index); }
    let out = crate::dispatch::run_with_timeout(cmd, 40)?;
    if !out.status.success() { return Err(format!("checkpoint git {} failed: {}", args[0], String::from_utf8_lossy(&out.stderr))); }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn repository_identity(raw: &str) -> String {
    if let Some(path) = raw.strip_prefix("git@github.com:") { return format!("https://github.com/{}", path.trim_end_matches(".git").to_ascii_lowercase()); }
    if let Ok(mut url) = reqwest::Url::parse(raw) {
        let _ = url.set_username(""); let _ = url.set_password(None);
        if url.host_str() == Some("github.com") { return format!("https://github.com{}", url.path().trim_end_matches(".git").to_ascii_lowercase()); }
        return url.to_string();
    }
    raw.to_string()
}

pub fn publish(path: &Path, task: &str, generation: u64, next: &str, environment: Vec<String>) -> Result<Checkpoint, String> {
    let checkpoint = capture(path, task, generation, next, environment)?;
    publish_captured(path, &checkpoint)?;
    Ok(checkpoint)
}

/// Local immutable snapshot first; callers persist this exact object before
/// publication. Retrying publication never invents another ref/commit/effect.
pub fn capture(path: &Path, task: &str, generation: u64, next: &str, environment: Vec<String>) -> Result<Checkpoint, String> {
    let repo = repository_identity(&git(path, &["remote", "get-url", "origin"], None)?);
    let base = git(path, &["rev-parse", "HEAD"], None)?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    // The temporary index lives in Git's private area, not among snapshot inputs.
    let git_dir = git(path, &["rev-parse", "--absolute-git-dir"], None)?;
    let index = std::path::PathBuf::from(git_dir).join(format!("bridge-checkpoint-{}-{nonce}.index", std::process::id()));
    let snapshot = (|| {
        git(path, &["read-tree", "HEAD"], Some(&index))?;
        git(path, &["add", "--all", "--", "."], Some(&index))?;
        let tree = git(path, &["write-tree"], Some(&index))?;
        // Snapshot commits are private preservation objects, not code delivery.
        // Signing uses the runner's already-verified repository-local identity.
        let commit = git(path, &["commit-tree", "-S", &tree, "-p", &base, "-m", &format!("Bridge checkpoint {task} generation {generation}")], None)?;
        let slug: String = task.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
        let remote_ref = format!("refs/heads/bridge-checkpoints/{slug}/{generation}/{nonce}");
        Ok(Checkpoint { repo, remote_ref, commit, tree, base, environment, next: next.into(), tests: vec![] })
    })();
    let _ = std::fs::remove_file(&index);
    snapshot
}

pub fn publish_captured(path: &Path, checkpoint: &Checkpoint) -> Result<(), String> {
    if repository_identity(&git(path, &["remote", "get-url", "origin"], None)?) != checkpoint.repo { return Err("checkpoint repository mismatch".into()); }
    if !checkpoint.remote_ref.starts_with("refs/heads/bridge-checkpoints/") { return Err("gate: checkpoint publication cannot write a delivery branch".into()); }
    if git(path, &["rev-parse", &format!("{}^{{tree}}", checkpoint.commit)], None)? != checkpoint.tree { return Err("gate: captured checkpoint tree does not match its immutable commit".into()); }
    git(path, &["merge-base", "--is-ancestor", &checkpoint.base, &checkpoint.commit], None)?;
    let observed = git(path, &["ls-remote", "origin", &checkpoint.remote_ref], None)?;
    if let Some(head) = observed.split_whitespace().next() {
        return if head == checkpoint.commit { Ok(()) } else { Err("gate: checkpoint ref already contains different content; retain work".into()) };
    }
    git(path, &["push", "origin", &format!("{}:{}", checkpoint.commit, checkpoint.remote_ref)], None)?;
    let observed = git(path, &["ls-remote", "--exit-code", "origin", &checkpoint.remote_ref], None)?;
    if observed.split_whitespace().next() != Some(checkpoint.commit.as_str()) { return Err("checkpoint publication readback did not match content".into()); }
    Ok(())
}

pub fn verify_published(path: &Path, checkpoint: &Checkpoint) -> Result<(), String> {
    if repository_identity(&git(path, &["remote", "get-url", "origin"], None)?) != checkpoint.repo { return Err("checkpoint repository mismatch".into()); }
    let observed = git(path, &["ls-remote", "--exit-code", "origin", &checkpoint.remote_ref], None)?;
    if observed.split_whitespace().next() != Some(checkpoint.commit.as_str()) { return Err("checkpoint remote no longer matches its verified receipt".into()); }
    Ok(())
}

/// Compare all snapshot inputs, including dirty/untracked files, without
/// altering HEAD or the user's index. Cleanup consumes this exact proof.
pub fn matches_working_tree(path: &Path, checkpoint: &Checkpoint) -> Result<bool, String> {
    let git_dir = git(path, &["rev-parse", "--absolute-git-dir"], None)?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let index = std::path::PathBuf::from(git_dir).join(format!("bridge-workspace-{}-{nonce}.index", std::process::id()));
    let result = (|| {
        git(path, &["read-tree", "HEAD"], Some(&index))?;
        git(path, &["add", "--all", "--", "."], Some(&index))?;
        Ok(git(path, &["write-tree"], Some(&index))? == checkpoint.tree)
    })();
    let _ = std::fs::remove_file(index);
    result
}

/// Never reset an existing dirty worktree to a checkpoint. That is newer work,
/// not disposable residue. A restoring runner must preserve it first.
pub fn restore(path: &Path, checkpoint: &Checkpoint) -> Result<(), String> {
    if repository_identity(&git(path, &["remote", "get-url", "origin"], None)?) != checkpoint.repo { return Err("checkpoint repository mismatch".into()); }
    verify_published(path,checkpoint)?;
    // Linked worktrees share FETCH_HEAD. Fetch this immutable object without
    // publishing a shared mutable selector that another preparation can race.
    git(path, &["fetch", "--no-write-fetch-head", "--no-tags", "origin", &checkpoint.commit], None)?;
    if git(path, &["rev-parse", &format!("{}^{{commit}}",checkpoint.commit)], None)? != checkpoint.commit { return Err("checkpoint remote commit mismatch".into()); }
    if git(path, &["rev-parse", &format!("{}^{{tree}}", checkpoint.commit)], None)? != checkpoint.tree { return Err("checkpoint tree digest mismatch".into()); }
    git(path, &["merge-base", "--is-ancestor", &checkpoint.base, &checkpoint.commit], None)?;
    let dirty = git(path, &["status", "--porcelain"], None)?;
    if !dirty.is_empty() {
        let git_dir = git(path, &["rev-parse", "--absolute-git-dir"], None)?;
        let index = std::path::PathBuf::from(git_dir).join(format!("bridge-restore-{}.index", std::process::id()));
        let content = (|| {
            git(path, &["read-tree", "HEAD"], Some(&index))?;
            git(path, &["add", "--all", "--", "."], Some(&index))?;
            git(path, &["write-tree"], Some(&index))
        })();
        let _ = std::fs::remove_file(index);
        if content? == checkpoint.tree { return Ok(()); } // same-host exact content: preserve HEAD/index/WIP
        return Err("checkpoint restoration refused: newer local WIP must be preserved first".into());
    }
    git(path, &["checkout", "--detach", &checkpoint.commit], None)?;
    if git(path, &["rev-parse", "HEAD^{tree}"], None)? != checkpoint.tree { return Err("restored checkpoint content mismatch".into()); }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            loop {
                let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let p = std::env::temp_dir().join(format!("bridge-checkpoint-test-{}-{nonce}-{sequence}", std::process::id()));
                match std::fs::create_dir(&p) {
                    Ok(()) => return Self(p),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("checkpoint sandbox: {error}"),
                }
            }
        }
    }
    impl Drop for Sandbox { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    pub(crate) fn init(root: &Path) -> PathBuf {
        let remote = root.join("remote.git");
        git(root, &["init", "--bare", remote.to_str().unwrap()], None).unwrap();
        let source = root.join("source");
        git(root, &["clone", remote.to_str().unwrap(), source.to_str().unwrap()], None).unwrap();
        let key = root.join("signing");
        assert!(Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f", key.to_str().unwrap()]).status().unwrap().success());
        for (k, v) in [("user.name", "Checkpoint test"), ("user.email", "checkpoint@example.test"), ("gpg.format", "ssh"), ("user.signingkey", key.to_str().unwrap()), ("gpg.ssh.program", "/usr/bin/ssh-keygen")] {
            git(&source, &["config", "--local", k, v], None).unwrap();
        }
        std::fs::write(source.join("tracked"), "base\n").unwrap();
        git(&source, &["add", "--", "tracked"], None).unwrap();
        git(&source, &["commit", "-m", "base"], None).unwrap();
        git(&source, &["push", "origin", "HEAD"], None).unwrap();
        source
    }
    #[test]
    fn dirty_work_survives_publication_and_cross_host_restore_without_index_or_head_mutation() {
        let sandbox = Sandbox::new(); let source = init(&sandbox.0);
        let head = git(&source, &["rev-parse", "HEAD"], None).unwrap();
        let index = git(&source, &["write-tree"], None).unwrap();
        std::fs::write(source.join("tracked"), "repair\n").unwrap();
        std::fs::write(source.join("new-input"), "untracked but necessary\n").unwrap();
        let checkpoint = publish(&source, "BR#1", 1, "Test repair", vec![]).unwrap();
        assert_eq!(git(&source, &["rev-parse", "HEAD"], None).unwrap(), head);
        assert_eq!(git(&source, &["write-tree"], None).unwrap(), index);
        assert!(git(&source, &["status", "--porcelain"], None).unwrap().contains("new-input"));
        // Same-host resume proves exact working content without discarding WIP.
        restore(&source, &checkpoint).unwrap();
        let destination = sandbox.0.join("other-host");
        git(&sandbox.0, &["clone", checkpoint.repo.as_str(), destination.to_str().unwrap()], None).unwrap();
        restore(&destination, &checkpoint).unwrap();
        assert_eq!(std::fs::read_to_string(destination.join("tracked")).unwrap(), "repair\n");
        assert_eq!(std::fs::read_to_string(destination.join("new-input")).unwrap(), "untracked but necessary\n");
        assert_eq!(git(&destination, &["rev-parse", "HEAD^{tree}"], None).unwrap(), checkpoint.tree);
    }
    #[test]
    fn publication_failure_and_newer_wip_are_fail_closed() {
        let sandbox = Sandbox::new(); let source = init(&sandbox.0);
        let checkpoint = publish(&source, "BR#2", 1, "Test", vec![]).unwrap();
        std::fs::write(source.join("tracked"), "newer repair — keep me\n").unwrap();
        assert!(restore(&source, &checkpoint).unwrap_err().contains("newer local WIP"));
        git(&source, &["remote", "set-url", "origin", sandbox.0.join("offline.git").to_str().unwrap()], None).unwrap();
        assert!(publish(&source, "BR#2", 2, "Test", vec![]).is_err());
        assert_eq!(std::fs::read_to_string(source.join("tracked")).unwrap(), "newer repair — keep me\n");
    }

    #[test]
    fn linked_worktrees_restore_their_own_immutable_checkpoint_without_mutating_shared_fetch_head() {
        let sandbox=Sandbox::new();let source=init(&sandbox.0);
        std::fs::write(source.join("tracked"),"first repair\n").unwrap();
        let first=publish(&source,"first",1,"restore",vec![]).unwrap();
        std::fs::write(source.join("tracked"),"second repair\n").unwrap();
        let second=publish(&source,"second",1,"restore",vec![]).unwrap();
        let cache=sandbox.0.join("cache");git(&sandbox.0,&["clone",&first.repo,cache.to_str().unwrap()],None).unwrap();
        let a=sandbox.0.join("a");let b=sandbox.0.join("b");
        for path in [&a,&b] {git(&cache,&["worktree","add","--detach",path.to_str().unwrap(),"HEAD"],None).unwrap();}
        let fetch_head=cache.join(".git/FETCH_HEAD");std::fs::write(&fetch_head,"another execution's immutable observation\n").unwrap();
        let pa=a.clone();let pb=b.clone();
        let one=std::thread::spawn(move ||restore(&pa,&first));let two=std::thread::spawn(move ||restore(&pb,&second));
        one.join().unwrap().unwrap();two.join().unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(a.join("tracked")).unwrap(),"first repair\n");
        assert_eq!(std::fs::read_to_string(b.join("tracked")).unwrap(),"second repair\n");
        assert_eq!(std::fs::read_to_string(fetch_head).unwrap(),"another execution's immutable observation\n");
    }
}
