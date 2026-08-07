// OpenSwarm desktop shell (INT-3388 M2).
//
// A thin Tauri client attaching to the launchd-managed OpenSwarm daemon
// (com.intrect.openswarm, http://127.0.0.1:3847). Ported and reduced from
// vega-agent's desktop shell: the Python sidecar lifecycle, auto-updater, and
// mobile branches are gone; the origin-trust system, boot splash log tail, and
// backend recovery tracking are kept intact.
//
// Common: tray icon + window toggle + settings window + close-to-tray.

pub mod client_config;
mod daemon_health;
mod flavor;

use daemon_health::{
    fetch_backend_health, identity_matches, BackendRecoveryEvent, BackendRecoveryTracker,
};
use flavor::{daemon_log_dir, log_dir};

// strings() provides the tray/settings labels.
use client_config::strings;

use tauri::Manager;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// launchd label of the daemon service (`scripts/com.intrect.openswarm.plist`,
/// installed via `npm run service:install`). Distinct from this app's bundle
/// identifier `com.intrect.openswarm-desktop` on purpose.
const DAEMON_LAUNCHD_LABEL: &str = "com.intrect.openswarm";

// ── Shell logging ─────────────────────────────────────────────────────────────
// A packaged .app has no console, so eprintln! output vanishes. Keep the Rust
// shell's diagnostics in a file under the OS-standard user log location
// (~/Library/Logs/OpenSwarm) — outside the bundle, safe across code signing.

/// Shell log file path (~/Library/Logs/OpenSwarm/openswarm-shell.log).
fn shell_log_path() -> std::path::PathBuf {
    log_dir().join("openswarm-shell.log")
}

/// Append one line to the shell log file and mirror it to stderr. Failures are ignored.
fn shell_log(msg: &str) {
    use fs2::FileExt;
    use std::io::Write;
    eprintln!("{msg}");
    let path = shell_log_path();
    let lock_path = path.with_extension("log.lock");
    let lock = std::fs::OpenOptions::new().create(true).write(true).open(lock_path);
    let _guard = lock.ok().and_then(|file| {
        file.lock_exclusive().ok()?;
        Some(file)
    });
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) >= 10 * 1024 * 1024 {
        let rotated = path.with_extension(format!(
            "log.{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::rename(&path, rotated);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{msg}");
    }
}

/// eprintln! replacement — logs to the shell log file and stderr.
macro_rules! vlog {
    ($($arg:tt)*) => { crate::shell_log(&format!($($arg)*)) };
}

// ── WebView script helpers ────────────────────────────────────────────────────

fn js_string(value: &str) -> String {
    // JSON string literals are valid JavaScript string literals and handle control
    // characters as well as quotes and backslashes without ad-hoc escaping.
    serde_json::to_string(value).expect("serializing a string cannot fail")
}

fn progress_script(pct: u32, label: &str) -> String {
    let label = js_string(label);
    format!("window.osProgress && window.osProgress({pct}, {label})")
}

fn backend_failure_script(backend: &str, log_path: &str) -> String {
    let backend = js_string(backend);
    let log_path = js_string(log_path);
    format!(
        r#"document.body.replaceChildren();const box=document.createElement('div');box.style.cssText='font-family:sans-serif;padding:40px;color:#e6edf3;background:#0d1117';const title=document.createElement('h2');title.textContent='데몬 연결 실패';const detail=document.createElement('p');detail.textContent='OpenSwarm 데몬('+{backend}+')에 접속할 수 없습니다.';const hint=document.createElement('p');hint.style.color='#9aa4b2';hint.textContent='데몬이 설치되지 않았다면 OpenSwarm 저장소에서 npm run service:install 을 실행하세요.';const logs=document.createElement('p');logs.style.color='#9aa4b2';logs.textContent={log_path}+' 의 로그를 확인하세요.';box.append(title,detail,hint,logs);document.body.append(box)"#
    )
}

fn config_failure_script(error: &str) -> String {
    let error = js_string(error);
    format!(
        r#"document.body.replaceChildren();const box=document.createElement('div');box.style.cssText='font-family:sans-serif;padding:40px;color:#e6edf3;background:#0d1117';const title=document.createElement('h2');title.textContent='서버 설정 오류';const detail=document.createElement('p');detail.textContent={error};const hint=document.createElement('p');hint.style.color='#9aa4b2';hint.textContent='설정 창에서 서버 URL을 다시 저장하면 즉시 재연결합니다.';box.append(title,detail,hint);document.body.append(box)"#
    )
}

/// Daemon pages open external references (e.g. Linear issue links on the issue
/// board) with `target="_blank"`, which asks for a NEW WebView window and never
/// reaches `on_navigation` — in this shell such clicks would silently do
/// nothing (review finding). The bridge turns them into ordinary top-level
/// navigations; `on_navigation` then rejects the external origin and hands the
/// URL to the OS browser. No IPC involved, so it works on daemon pages, which
/// have no remote capability.
const NEW_WINDOW_BRIDGE_JS: &str = r#"(function(){
  if (window.__osNewWindowBridge) return; window.__osNewWindowBridge = true;
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
    if (a && a.href) { e.preventDefault(); window.location.href = a.href; }
  }, true);
  var origOpen = window.open;
  window.open = function(u){
    if (u) { window.location.href = String(u); return null; }
    return origOpen ? origOpen.apply(window, arguments) : null;
  };
})();"#;

fn navigation_allowed(candidate: &url::Url) -> bool {
    trusted_webview_url(candidate)
}

// ── Origin trust ──────────────────────────────────────────────────────────────
// Ported verbatim from vega-agent (INT-2887/2895/3194 hardening). Global Tauri
// events expose a destination, not an authenticated emitter. Privileged frontend
// actions must use commands receiving an injected `WebviewWindow`, then validate
// it with `trusted_main_window`/`trusted_command_window`.

