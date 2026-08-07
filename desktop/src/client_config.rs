// Local settings for the desktop shell.
// Stored at: ~/Library/Application Support/openswarm-desktop/config.json (macOS)
//            ~/.config/openswarm-desktop/config.json (Linux)

use atomicwrites::{AtomicFile, OverwriteBehavior};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
pub struct ClientConfig {
    /// Base URL of the OpenSwarm daemon's web server.
    #[serde(default = "default_server_url")]
    pub server_url: String,
    /// Path joined onto the base URL for the main window's first navigation.
    /// Empty for the current dashboard root; a later milestone flips this to
    /// "app" once the desktop-dedicated SPA ships — without a shell rebuild.
    #[serde(default)]
    pub entry_path: String,
}

fn default_server_url() -> String {
    crate::flavor::server_url().to_string()
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            server_url: default_server_url(),
            entry_path: String::new(),
        }
    }
}

fn config_path() -> PathBuf {
    dirs_next::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("openswarm-desktop")
        .join("config.json")
}

pub fn load_config() -> Result<ClientConfig, String> {
    let p = config_path();
    if !p.exists() {
        return Ok(ClientConfig::default());
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("Failed to read config: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid config: {e}"))
}

fn save_config(cfg: &ClientConfig) -> Result<(), String> {
    let p = config_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let lock_path = p.with_extension("json.lock");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(lock_path)
        .map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    AtomicFile::new(&p, OverwriteBehavior::AllowOverwrite)
        .write(|file| file.write_all(&json).and_then(|_| file.sync_all()))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_server_base_url;

    #[test]
    fn accepts_http_base_urls() {
        for (input, expected) in [
            (" https://example.com ", "https://example.com/"),
            ("https://example.com/", "https://example.com/"),
            ("https://example.com/api", "https://example.com/api/"),
            ("https://example.com/api/v1/", "https://example.com/api/v1/"),
            ("http://127.0.0.1:3847", "http://127.0.0.1:3847/"),
        ] {
            let parsed = parse_server_base_url(input).unwrap();
            assert_eq!(parsed.as_str(), expected, "{input}");
        }
    }

    #[test]
    fn rejects_malformed_and_non_http_urls() {
        for candidate in ["", "example.com", "not a url", "ftp://example.com", "http:///api"] {
            assert!(parse_server_base_url(candidate).is_err(), "{candidate}");
        }
    }

    #[test]
    fn rejects_credentials_query_and_fragment() {
        for candidate in [
            "https://example.com@evil.test",
            "https://user:pass@example.com",
            "https://example.com/api?next=https://evil.test",
            "https://example.com/api#https://evil.test",
        ] {
            assert!(parse_server_base_url(candidate).is_err(), "{candidate}");
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_server_url() -> String {
    load_config()
        .map(|c| c.server_url)
        .unwrap_or_else(|e| format!("config error: {e}"))
}

pub(crate) fn parse_server_base_url(input: &str) -> Result<url::Url, String> {
    let input = input.trim();
    let has_valid_authority = input
        .split_once("://")
        .is_some_and(|(_, authority)| !authority.is_empty() && !authority.starts_with('/'));
    let mut parsed = url::Url::parse(input)
        .map_err(|_| "Server URL must be a valid HTTP(S) base URL.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !has_valid_authority
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Server URL must be an HTTP(S) base URL without credentials, query, or fragment."
                .to_string(),
        );
    }
    let path = format!("{}/", parsed.path().trim_end_matches('/'));
    parsed.set_path(&path);
    Ok(parsed)
}

/// Return the persisted backend only after applying the same validation used on save.
/// This rejects malformed legacy or manually edited configuration.
pub(crate) fn validated_server_base_url() -> Result<url::Url, String> {
    parse_server_base_url(&load_config()?.server_url)
}

/// vega INT-3194: this command takes an injected `WebviewWindow` (not a bare
/// `AppHandle`) and checks it with `trusted_command_window`, so no remote page
/// can overwrite the persisted backend URL and redirect the main WebView to an
/// attacker-selected origin. Defense in depth: the capability file grants no
/// `remote` IPC at all, so this Rust check is the second layer, not the only
/// one. Only the settings window calls this — that is where settings.html lives.
#[tauri::command]
pub fn set_server_url(url: String, window: tauri::WebviewWindow) -> Result<(), String> {
    if !crate::trusted_command_window(&window, &["settings"]) {
        return Err("untrusted WebView sender".into());
    }
    let parsed = parse_server_base_url(&url)?;
    let url = parsed.to_string();
    let mut cfg = load_config()?;
    cfg.server_url = url.clone();
    save_config(&cfg)?;

    if let Some(win) = window.app_handle().get_webview_window("main") {
        let entry_url = parsed
            .join(cfg.entry_path.trim_start_matches('/'))
            .map_err(|error| error.to_string())?;
        let _ = win.eval(&format!(
            "window.location.href = {}",
            crate::js_string(entry_url.as_str())
        )); // cxt-ignore: security
    }
    Ok(())
}

/// English-only labels shared by the tray and settings window.
pub struct Strings {
    pub open: &'static str,
    pub hide: &'static str,
    pub settings: &'static str,
    pub restart: &'static str,
    pub quit: &'static str,
    pub settings_title: &'static str,
    pub tooltip: &'static str,
}

pub fn strings() -> Strings {
    Strings {
        open: "Open OpenSwarm",
        hide: "Hide",
        settings: "Settings…",
        restart: "Restart daemon",
        quit: "Quit",
        settings_title: "OpenSwarm Settings",
        tooltip: "OpenSwarm",
    }
}
