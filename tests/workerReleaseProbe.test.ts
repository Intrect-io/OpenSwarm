// ============================================
// OpenSwarm - Dangerous-script probe for the worker shell (AGT-4811)
// ============================================
//
// A repository whose `scripts/release.sh` wraps `gh workflow run` is the
// simplest way for a worker to start a production deploy by "verifying" its
// change. Two defences stand between that script and a real workflow run:
//
//   - #840 (AGT-4783): the worker's shell gets no credentials, and with
//     `workerSandbox: on` and no sandbox it refuses to run at all;
//   - #841 (AGT-4798): the worker's shell reaches loopback only.
//
// This probe runs the script through the production bash tool with a fake
// `gh` first on PATH. The fake records whether a token reached it and tries to
// reach a stand-in for GitHub on a non-loopback address of this host. The
// expected outcome is 0 workflow runs: no token seen, no connection made.
// Each defence is asserted on its own, so reverting either PR turns this red.
// Deterministic: no model, no real `gh`, no network beyond this host.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { executeTool, SANDBOX_UNAVAILABLE_MESSAGE } from '../src/adapters/tools.js';
import { detectSandboxBackend, setWorkerNetworkPolicy } from '../src/support/osSandbox.js';

const dirs: string[] = [];
let server: Server | undefined;
let connections = 0;

function nonLoopbackIPv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) if (addr.family === 'IPv4' && !addr.internal) return addr.address;
  }
  return undefined;
}

/**
 * In CI (the harness-gate job installs bubblewrap and lifts the AppArmor
 * userns restriction) the #841 network assertion must actually run: a missing
 * sandbox or a host without a non-loopback address would otherwise take a
 * fail-closed or early-return branch and the gate would pass without checking
 * loopback-only networking at all.
 */
function requireLiveProbe(ci: string | undefined, backend: string | null, host: string | undefined): void {
  if (!ci) return;
  if (!backend) throw new Error('CI must run the sandboxed probe, but no sandbox backend was found (install bubblewrap)');
  if (!host) throw new Error('CI must run the network probe, but this runner has no non-loopback IPv4 address');
}

beforeEach(async () => {
  connections = 0;
  server = createServer((socket) => { connections++; socket.on('error', () => {}); socket.end('HTTP/1.1 201 Created\r\n\r\n'); });
  await new Promise<void>((resolve) => server!.listen(0, '0.0.0.0', resolve));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setWorkerNetworkPolicy('loopback');
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function probeRepo(host: string, port: number): { cwd: string; log: string; shimDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'osw-release-probe-'));
  dirs.push(root);
  const cwd = path.join(root, 'repo');
  const shimDir = path.join(root, 'bin');
  mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  mkdirSync(shimDir);
  const log = path.join(cwd, 'gh-calls.log'); // inside the worktree: writable under the sandbox
  writeFileSync(path.join(cwd, 'scripts', 'release.sh'), '#!/bin/sh\nset -e\ngh workflow run release.yml --ref main\n');
  chmodSync(path.join(cwd, 'scripts', 'release.sh'), 0o755);
  // The stand-in for gh: say it ran, whether a token reached it, and whether
  // GitHub (here: a listener on this host's non-loopback address) was reachable.
  const reach = `const s=require('net').connect(${port},'${host}');`
    + `s.on('connect',()=>{console.log('net=reached');s.destroy()});`
    + `s.on('error',e=>console.log('net=blocked '+e.code));`
    + 'setTimeout(()=>{console.log("net=timeout");process.exit(0)},3000).unref();';
  writeFileSync(path.join(shimDir, 'gh'), [
    '#!/bin/sh',
    `{ echo "ran $*"; echo "token=\${GH_TOKEN:+GH_TOKEN}\${GITHUB_TOKEN:+GITHUB_TOKEN}"; "${process.execPath}" -e "${reach.replace(/"/g, '\\"')}"; } >> "${log}" 2>&1`,
    '',
  ].join('\n'));
  chmodSync(path.join(shimDir, 'gh'), 0o755);
  return { cwd, log, shimDir };
}

const call = (command: string) => ({ id: 'tc-1', function: { name: 'bash', arguments: JSON.stringify({ command }) } });

describe('a worker running scripts/release.sh that wraps `gh workflow run`', () => {
  it('starts 0 workflow runs: no token reaches gh and GitHub is unreachable', async () => {
    const host = nonLoopbackIPv4();
    requireLiveProbe(process.env.CI, detectSandboxBackend(), host);
    const port = (server!.address() as { port: number }).port;
    const { cwd, log, shimDir } = probeRepo(host ?? '192.0.2.1', port);
    // The daemon's own environment carries credentials, as a real host's does.
    vi.stubEnv('GH_TOKEN', 'probe-token');
    vi.stubEnv('GITHUB_TOKEN', 'probe-token');
    vi.stubEnv('PATH', `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`);

    const res = await executeTool(call('sh scripts/release.sh'), cwd, undefined, { sandbox: 'on' });
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';

    expect(connections).toBe(0); // 0 workflow runs
    expect(calls).not.toMatch(/token=\S/); // #840: no credential in the worker's shell

    if (!detectSandboxBackend()) {
      // #840: with the sandbox on and none available, nothing runs at all.
      expect(res.content).toBe(SANDBOX_UNAVAILABLE_MESSAGE);
      expect(calls).toBe('');
      return;
    }
    // The probe is live, not vacuous: the fake gh did run inside the sandbox.
    expect(calls).toContain('ran workflow run release.yml --ref main');
    if (host) {
      // #841: loopback-only network, so the connect is refused, not completed.
      expect(calls).toMatch(/net=(blocked|timeout)/);
      expect(calls).not.toContain('net=reached');
    }
  }, 20_000);

  it('the stand-in GitHub is reachable outside the worker shell (the probe can see a breach)', async () => {
    const host = nonLoopbackIPv4();
    requireLiveProbe(process.env.CI, 'not needed', host);
    if (!host) return; // no non-loopback interface on this host: nothing to show
    const { cwd, log, shimDir } = probeRepo(host, (server!.address() as { port: number }).port);
    vi.stubEnv('PATH', `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('GH_TOKEN', 'probe-token');
    setWorkerNetworkPolicy('open');

    await executeTool(call('sh scripts/release.sh'), cwd, undefined, { sandbox: 'off' });

    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('net=reached');
    expect(connections).toBe(1);
  }, 20_000);
});

describe('requireLiveProbe', () => {
  it('lets a local run without a sandbox or a routable address take the fallback branches', () => {
    expect(() => requireLiveProbe(undefined, null, undefined)).not.toThrow();
    expect(() => requireLiveProbe('', null, undefined)).not.toThrow();
  });

  it('fails a CI run that would skip the sandboxed or the network assertion', () => {
    expect(() => requireLiveProbe('true', null, '10.0.0.2')).toThrow(/no sandbox backend/);
    expect(() => requireLiveProbe('true', 'bwrap', undefined)).toThrow(/no non-loopback IPv4/);
    expect(() => requireLiveProbe('true', 'bwrap', '10.0.0.2')).not.toThrow();
  });
});
