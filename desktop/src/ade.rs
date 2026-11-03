//! ADE workspace window: a bundled local page that watches agent runs.
//!
//! The legacy main window loads the daemon's own web pages, which made the
//! desktop app a browser with a tray icon. The ADE window instead loads
//! `dist/ade/index.html` from the app bundle and reads the daemon through the
//! commands below, so the page never needs network access, a remote
//! capability, or the daemon's CORS allowlist.
//!
//! The proxy is read-only and allowlisted by path. The page is untrusted with
//! respect to WHAT it asks for: a compromised or buggy page can only reach the
//! five read surfaces listed in [`allowlisted_daemon_path`], each with a fixed
//! set of query keys, and never a mutating method.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Window label of the ADE workspace.
pub(crate) const ADE_WINDOW: &str = "ade";
/// Event name the daemon's SSE stream is re-emitted under, to the ADE window only.
pub(crate) const ADE_EVENT: &str = "ade-event";

/// Largest JSON body the proxy hands the page (the diff route caps itself at 256 KiB).
const MAX_BODY_BYTES: u64 = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// SSE event types the workspace renders; everything else stays in the daemon.
const FORWARDED_EVENT_TYPES: &[&str] = &[
    "log",
    "pipeline:stage",
    "task:queued",
    "task:started",
    "task:completed",
];

/// A task id as the daemon prints it: issue UUIDs, `INT-123`, `t_abc`, `swarm:x`.
/// Anything else (slashes, dots-only, `%`, whitespace) is refused before it can
/// shape the request path.
fn valid_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id != "."
        && id != ".."
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '@'))
}

fn digits(value: &str, max_len: usize) -> bool {
    !value.is_empty() && value.len() <= max_len && value.chars().all(|c| c.is_ascii_digit())
}

/// Map a page request onto a daemon path, or refuse it.
///
/// Returns the path plus a query string built only from keys that route
/// accepts; values are validated, never passed through. `/api/events` is the
/// SSE stream and only ever opened by [`ade_subscribe_events`], never by
/// [`ade_get`].
pub(crate) fn allowlisted_daemon_path(
    path: &str,
    query: &BTreeMap<String, String>,
) -> Result<String, String> {
    let refuse = || Err(format!("path is not an ADE read surface: {path}"));
    let only = |allowed: &[&str]| -> Result<(), String> {
        match query.keys().find(|key| !allowed.contains(&key.as_str())) {
            Some(key) => Err(format!("query key not allowed for {path}: {key}")),
            None => Ok(()),
        }
    };

    if path == "/api/work/sessions" {
        only(&["limit"])?;
        return match query.get("limit") {
            Some(limit) if digits(limit, 3) => Ok(format!("{path}?limit={limit}")),
            Some(_) => Err("limit must be a number".into()),
            None => Ok(path.to_string()),
        };
    }
    if path == "/api/work/diff" {
        only(&["taskId", "maxBytes"])?;
        let task = query.get("taskId").ok_or("taskId is required for /api/work/diff")?;
        if !valid_task_id(task) {
            return Err("taskId has characters a task id never has".into());
        }
        let mut out = format!("{path}?taskId={task}");
        if let Some(max) = query.get("maxBytes") {
            if !digits(max, 7) {
                return Err("maxBytes must be a number".into());
            }
            out.push_str(&format!("&maxBytes={max}"));
        }
        return Ok(out);
    }
    if path == "/api/events" {
        only(&[])?;
        return Ok(format!("{path}?skipReplay=1"));
    }
    if let Some(rest) = path.strip_prefix("/api/work/sessions/") {
        if let Some(id) = rest.strip_suffix("/log") {
            only(&[])?;
            return if valid_task_id(id) { Ok(path.to_string()) } else { refuse() };
        }
        return refuse();
    }
    if let Some(id) = path.strip_prefix("/api/automation/runs/") {
        only(&[])?;
        return if valid_task_id(id) { Ok(path.to_string()) } else { refuse() };
    }
    refuse()
}

/// Join a validated path onto the configured daemon origin.
fn daemon_url(base: &url::Url, path_and_query: &str) -> Result<url::Url, String> {
    let joined = base.join(path_and_query).map_err(|error| error.to_string())?;
    // `join` resolves `//host` and absolute URLs; the allowlist already rules
    // them out, and this keeps it true if the allowlist ever loosens.
    if joined.origin() != base.origin() {
        return Err("refusing to leave the daemon origin".into());
    }
    Ok(joined)
}

fn http_client(timeout: Option<Duration>) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5));
    builder = match timeout {
        Some(timeout) => builder.timeout(timeout),
        None => builder.timeout(None),
    };
    builder.build().map_err(|error| error.to_string())
}

