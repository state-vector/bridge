//! Legacy Git checkpoint metadata retained for reading existing journals.
//! BR#14525 (owner ruling 2026-11-13): NO git-pushed checkpoints — the
//! WORKTREE is the durability boundary. A checkpoint records a LOCAL commit;
//! verification inspects the provisioned clone's own object store, never a
//! published origin ref.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub repo: String,
    pub commit: String,
    pub tree: String,
    pub base: String,
    pub environment: Vec<String>,
    pub next: String,
    pub tests: Vec<serde_json::Value>,
}

/// Restore only from the provisioned repository, not a URL supplied by the
/// checkpoint author. Verify the local objects before checkout. No fetch
/// writes FETCH_HEAD in the shared repository cache; nothing is published.
pub fn restore(worktree: &std::path::Path, checkpoint: &Checkpoint, _task: &str, _generation: u64) -> Result<(), String> {
    verify_checkpoint(worktree, checkpoint, true)
}

/// An originating gateway must check the stopped workspace, not simply
/// trust the worker's claimed checkpoint or account for dirty input as saved.
pub fn verify_stopped(worktree: &std::path::Path, checkpoint: &Checkpoint, _task: &str, _generation: u64) -> Result<(), String> {
    verify_checkpoint(worktree, checkpoint, false)
}

fn verify_checkpoint(worktree: &std::path::Path, checkpoint: &Checkpoint, checkout: bool) -> Result<(), String> {
    use std::process::Command;
    let sha = |value: &str| value.len() == 40 && value.bytes().all(|c| c.is_ascii_hexdigit());
    if !sha(&checkpoint.commit) || !sha(&checkpoint.tree) {
        return Err("checkpoint does not identify exact commit and tree".into());
    }
    let git = |args: &[&str]| -> Result<String, String> {
        let mut cmd = Command::new("git");
        cmd.current_dir(worktree).env("GIT_TERMINAL_PROMPT", "0")
            .args(["-c", "core.hooksPath=/dev/null", "--no-replace-objects"]).args(args);
        let out = crate::dispatch::run_with_timeout(cmd, 30)?;
        if !out.status.success() { return Err(format!("checkpoint Git {} failed", args[0])); }
        String::from_utf8(out.stdout).map_err(|_| "invalid checkpoint Git output".into())
    };
    let origin = git(&["remote", "get-url", "origin"])?;
    if origin.trim().trim_end_matches(".git") != checkpoint.repo.trim_end_matches(".git") {
        return Err("checkpoint repository differs from the provisioned origin".into());
    }
    if checkout {
        // The worktree shares the repository cache's object store: the local
        // commit is already present — never fetched from origin.
        git(&["cat-file", "-e", &format!("{}^{{commit}}", checkpoint.commit)])?;
    } else {
        if !git(&["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])?.is_empty() {
            return Err("stopped workspace has unpublished changes; retain it".into());
        }
        crate::dispatch::assert_no_unpreserved_checkpoint_inputs(worktree)?;
    }
    if git(&["rev-parse", "--verify", &format!("{}^{{tree}}", checkpoint.commit)])?.trim() != checkpoint.tree {
        return Err("checkpoint tree differs from the recorded tree".into());
    }
    if checkout { git(&["checkout", "--detach", &checkpoint.commit])?; }
    if git(&["rev-parse", "--verify", "HEAD"])?.trim() != checkpoint.commit {
        return Err("restored checkout does not match the recorded commit".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use std::{path::{Path, PathBuf}, process::Command};

    fn git(path: &Path, args: &[&str]) -> Result<(), String> {
        let output = Command::new("git").current_dir(path).args(args).output().map_err(|e| e.to_string())?;
        if output.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&output.stderr).into_owned()) }
    }
    pub(crate) fn init(root: &Path) -> PathBuf {
        let remote = root.join("remote.git");
        git(root, &["init", "--bare", remote.to_str().unwrap()]).unwrap();
        let source = root.join("source");
        git(root, &["clone", remote.to_str().unwrap(), source.to_str().unwrap()]).unwrap();
        let key = root.join("signing");
        assert!(Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f", key.to_str().unwrap()]).status().unwrap().success());
        for (k, v) in [("user.name", "Checkpoint test"), ("user.email", "checkpoint@example.test"), ("gpg.format", "ssh"), ("user.signingkey", key.to_str().unwrap()), ("gpg.ssh.program", "/usr/bin/ssh-keygen")] {
            git(&source, &["config", "--local", k, v]).unwrap();
        }
        std::fs::write(source.join("tracked"), "base\n").unwrap();
        git(&source, &["add", "--", "tracked"]).unwrap();
        git(&source, &["commit", "-m", "base"]).unwrap();
        git(&source, &["push", "origin", "HEAD"]).unwrap();
        source
    }

    #[test]
    fn restore_checks_exact_repo_generation_commit_and_tree_before_checkout() {
        let temp = tempfile::tempdir().unwrap();
        let source = init(temp.path());
        let repo = temp.path().join("remote.git").to_string_lossy().into_owned();
        let read = |path: &Path, args: &[&str]| String::from_utf8(Command::new("git")
            .current_dir(path).args(args).output().unwrap().stdout).unwrap().trim().to_owned();
        let base = read(&source, &["rev-parse", "HEAD"]);
        std::fs::write(source.join("tracked"), "checkpoint\n").unwrap();
        git(&source, &["commit", "-am", "checkpoint"]).unwrap();
        let commit = read(&source, &["rev-parse", "HEAD"]);
        let tree = read(&source, &["rev-parse", "HEAD^{tree}"]);
        let dest = temp.path().join("dest");
        git(temp.path(), &["clone", &repo, dest.to_str().unwrap()]).unwrap();
        // BR#14525: a checkpoint is a LOCAL commit — the destination clone must
        // already hold the object (shared repository cache), never a fetched
        // origin ref. The wrong-repo and wrong-tree cases still refuse.
        let cp = super::Checkpoint { repo: repo.clone(), commit, tree,
            base: base.clone(), environment: vec![], next: "Resume".into(), tests: vec![] };
        for wrong in [
            super::Checkpoint { repo: "https://example.invalid/wrong.git".into(), ..cp.clone() },
            super::Checkpoint { tree: "f".repeat(40), ..cp.clone() },
            super::Checkpoint { commit: base.clone(), ..cp.clone() },
        ] {
            assert!(super::restore(&dest, &wrong, "BR#42", 7).is_err());
            assert_eq!(read(&dest, &["rev-parse", "HEAD"]), base);
        }
        // The commit exists locally only after the clone carries it: push the
        // branch to origin, clone again — the object is in the new clone's
        // store without any ref magic, mirroring the shared cache.
        git(&source, &["push", "origin", "HEAD:refs/heads/main-force"]).unwrap();
        let dest2 = temp.path().join("dest2");
        git(temp.path(), &["clone", &repo, dest2.to_str().unwrap()]).unwrap();
        git(&dest2, &["fetch", "origin"]).unwrap();
        super::restore(&dest2, &cp, "BR#42", 7).unwrap();
        assert_eq!(read(&dest2, &["rev-parse", "HEAD"]), cp.commit);
        assert_eq!(std::fs::read_to_string(dest2.join("tracked")).unwrap(), "checkpoint\n");
    }
}
