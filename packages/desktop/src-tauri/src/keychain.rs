//! Gateway-token at rest (credential-class ADR, desktop gateway leg —
//! BR#2674). The secret NEVER lands in config.json, never crosses to the
//! webview/JS/UI, and never appears in logs — Rust is the only reader, and
//! the UI only ever sees a boolean.
//!
//! Store precedence (macOS), per Ray 2026-10-23 ("securely store creds
//! without needing general access to my login keychain"):
//!   1. the DATA PROTECTION keychain (kSecUseDataProtectionKeychain) — the
//!      iOS-style per-app store; NOT the user's login keychain, no ACL
//!      prompts, access scoped to this binary's code identity. Requires the
//!      binary to be signed with keychain access — true for the bundled,
//!      signed app.
//!   2. unsigned dev/test binaries cannot hold data protection items
//!      (errSecMissingEntitlement), so they fall back to a 0600 file under
//!      ~/.bridge — dev machines only, the fallback announces itself in the
//!      log once per process.
//! Non-macOS targets: the same 0600 file.
//! A missing entry is an empty token, not an error; all ops are best-effort
//! Results. The keychain item is deleted only when the credential is provably
//! dead (hub 401 / wrong class) — UI logout keeps it (re-vend at next login).

/// errSecMissingEntitlement — unsigned binary, no data protection access
const ERR_MISSING_ENTITLEMENT: i32 = -34018;

/// 0600-file fallback under ~/.bridge — shared by non-macOS targets and by
/// unsigned dev/test binaries on macOS (never the login keychain).
mod file {
    use std::path::PathBuf;

    fn token_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".bridge").join("gateway-token")
    }

    pub fn save_token(secret: &str) -> Result<(), String> {
        let path = token_path();
        let dir = path.parent().ok_or("no token dir")?.to_path_buf();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(&path, secret).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn load_token() -> Result<String, String> {
        match std::fs::read_to_string(token_path()) {
            Ok(s) => Ok(s.trim().to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete_token() -> Result<(), String> {
        match std::fs::remove_file(token_path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{file, ERR_MISSING_ENTITLEMENT};
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        PasswordOptions,
    };
    use std::sync::atomic::{AtomicBool, Ordering};

    const SERVICE: &str = "bridge-desktop";
    const ACCOUNT: &str = "gateway-token";
    /// errSecItemNotFound — a missing entry is an empty token, not an error
    const ERR_ITEM_NOT_FOUND: i32 = -25300;
    /// sticky: this binary can't hold protected items (signing state is
    /// per-binary, so the answer never changes mid-process)
    static FALLBACK: AtomicBool = AtomicBool::new(false);

    fn options() -> PasswordOptions {
        let mut o = PasswordOptions::new_generic_password(SERVICE, ACCOUNT);
        o.use_protected_keychain();
        o
    }

    pub fn save_token(secret: &str) -> Result<(), String> {
        if FALLBACK.load(Ordering::Relaxed) {
            return file::save_token(secret);
        }
        match set_generic_password_options(secret.as_bytes(), options()) {
            Ok(()) => {
                // the protected store owns the credential now — clear any
                // dev-file token so the two stores never diverge
                let _ = file::delete_token();
                Ok(())
            }
            Err(e) if e.code() == ERR_MISSING_ENTITLEMENT => {
                FALLBACK.store(true, Ordering::Relaxed);
                crate::logging::emit("keychain", None, "unsigned binary — data protection keychain unavailable, using ~/.bridge/gateway-token (0600)");
                file::save_token(secret)
            }
            Err(e) => Err(format!("keychain write failed: {e}")),
        }
    }

    pub fn load_token() -> Result<String, String> {
        if FALLBACK.load(Ordering::Relaxed) {
            return file::load_token();
        }
        match generic_password(options()) {
            Ok(bytes) => {
                String::from_utf8(bytes).map_err(|e| format!("keychain read failed: {e}"))
            }
            // not in the protected store → adopt the dev-file token if one
            // exists (same machine, same user, same gateway class)
            Err(e) if e.code() == ERR_ITEM_NOT_FOUND => file::load_token(),
            Err(e) if e.code() == ERR_MISSING_ENTITLEMENT => {
                FALLBACK.store(true, Ordering::Relaxed);
                file::load_token()
            }
            Err(e) => Err(format!("keychain read failed: {e}")),
        }
    }

    pub fn delete_token() -> Result<(), String> {
        // clear BOTH stores — a stale token in either is a dead credential
        let protected = match delete_generic_password_options(options()) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_ITEM_NOT_FOUND => Ok(()),
            Err(e) if e.code() == ERR_MISSING_ENTITLEMENT => {
                FALLBACK.store(true, Ordering::Relaxed);
                Ok(())
            }
            Err(e) => Err(format!("keychain delete failed: {e}")),
        };
        file::delete_token()?;
        protected
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub use super::file::{delete_token, load_token, save_token};
}

pub fn save_token(secret: &str) -> Result<(), String> {
    imp::save_token(secret)
}

/// Empty string = no provisioned token (awaiting the next login).
pub fn load_token() -> Result<String, String> {
    imp::load_token()
}

/// Used only when the credential is provably dead (hub 401 / wrong class) —
/// UI logout KEEPS the credential (the gateway survives logout; re-vend at
/// the next login replaces it).
pub fn delete_token() -> Result<(), String> {
    imp::delete_token()
}

/// Serializes every test that touches the real persistent token store
/// (this module's round-trip + store.rs's real-store tests) — the default
/// test harness runs them in parallel otherwise.
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_round_trips_and_deletes() {
        // real store — protected keychain on signed builds, the 0600 file
        // fallback on unsigned dev binaries; exercises the exact paths
        // production uses
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // snapshot/restore: a dev machine may hold a live CLI token in the
        // fallback file — the test must never wipe a real credential
        let saved = load_token().unwrap_or_default();
        save_token("bkw_test_secret").expect("save");
        assert_eq!(load_token().expect("load"), "bkw_test_secret");
        // overwrite = rotate-in-place (same entry, no accumulation)
        save_token("bkw_rotated").expect("save 2");
        assert_eq!(load_token().expect("load 2"), "bkw_rotated");
        delete_token().expect("delete");
        assert_eq!(load_token().expect("load after delete"), "");
        // deleting an absent entry is idempotent
        delete_token().expect("delete again");
        if !saved.is_empty() {
            save_token(&saved).expect("restore real token");
        }
    }
}
