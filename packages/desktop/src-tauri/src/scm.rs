//! Source-control abstraction: forge-specific URL grammar and PR semantics
//! behind one trait. The hub treats repos as opaque strings and receipts as
//! URLs; only the gateway executes on them (clone cache, worktrees, PR
//! detection at finalize), so per-forge behaviour lives here. A forge the
//! registry doesn't know falls through to `GenericGit`: clone/branch/worktree
//! semantics only, no pull requests — a PR-receipt task on an unknown forge
//! resolves to no repo ref and is refused loudly at the gate, never guessed.

/// Repo + number + cleaned URL for a pull request. `repo_url`/`number` are the
/// coordinates `checkout_pr`-style gateway work (planned) will execute on.
#[allow(dead_code)]
pub struct PullRef {
    pub repo_url: String,
    pub number: u64,
    pub url: String,
}

pub trait SourceControl: Send + Sync {
    /// Whether this forge owns the given URL/reference shape.
    fn handles(&self, url: &str) -> bool;
    /// Normalize any page URL (pull/N, commit/<sha>, blob/tree, issues) to its
    /// owning repository clone URL. None = not a resolvable repo reference.
    fn repo_ref(&self, url: &str) -> Option<String>;
    /// Parse a pull-request URL into its repo, number, and cleaned URL.
    fn pull_ref(&self, url: &str) -> Option<PullRef>;
}

/// Strip trailing punctuation picked up from prose ("…/pull/2129, merged"),
/// and a trailing .git where allowed.
fn trim_url_edge(s: &str, git: bool) -> String {
    let s = s
        .trim_end_matches(|c: char| matches!(c, ',' | '.' | ';' | ')' | ']' | '>' | '!' | '?' | '"' | '\''))
        .trim_end_matches('/');
    let s = if git { s.trim_end_matches(".git") } else { s };
    s.to_string()
}

fn clean_seg(s: &str, dots: bool) -> String {
    s.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_' && !(dots && c == '.'))
        .trim_end_matches(".git")
        .to_string()
}

pub struct GitHub;

impl SourceControl for GitHub {
    fn handles(&self, url: &str) -> bool {
        url.starts_with("https://github.com/") || url.starts_with("git@github.com:")
    }
    fn repo_ref(&self, url: &str) -> Option<String> {
        if let Some(rest) = url.strip_prefix("git@github.com:") {
            let mut segs = rest.split(':').next()?.split('/');
            let owner = clean_seg(segs.next()?, false);
            let repo = clean_seg(segs.next()?, true);
            return (!owner.is_empty() && !repo.is_empty())
                .then(|| format!("git@github.com:{owner}/{repo}"));
        }
        let host = trim_url_edge(url.strip_prefix("https://github.com/")?, false);
        let mut segs = host.split('/');
        let owner = clean_seg(segs.next()?, false);
        let repo = clean_seg(segs.next()?, true);
        (!owner.is_empty() && !repo.is_empty()).then(|| format!("https://github.com/{owner}/{repo}"))
    }
    fn pull_ref(&self, url: &str) -> Option<PullRef> {
        let cleaned = trim_url_edge(url.split_whitespace().next()?, false);
        let rest = cleaned.strip_prefix("https://github.com/")?;
        let mut segs = rest.split('/');
        let owner = clean_seg(segs.next()?, false);
        let repo = clean_seg(segs.next()?, true);
        match (segs.next()?, segs.next()?) {
            ("pull", n) => {
                let number: u64 = n.parse().ok()?;
                Some(PullRef {
                    repo_url: format!("https://github.com/{owner}/{repo}"),
                    number,
                    url: cleaned,
                })
            }
            _ => None,
        }
    }
}

/// Fallback for every non-GitHub git remote: full clone URLs only. PR
/// semantics are forge-specific and unknowable here, so `pull_ref` is None —
/// never guessed.
pub struct GenericGit;

impl SourceControl for GenericGit {
    fn handles(&self, _url: &str) -> bool {
        true
    }
    fn repo_ref(&self, url: &str) -> Option<String> {
        if url.starts_with("git@") {
            let cleaned = trim_url_edge(url, true);
            return (!cleaned.is_empty()).then_some(cleaned);
        }
        if url.ends_with(".git") {
            let cleaned = trim_url_edge(url, true);
            return (!cleaned.is_empty()).then_some(cleaned);
        }
        None
    }
    fn pull_ref(&self, _url: &str) -> Option<PullRef> {
        None
    }
}

/// Registry, tried in order. `GenericGit` claims everything and must stay last.
pub fn forge_for(url: &str) -> Option<&'static dyn SourceControl> {
    const FORGES: &[&dyn SourceControl] = &[&GitHub, &GenericGit];
    FORGES.iter().copied().find(|f| f.handles(url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_receipt_urls_resolve_to_repo() {
        let gh = &GitHub as &dyn SourceControl;
        for url in [
            "https://github.com/state-vector/bridge/pull/16",
            "https://github.com/state-vector/bridge/pull/71,",
            "https://github.com/state-vector/bridge/commit/692fc504c",
            "https://github.com/state-vector/bridge/blob/main/x.ts",
            "https://github.com/state-vector/bridge/issues/9",
            "https://github.com/state-vector/bridge",
        ] {
            assert_eq!(
                gh.repo_ref(url).as_deref(),
                Some("https://github.com/state-vector/bridge"),
                "{url}"
            );
        }
    }

    #[test]
    fn github_pull_parse() {
        let gh = &GitHub as &dyn SourceControl;
        let p = gh.pull_ref("https://github.com/o/r/pull/2129,").unwrap();
        assert_eq!(p.repo_url, "https://github.com/o/r");
        assert_eq!(p.number, 2129);
        assert_eq!(p.url, "https://github.com/o/r/pull/2129");
        assert!(gh.pull_ref("https://github.com/o/r/pulls").is_none());
    }

    #[test]
    fn generic_git_never_invents_prs() {
        let g = &GenericGit as &dyn SourceControl;
        assert_eq!(g.repo_ref("https://gitlab.com/g/r.git").as_deref(), Some("https://gitlab.com/g/r"));
        assert!(g.repo_ref("https://gitlab.com/g/r").is_none());
        assert!(g.pull_ref("https://gitlab.com/g/r/-/merge_requests/1").is_none());
    }

    #[test]
    fn gist_is_not_a_repo() {
        assert!(forge_for("https://gist.github.com/user/abc123")
            .and_then(|f| f.repo_ref("https://gist.github.com/user/abc123"))
            .is_none());
    }
}
