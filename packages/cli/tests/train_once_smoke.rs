//! `bridge train --once` smoke test (BR#3879): the native executor must run
//! with ZERO Node present and fail LOUD when it cannot reach a hub — a named
//! preflight failure (gh/git/workdir/method) or the named missing-config
//! error, never a silent zero.

use std::process::Command;

#[test]
fn train_once_without_hub_config_exits_nonzero_and_names_the_cause() {
    let out = Command::new(env!("CARGO_BIN_EXE_bridge"))
        .args(["train", "--once"])
        // the executor's config is env-only (BRIDGE_URL/BRIDGE_TOKEN); strip
        // both so the tick fails loud instead of calling a real hub
        .env_remove("BRIDGE_URL")
        .env_remove("BRIDGE_TOKEN")
        .output()
        .expect("bridge binary runs");
    assert!(
        !out.status.success(),
        "train --once without hub config must exit non-zero (got {})",
        out.status
    );
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    // two honest loud failures are acceptable, both name the fix:
    //  - "preflight failed: …"  (gh/git not usable in this environment)
    //  - "BRIDGE_URL / BRIDGE_TOKEN not set — run `bridge doctor`, export both, retry"
    assert!(
        text.contains("preflight failed") || text.contains("BRIDGE_URL"),
        "expected a named failure, got: {text}"
    );
}
