//! Desktop/daemon health identity contract.
//!
//! The shell must not treat an arbitrary HTTP 200 on port 3847 as the OpenSwarm
//! daemon. The daemon's `/api/health` (developed in parallel on the daemon side;
//! contract fixed for INT-3388) responds with:
//!
//! ```json
//! {"status":"ok","app":"openswarm","backend_owner":"...","backend_version":"...",
//!  "backend_instance_id":"...","backend_pid":123,"backend_parent_pid":1,"uptime_s":42}
//! ```
//!
//! Unknown fields are ignored and every field is optional so the shell keeps
//! working while the daemon payload evolves.

#[derive(Debug, serde::Deserialize)]
pub(crate) struct BackendHealth {
    pub(crate) status: Option<String>,
    pub(crate) app: Option<String>,
    #[allow(dead_code)]
    pub(crate) backend_owner: Option<String>,
    #[allow(dead_code)]
    pub(crate) backend_version: Option<String>,
    #[allow(dead_code)]
    pub(crate) backend_instance_id: Option<String>,
    pub(crate) backend_pid: Option<u32>,
    #[allow(dead_code)]
    pub(crate) backend_parent_pid: Option<u32>,
    #[allow(dead_code)]
    pub(crate) uptime_s: Option<f64>,
}

pub(crate) fn fetch_backend_health(backend: &url::Url) -> Option<BackendHealth> {
    let health = backend.join("api/health").ok()?;
    if !matches!(health.scheme(), "http" | "https") {
        return None;
    }
    reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(800))
        .timeout(std::time::Duration::from_millis(800))
        .build()
        .ok()?
        .get(health)
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .ok()
}

/// The shell attaches to any healthy OpenSwarm daemon: unlike vega's bundled
/// sidecar there is no owner/version/instance pinning because the daemon is an
/// independently updated launchd service, not something this shell spawned.
pub(crate) fn identity_matches(health: &BackendHealth) -> bool {
    health.status.as_deref() == Some("ok") && health.app.as_deref() == Some("openswarm")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackendRecoveryEvent {
    None,
    Disconnected,
    Reconnect { previous_pid: Option<u32>, pid: Option<u32> },
}

/// Tracks an already-navigated daemon connection across launchd respawns.
///
/// A single failed health sample is treated as transient. Two consecutive failures
/// establish a disconnect; the next healthy sample must reattach the WebView. A PID
/// change between healthy samples also reattaches even when launchd restarted the
/// daemon quickly enough that the polling loop never observed the outage.
pub(crate) struct BackendRecoveryTracker {
    last_pid: Option<u32>,
    failed_samples: u8,
    disconnected: bool,
}

impl BackendRecoveryTracker {
    pub(crate) fn new(initial_pid: Option<u32>, initially_disconnected: bool) -> Self {
        Self {
            last_pid: initial_pid,
            failed_samples: if initially_disconnected { 2 } else { 0 },
            disconnected: initially_disconnected,
        }
    }

    pub(crate) fn observe_unavailable(&mut self) -> BackendRecoveryEvent {
        self.failed_samples = self.failed_samples.saturating_add(1);
        if self.failed_samples >= 2 && !self.disconnected {
            self.disconnected = true;
            return BackendRecoveryEvent::Disconnected;
        }
        BackendRecoveryEvent::None
    }

    pub(crate) fn observe_healthy(&mut self, pid: Option<u32>) -> BackendRecoveryEvent {
        let previous_pid = self.last_pid;
        let pid_changed =
            matches!((previous_pid, pid), (Some(previous), Some(current)) if previous != current);
        // A WebView already attached to the dashboard keeps talking to the same
        // process after a brief slowdown; a location.replace() there would amplify
        // sleep/wake or a short health timeout into a page reload. Only the initial
        // failure page has no PID baseline, so it navigates on recovery; afterwards
        // only a real PID swap counts as a reattach signal (vega INT-2925).
        let recovered_from_initial_failure = self.disconnected && previous_pid.is_none();
        let should_reconnect = recovered_from_initial_failure || pid_changed;
        self.last_pid = pid.or(previous_pid);
        self.failed_samples = 0;
        self.disconnected = false;
        if should_reconnect {
            BackendRecoveryEvent::Reconnect { previous_pid, pid }
        } else {
            BackendRecoveryEvent::None
        }
    }
}
