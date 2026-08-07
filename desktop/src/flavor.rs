//! Build-time flavor values for the OpenSwarm desktop shell.
//!
//! Reduced from vega-agent's `desktop_flavor.rs`: the LaunchAgent plist rendering
//! and sidecar data-dir helpers are gone because this shell never owns the daemon
//! process — launchd (`com.intrect.openswarm`) does.

pub(crate) fn name() -> &'static str {
    option_env!("OPENSWARM_DESKTOP_FLAVOR_NAME").unwrap_or("OpenSwarm")
}

/// Default daemon URL baked into the build. Overridable at compile time with
/// `OPENSWARM_DESKTOP_SERVER_URL` (e.g. preview builds pointing at another port).
pub(crate) fn server_url() -> &'static str {
    option_env!("OPENSWARM_DESKTOP_SERVER_URL").unwrap_or("http://127.0.0.1:3847")
}

/// Shell log directory. macOS: `~/Library/Logs/OpenSwarm`.
pub(crate) fn log_dir() -> std::path::PathBuf {
    #[cfg(target_os = "macos")]
    let dir = dirs_next::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("Library/Logs")
        .join(name());
    #[cfg(not(target_os = "macos"))]
    let dir = dirs_next::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(name())
        .join("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Where the launchd service writes the daemon's stdout/stderr
/// (`scripts/com.intrect.openswarm.plist` → `~/.openswarm/logs/{stdout,stderr}.log`).
/// The boot splash tails these files; they are owned by the daemon, never created here.
pub(crate) fn daemon_log_dir() -> std::path::PathBuf {
    dirs_next::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".openswarm")
        .join("logs")
}
