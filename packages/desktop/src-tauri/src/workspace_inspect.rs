//! Local inspection is authorized by OS access to the workspace owner's
//! registry and files, not by a remote MCP caller or a supplied directory.
use super::{run_with_output_limit, workspace, worktree_registry_load, DispatchConfig};
use serde_json::{json, Value};
use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::{
    fd::{AsRawFd, FromRawFd},
    unix::ffi::OsStrExt,
};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};

const FILE_LIMIT: u64 = 64 * 1024;
const OUTPUT_LIMIT: u64 = 3 * FILE_LIMIT;

pub(super) fn inspect(
    home: &Path,
    cfg: Option<&DispatchConfig>,
    task: &str,
    file: Option<&str>,
) -> Result<Value, String> {
    let digits = task.strip_prefix("BR#").unwrap_or("");
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err("expected a task ID such as BR#123".into());
    }
    let paths = match cfg.filter(|cfg| cfg.label.is_some()) {
        Some(cfg) => workspace::Owner::inspection_paths(cfg, task)?,
        None => vec![],
    };
    // Prefer the current managed owner. Interactive registrations may
    // survive claim changes and are only fallback local evidence.
    let paths = if paths.is_empty() {
        worktree_registry_load(home)
            .into_iter()
            .filter(|entry| entry.task == task)
            .map(|entry| PathBuf::from(entry.path))
            .collect()
    } else {
        paths
    };
    let root = select_root(paths)?;
    snapshot(&root, task, file)
}

fn select_root(paths: Vec<PathBuf>) -> Result<PathBuf, String> {
    let mut roots = paths
        .into_iter()
        .filter(|p| p.is_absolute() && fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()))
        .filter_map(|p| p.canonicalize().ok())
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    match roots.len() {
        0 => Err("no registered worktree for this task on this host".into()),
        1 => Ok(roots.remove(0)),
        _ => Err("multiple registered worktrees for this task; inspection cannot identify a unique workspace".into()),
    }
}

