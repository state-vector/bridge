//! Single-owner credential/config store (BR#2840).
//!
//! One module owns ALL persistent runner state. Before this, seven code
//! paths wrote `~/.bridge/config.json` in different partial shapes with no
//! schema, no validation and no atomic write — the login token vanished
//! three times in one day because of it. Laws enforced here:
//!
//! 1. **Token**: OS keychain (crate::keychain) — `config.json` never holds
//!    the token. `rotate()` updates the persistent store AND the in-memory
//!    config in one call, so the stale-token window after a re-vend is
//!    structurally impossible.
//! 2. **Principal is write-once**: `~/.bridge/principal` (0600), minted by
//!    the hub on first provision, adopted here exactly once, re-written in
//!    exactly one place when the hub rotates it. Never regenerated
//!    client-side; `bridge reset-principal` is the only local clear.
//! 3. **Config has one writer**: `save_config()` serializes the full
//!    versioned struct, writes a temp file, fsyncs, renames atomically and
//!    chmods 0600. A crash at ANY point leaves the previous file intact —
//!    a partial file can never appear at `config.json`. No other code
//!    writes config.json (a source guard test enforces this).
//! 4. Legacy migration rides the load paths: a plaintext `token` field
//!    moves to the keychain once; a `principal` field inside config.json
//!    moves to its own file once; the next save writes the clean shape.

use std::path::{Path, PathBuf};

use crate::dispatch::DispatchConfig;

/// Current config shape. Bump on any breaking change to the serialized
/// struct; loaders warn loudly on files from the future.
pub const CONFIG_SCHEMA_VERSION: u64 = 2;

pub struct TokenStore {
    root: PathBuf,
}