fn same_origin(left: &url::Url, right: &url::Url) -> bool {
    left.scheme() == right.scheme()
        && left.host() == right.host()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn trusted_webview_url(candidate: &url::Url) -> bool {
    trusted_webview_url_with_backend(candidate, backend_base())
}

/// Split from `trusted_webview_url` so the "backend unavailable" branch is
/// reachable from a test without touching process-global environment. A corrupt
/// client config can make `backend_base()` fail here.
fn trusted_webview_url_with_backend(
    candidate: &url::Url,
    backend: Result<url::Url, String>,
) -> bool {
    // The app's own assets are trusted independently of the backend: a corrupt
    // client config or an unparseable server URL must not turn the window's first
    // navigation into an "external link" and hand the app to the OS browser.
    if tauri_asset_origin(candidate) {
        return true;
    }
    let Ok(backend) = backend else {
        return false;
    };
    trusted_webview_url_for_backend(candidate, &backend)
}

/// Tauri's own asset origin, which differs by platform: Windows WebView2 serves
/// from `http://tauri.localhost`, macOS and Linux from `tauri://localhost`.
/// Trusting only the https form sent Windows users' first navigation to the OS
/// browser on every launch (vega INT-2887). The host is reserved by Tauri, so
/// accepting both http schemes widens nothing externally reachable — `same_origin`
/// still rejects `tauri.localhost.evil.test`, subdomains and non-default ports.
fn tauri_asset_origin(candidate: &url::Url) -> bool {
    match candidate.scheme() {
        "http" | "https" => ["http://tauri.localhost", "https://tauri.localhost"]
            .iter()
            .any(|base| url::Url::parse(base).is_ok_and(|base| same_origin(candidate, &base))),
        "tauri" => candidate.host_str() == Some("localhost"),
        _ => false,
    }
}

fn trusted_webview_url_for_backend(candidate: &url::Url, backend: &url::Url) -> bool {
    match candidate.scheme() {
        "http" | "https" => same_origin(candidate, backend) || tauri_asset_origin(candidate),
        // Tauri's application asset protocol. Opaque documents (notably data: and
        // about:) are deliberately excluded because they have no trustworthy origin.
        "tauri" => candidate.host_str() == Some("localhost"),
        _ => false,
    }
}

fn trusted_main_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    trusted_command_window(window, &["main"])
}

fn trusted_command_window<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    allowed_labels: &[&str],
) -> bool {
    // The configured backend origin is deliberately treated as a shell principal:
    // it is selected through the local settings flow and is required to open its
    // own settings, restart, and external-link controls. Any other remote URL is
    // denied by the exact-origin comparison below.
    allowed_labels.contains(&window.label())
        && window
            .url()
            .ok()
            .is_some_and(|url| trusted_webview_url(&url))
}

// ── Privileged commands ───────────────────────────────────────────────────────

/// IPC entry point: `WebviewWindow` is injected by Tauri from the authenticated
/// invoke request, unlike global events (whose `EventTarget` is only a destination).
#[tauri::command]
fn open_url(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    if !trusted_command_window(&window, &["main", "settings"]) {
        return Err("untrusted WebView sender".into());
    }
    open_external_url(url)
}

#[tauri::command]
async fn open_settings(window: tauri::WebviewWindow, section: String) -> Result<(), String> {
    if !trusted_main_window(&window) {
        return Err("untrusted WebView sender".into());
    }
    spawn_settings_window(window.app_handle(), section);
    Ok(())
}

/// Restart the GUI shell only. The daemon is launchd-owned and keeps running.
#[tauri::command]
fn request_restart(window: tauri::WebviewWindow) -> Result<(), String> {
    if !trusted_main_window(&window) {
        return Err("untrusted WebView sender".into());
    }
    let handle = window.app_handle().clone();
    let restart_handle = handle.clone();
    handle
        .run_on_main_thread(move || restart_handle.restart())
        .map_err(|error| error.to_string())
}

/// Settings-window connection test. settings.html runs on the Tauri asset
/// origin, so a direct fetch of the daemon's /api/health is cross-origin and
/// the daemon's CORS allowlist (correctly) does not include that origin — the
/// probe goes through the shell instead. The URL is untrusted form input and
/// gets the same validation as a save.
#[tauri::command]
async fn test_daemon_connection(
    window: tauri::WebviewWindow,
    url: String,
) -> Result<daemon_health::ConnectionTestResult, String> {
    if !trusted_command_window(&window, &["settings"]) {
        return Err("untrusted WebView sender".into());
    }
    let base = client_config::parse_server_base_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        daemon_health::connection_test(&base, std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|error| error.to_string())
}

/// Restart the launchd-managed daemon (`launchctl kickstart -k`). The daemon's
/// own /api/service/restart calls systemctl and does nothing on macOS, so the
/// shell drives launchctl directly instead of relying on that API.
#[tauri::command]
fn restart_daemon(window: tauri::WebviewWindow) -> Result<(), String> {
    if !trusted_command_window(&window, &["main", "settings"]) {
        return Err("untrusted WebView sender".into());
    }
    restart_daemon_service()
}

#[cfg(target_os = "macos")]
fn restart_daemon_service() -> Result<(), String> {
    let uid = unsafe { libc::getuid() };
    let target = format!("gui/{uid}/{DAEMON_LAUNCHD_LABEL}");
    let loaded = std::process::Command::new("launchctl")
        .args(["print", &target])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !loaded {
        return Err(format!(
            "OpenSwarm daemon service ({DAEMON_LAUNCHD_LABEL}) is not installed. \
             Run `npm run service:install` in the OpenSwarm repository first."
        ));
    }
    match std::process::Command::new("launchctl")
        .args(["kickstart", "-k", &target])
        .status()
    {
        Ok(s) if s.success() => {
            vlog!("[OpenSwarm] daemon restarted: {target}");
            Ok(())
        }
        Ok(s) => Err(format!("launchctl kickstart failed: {s}")),
        Err(e) => Err(format!("failed to run launchctl: {e}")),
    }
}

#[cfg(not(target_os = "macos"))]
fn restart_daemon_service() -> Result<(), String> {
    Err("Daemon restart via launchctl is only supported on macOS.".into())
}

// ── Daemon health / readiness ─────────────────────────────────────────────────

