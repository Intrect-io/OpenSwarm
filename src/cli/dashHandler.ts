// ============================================
// OpenSwarm - `openswarm dash` (AGT-3408)
// ============================================
// Extracted from cli.ts's inline action so the SIGINT/SIGTERM dedupe and
// browser-launch wiring are directly testable, matching the rest of the
// codebase's delegate-to-handler convention.

export interface DashChildProcessLike {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
}

export interface DashDeps {
  startWebServer: (port: number) => Promise<void>;
  stopWebServer: () => Promise<void>;
  spawnBrowser: (url: string) => DashChildProcessLike;
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  log: (message: string) => void;
  logError: (message: string, error: unknown) => void;
  setExitCode: (code: number) => void;
}

export async function runDashCommand(port: number, open: boolean, deps: DashDeps): Promise<void> {
  await deps.startWebServer(port);
  deps.log(`Dashboard running at http://localhost:${port}`);

  if (open) {
    const url = `http://localhost:${port}`;
    const child = deps.spawnBrowser(url);
    let reportedOpenFailure = false;
    const reportOpenFailure = (): void => {
      if (reportedOpenFailure) return;
      reportedOpenFailure = true;
      deps.log(`Open ${url} in your browser`);
    };
    child.on('error', reportOpenFailure);
    child.on('close', (code) => { if (code !== 0) reportOpenFailure(); });
  }

  // Keep process alive; SIGINT and SIGTERM converge on the same idempotent
  // cleanup so `dash` shuts down its server cleanly regardless of which one
  // arrives (e.g. a process manager sending SIGTERM vs. a user's Ctrl+C).
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void deps.stopWebServer()
      .catch((error) => deps.logError('[Dashboard] graceful shutdown failed:', error))
      .finally(() => {
        deps.log('\nDashboard stopped.');
        deps.setExitCode(0);
      });
  };
  deps.onSignal('SIGINT', shutdown);
  deps.onSignal('SIGTERM', shutdown);
}