fn get_json(url: &url::Url) -> Result<serde_json::Value, String> {
    let response = http_client(Some(REQUEST_TIMEOUT))?
        .get(url.clone())
        .header("Accept", "application/json")
        .send()
        .map_err(|error| format!("daemon unreachable: {error}"))?;
    let status = response.status();
    let mut body = Vec::new();
    response
        .take(MAX_BODY_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| error.to_string())?;
    if body.len() as u64 > MAX_BODY_BYTES {
        return Err(format!("daemon response exceeds {MAX_BODY_BYTES} bytes"));
    }
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| format!("daemon answered {status} with a non-JSON body"))?;
    if !status.is_success() {
        let detail = value
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("request failed");
        return Err(format!("daemon answered {}: {detail}", status.as_u16()));
    }
    Ok(value)
}

/// The ADE commands answer only the ADE window, and only while it shows the
/// bundled page (never a navigated-away or remote document).
fn trusted_ade_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    window.label() == ADE_WINDOW
        && window
            .url()
            .ok()
            .is_some_and(|url| crate::tauri_asset_origin(&url))
}

/// Read one allowlisted daemon surface.
#[tauri::command]
pub(crate) async fn ade_get(
    window: tauri::WebviewWindow,
    path: String,
    query: Option<BTreeMap<String, String>>,
) -> Result<serde_json::Value, String> {
    if !trusted_ade_window(&window) {
        return Err("untrusted WebView sender".into());
    }
    let query = query.unwrap_or_default();
    let path_and_query = allowlisted_daemon_path(&path, &query)?;
    if path == "/api/events" {
        return Err("subscribe to /api/events with ade_subscribe_events".into());
    }
    let base = crate::client_config::validated_server_base_url()?;
    let url = daemon_url(&base, &path_and_query)?;
    tauri::async_runtime::spawn_blocking(move || get_json(&url))
        .await
        .map_err(|error| error.to_string())?
}

static EVENTS_RUNNING: AtomicBool = AtomicBool::new(false);

/// The `data:` payload of one SSE line, if it is an event the workspace renders.
pub(crate) fn forwarded_event(line: &str) -> Option<serde_json::Value> {
    let payload = line.strip_prefix("data:")?.trim_start();
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let kind = value.get("type")?.as_str()?;
    FORWARDED_EVENT_TYPES.contains(&kind).then_some(value)
}

/// Start (once per process) relaying the daemon's event stream to the ADE window.
///
/// A background thread holds the SSE connection and reconnects with backoff;
/// the page receives `ade-event` events and an `ade-events-status` event on
/// every connect/disconnect, so it can show "live" vs "reconnecting".
#[tauri::command]
pub(crate) fn ade_subscribe_events(window: tauri::WebviewWindow) -> Result<(), String> {
    if !trusted_ade_window(&window) {
        return Err("untrusted WebView sender".into());
    }
    if EVENTS_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let app = window.app_handle().clone();
    std::thread::spawn(move || {
        let mut backoff = Duration::from_secs(1);
        loop {
            let status = |connected: bool, detail: &str| {
                let _ = app.emit_to(
                    ADE_WINDOW,
                    "ade-events-status",
                    serde_json::json!({ "connected": connected, "detail": detail }),
                );
            };
            let result = (|| -> Result<(), String> {
                let base = crate::client_config::validated_server_base_url()?;
                let url = daemon_url(&base, &allowlisted_daemon_path("/api/events", &BTreeMap::new())?)?;
                let response = http_client(None)?
                    .get(url)
                    .header("Accept", "text/event-stream")
                    .send()
                    .map_err(|error| error.to_string())?;
                if !response.status().is_success() {
                    return Err(format!("daemon answered {}", response.status().as_u16()));
                }
                status(true, "");
                backoff = Duration::from_secs(1);
                for line in BufReader::new(response).lines() {
                    let line = line.map_err(|error| error.to_string())?;
                    if let Some(event) = forwarded_event(&line) {
                        let _ = app.emit_to(ADE_WINDOW, ADE_EVENT, event);
                    }
                }
                Err("stream closed".into())
            })();
            if let Err(detail) = result {
                status(false, &detail);
            }
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    });
    Ok(())
}

/// Show the ADE window, building it on first use.
pub(crate) fn show_ade_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window(ADE_WINDOW) {
        let _ = win.unminimize(); // cxt-ignore: error_swallow
        let _ = win.show(); // cxt-ignore: error_swallow
        let _ = win.set_focus(); // cxt-ignore: error_swallow
        return;
    }
    let app = app.clone();
    // Same reason as spawn_settings_window: WebView2 can deadlock when a
    // WebView is created from a menu handler on the UI thread.
    std::thread::spawn(move || build_ade_window(&app));
}