impl TokenStore {
    /// The production store at `~/.bridge`.
    pub fn open() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        Self { root: PathBuf::from(home).join(".bridge") }
    }

    /// Store rooted elsewhere — tests and tooling.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn from_root(root: PathBuf) -> Self {
        Self { root }
    }

    fn config_path(&self) -> PathBuf {
        self.root.join("config.json")
    }

    fn principal_path(&self) -> PathBuf {
        self.root.join("principal")
    }

    // ------------------------------------------------------------------
    // config: the single writer
    // ------------------------------------------------------------------

    /// THE only writer of config.json: full versioned struct, atomic
    /// temp+rename, 0600. Every caller (pairing, self-provision, settings
    /// apply, CLI onboarding, loop persist) funnels through here.
    pub fn save_config(&self, cfg: &DispatchConfig) -> Result<(), String> {
        let mut out = cfg.clone();
        out.normalize();
        out.schema_version = CONFIG_SCHEMA_VERSION;
        let body = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?;
        self.atomic_write(&self.config_path(), body.as_bytes())?;
        eprintln!("[store] config saved to {}", self.config_path().display());
        Ok(())
    }

    /// Loud parse: a bad config file is an error event, never a silent
    /// None that downstream code mistakes for "first run" (which used to
    /// re-onboard and wipe settings). Also migrates a legacy in-config
    /// principal into its own file eagerly — every load path (doctor,
    /// resolve, loop) converges the state; the stale field itself leaves
    /// config.json on the next save (loads never write).
    pub fn load_config(&self) -> Option<DispatchConfig> {
        let raw = std::fs::read_to_string(self.config_path()).ok()?;
        match serde_json::from_str::<DispatchConfig>(&raw) {
            Ok(mut c) => {
                if c.schema_version > CONFIG_SCHEMA_VERSION {
                    eprintln!(
                        "[store] WARNING: config schema {} is newer than this build knows ({}); update the runner",
                        c.schema_version, CONFIG_SCHEMA_VERSION
                    );
                }
                let _ = self.principal(); // eager one-way legacy migration
                c.normalize();
                Some(c)
            }
            Err(e) => {
                eprintln!("[store] ERROR: config.json is corrupt: {e} — fix or delete {} (settings reset to defaults)", self.config_path().display());
                None
            }
        }
    }

    /// Atomic durable write: temp file in the same directory, fsync, chmod
    /// 0600 BEFORE the rename (never a world-readable window), then the
    /// rename itself — atomic on POSIX, so a crash mid-write leaves the
    /// old file and at worst a stray `.tmp`.
    fn atomic_write(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        use std::io::Write;
        let dir = path.parent().ok_or("no parent dir")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let name = path.file_name().and_then(|n| n.to_str()).ok_or("no file name")?;
        let tmp = dir.join(format!(".{name}.tmp"));
        {
            let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            f.write_all(bytes).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // token: keychain only, rotated store+memory in one call
    // ------------------------------------------------------------------

    /// Current gateway token from the persistent store ("" = not
    /// provisioned). The keychain is the single source of truth.
    pub fn load_token(&self) -> String {
        crate::keychain::load_token().unwrap_or_default()
    }

    /// Rotate: persist the new secret AND update the in-memory config in
    /// one call — the caller's next hub hop uses the new token, so the
    /// post-re-vend 401 window cannot happen. Refuses empty tokens (an
    /// empty rotate is how credentials used to vanish).
    pub fn rotate(&self, cfg: &mut DispatchConfig, token: &str) -> Result<(), String> {
        let t = token.trim();
        if t.is_empty() {
            return Err("rotate: refusing to store an empty token".into());
        }
        crate::keychain::save_token(t)?;
        cfg.token = t.to_string();
        Ok(())
    }

    /// The credential is provably dead (hub 401, wrong class): clear the
    /// persistent copy. UI logout does NOT call this — the gateway
    /// survives logout.
    pub fn clear_token(&self) -> Result<(), String> {
        crate::keychain::delete_token()
    }

    /// Attach the persistent credential to an in-memory config, migrating
    /// a legacy on-disk plaintext token to the keychain on the way (once —
    /// the field is `skip_serializing`, so the next save writes it out).
    pub fn attach_token(&self, cfg: &mut DispatchConfig) {
        if !cfg.token.is_empty() {
            match crate::keychain::save_token(cfg.token.trim()) {
                Ok(()) => eprintln!("[store] migrated gateway token from config.json to the OS keychain"),
                Err(e) => eprintln!("[store] WARNING: keychain migration failed ({e}) — token cleared from config anyway; sign in to re-provision"),
            }
            cfg.token.clear();
        }
        cfg.token = self.load_token();
    }

    // ------------------------------------------------------------------
    // principal: write-once device identity, own file
    // ------------------------------------------------------------------

    /// The machine's stable principal: `~/.bridge/principal` (0600), ""
    /// until the hub mints one. Migrates a legacy config.json `principal`
    /// field into the file on first read (one-way).
    pub fn principal(&self) -> String {
        if let Ok(raw) = std::fs::read_to_string(self.principal_path()) {
            let p = raw.trim();
            if !p.is_empty() {
                return p.to_string();
            }
        }
        // legacy: principal used to live inside config.json
        if let Ok(raw) = std::fs::read_to_string(self.config_path()) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(p) = v.get("principal").and_then(|p| p.as_str()).filter(|p| !p.trim().is_empty()) {
                    let p = p.trim().to_string();
                    if self.write_principal(&p).is_ok() {
                        eprintln!(
                            "[store] migrated principal out of config.json into {}",
                            self.principal_path().display()
                        );
                    }
                    return p;
                }
            }
        }
        String::new() // not yet vended — the hub mints it on first provision
    }

    /// Adopt a hub-vended principal. Write-once: adopting the same value
    /// is a no-op; a DIFFERENT value is a hub-side rotation and rewrites
    /// the one file (the only place principal is ever written). Empty is
    /// ignored — a blank vended principal must never blank the identity.
    pub fn adopt_principal(&self, vended: &str) {
        let p = vended.trim();
        if p.is_empty() {
            return;
        }
        let current = self.principal();
        if current == p {
            return;
        }
        if !current.is_empty() {
            eprintln!("[store] principal rotated by the hub: {current} -> {p}");
        }
        if let Err(e) = self.write_principal(p) {
            eprintln!("[store] ERROR: principal write failed: {e}");
        }
    }

    /// `bridge reset-principal` — the ONLY local clear, for debugging.
    /// Order matters: scrub config.json FIRST (the typed round-trip drops
    /// the legacy field, and the load inside it may migrate that field
    /// into the file), THEN remove the file — no resurrection path.
    #[allow(dead_code)] // CLI-only for now (desktop UI has no reset surface)
    pub fn reset_principal(&self) -> Result<(), String> {
        if let Some(cfg) = self.load_config() {
            self.save_config(&cfg)?; // typed round-trip drops unknown fields
        }
        match std::fs::remove_file(self.principal_path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write_principal(&self, p: &str) -> Result<(), String> {
        self.atomic_write(&self.principal_path(), p.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let uniq = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let d = std::env::temp_dir().join(format!("bridge-store-{tag}-{uniq}"));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The real persistent token store must not be disturbed by tests:
    /// snapshot it, run the closure, restore (or clear if none existed).
    /// Shares its lock with keychain.rs's own round-trip test so parallel
    /// test runs never interleave real-store writes.
    static REAL_TOKEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn guard_real_token<T>(f: impl FnOnce() -> T) -> T {
        let _g = REAL_TOKEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _kg = crate::keychain::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved = crate::keychain::load_token().unwrap_or_default();
        let out = f();
        if saved.is_empty() {
            let _ = crate::keychain::delete_token();
        } else {
            let _ = crate::keychain::save_token(&saved);
        }
        out
    }

    fn sample_cfg(url: &str) -> DispatchConfig {
        let mut c = crate::dispatch::default_config();
        c.url = url.into();
        c
    }

    /// The BR#2840 receipt: write via every writer-shaped path and assert
    /// the file ALWAYS parses with every key present — the shape-drift
    /// class (token key vanishing) is dead.
    #[test]
    fn every_writer_path_produces_parseable_full_config() {
        let root = temp_root("all-paths");
        let store = TokenStore::from_root(root.clone());

        // path 1+2: pairing / self-provision vend credentials
        let mut cfg = sample_cfg("https://hub.example");
        guard_real_token(|| store.rotate(&mut cfg, "bkw_vend_test").expect("rotate"));
        store.save_config(&cfg).expect("save after vend");
        assert_full_config(&root);

        // path 3: principal-ensure (hub vends device credential)
        store.adopt_principal("dev-abc123");
        assert_full_config(&root);

        // path 4: run-loop pairing save / path 5: settings persist /
        // path 6+7: CLI onboarding saves — same store entry point
        let mut re = store.load_config().expect("reload");
        re.poll_secs = 45;
        store.save_config(&re).expect("save settings");
        assert_full_config(&root);

        // reload after EVERY path still round-trips the settings
        let final_cfg = store.load_config().expect("final reload");
        assert_eq!(final_cfg.url, "https://hub.example");
        assert_eq!(final_cfg.poll_secs, 45);
        assert_eq!(final_cfg.schema_version, CONFIG_SCHEMA_VERSION);
        std::fs::remove_dir_all(&root).ok();
    }

    fn assert_full_config(root: &Path) {
        let raw = std::fs::read_to_string(root.join("config.json")).expect("config exists");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("config always parses");
        for key in [
            "url", "workdir", "poll_secs", "timeout_mins", "opencode_bin",
            "max_sessions", "backends", "isolate", "schema_version",
        ] {
            assert!(v.get(key).is_some(), "key {key} missing after write: {raw}");
        }
        assert_eq!(v["schema_version"].as_u64(), Some(CONFIG_SCHEMA_VERSION));
        assert!(v.get("token").is_none(), "token must never be serialized: {raw}");
        assert!(v.get("principal").is_none(), "principal lives in its own file: {raw}");
    }

    /// Crash-safety receipt: SIGKILL a process mid save-loop and the
    /// config at rest is never corrupt — atomic rename means the file is
    /// always the complete previous or complete next version.
    #[cfg(unix)]
    #[test]
    fn sigkill_mid_write_never_corrupts_config() {
        let root = temp_root("sigkill");
        let child_root = root.join("child");
        std::fs::create_dir_all(&child_root).unwrap();
        // env is set on the CHILD process only — the parent's own
        // crash_child_hammer run never sees it (no-op), and the test
        // harness accepts no unknown args.
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("store::tests::crash_child_hammer")
            .env("BRIDGE_STORE_CRASH_CHILD", &child_root)
            .spawn()
            .expect("spawn child");
        std::thread::sleep(std::time::Duration::from_millis(400));
        let pid = child.id() as i32;
        unsafe {
            kill(pid, 9);
        }
        // reap (spawn drops the handle without waiting)
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .ok();
        let raw = std::fs::read_to_string(child_root.join("config.json"))
            .expect("child config exists");
        serde_json::from_str::<serde_json::Value>(&raw).expect("config intact after SIGKILL");
        assert!(raw.contains("schema_version"));
        std::fs::remove_dir_all(&root).ok();
    }

    /// Child leg of the SIGKILL test: hammer save_config forever. A no-op
    /// unless the child env var is present (normal test runs).
    #[test]
    fn crash_child_hammer() {
        let Ok(root) = std::env::var("BRIDGE_STORE_CRASH_CHILD") else { return };
        let store = TokenStore::from_root(PathBuf::from(root));
        let mut n = 0u64;
        loop {
            let mut cfg = sample_cfg("https://child.example");
            cfg.poll_secs = (n % 97) + 1;
            let _ = store.save_config(&cfg);
            n += 1;
        }
    }

    /// Rotation receipt: store AND memory move together — the next hub hop
    /// uses the new token with no stale window.
    #[test]
    fn rotate_updates_store_and_memory_together() {
        let store = TokenStore::open();
        guard_real_token(|| {
            let mut cfg = sample_cfg("https://hub.example");
            store.rotate(&mut cfg, "bkw_new_token").expect("rotate");
            assert_eq!(cfg.token, "bkw_new_token", "in-memory token updated");
            assert_eq!(store.load_token(), "bkw_new_token", "persistent store updated");
            // empty rotate is refused — this is how credentials vanished
            assert!(store.rotate(&mut cfg, "").is_err());
        });
    }

    /// Principal receipt: write-once, single location, legacy migration
    /// out of config.json, reset clears, hub rotation rewrites one place.
    #[test]
    fn principal_write_once_migrates_and_resets() {
        let root = temp_root("principal");
        let store = TokenStore::from_root(root.clone());

        // legacy shape: principal inside config.json
        let legacy = r#"{"url":"https://hub.example","principal":"dev-legacy-1"}"#;
        std::fs::write(root.join("config.json"), legacy).unwrap();

        assert_eq!(store.principal(), "dev-legacy-1", "read migrates legacy field");
        assert_eq!(
            std::fs::read_to_string(root.join("principal")).unwrap().trim(),
            "dev-legacy-1",
            "migrated into its own file"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(root.join("principal")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "principal file is 0600");
        }

        store.adopt_principal("dev-legacy-1"); // same value: no-op
        store.adopt_principal(""); // empty: ignored, never blanks identity
        assert_eq!(store.principal(), "dev-legacy-1");

        store.adopt_principal("dev-rotated-2"); // hub rotation: one place
        assert_eq!(store.principal(), "dev-rotated-2");
        assert_eq!(
            std::fs::read_to_string(root.join("principal")).unwrap().trim(),
            "dev-rotated-2"
        );

        store.reset_principal().expect("reset");
        assert_eq!(store.principal(), "", "legacy field already migrated — stays clear");

        // config.json still parses; next save writes the clean shape
        let cfg = store.load_config().expect("config parses");
        store.save_config(&cfg).expect("save");
        let raw = std::fs::read_to_string(root.join("config.json")).unwrap();
        assert!(!raw.contains("principal"), "principal dropped from config.json on save");
        std::fs::remove_dir_all(&root).ok();
    }

    /// Legacy plaintext token in config migrates to the persistent store
    /// and never round-trips back into the file.
    #[test]
    fn legacy_plaintext_token_migrates_out() {
        let root = temp_root("token-migrate");
        let store = TokenStore::from_root(root.clone());
        guard_real_token(|| {
            let mut cfg = sample_cfg("https://hub.example");
            cfg.token = "bkw_legacy_plaintext".into(); // as deserialized from a legacy file
            store.attach_token(&mut cfg);
            assert_eq!(cfg.token, "bkw_legacy_plaintext", "attached from store");
            assert_eq!(store.load_token(), "bkw_legacy_plaintext", "migrated to the store");
            store.save_config(&cfg).expect("save");
            let raw = std::fs::read_to_string(root.join("config.json")).unwrap();
            assert!(!raw.contains("bkw_legacy_plaintext"), "secret never on disk");
        });
        std::fs::remove_dir_all(&root).ok();
    }

    /// Source guard: the hand-built config write patterns are gone from
    /// dispatch.rs — config.json has exactly one writer and one shape.
    #[test]
    fn no_hand_built_config_writes_remain() {
        let src = include_str!("dispatch.rs");
        assert!(!src.contains("fn config_path"), "config path knowledge belongs to store.rs");
        assert!(
            !src.contains("fs::write(&path"),
            "direct file write pattern in dispatch.rs — route through store.rs"
        );
        assert!(
            !src.contains("from_str::<serde_json::Value>(&std::fs::read_to_string(&path)"),
            "hand-built JSON merge write pattern — route through store.rs"
        );
    }
}

#[cfg(all(test, unix))]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}
