//! Gateway-token at rest (credential-class ADR, desktop gateway leg —
//! BR#2674). The secret lives in the OS keychain; it NEVER lands in
//! config.json, never crosses to the webview/JS/UI, and never appears in
//! logs — Rust is the only reader, and the UI only ever sees a boolean.
//!
//! Platform split: macOS (the desktop app) uses the Login keychain via
//! `keyring`; other targets (the headless CLI vendor of dispatch.rs, ADR
//! leg 2) use a dedicated 0600 file under ~/.bridge — still isolated from
//! the settings file and from anything the UI can read. All operations are
//! best-effort Results: a missing entry is an empty token, not an error.

#[cfg(target_os = "macos")]
mod imp {
    use keyring::Entry;

    const SERVICE: &str = "bridge-desktop";
    const ACCOUNT: &str = "gateway-token";

    fn entry() -> Result<Entry, String> {
        Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keychain unavailable: {e}"))
    }

    pub fn save_token(secret: &str) -> Result<(), String> {
        entry()?
            .set_password(secret)
            .map_err(|e| format!("keychain write failed: {e}"))
    }

    pub fn load_token() -> Result<String, String> {
        match entry()?.get_password() {
            Ok(s) => Ok(s),
            Err(keyring::Error::NoEntry) => Ok(String::new()),
            Err(e) => Err(format!("keychain read failed: {e}")),
        }
    }

    pub fn delete_token() -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keychain delete failed: {e}")),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_round_trips_and_deletes() {
        // real keychain/file store — exercises the exact paths production uses
        save_token("bkw_test_secret").expect("save");
        assert_eq!(load_token().expect("load"), "bkw_test_secret");
        // overwrite = rotate-in-place (same entry, no accumulation)
        save_token("bkw_rotated").expect("save 2");
        assert_eq!(load_token().expect("load 2"), "bkw_rotated");
        delete_token().expect("delete");
        assert_eq!(load_token().expect("load after delete"), "");
        // deleting an absent entry is idempotent
        delete_token().expect("delete again");
    }
}
