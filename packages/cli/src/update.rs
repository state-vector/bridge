//! Installation/configuration only. The updater runs independently of the
//! replaceable runner so a bad candidate cannot destroy its rollback executor.
use crate::dispatch::{AutoUpdateConfig, DispatchConfig, UpdateChannel};
use std::{path::PathBuf, process::Command};

pub fn command(args: &[String]) -> Result<(), String> {
    let home = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?);
    match args.first().map(String::as_str).unwrap_or("status") {
        "enable" | "disable" => {
            let mut cfg = DispatchConfig::resolve().ok_or("pair/configure the runner first")?;
            let enabled = args[0] == "enable";
            let channel = match args.get(1).map(String::as_str).unwrap_or("main") {
                "main" => UpdateChannel::Main, "stable" => UpdateChannel::Stable, "pinned" => UpdateChannel::Pinned,
                _ => return Err("channel must be main, stable or pinned".into()),
            };
            cfg.auto_update = Some(AutoUpdateConfig { enabled, channel });
            cfg.save()?;
            println!("auto_update saved; {}", if enabled { "explicit opt-in enabled (install/start the updater service separately)" } else { "disabled; no new downloads or updates" });
        }
        "status" => {
            let cfg = DispatchConfig::resolve().ok_or("no config")?;
            println!("{}", serde_json::json!({"config":cfg.auto_update,"state":std::fs::read_to_string(home.join(".bridge/update/state.json")).ok().and_then(|v|serde_json::from_str::<serde_json::Value>(&v).ok())}));
        }
        "install" => {
            if !cfg!(target_os = "linux") { return Err("automatic installation currently requires Linux/systemd".into()); }
            if !Command::new("python3").arg("--version").status().map(|s|s.success()).unwrap_or(false) { return Err("install Python 3.10+ first".into()); }
            let bin = std::env::current_exe().map_err(|e|e.to_string())?;
            let root = home.join(".bridge/update");
            std::fs::create_dir_all(&root).map_err(|e|e.to_string())?;
            let script = root.join("supervisor.py");
            std::fs::write(&script, include_str!("../updater/supervisor.py")).map_err(|e|e.to_string())?;
            let units = home.join(".config/systemd/user");
            std::fs::create_dir_all(&units).map_err(|e|e.to_string())?;
            let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into());
            std::fs::write(units.join("bridge-update.service"), format!("[Unit]\nDescription=Bridge opt-in update supervisor\nAfter=network-online.target\n\n[Service]\nExecStart=/usr/bin/python3 \"{}\" --bin \"{}\"\nEnvironment=\"PATH={}\"\nEnvironmentFile=-%h/.bridge/env\nWorkingDirectory=%h\nRestart=on-failure\nRestartSec=30\n\n[Install]\nWantedBy=default.target\n", script.display(), bin.display(), path)).map_err(|e|e.to_string())?;
            let dropins = units.join("bridge.service.d");
            std::fs::create_dir_all(&dropins).map_err(|e|e.to_string())?;
            std::fs::write(dropins.join("update.conf"), "[Service]\nEnvironment=BRIDGE_MANAGED_UPDATES=1\n").map_err(|e|e.to_string())?;
            println!("Installed updater (did NOT enable config or start/restart services).\nRun bridge service install if needed, then: systemctl --user daemon-reload\nEnable opt-in: bridge update enable main\nOnce existing work is safely idle: systemctl --user enable --now bridge bridge-update");
        }
        _ => return Err("usage: bridge update install | enable main|stable|pinned | disable | status".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_opt_in_is_explicit_and_channel_is_closed() {
        let cfg = crate::dispatch::default_config();
        assert!(cfg.auto_update.is_none());
        let mut value = serde_json::to_value(cfg).unwrap();
        value["auto_update"] = serde_json::json!({"channel":"main"});
        let parsed: DispatchConfig = serde_json::from_value(value.clone()).unwrap();
        assert!(!parsed.auto_update.unwrap().enabled);
        value["auto_update"] = serde_json::json!({"enabled":true,"channel":"made-up"});
        assert!(serde_json::from_value::<DispatchConfig>(value).is_err());
    }
}