fn git(root: &Path, args: &[&str], limit: u64) -> Result<Output, String> {
    let mut cmd = Command::new("/usr/bin/git");
    cmd.current_dir(root)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_NO_LAZY_FETCH", "1")
        .args([
            "--no-optional-locks",
            "--no-replace-objects",
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args);
    run_with_output_limit(cmd, 2, limit)
}

fn output(out: Output) -> Result<String, String> {
    if !out.status.success() {
        return Err("could not read registered Git evidence".into());
    }
    String::from_utf8(out.stdout).map_err(|_| "inspection supports UTF-8 text only".into())
}

fn snapshot(root: &Path, task: &str, file: Option<&str>) -> Result<Value, String> {
    // Never discover a repository by walking up from an arbitrary directory.
    let dot_git = fs::symlink_metadata(root.join(".git"))
        .map_err(|_| "registered directory is not a worktree")?;
    if !dot_git.is_file() && !dot_git.is_dir() {
        return Err("invalid worktree Git metadata".into());
    }
    let top = output(git(root, &["rev-parse", "--show-toplevel"], 8192)?)?;
    if Path::new(top.trim_end_matches('\n')) != root {
        return Err("registered path is not the Git worktree root".into());
    }
    let head = output(git(root, &["rev-parse", "--verify", "HEAD^{commit}"], 128)?)?;
    let head = head.trim_end();
    let mut result = json!({"task_id": task, "committed": {"head": head}});
    if let Some(file) = file {
        result["live_wip"] = inspect_file(root, head, file)?;
    }
    Ok(result)
}

fn inspect_file(root: &Path, head: &str, file: &str) -> Result<Value, String> {
    let path = Path::new(file);
    if file.is_empty()
        || file.len() > 4096
        || file.contains(['\n', '\r'])
        || file
            .split('/')
            .any(|p| p.is_empty() || matches!(p, "." | "..") || p.eq_ignore_ascii_case(".git"))
    {
        return Err("expected a worktree-relative tracked file path".into());
    }
    let tree = output(git(root, &["ls-tree", "-z", head, "--", file], 8192)?)?;
    let before = if tree.is_empty() {
        let index = output(git(root, &["ls-files", "--stage", "-z", "--", file], 8192)?)?;
        if !index.split_terminator('\0').any(|entry| {
            entry
                .split_once('\t')
                .is_some_and(|(info, name)| name == file && info.starts_with("100"))
        }) {
            return Err("only regular files tracked in HEAD or the index can be inspected".into());
        }
        None
    } else {
        let (info, name) = tree
            .trim_end_matches('\0')
            .split_once('\t')
            .ok_or("invalid Git tree entry")?;
        let oid = info.split_whitespace().nth(2).ok_or("missing Git blob")?;
        if name != file || !info.starts_with("100") {
            return Err("only tracked regular files can be inspected".into());
        }
        let size = output(git(root, &["cat-file", "-s", oid], 128)?)?;
        if size
            .trim()
            .parse::<u64>()
            .map_err(|_| "invalid Git blob size")?
            > FILE_LIMIT
        {
            return Err("committed file exceeds 64 KiB".into());
        }
        Some(output(git(root, &["cat-file", "blob", oid], FILE_LIMIT)?)?)
    };
    let after = read_regular(root, path)?;
    if before
        .iter()
        .chain(after.iter())
        .any(|text| text.contains('\0'))
    {
        return Err("inspection supports text files only".into());
    }
    // Diff snapshots in scratch space, not in the workspace. No Git diff,
    // checkout, status, clean filters, hooks, or textconv touch the live file.
    let tmp = tempfile::tempdir_in("/tmp").map_err(|e| e.to_string())?;
    let old = tmp.path().join("committed");
    let new = tmp.path().join("live");
    fs::write(&old, before.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
    fs::write(&new, after.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
    let mut diff = Command::new("/usr/bin/diff");
    diff.env_clear()
        .env("LC_ALL", "C")
        .args(["-u", "-L", "HEAD", "-L", "live WIP"])
        .arg(old)
        .arg(new);
    let patch = run_with_output_limit(diff, 2, OUTPUT_LIMIT)?;
    if !matches!(patch.status.code(), Some(0 | 1)) {
        return Err("could not compare file snapshots".into());
    }
    Ok(
        json!({"file": file, "head_present": before.is_some(), "live_present": after.is_some(),
        "patch": String::from_utf8(patch.stdout).map_err(|_| "inspection supports UTF-8 text only")?}),
    )
}

// Open each component relative to its already-open parent: a concurrent
// rename or symlink swap cannot make a live read follow an outside path.
fn read_regular(root: &Path, path: &Path) -> Result<Option<String>, String> {
    let mut dir = File::open(root).map_err(|e| e.to_string())?;
    let mut components = path.components().peekable();
    while let Some(Component::Normal(name)) = components.next() {
        let last = components.peek().is_none();
        let name = CString::new(name.as_bytes()).map_err(|_| "invalid file path")?;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if last { 0 } else { libc::O_DIRECTORY };
        let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(format!(
                "could not open live file without following symlinks: {error}"
            ));
        }
        let opened = unsafe { File::from_raw_fd(fd) };
        if !last {
            dir = opened;
            continue;
        }
        if !opened.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("live path is not a regular file".into());
        }
        let mut bytes = vec![];
        opened
            .take(FILE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > FILE_LIMIT {
            return Err("live file exceeds 64 KiB".into());
        }
        return String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "inspection supports UTF-8 text only".into());
    }
    Err("expected a worktree-relative tracked file path".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn setup_git(path: &Path, args: &[&str]) {
        let out = Command::new("/usr/bin/git")
            .current_dir(path)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.org",
                "-c",
                "commit.gpgSign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn inspection_is_scoped_to_registered_tracked_files_and_does_not_run_filters() {
        let scratch = tempfile::tempdir().unwrap();
        let home = scratch.path();
        let repo = home.join("repo");
        fs::create_dir(&repo).unwrap();
        setup_git(&repo, &["init"]);
        fs::write(repo.join("tracked"), "committed\n").unwrap();
        setup_git(&repo, &["add", "tracked"]);
        setup_git(&repo, &["commit", "-m", "fixture"]);
        let worker = home.join("worker");
        setup_git(
            &repo,
            &["worktree", "add", "--detach", worker.to_str().unwrap()],
        );
        let worker = worker.canonicalize().unwrap();
        fs::write(worker.join("tracked"), "live edit\n").unwrap();
        fs::write(worker.join("untracked"), "do not expose\n").unwrap();
        fs::create_dir(home.join(".bridge")).unwrap();
        let reg = json!({"path": worker, "repo": "test/repo", "task": "BR#42", "ts": 0});
        fs::write(
            home.join(".bridge/worktree-registry.jsonl"),
            format!("{reg}\n{reg}\n"),
        )
        .unwrap();
        setup_git(
            &repo,
            &["config", "filter.probe.clean", "touch filter-ran; cat"],
        );
        fs::write(worker.join(".gitattributes"), "tracked filter=probe\n").unwrap();

        let result = inspect(home, None, "BR#42", Some("tracked")).unwrap();
        assert_eq!(result["committed"]["head"].as_str().unwrap().len(), 40);
        let patch = result["live_wip"]["patch"].as_str().unwrap();
        assert!(patch.contains("-committed\n+live edit\n"));
        assert!(!worker.join("filter-ran").exists());
        assert_eq!(
            fs::read_to_string(worker.join("tracked")).unwrap(),
            "live edit\n"
        );
        for file in ["untracked", "../repo/tracked", ".git", "/etc/passwd"] {
            assert!(inspect(home, None, "BR#42", Some(file)).is_err());
        }
        assert!(inspect(home, None, "BR#43", Some("tracked")).is_err());
        assert!(select_root(vec![worker.clone(), repo])
            .unwrap_err()
            .contains("multiple"));

        fs::remove_file(worker.join("tracked")).unwrap();
        assert_eq!(
            inspect(home, None, "BR#42", Some("tracked")).unwrap()["live_wip"]["live_present"],
            false
        );
        symlink(worker.join("untracked"), worker.join("tracked")).unwrap();
        assert!(inspect(home, None, "BR#42", Some("tracked")).is_err());
    }
}
