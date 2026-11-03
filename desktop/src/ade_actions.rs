//! ADE workspace actions: stop and retry a run (opening its PR is `open_url`).
//!
//! These are the only state-changing calls the ADE makes, so three rules
//! hold for every one of them:
//!
//! 1. **The token never reaches the page.** The daemon authorises mutations
//!    with `X-OpenSwarm-Token` (`OPENSWARM_WEB_TOKEN`). The shell reads it from
//!    its own client config (refused unless that file is private, 0600) or its
//!    environment, attaches it here, and scrubs it from anything returned —
//!    including a daemon error that echoes it back.
//! 2. **A person confirms in a native dialog.** The confirmation is shown by
//!    the shell, not the page, so a compromised page cannot click through it.
//! 3. **Only these two requests exist.** No path, method or body comes from
//!    the page: it names an action and a validated task id, and this module
//!    builds the request.

use std::io::Read;
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;

/// What the page may ask for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AdeAction {
    /// Abort the run's pipeline: `DELETE /api/processes/:taskId`.
    Stop { task_id: String },
    /// Dispatch the issue again: `POST /api/work {issueIds, projectPath}`.
    Retry { task_id: String, project_path: String },
}

impl AdeAction {
    pub(crate) fn parse(action: &str, task_id: String, project_path: Option<String>) -> Result<Self, String> {
        if !crate::ade::valid_task_id(&task_id) {
            return Err("task id has characters a task id never has".into());
        }
        match action {
            "stop" => {
                // The daemon reads an all-digit id as a PID and kills that
                // process (`/api/processes/:pid`). A task is never all digits.
                if task_id.chars().all(|c| c.is_ascii_digit()) {
                    return Err("refusing an all-digit id: the daemon would treat it as a process id".into());
                }
                Ok(Self::Stop { task_id })
            }
            "retry" => {
                let project_path = project_path.ok_or("retry needs the run's project path")?;
                if !project_path.starts_with('/') || project_path.contains('\0') || project_path.len() > 4096 {
                    return Err("project path must be an absolute path".into());
                }
                Ok(Self::Retry { task_id, project_path })
            }
            other => Err(format!("unknown ADE action: {other}")),
        }
    }

    /// The question the native dialog asks, and its confirm button.
    pub(crate) fn confirmation(&self) -> (String, &'static str) {
        match self {
            Self::Stop { task_id } => (format!("Stop run {task_id}? Its current attempt is aborted; work already committed on the branch is kept."), "Stop run"),
            Self::Retry { task_id, .. } => (format!("Dispatch {task_id} again? A new attempt starts on the daemon."), "Retry run"),
        }
    }

    /// Method, path and JSON body. Nothing here comes from the page unvalidated.
    pub(crate) fn request(&self) -> (reqwest::Method, String, Option<serde_json::Value>) {
        match self {
            Self::Stop { task_id } => (reqwest::Method::DELETE, format!("/api/processes/{task_id}"), None),
            Self::Retry { task_id, project_path } => (
                reqwest::Method::POST,
                "/api/work".into(),
                Some(serde_json::json!({ "issueIds": [task_id], "projectPath": project_path })),
            ),
        }
    }
}

/// What the page learns about an action. Never carries the token.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct AdeActionOutcome {
    /// `done` or `cancelled` (the person declined the dialog).
    pub status: &'static str,
    pub detail: String,
}

/// Where the token comes from: the client config's `web_token`, then the
/// environment. A config file anyone else can read is refused, not used.
pub(crate) fn daemon_token() -> Result<String, String> {
    if let Some(token) = crate::client_config::private_web_token()? {
        return Ok(token);
    }
    std::env::var("OPENSWARM_WEB_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "no daemon token: set \"web_token\" in the desktop config.json (mode 0600) or OPENSWARM_WEB_TOKEN".into())
}

fn scrub(text: &str, token: &str) -> String {
    if token.is_empty() { text.to_string() } else { text.replace(token, "[redacted]") }
}