pub(crate) fn build_ade_window<M: Manager<tauri::Wry>>(manager: &M) {
    let builder = WebviewWindowBuilder::new(manager, ADE_WINDOW, WebviewUrl::App("ade/index.html".into()))
        .title("OpenSwarm — ADE")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .center()
        // The bundled page has no business navigating anywhere else; links
        // (a PR, an issue) open in the OS browser instead.
        .on_navigation(|url| {
            if crate::tauri_asset_origin(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                let _ = crate::open_external_url(url.as_str().to_string());
            }
            false
        });
    if let Err(error) = builder.build() {
        crate::shell_log(&format!("[OpenSwarm] failed to create the ADE window: {error}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn ade_proxy_only_reaches_allowlisted_daemon_paths() {
        let none = BTreeMap::new();
        assert_eq!(allowlisted_daemon_path("/api/work/sessions", &none).unwrap(), "/api/work/sessions");
        assert_eq!(
            allowlisted_daemon_path("/api/work/sessions", &q(&[("limit", "50")])).unwrap(),
            "/api/work/sessions?limit=50"
        );
        assert_eq!(
            allowlisted_daemon_path("/api/work/sessions/INT-12/log", &none).unwrap(),
            "/api/work/sessions/INT-12/log"
        );
        assert_eq!(
            allowlisted_daemon_path("/api/work/diff", &q(&[("taskId", "t_ab-1"), ("maxBytes", "65536")])).unwrap(),
            "/api/work/diff?taskId=t_ab-1&maxBytes=65536"
        );
        assert_eq!(
            allowlisted_daemon_path("/api/automation/runs/9f1c-uuid", &none).unwrap(),
            "/api/automation/runs/9f1c-uuid"
        );
        assert_eq!(allowlisted_daemon_path("/api/events", &none).unwrap(), "/api/events?skipReplay=1");

        // Everything else — mutating routes, config, secrets, other reads — is refused.
        for path in [
            "/api/work",
            "/api/service/restart",
            "/api/exec",
            "/api/chat",
            "/api/fs/list",
            "/api/warehouse/file",
            "/api/work/sessions/../../api/exec/log",
            "/api/work/sessions/a/b/log",
            "/api/work/sessions/x/log/extra",
            "/api/automation/runs/a/b",
            "/api/automation/runs/",
            "https://evil.example/api/work/sessions",
            "//evil.example/api/work/sessions",
            "/api/work/sessions/%2e%2e/log",
            "",
        ] {
            assert!(allowlisted_daemon_path(path, &none).is_err(), "must refuse {path}");
        }
        // Query keys and values are validated, never passed through.
        assert!(allowlisted_daemon_path("/api/work/sessions", &q(&[("limit", "1;drop")])).is_err());
        assert!(allowlisted_daemon_path("/api/work/sessions", &q(&[("cursor", "x")])).is_err());
        assert!(allowlisted_daemon_path("/api/work/diff", &none).is_err());
        assert!(allowlisted_daemon_path("/api/work/diff", &q(&[("taskId", "a&b=c")])).is_err());
        assert!(allowlisted_daemon_path("/api/work/diff", &q(&[("taskId", "..")])).is_err());
        assert!(allowlisted_daemon_path("/api/events", &q(&[("skipReplay", "0")])).is_err());
    }

    #[test]
    fn proxied_urls_never_leave_the_daemon_origin() {
        let base = url::Url::parse("http://127.0.0.1:3847").unwrap();
        let url = daemon_url(&base, "/api/work/sessions?limit=5").unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:3847/api/work/sessions?limit=5");
        assert!(daemon_url(&base, "//evil.example/x").is_err());
        assert!(daemon_url(&base, "https://evil.example/x").is_err());
    }

    #[test]
    fn only_rendered_event_types_are_forwarded() {
        let log = r#"data: {"type":"log","data":{"taskId":"t1","stage":"worker","line":"hi","seq":3}}"#;
        assert_eq!(forwarded_event(log).unwrap()["data"]["seq"], 3);
        assert!(forwarded_event(r#"data: {"type":"task:started","data":{"taskId":"t1"}}"#).is_some());
        assert!(forwarded_event(r#"data: {"type":"chat:user","data":{}}"#).is_none());
        assert!(forwarded_event(r#"data: {"type":"stats","data":{}}"#).is_none());
        assert!(forwarded_event(":connected").is_none());
        assert!(forwarded_event("data: not json").is_none());
        assert!(forwarded_event("event: log").is_none());
    }

    #[test]
    fn task_ids_reject_path_and_query_shaping_characters() {
        for ok in ["INT-1", "t_3822a10d", "4b1f0c3e-9a2d-4c1e-8f00-1234567890ab", "swarm:x", "a.b"] {
            assert!(valid_task_id(ok), "{ok}");
        }
        for bad in ["", ".", "..", "a/b", "a%2f", "a b", "a?b", "a#b", "a&b", &"x".repeat(161)] {
            assert!(!valid_task_id(bad), "{bad}");
        }
    }
}