fn backend_is_listening(backend: &url::Url) -> bool {
    use std::net::ToSocketAddrs;
    let Some(host) = backend.host_str() else {
        return false;
    };
    let Some(port) = backend.port_or_known_default() else {
        return false;
    };
    // Bounded connect: an unbounded TcpStream::connect against a blackholed
    // endpoint can stall a poll iteration for minutes (review finding).
    let Ok(mut addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs.next().is_some_and(|addr| {
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(800)).is_ok()
    })
}

/// Plain HTTP 200 check on /api/health. Used by tests and as a coarse liveness
/// probe; readiness for navigation additionally requires `identity_matches`
/// (see `ready_backend_pid`) so an arbitrary server on the port is not trusted.
#[cfg_attr(not(test), allow(dead_code))]
fn backend_health_ok(backend: &url::Url) -> bool {
    let health = match backend.join("api/health") {
        Ok(url) if matches!(url.scheme(), "http" | "https") => url,
        _ => return false,
    };
    reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(800))
        .timeout(std::time::Duration::from_millis(800))
        .build()
        .and_then(|client| client.get(health).send())
        .is_ok_and(|response| response.status() == reqwest::StatusCode::OK)
}

/// Some(pid) when the port is serving a healthy OpenSwarm daemon; the inner
/// Option is the daemon PID as reported by /api/health (None when omitted).
fn ready_backend_pid(backend: &url::Url) -> Option<Option<u32>> {
    fetch_backend_health(backend)
        .filter(identity_matches)
        .map(|health| health.backend_pid)
}

/// Backend base URL (scheme + host + port, no path) from the validated config.
fn backend_base() -> Result<url::Url, String> {
    client_config::validated_server_base_url()
}

/// First navigation target. `entry_path` is empty for the current dashboard
/// root and will point at the desktop SPA in a later milestone.
fn backend_url() -> Result<String, String> {
    let cfg = client_config::load_config()?;
    backend_base()?
        .join(cfg.entry_path.trim_start_matches('/'))
        .map(|url| url.to_string())
        .map_err(|error| error.to_string())
}

/// Monotonic generation for the backend waiter/watcher threads. Saving a new
/// server URL bumps it; every thread spawned under an older generation exits on
/// its next tick, so exactly one watcher observes exactly the configured
/// backend (review finding: the old watcher kept polling the previous daemon
/// and could yank the WebView back to the stale URL on a PID swap there).
static WATCH_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn current_watch_generation() -> u64 {
    WATCH_GENERATION.load(std::sync::atomic::Ordering::SeqCst)
}

fn bump_watch_generation() -> u64 {
    WATCH_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

/// Retire all existing waiter/watcher threads and bind a fresh recovery watcher
/// to the just-saved backend configuration. Called after a successful
/// `set_server_url` save.
pub(crate) fn restart_backend_watch(app: &tauri::AppHandle, url: String) {
    let generation = bump_watch_generation();
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    match backend_base() {
        Ok(backend) => watch_backend_recovery(win, backend, url, None, false, generation),
        Err(error) => vlog!("[OpenSwarm] cannot watch the new backend: {error}"),
    }
}

/// Keep observing the daemon after the WebView attached. launchd restarting the
/// daemon (crash, `npm run service:install`, Restart daemon tray item) is an
/// everyday event; a PID swap between healthy samples reattaches the WebView.
fn watch_backend_recovery(
    win: tauri::WebviewWindow,
    backend: url::Url,
    url: String,
    initial_pid: Option<u32>,
    initially_disconnected: bool,
    generation: u64,
) {
    let app = win.app_handle().clone();
    std::thread::spawn(move || {
        let mut tracker = BackendRecoveryTracker::new(initial_pid, initially_disconnected);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if current_watch_generation() != generation {
                return;
            }
            if app.get_webview_window("main").is_none() {
                return;
            }
            let event = match fetch_backend_health(&backend).filter(identity_matches) {
                Some(health) => tracker.observe_healthy(health.backend_pid),
                None => tracker.observe_unavailable(),
            };
            match event {
                BackendRecoveryEvent::None => {}
                BackendRecoveryEvent::Disconnected => {
                    vlog!("[OpenSwarm] daemon connection lost — waiting for restart");
                }
                BackendRecoveryEvent::Reconnect { previous_pid, pid } => {
                    vlog!("[OpenSwarm] daemon reconnected: previous_pid={previous_pid:?}, pid={pid:?}");
                    let _ = win.eval(&format!(
                        "window.location.replace({})",
                        js_string(&url),
                    )); // cxt-ignore: security
                    if let Some(settings) = app.get_webview_window("settings") {
                        let _ = settings.eval(
                            "window.dispatchEvent(new CustomEvent('openswarm-daemon-recovered'))",
                        ); // cxt-ignore: security
                    }
                }
            }
        }
    });
}

// ── Boot splash: log tail + wait-and-navigate ─────────────────────────────────

/// Offset-based log file tail — returns only lines appended since the last poll.
/// A missing file is silently empty; rotation (length decrease) restarts from 0.
/// The read offset advances immediately, but an incomplete line (including a
/// split UTF-8 sequence) is buffered until the next poll.
struct LogTail {
    path: std::path::PathBuf,
    pos: u64,
    pending: Vec<u8>,
    discarding_overlong_line: bool,
}

impl LogTail {
    /// start_pos=None starts at the current EOF (skipping previous sessions),
    /// Some(n) starts at byte n.
    fn new(path: std::path::PathBuf, start_pos: Option<u64>) -> Self {
        let pos = start_pos
            .unwrap_or_else(|| std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0));
        Self { path, pos, pending: Vec::new(), discarding_overlong_line: false }
    }

    fn read_new_lines(&mut self) -> Vec<String> {
        use std::io::{Read, Seek, SeekFrom};
        let Ok(mut f) = std::fs::File::open(&self.path) else { return Vec::new() };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.pos {
            self.pos = 0; // rotation/truncate
            self.pending.clear();
            self.discarding_overlong_line = false;
        }
        if len == self.pos {
            return Vec::new();
        }
        if f.seek(SeekFrom::Start(self.pos)).is_err() {
            return Vec::new();
        }
        let mut buf = Vec::new();
        if f.take(64 * 1024).read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        self.pos += buf.len() as u64;

        if self.discarding_overlong_line {
            let Some(newline) = buf.iter().position(|&byte| byte == b'\n') else {
                return Vec::new();
            };
            buf.drain(..=newline);
            self.discarding_overlong_line = false;
        }
        self.pending.extend_from_slice(&buf);
        let consumed = match self.pending.iter().rposition(|&byte| byte == b'\n') {
            Some(i) => i + 1,
            None if self.pending.len() >= 64 * 1024 => {
                self.pending.clear();
                self.discarding_overlong_line = true;
                return Vec::new();
            }
            None => return Vec::new(),
        };
        let complete: Vec<u8> = self.pending.drain(..consumed).collect();
        String::from_utf8_lossy(&complete)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                let mut s = l.to_string();
                if s.len() > 240 {
                    let mut cut = 240;
                    while cut > 0 && !s.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    s.truncate(cut);
                    s.push('…');
                }
                s
            })
            .collect()
    }
}