/// Send one action to the daemon with the token attached.
pub(crate) fn send_action(base: &url::Url, action: &AdeAction, token: &str) -> Result<serde_json::Value, String> {
    let (method, path, body) = action.request();
    let url = base.join(&path).map_err(|e| e.to_string())?;
    if url.origin() != base.origin() {
        return Err("refusing to leave the daemon origin".into());
    }
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.request(method, url).header("X-OpenSwarm-Token", token).header("Accept", "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().map_err(|e| scrub(&format!("daemon unreachable: {e}"), token))?;
    let status = response.status();
    let mut raw = Vec::new();
    response.take(1024 * 1024).read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = scrub(&String::from_utf8_lossy(&raw), token);
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        let detail = value.get("error").and_then(|e| e.as_str()).map(str::to_string)
            .unwrap_or_else(|| if status.as_u16() == 401 || status.as_u16() == 403 {
                "the daemon refused the token".into()
            } else {
                text.chars().take(200).collect()
            });
        return Err(format!("daemon answered {}: {detail}", status.as_u16()));
    }
    Ok(value)
}

/// The whole flow, with the dialog and the token injected so it is testable.
pub(crate) fn run_action(
    base: &url::Url,
    action: &AdeAction,
    token: impl FnOnce() -> Result<String, String>,
    confirm: impl FnOnce(&str, &str) -> bool,
) -> Result<AdeActionOutcome, String> {
    let (question, button) = action.confirmation();
    if !confirm(&question, button) {
        return Ok(AdeActionOutcome { status: "cancelled", detail: "Nothing was sent.".into() });
    }
    let token = token()?;
    let value = send_action(base, action, &token)?;
    let detail = match action {
        AdeAction::Stop { task_id } => format!("Stop requested for {task_id}."),
        AdeAction::Retry { task_id, .. } => {
            let queued = value.get("queued").and_then(|q| q.as_u64()).unwrap_or(0);
            if queued == 0 {
                return Err(scrub(&format!("the daemon did not queue {task_id}: {value}"), &token));
            }
            format!("{task_id} dispatched again.")
        }
    };
    Ok(AdeActionOutcome { status: "done", detail: scrub(&detail, &token) })
}

