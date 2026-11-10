//! Legacy Git checkpoint metadata retained for reading existing journals.
use serde::{Deserialize, Serialize};

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
}