/// Poll the daemon for up to 120 s, then load the real URL into the window.
/// While waiting, stream real log lines (shell log + the daemon's launchd
/// stdout/stderr under ~/.openswarm/logs) to the splash console.
fn wait_and_navigate(win: tauri::WebviewWindow, url: String, shell_log_from: u64) {
    std::thread::spawn(move || {
        let generation = current_watch_generation();
        let backend = match backend_base() {
            Ok(url) => url,
            Err(error) => {
                vlog!("invalid backend URL: {error}");
                return;
            }
        };

        // Helper calling index.html's window.osProgress(pct, label).
        let progress = |win: &tauri::WebviewWindow, pct: u32, label: &str| {
            let _ = win.eval(&progress_script(pct, label)); // cxt-ignore: security
        };

        // Real startup logs — not staged fakes (vega INT-1465): the shell log plus
        // the daemon's stdout/stderr as written by launchd.
        let daemon_logs = daemon_log_dir();
        let mut tails = [
            LogTail::new(shell_log_path(), Some(shell_log_from)),
            LogTail::new(daemon_logs.join("stdout.log"), None),
            LogTail::new(daemon_logs.join("stderr.log"), None),
        ];
        let push_logs = |win: &tauri::WebviewWindow, tails: &mut [LogTail]| {
            let mut lines: Vec<String> = Vec::new();
            for t in tails.iter_mut() {
                lines.extend(t.read_new_lines());
            }
            // Flood guard — only the last 10 lines per tick.
            let skip = lines.len().saturating_sub(10);
            for line in lines.into_iter().skip(skip) {
                if let Ok(js_str) = serde_json::to_string(&line) {
                    let _ = win.eval(&format!("window.osLog && window.osLog({js_str})")); // cxt-ignore: security
                }
            }
        };

        // Polling against a wall-clock 120 s deadline (a tick counter alone
        // undercounts: each iteration can spend up to 1.6 s inside the bounded
        // health/TCP probes — review finding). Progress is driven by real signals:
        //  - TCP not connectable yet: elapsed-time based 0→80%
        //  - TCP listening: 85–96% ("checking daemon response")
        //  - health OK + identity match: 100%, then navigate
        let started = std::time::Instant::now();
        let deadline = std::time::Duration::from_secs(120);
        let mut listening_seen = false;
        let mut i: u32 = 0;
        loop {
            if current_watch_generation() != generation {
                return;
            }
            push_logs(&win, &mut tails);
            if let Some(backend_pid) = ready_backend_pid(&backend) {
                push_logs(&win, &mut tails);
                progress(&win, 100, "준비 완료");
                let _ = win.eval(&format!("window.location.href = {}", js_string(&url))); // cxt-ignore: security
                watch_backend_recovery(win, backend, url, backend_pid, false, generation);
                return;
            }
            if backend_is_listening(&backend) {
                if !listening_seen {
                    listening_seen = true;
                    progress(&win, 88, "서버 응답 확인 중…");
                }
                // TCP is open but health/identity is not ready — creep 90→96%.
                let creep = 90 + (i % 7);
                progress(&win, creep.min(96), "데몬 상태 확인 중…");
            } else {
                // No listener yet — poll count fills 0→80% (~16 s to 80%).
                let pct = (i * 5).min(80);
                progress(&win, pct, "OpenSwarm 데몬 연결 중…");
            }
            if started.elapsed() >= deadline {
                break;
            }
            let poll_ms = if i == 0 { 100 } else { 500 };
            i = i.saturating_add(1);
            std::thread::sleep(std::time::Duration::from_millis(poll_ms));
        }
        // Still not up after 120 s — show the failure page.
        let _ = win.eval(&backend_failure_script(
            backend.as_str(),
            &log_dir().display().to_string(),
        )); // cxt-ignore: security
        // launchd may recover after the startup deadline. Keep observing so the
        // failure page can attach without requiring the user to restart the shell.
        watch_backend_recovery(win, backend, url, None, true, generation);
    });
}

fn make_loading_page() -> WebviewUrl {
    // Inline boot splash — replaced by JS once the daemon is ready.
    WebviewUrl::App("index.html".into())
}

// ── Windows (main/settings) ───────────────────────────────────────────────────

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize(); // cxt-ignore: error_swallow
        let _ = win.show(); // cxt-ignore: error_swallow
        let _ = win.set_focus(); // cxt-ignore: error_swallow
    }
}

fn open_settings_window(app: &tauri::AppHandle) {
    spawn_settings_window(app, String::new());
}

/// Windows WebView2 can deadlock the UI thread when a new WebView is created from
/// a synchronous IPC command or a menu/tray event handler. Tauri's documented
/// pattern is to build the window on a separate thread.
/// https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html#known-issues
fn spawn_settings_window(app: &tauri::AppHandle, section: String) {
    if show_existing_settings_window(app, &section) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || build_settings_window(&app, &section));
}

fn show_existing_settings_window(app: &tauri::AppHandle, section: &str) -> bool {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show(); // cxt-ignore: error_swallow
        let _ = win.set_focus(); // cxt-ignore: error_swallow
        // Already open — update the fragment to switch tabs (settings.html hashchange).
        if !section.is_empty() {
            let _ = win.eval(&format!("window.location.hash = {section:?}; window.dispatchEvent(new HashChangeEvent('hashchange'))")); // cxt-ignore: security
        }
        return true;
    }
    false
}