/// Stop or retry a run from the ADE window, after a native confirmation.
#[tauri::command]
pub(crate) async fn ade_action(
    window: tauri::WebviewWindow,
    action: String,
    task_id: String,
    project_path: Option<String>,
) -> Result<AdeActionOutcome, String> {
    if !crate::ade::trusted_ade_window(&window) {
        return Err("untrusted WebView sender".into());
    }
    let action = AdeAction::parse(&action, task_id, project_path)?;
    let base = crate::client_config::validated_server_base_url()?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_action(&base, &action, daemon_token, |question, button| {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
            app.dialog()
                .message(question)
                .title("OpenSwarm")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(button.into(), "Cancel".into()))
                .blocking_show()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// A one-request fake daemon: returns what it received and answers `reply`.
    fn fake_daemon(status: &'static str, reply: String) -> (url::Url, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let Ok((stream, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            let mut content_length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" { break; }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    content_length = v.trim().parse().unwrap_or(0);
                }
                head.push_str(&line);
            }
            let mut body = vec![0; content_length];
            let _ = reader.read_exact(&mut body);
            head.push_str(&String::from_utf8_lossy(&body));
            let _ = tx.send(head);
            let mut stream = stream;
            let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
        });
        (base, rx)
    }

    #[test]
    fn ade_mutation_sends_token_header() {
        let (base, seen) = fake_daemon("200 OK", r#"{"ok":true}"#.into());
        let action = AdeAction::parse("stop", "INT-42".into(), None).unwrap();
        let outcome = run_action(&base, &action, || Ok("s3cret-token".into()), |_, _| true).unwrap();
        let request = seen.recv_timeout(Duration::from_secs(5)).unwrap().to_ascii_lowercase();
        assert!(request.starts_with("delete /api/processes/int-42 http/1.1"), "{request}");
        assert!(request.contains("x-openswarm-token: s3cret-token"), "{request}");
        assert_eq!(outcome, AdeActionOutcome { status: "done", detail: "Stop requested for INT-42.".into() });

        let (base, seen) = fake_daemon("202 Accepted", r#"{"queued":1}"#.into());
        let action = AdeAction::parse("retry", "INT-7".into(), Some("/home/u/dev/repo".into())).unwrap();
        run_action(&base, &action, || Ok("s3cret-token".into()), |_, _| true).unwrap();
        let request = seen.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.starts_with("POST /api/work HTTP/1.1"), "{request}");
        assert!(request.contains(r#"{"issueIds":["INT-7"],"projectPath":"/home/u/dev/repo"}"#), "{request}");
    }

    #[test]
    fn ade_token_never_reaches_webview() {
        // A daemon that echoes the token in its error must not hand it to the page.
        let (base, _seen) = fake_daemon("403 Forbidden", r#"{"error":"token s3cret-token is not valid"}"#.into());
        let action = AdeAction::parse("stop", "INT-1".into(), None).unwrap();
        let err = run_action(&base, &action, || Ok("s3cret-token".into()), |_, _| true).unwrap_err();
        assert!(!err.contains("s3cret-token"), "{err}");
        assert!(err.contains("403") && err.contains("[redacted]"), "{err}");

        // Nor in a success that echoes it.
        let (base, _seen) = fake_daemon("202 Accepted", r#"{"queued":0,"why":"s3cret-token"}"#.into());
        let action = AdeAction::parse("retry", "INT-2".into(), Some("/r".into())).unwrap();
        let err = run_action(&base, &action, || Ok("s3cret-token".into()), |_, _| true).unwrap_err();
        assert!(!err.contains("s3cret-token"), "{err}");

        // What the page receives on success has no field that could carry it.
        let outcome = serde_json::to_value(AdeActionOutcome { status: "done", detail: "x".into() }).unwrap();
        assert_eq!(outcome.as_object().unwrap().keys().collect::<Vec<_>>(), vec!["detail", "status"]);
    }

    #[test]
    fn a_declined_confirmation_sends_nothing() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let action = AdeAction::parse("stop", "INT-3".into(), None).unwrap();
        let mut asked = None;
        let outcome = run_action(&base, &action, || panic!("the token must not even be read"), |q, b| {
            asked = Some((q.to_string(), b.to_string()));
            false
        }).unwrap();
        assert_eq!(outcome.status, "cancelled");
        assert!(asked.unwrap().0.contains("Stop run INT-3?"));
        assert!(listener.accept().is_err(), "no request may reach the daemon");
    }

    #[test]
    fn actions_are_validated_before_anything_is_sent() {
        assert!(AdeAction::parse("stop", "1234".into(), None).is_err(), "all-digit ids are PIDs to the daemon");
        assert!(AdeAction::parse("stop", "../../exec".into(), None).is_err());
        assert!(AdeAction::parse("kill", "INT-1".into(), None).is_err());
        assert!(AdeAction::parse("retry", "INT-1".into(), None).is_err());
        assert!(AdeAction::parse("retry", "INT-1".into(), Some("relative/path".into())).is_err());
        assert_eq!(
            AdeAction::parse("retry", "INT-1".into(), Some("/r".into())).unwrap().request().1,
            "/api/work"
        );
    }

    #[test]
    fn a_missing_token_is_an_error_not_an_unauthenticated_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let action = AdeAction::parse("stop", "INT-4".into(), None).unwrap();
        let err = run_action(&base, &action, || Err("no daemon token".into()), |_, _| true).unwrap_err();
        assert!(err.contains("no daemon token"));
        assert!(listener.accept().is_err());
    }
}
