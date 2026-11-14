// ============================================
// OpenSwarm - `openswarm pause` / `openswarm resume` (AGT-4808)
// ============================================
//
// The kill switch from the terminal. Writes the same pause row the dashboard
// writes, in the same automation database the daemon claims from, so the pause
// takes effect on the daemon's next heartbeat with no restart and survives
// one. The database path is resolved exactly like `exec`: the configured
// `autonomous.automationDbPath`, overridable by OPENSWARM_AUTOMATION_DB.

import { userInfo } from 'node:os';
import { loadConfig } from '../core/config.js';
import type { SwarmConfig } from '../core/types.js';
import { defaultAutomationDbPath, setAutomationDbPath } from '../automation/automationDbPath.js';
import {
  FactoryPauseStore,
  GLOBAL_PAUSE_SCOPE,
  formatPauseLine,
  type FactoryPause,
  type PauseMode,
} from '../automation/factoryPause.js';

export interface PauseCommandOptions {
  project?: string;
  now?: boolean;
  drain?: boolean;
  reason?: string;
  list?: boolean;
  json?: boolean;
}

export interface PauseCommandDeps {
  loadConfig?: () => SwarmConfig;
  openStore?: (dbPath: string) => Pick<FactoryPauseStore, 'set' | 'clear' | 'list' | 'close'>;
  actor?: string;
  out?: (line: string) => void;
}

export interface PauseCommandResult {
  exitCode: number;
  dbPath?: string;
  pauses?: FactoryPause[];
}

function resolveDbPath(deps: PauseCommandDeps): string {
  // A missing or broken config must not stop an operator from pulling the
  // kill switch: fall back to the default database path.
  try {
    const config = (deps.loadConfig ?? loadConfig)();
    setAutomationDbPath(config.autonomous?.automationDbPath);
  } catch {
    /* default path */
  }
  return defaultAutomationDbPath();
}

function defaultActor(): string {
  try { return `cli:${userInfo().username}`; } catch { return 'cli'; }
}

export function parsePauseMode(opts: Pick<PauseCommandOptions, 'now' | 'drain'>): PauseMode {
  if (opts.now && opts.drain) throw new Error('--now and --drain are mutually exclusive');
  return opts.now ? 'now' : 'drain';
}

function describeScope(scope: string): string {
  return scope === GLOBAL_PAUSE_SCOPE ? 'the whole factory' : scope;
}

export function runPauseCommand(opts: PauseCommandOptions, deps: PauseCommandDeps = {}): PauseCommandResult {
  const out = deps.out ?? ((line: string) => console.log(line));
  const dbPath = resolveDbPath(deps);
  const store = (deps.openStore ?? ((path: string) => new FactoryPauseStore(path)))(dbPath);
  try {
    if (opts.list) {
      const pauses = store.list();
      if (opts.json) out(JSON.stringify({ dbPath, pauses }));
      else if (pauses.length === 0) out(`Not paused (${dbPath})`);
      else for (const pause of pauses) out(formatPauseLine(pause));
      return { exitCode: 0, dbPath, pauses };
    }
    const mode = parsePauseMode(opts);
    const { pause, existed } = store.set({
      projectPath: opts.project ?? null,
      mode,
      reason: opts.reason,
      actor: deps.actor ?? defaultActor(),
    });
    if (opts.json) {
      out(JSON.stringify({ dbPath, pause, existed }));
    } else {
      out(`${existed ? 'Updated pause' : 'Paused'}: ${describeScope(pause.scope)} (${pause.mode})`);
      out(pause.mode === 'now'
        ? 'The daemon cancels in-flight runs and stops claiming on its next heartbeat.'
        : 'In-flight runs finish; nothing new is claimed from the next heartbeat.');
      out(`Database: ${dbPath}`);
    }
    return { exitCode: 0, dbPath, pauses: [pause] };
  } finally {
    store.close();
  }
}

export function runResumeCommand(opts: Pick<PauseCommandOptions, 'project' | 'json'>, deps: PauseCommandDeps = {}): PauseCommandResult {
  const out = deps.out ?? ((line: string) => console.log(line));
  const dbPath = resolveDbPath(deps);
  const store = (deps.openStore ?? ((path: string) => new FactoryPauseStore(path)))(dbPath);
  try {
    const removed = store.clear(opts.project ?? null);
    const remaining = store.list();
    if (opts.json) {
      out(JSON.stringify({ dbPath, removed, remaining }));
    } else {
      const scope = opts.project ? opts.project : 'the whole factory';
      out(removed ? `Resumed: ${scope}` : `No pause was set for ${scope}`);
      for (const pause of remaining) out(`Still paused: ${formatPauseLine(pause)}`);
    }
    return { exitCode: 0, dbPath, pauses: remaining };
  } finally {
    store.close();
  }
}