/// When section is non-empty the window opens at settings.html#<section>.
fn build_settings_window(app: &tauri::AppHandle, section: &str) {
    let settings_html = if section.is_empty() {
        "settings.html".to_string()
    } else {
        format!("settings.html#{section}")
    };
    let title = strings().settings_title;
    let builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(settings_html.into()))
        .title(title)
        .inner_size(880.0, 640.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .center();
    // Overlay title bar is a macOS-only API — Windows/Linux keep the default bar.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    if let Err(error) = builder.build() {
        vlog!("[OpenSwarm] failed to create the settings window: {error}");
    }
}

/// Open an external URL in the OS default browser.
///
/// A Tauri WebView has no "new tab": window.open('...','_blank') silently does
/// nothing. Flows that must leave the app (OAuth consent, docs links) invoke
/// this command to launch the system browser.
fn open_external_url(url: String) -> Result<(), String> {
    // Safety: http(s) only — no arbitrary schemes / command injection.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("disallowed URL scheme: {url}"));
    }
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(target_os = "linux")]
    let prog = "xdg-open";
    #[cfg(target_os = "windows")]
    let prog = "explorer";
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        return Err(format!("opening external URLs is not supported on this platform: {url}"));
    }
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    std::process::Command::new(prog)
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open the browser: {e}"))
}

// ── Close-to-tray preference ──────────────────────────────────────────────────
// Persists the settings window's "Close = Hide" toggle. Missing/corrupt files
// fall back to true (hide) so the default behavior never regresses.

