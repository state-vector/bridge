fn main() {
    println!("cargo:rerun-if-env-changed=BRIDGE_BUILD_COMMIT");
    for name in ["HEAD".to_string(), "packed-refs".to_string()].into_iter().chain(
        std::process::Command::new("git").args(["symbolic-ref", "-q", "HEAD"]).output().ok()
            .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    ) {
        if let Ok(output) = std::process::Command::new("git").args(["rev-parse", "--git-path", &name]).output() {
            if output.status.success() { println!("cargo:rerun-if-changed={}", String::from_utf8_lossy(&output.stdout).trim()); }
        }
    }
    let sha = std::env::var("BRIDGE_BUILD_COMMIT").ok().or_else(|| {
        std::process::Command::new("git").args(["rev-parse", "HEAD"]).output().ok()
            .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    }).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=BRIDGE_BUILD_COMMIT={sha}");
}
