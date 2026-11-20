// ============================================
// OpenSwarm — a loopback mutation needs the daemon token (AGT-4814)
// ============================================
//
// A worker's sandboxed shell reaches the daemon on loopback. "Loopback and no
// Origin (or a same-host Origin)" used to authorize a mutation, so a worker
// could POST /api/exec and start unfenced work. These tests pin the new rule
// and the pieces that keep the operator's own clients working.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pipelineConfigs: Array<Record<string, unknown>> = [];
vi.mock('../agents/pairPipeline.js', () => ({
  PairPipeline: class {
    constructor(config: Record<string, unknown>) { pipelineConfigs.push(config); }
    on(): void {}
    async run() { return { success: true, finalStatus: 'approved', workerResult: { summary: 'ok' } }; }
  },
}));

import { isAuthorizedMutation, isAuthorizedLocalRead } from './webAuth.js';
import {
  daemonTokenDir, daemonTokenPath, ensureDaemonToken, readClientDaemonToken,
  readPrivateTokenFile, setActiveDaemonTokenForTesting,
} from './daemonToken.js';
import { buildBwrapArgs, buildMacSandboxProfile } from './osSandbox.js';
import { execTasks, startExecTask } from './webExecTasks.js';

function req(opts: { origin?: string; host?: string; token?: string; remote?: string } = {}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  if (opts.host) headers.host = opts.host;
  if (opts.token) headers['x-openswarm-token'] = opts.token;
  return {
    headers,
    socket: { remoteAddress: opts.remote ?? '127.0.0.1', localAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}

const TOKEN = 'a'.repeat(64);
const ORIGINAL_WEB_TOKEN = process.env.OPENSWARM_WEB_TOKEN;
const ORIGINAL_DAEMON_TOKEN = process.env.OPENSWARM_DAEMON_TOKEN;
let home: string;

beforeEach(() => {
  delete process.env.OPENSWARM_WEB_TOKEN;
  delete process.env.OPENSWARM_DAEMON_TOKEN;
  setActiveDaemonTokenForTesting(TOKEN);
  home = mkdtempSync(join(tmpdir(), 'daemon-token-'));
});

afterEach(() => {
  setActiveDaemonTokenForTesting(null);
  if (ORIGINAL_WEB_TOKEN === undefined) delete process.env.OPENSWARM_WEB_TOKEN;
  else process.env.OPENSWARM_WEB_TOKEN = ORIGINAL_WEB_TOKEN;
  if (ORIGINAL_DAEMON_TOKEN === undefined) delete process.env.OPENSWARM_DAEMON_TOKEN;
  else process.env.OPENSWARM_DAEMON_TOKEN = ORIGINAL_DAEMON_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe('mutations on loopback (AGT-4814)', () => {
  it('refuses a loopback mutation without a token even with a same-host Origin', () => {
    expect(isAuthorizedMutation(req())).toBe(false);
    expect(isAuthorizedMutation(req({ origin: 'http://127.0.0.1:3847', host: '127.0.0.1:3847' }))).toBe(false);
    expect(isAuthorizedMutation(req({ origin: 'http://localhost:3847', host: '127.0.0.1:3847' }))).toBe(false);
    expect(isAuthorizedMutation(req({ remote: '::1' }))).toBe(false);
    expect(isAuthorizedMutation(req({ token: 'b'.repeat(64) }))).toBe(false);
  });

  it('accepts a loopback mutation that carries the daemon token', () => {
    expect(isAuthorizedMutation(req({ token: TOKEN }))).toBe(true);
    expect(isAuthorizedMutation(req({ token: TOKEN, origin: 'http://127.0.0.1:3847', host: '127.0.0.1:3847' }))).toBe(true);
  });

  it('refuses every loopback mutation when no token is set up at all (fails closed)', () => {
    setActiveDaemonTokenForTesting(null);
    expect(isAuthorizedMutation(req())).toBe(false);
  });

  it('still answers loopback reads without a token', () => {
    expect(isAuthorizedLocalRead(req())).toBe(true);
  });
});

describe('the daemon token file', () => {
  const env = () => ({ XDG_CONFIG_HOME: join(home, 'config') });

  it('is created 0600 in a 0700 directory and reused on the next start', () => {
    const first = ensureDaemonToken(env(), home);
    expect(first.source).toBe('created');
    expect(statSync(daemonTokenDir(env(), home)).mode & 0o777).toBe(0o700);
    expect(statSync(daemonTokenPath(env(), home)).mode & 0o777).toBe(0o600);
    const written = readFileSync(daemonTokenPath(env(), home), 'utf8').trim();
    expect(written).toMatch(/^[0-9a-f]{64}$/);
    setActiveDaemonTokenForTesting(null);
    expect(ensureDaemonToken(env(), home).source).toBe('file');
    expect(isAuthorizedMutation(req({ token: written }))).toBe(true);
  });

  it('is not used by a client when other users can read it', () => {
    const dir = daemonTokenDir(env(), home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(daemonTokenPath(env(), home), `${TOKEN}\n`);
    chmodSync(daemonTokenPath(env(), home), 0o644);
    expect(readPrivateTokenFile(daemonTokenPath(env(), home))).toBeNull();
    chmodSync(daemonTokenPath(env(), home), 0o600);
    expect(readClientDaemonToken(env(), home)).toBe(TOKEN);
  });

  it('is hidden inside the worker sandbox on both backends', () => {
    const dir = daemonTokenDir(env(), home);
    const spec = { writableRoots: ['/work'], allowNetwork: false, hiddenRoots: [dir] };
    const bwrap = buildBwrapArgs(spec);
    expect(bwrap.slice(bwrap.indexOf('--tmpfs'), bwrap.indexOf('--tmpfs') + 2)).toEqual(['--tmpfs', dir]);
    expect(buildMacSandboxProfile(spec)).toMatch(new RegExp(`\\(deny file-read\\* file-write\\* \\(subpath "${dir.replace(/[/.]/g, '\\$&')}"\\)\\)$`));
  });
});

describe('POST /api/exec pipelines (AGT-4814)', () => {
  it('builds the exec pipeline with the worker sandbox', async () => {
    pipelineConfigs.length = 0;
    const taskId = startExecTask('do the thing', { projectPath: home });
    await vi.waitFor(() => expect(execTasks.get(taskId)?.status).toBe('completed'));
    expect(pipelineConfigs).toHaveLength(1);
    expect(pipelineConfigs[0].workerSandbox).toBe('on');
  });
});