fn window_prefs_path() -> std::path::PathBuf {
    dirs_next::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("openswarm-desktop")
        .join("window-prefs.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct WindowPrefs {
    #[serde(default = "default_close_to_tray")]
    close_to_tray: bool,
}

fn default_close_to_tray() -> bool {
    true
}

impl Default for WindowPrefs {
    fn default() -> Self {
        Self { close_to_tray: default_close_to_tray() }
    }
}

fn load_window_prefs() -> WindowPrefs {
    std::fs::read_to_string(window_prefs_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_window_prefs(prefs: &WindowPrefs) -> Result<(), String> {
    use std::io::Write;
    let p = window_prefs_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?;
    atomicwrites::AtomicFile::new(&p, atomicwrites::OverwriteBehavior::AllowOverwrite)
        .write(|file| file.write_all(&json).and_then(|_| file.sync_all()))
        .map_err(|e| e.to_string())
}

/// Current "Close = Hide" preference as read by the close handler.
fn close_to_tray_enabled() -> bool {
    load_window_prefs().close_to_tray
}

#[tauri::command]
fn get_close_to_tray() -> bool {
    close_to_tray_enabled()
}

// IPC entry point: the `WebviewWindow` param lets us apply the same origin check
// the other privileged commands use, so an untrusted sender (e.g. a same-origin
// iframe) cannot flip this preference.
#[tauri::command]
fn set_close_to_tray(window: tauri::WebviewWindow, value: bool) -> Result<(), String> {
    if !trusted_command_window(&window, &["main", "settings"]) {
        return Err("untrusted WebView sender".into());
    }
    save_window_prefs(&WindowPrefs { close_to_tray: value })
}

// ── App entry ─────────────────────────────────────────────────────────────────

pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be the first plugin: a second shell instance exits immediately and
    // only restores the existing main window.
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show_main_window(app);
    }));

    builder = builder
        .plugin(tauri_plugin_dialog::init())
        // Clipboard fallback for the remote-origin WebView where
        // navigator.clipboard is blocked.
        .plugin(tauri_plugin_clipboard_manager::init());

    builder = builder.invoke_handler(tauri::generate_handler![
        client_config::get_server_url,
        client_config::set_server_url,
        get_close_to_tray,
        set_close_to_tray,
        open_url,
        open_settings,
        request_restart,
        restart_daemon,
        test_daemon_connection,
    ]);

    let app = builder
        .setup(|app| {
            let win_builder = WebviewWindowBuilder::new(app, "main", make_loading_page())
                .title("OpenSwarm")
                // External http(s) links leave the WebView and open in the OS
                // default browser. Internal targets (the configured daemon origin,
                // app assets, the loading page) navigate normally.
                .on_navigation(|url| {
                    if navigation_allowed(url) {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = open_external_url(url.as_str().to_string());
                    }
                    false
                })
                .on_page_load(|window, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        let _ = window.eval(NEW_WINDOW_BRIDGE_JS); // cxt-ignore: security
                    }
                })
                .inner_size(980.0, 760.0)
                .min_inner_size(420.0, 480.0)
                .resizable(true)
                .center();

            // Overlay title bar is a macOS-only API — Windows/Linux keep the default bar.
            #[cfg(target_os = "macos")]
            let win_builder = win_builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);

            let win = win_builder.build()?;

            // Splash console tail baseline — only shell log lines written after
            // this point are shown on the loading screen.
            let shell_log_from = std::fs::metadata(shell_log_path())
                .map(|m| m.len())
                .unwrap_or(0);

            // Navigate once the daemon is ready (avoids a white window).
            match backend_url() {
                Ok(url) => wait_and_navigate(win, url, shell_log_from),
                Err(error) => {
                    // A malformed config.json must not strand the splash at a
                    // frozen progress bar (review finding): surface the error in
                    // the window and open settings so a valid save — which calls
                    // restart_backend_watch — recovers without a shell restart.
                    vlog!("invalid configured backend URL: {error}");
                    let _ = win.eval(&config_failure_script(&error)); // cxt-ignore: security
                    spawn_settings_window(app.handle(), String::new());
                }
            }

            // Tray menu
            let s = strings();
            let show_item = MenuItemBuilder::with_id("show", s.open).build(app)?;
            let hide_item = MenuItemBuilder::with_id("hide", s.hide).build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", s.settings).build(app)?;
            let restart_item =
                MenuItemBuilder::with_id("restart-daemon", s.restart).build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", s.quit).build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&show_item, &hide_item])
                .separator()
                .items(&[&settings_item, &restart_item])
                .separator()
                .items(&[&quit_item])
                .build()?;

            let tray_icon = app
                .default_window_icon()
                .ok_or("tray icon not configured in tauri.conf.json")?
                .clone();
            TrayIconBuilder::with_id("openswarm-tray")
                .icon(tray_icon)
                .tooltip(s.tooltip)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "hide" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.hide(); // cxt-ignore: error_swallow
                        }
                    }
                    "settings" => open_settings_window(app),
                    "restart-daemon" => {
                        if let Err(error) = restart_daemon_service() {
                            vlog!("[OpenSwarm] daemon restart failed: {error}");
                        }
                    }
                    "quit" => {
                        // Quit the GUI shell only — the launchd daemon keeps running.
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // macOS app menu: "Settings… (⌘,)" inserted after About in the app
            // submenu (standard macOS placement), keeping the default menu (and
            // its Edit copy/paste accelerators) intact.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItemKind};
                let menu = Menu::default(app.handle())?;
                let settings_menu_item = MenuItemBuilder::with_id("menu-settings", s.settings)
                    .accelerator("Cmd+,")
                    .build(app)?;
                if let Some(MenuItemKind::Submenu(app_submenu)) =
                    menu.items()?.into_iter().next()
                {
                    app_submenu.insert(&settings_menu_item, 1)?;
                }
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().as_ref() == "menu-settings" {
                        open_settings_window(app);
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window hides it (reopenable from the tray) unless
            // the user disabled close-to-tray in settings.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    if close_to_tray_enabled() {
                        let _ = window.hide(); // cxt-ignore: error_swallow
                        api.prevent_close();
                    } else {
                        // Same path as the tray Quit — the daemon keeps running.
                        window.app_handle().exit(0);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("OpenSwarm desktop build error"); // cxt-ignore: panic_risk

    app.run(|app_handle, event| match event {
        // macOS delivers a Reopen run event when the Dock icon of the running
        // app is clicked; with close-to-tray the main window is merely hidden
        // and must be restored here (review finding).
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_main_window(app_handle),
        _ => {
            let _ = app_handle;
        }
    });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod origin_tests {
    use super::{
        backend_health_ok, navigation_allowed, same_origin, tauri_asset_origin,
        trusted_webview_url, trusted_webview_url_for_backend, trusted_webview_url_with_backend,
    };
    use crate::client_config::parse_server_base_url;
    use crate::daemon_health::{
        fetch_backend_health, identity_matches, BackendHealth, BackendRecoveryEvent,
        BackendRecoveryTracker,
    };

    #[test]
    fn health_check_targets_configured_backend() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 512];
            let count = stream.read(&mut request).unwrap();
            let request = std::str::from_utf8(&request[..count]).unwrap();
            assert!(request.starts_with("GET /configured/api/health HTTP/1.1\r\n"), "{request}");
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").unwrap();
        });
        let backend = parse_server_base_url(&format!("http://{address}/configured")).unwrap();
        assert!(backend_health_ok(&backend));
        server.join().unwrap();
    }

    #[test]
    fn listening_check_targets_configured_backend_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let backend =
            url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        assert!(super::backend_is_listening(&backend));
    }

    #[test]
    fn connection_test_reports_identity_and_metadata() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 512];
            let _ = stream.read(&mut request).unwrap();
            let body = r#"{"status":"ok","app":"openswarm","backend_version":"0.20.10","uptime_s":42.0}"#;
            stream
                .write_all(
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len())
                        .as_bytes(),
                )
                .unwrap();
        });
        let backend = parse_server_base_url(&format!("http://{address}")).unwrap();
        let result =
            crate::daemon_health::connection_test(&backend, std::time::Duration::from_secs(2));
        server.join().unwrap();
        assert!(result.reachable);
        assert!(result.is_openswarm);
        assert_eq!(result.backend_version.as_deref(), Some("0.20.10"));
        assert_eq!(result.uptime_s, Some(42.0));
    }

    #[test]
    fn connection_test_flags_non_openswarm_and_unreachable() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 512];
            let _ = stream.read(&mut request).unwrap();
            let body = r#"{"status":"ok","app":"vega"}"#;
            stream
                .write_all(
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len())
                        .as_bytes(),
                )
                .unwrap();
        });
        let backend = parse_server_base_url(&format!("http://{address}")).unwrap();
        let wrong_app =
            crate::daemon_health::connection_test(&backend, std::time::Duration::from_secs(2));
        server.join().unwrap();
        assert!(wrong_app.reachable);
        assert!(!wrong_app.is_openswarm);

        // Nobody listening: bind a port, drop the listener, probe it.
        let vacated = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = vacated.local_addr().unwrap();
        drop(vacated);
        let backend = parse_server_base_url(&format!("http://{address}")).unwrap();
        let unreachable =
            crate::daemon_health::connection_test(&backend, std::time::Duration::from_millis(500));
        assert!(!unreachable.reachable);
        assert!(!unreachable.is_openswarm);
    }

    fn health_sample(status: Option<&str>, app: Option<&str>) -> BackendHealth {
        BackendHealth {
            status: status.map(Into::into),
            app: app.map(Into::into),
            backend_owner: None,
            backend_version: None,
            backend_instance_id: None,
            backend_pid: None,
            backend_parent_pid: None,
            uptime_s: None,
        }
    }

    #[test]
    fn daemon_identity_requires_ok_status_and_openswarm_app() {
        assert!(identity_matches(&health_sample(Some("ok"), Some("openswarm"))));
        assert!(!identity_matches(&health_sample(Some("ok"), Some("vega-agent"))));
        assert!(!identity_matches(&health_sample(Some("degraded"), Some("openswarm"))));
        assert!(!identity_matches(&health_sample(None, Some("openswarm"))));
        assert!(!identity_matches(&health_sample(Some("ok"), None)));
    }

    /// The /api/health contract is deserialized leniently: unknown fields are
    /// ignored and missing fields become None, so the daemon payload can evolve
    /// without breaking older shells.
    #[test]
    fn health_contract_tolerates_unknown_and_missing_fields() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let body = r#"{"status":"ok","app":"openswarm","backend_owner":"service","backend_version":"0.20.10","backend_instance_id":null,"backend_pid":4242,"uptime_s":12.5,"future_field":{"nested":true}}"#;
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 512];
            let _ = stream.read(&mut request).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body,
            )
            .unwrap();
        });

        let backend = url::Url::parse(&format!("http://{address}/")).unwrap();
        let health = fetch_backend_health(&backend).expect("health must parse");
        assert!(identity_matches(&health));
        assert_eq!(health.backend_pid, Some(4242));
        assert_eq!(health.backend_version.as_deref(), Some("0.20.10"));
        assert_eq!(health.backend_instance_id, None);
        assert_eq!(health.backend_parent_pid, None);
        assert_eq!(health.uptime_s, Some(12.5));
        server.join().unwrap();
    }

    #[test]
    fn backend_recovery_tracker_reattaches_only_after_pid_change() {
        let mut tracker = BackendRecoveryTracker::new(Some(10), false);
        assert_eq!(tracker.observe_unavailable(), BackendRecoveryEvent::None);
        assert_eq!(tracker.observe_healthy(Some(10)), BackendRecoveryEvent::None);

        assert_eq!(tracker.observe_unavailable(), BackendRecoveryEvent::None);
        assert_eq!(tracker.observe_unavailable(), BackendRecoveryEvent::Disconnected);
        // The same daemon was briefly slow and recovered — no WebView reload needed.
        assert_eq!(tracker.observe_healthy(Some(10)), BackendRecoveryEvent::None);

        assert_eq!(tracker.observe_unavailable(), BackendRecoveryEvent::None);
        assert_eq!(tracker.observe_unavailable(), BackendRecoveryEvent::Disconnected);
        assert_eq!(
            tracker.observe_healthy(Some(11)),
            BackendRecoveryEvent::Reconnect { previous_pid: Some(10), pid: Some(11) },
        );
        assert_eq!(tracker.observe_healthy(Some(11)), BackendRecoveryEvent::None);

        assert_eq!(
            tracker.observe_healthy(Some(12)),
            BackendRecoveryEvent::Reconnect { previous_pid: Some(11), pid: Some(12) },
        );
    }

    #[test]
    fn backend_recovery_tracker_can_start_from_failure_page() {
        let mut tracker = BackendRecoveryTracker::new(None, true);
        assert_eq!(
            tracker.observe_healthy(Some(21)),
            BackendRecoveryEvent::Reconnect { previous_pid: None, pid: Some(21) },
        );
    }

    #[test]
    fn structured_origin_rejects_deceptive_urls() {
        let base = url::Url::parse("http://localhost:3847").unwrap();
        for candidate in [
            "http://localhost.evil.test:3847",
            "http://localhost@evil.test:3847",
            "http://sub.localhost:3847",
            "http://localhost:3848",
        ] {
            assert!(!same_origin(&url::Url::parse(candidate).unwrap(), &base), "{candidate}");
        }
        assert!(same_origin(&url::Url::parse("http://localhost:3847/app").unwrap(), &base));
        assert!(same_origin(
            &url::Url::parse("https://client.example.test/app").unwrap(),
            &url::Url::parse("https://client.example.test").unwrap(),
        ));
    }

    #[test]
    fn trusted_policy_denies_opaque_and_unrelated_origins() {
        let configured = super::backend_base().unwrap();
        let other_port = if configured.port_or_known_default() == Some(3848) {
            3847
        } else {
            3848
        };
        for candidate in [
            "data:text/html,evil",
            "about:blank",
            "file:///tmp/evil.html",
            "mailto:help@example.test",
            "openswarm-oauth://callback?code=unexpected",
            "http://localhost.evil.test:3847",
            "http://localhost@evil.test:3847",
            &format!("http://127.0.0.1:{other_port}"),
        ] {
            assert!(!trusted_webview_url(&url::Url::parse(candidate).unwrap()), "{candidate}");
        }
        assert!(trusted_webview_url(&url::Url::parse("tauri://localhost/index.html").unwrap()));
        assert!(trusted_webview_url(
            &url::Url::parse("https://tauri.localhost/index.html").unwrap()
        ));
    }

    /// Windows WebView2 serves app assets over http://tauri.localhost; macOS and
    /// Linux use tauri://localhost. All platform schemes must be trusted
    /// (vega INT-2887).
    #[test]
    fn tauri_asset_origin_is_trusted_on_every_platform_scheme() {
        for candidate in [
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
            "tauri://localhost/index.html",
        ] {
            assert!(tauri_asset_origin(&url::Url::parse(candidate).unwrap()), "{candidate}");
        }
    }

    /// Widening the scheme must not widen the host.
    #[test]
    fn lookalike_asset_hosts_stay_untrusted() {
        for candidate in [
            "http://tauri.localhost.evil.test/x",
            "https://tauri.localhost.evil.test/x",
            "http://sub.tauri.localhost/x",
            "http://tauri.localhost@evil.test/x",
            "http://tauri.localhost:3847/x",
            "http://evil.test/x",
            "data:text/html,evil",
            "file:///etc/passwd",
        ] {
            assert!(!tauri_asset_origin(&url::Url::parse(candidate).unwrap()), "{candidate}");
        }
    }

    /// The asset origin must not depend on the backend resolving; a corrupt
    /// client config previously rejected every navigation on all platforms.
    #[test]
    fn asset_origin_survives_an_unusable_backend() {
        let unusable = url::Url::parse("http://127.0.0.1:1/").unwrap();
        assert!(trusted_webview_url_for_backend(
            &url::Url::parse("http://tauri.localhost/index.html").unwrap(),
            &unusable
        ));
    }

    /// vega INT-2895: the asset check must run *before* the backend is consulted.
    /// A corrupt client config makes `backend_base()` return Err; rejecting the
    /// window's own first navigation there hands the app to the OS browser.
    #[test]
    fn assets_are_trusted_even_when_the_backend_cannot_be_resolved() {
        let broken = || Err("config.json is corrupt".to_string());
        for candidate in [
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
            "tauri://localhost/index.html",
        ] {
            assert!(
                trusted_webview_url_with_backend(&url::Url::parse(candidate).unwrap(), broken()),
                "asset origin must survive an unresolvable backend: {candidate}"
            );
        }
    }

    /// The same failure must not become a blanket allow — everything that is not
    /// an asset origin still has to be rejected when the backend is unknown.
    #[test]
    fn a_broken_backend_does_not_trust_anything_else() {
        for candidate in [
            "http://127.0.0.1:3847/",
            "http://evil.test/",
            "https://tauri.localhost.evil.test/",
        ] {
            assert!(
                !trusted_webview_url_with_backend(
                    &url::Url::parse(candidate).unwrap(),
                    Err("config.json is corrupt".to_string())
                ),
                "must stay untrusted when the backend is unknown: {candidate}"
            );
        }
    }

    #[test]
    fn navigation_callback_policy_uses_structured_origins() {
        let configured = super::backend_base().unwrap();
        let other_port = if configured.port_or_known_default() == Some(3848) {
            3847
        } else {
            3848
        };
        for candidate in [
            "http://localhost.evil.test:3847",
            "http://localhost@evil.test:3847",
            "http://sub.localhost:3847",
            &format!("http://127.0.0.1:{other_port}"),
            "https://tauri.localhost.evil.test",
        ] {
            assert!(!navigation_allowed(&url::Url::parse(candidate).unwrap()), "{candidate}");
        }
        assert!(navigation_allowed(&configured.join("").unwrap()));
        assert!(navigation_allowed(&url::Url::parse("tauri://localhost/index.html").unwrap()));
    }

    #[test]
    fn configured_client_origin_is_allowed_without_prefix_bypasses() {
        let backend = url::Url::parse("https://client.example.test:8443/base/").unwrap();
        assert!(trusted_webview_url_for_backend(
            &url::Url::parse("https://client.example.test:8443/app").unwrap(),
            &backend,
        ));
        for candidate in [
            "https://client.example.test.evil.test:8443/app",
            "https://client.example.test@evil.test:8443/app",
            "https://sub.client.example.test:8443/app",
            "https://client.example.test:8444/app",
        ] {
            assert!(
                !trusted_webview_url_for_backend(&url::Url::parse(candidate).unwrap(), &backend),
                "{candidate}"
            );
        }
    }
}

#[cfg(test)]
mod log_tail_tests {
    use super::{backend_failure_script, progress_script, LogTail};
    use std::io::Write;

    #[test]
    fn dynamic_ui_values_are_json_serialized_and_rendered_as_text() {
        let hostile = "quote '\" <tag> \\ slash\nnewline";
        let serialized = serde_json::to_string(hostile).unwrap();
        assert_eq!(serde_json::from_str::<String>(&serialized).unwrap(), hostile);
        assert!(serialized.contains("\\\""));
        assert!(serialized.contains("\\\\"));
        assert!(serialized.contains("\\n"));
        assert_eq!(
            progress_script(42, hostile),
            format!("window.osProgress && window.osProgress(42, {serialized})")
        );

        let failure = backend_failure_script(hostile, hostile);
        assert!(!failure.contains("innerHTML"));
        assert!(failure.contains("textContent"));
        assert_eq!(failure.matches(&serialized).count(), 2);
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("openswarm-tail-test-{}-{name}.log", std::process::id()))
    }

    #[test]
    fn skips_existing_reads_appended_and_handles_partial_lines() {
        let p = tmp("basic");
        std::fs::write(&p, "old-line\n").unwrap();
        let mut t = LogTail::new(p.clone(), None); // from EOF — previous lines excluded
        assert!(t.read_new_lines().is_empty());

        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        write!(f, "a\nb\n").unwrap();
        assert_eq!(t.read_new_lines(), vec!["a", "b"]);

        // A line without a trailing newline is buffered until completed.
        write!(f, "partial").unwrap();
        assert!(t.read_new_lines().is_empty());
        writeln!(f).unwrap();
        assert_eq!(t.read_new_lines(), vec!["partial"]);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn resets_on_truncate_and_starts_from_offset() {
        let p = tmp("rotate");
        std::fs::write(&p, "first\nsecond\n").unwrap();
        let mut t = LogTail::new(p.clone(), Some(6)); // after "first\n"
        assert_eq!(t.read_new_lines(), vec!["second"]);

        std::fs::write(&p, "rotated\n").unwrap(); // truncate + new content
        assert_eq!(t.read_new_lines(), vec!["rotated"]);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn missing_file_is_silent() {
        let mut t = LogTail::new(tmp("nope-not-created"), None);
        assert!(t.read_new_lines().is_empty());
    }

    #[test]
    fn waits_for_split_multibyte_character_without_stalling_or_corruption() {
        let p = tmp("split-utf8");
        std::fs::write(&p, [b'x', b' ', 0xe2, 0x82]).unwrap();
        let mut t = LogTail::new(p.clone(), Some(0));
        assert!(t.read_new_lines().is_empty());
        assert_eq!(t.pos, 4);

        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(&[0xac, b'\n']).unwrap();
        assert_eq!(t.read_new_lines(), vec!["x €"]);
        assert_eq!(t.pos, 6);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn malformed_complete_line_is_lossy_and_advances() {
        let p = tmp("malformed");
        std::fs::write(&p, [b'a', 0xff, b'b', b'\n']).unwrap();
        let mut t = LogTail::new(p.clone(), Some(0));
        assert_eq!(t.read_new_lines(), vec!["a�b"]);
        assert_eq!(t.pos, 4);
        assert!(t.read_new_lines().is_empty());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn discards_overlong_line_and_recovers_after_split_multibyte_boundary() {
        let p = tmp("overlong");
        let mut bytes = vec![b'x'; 64 * 1024 - 1];
        bytes.extend_from_slice(&[0xe2]);
        std::fs::write(&p, &bytes).unwrap();
        let mut t = LogTail::new(p.clone(), Some(0));
        assert!(t.read_new_lines().is_empty());
        assert_eq!(t.pos, 64 * 1024);

        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(&[0x82, 0xac, b'\n', b'o', b'k', b'\n']).unwrap();
        assert_eq!(t.read_new_lines(), vec!["ok"]);
        assert_eq!(t.pos, bytes.len() as u64 + 6);
        let _ = std::fs::remove_file(&p);
    }
}
