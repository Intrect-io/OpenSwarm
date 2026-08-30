import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import dgram from 'node:dgram';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, mkdir, open, readFile, readdir, readlink, realpath, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  prepareCliProcessTreeSpawn,
  terminateCliProcessTree,
  terminateProcessesWithEnvMarker,
  trackCliProcessTree,
  untrackCliProcessTree,
} from '../adapters/processTree.js';
import type { SandboxExecutionResult } from './protocol.js';

export interface WorkspaceIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

export interface SandboxIsolationBackend {
  prove(allowedRoots: string[], socketPath: string): Promise<void>;
  execute(
    workspace: WorkspaceIdentity,
    command: string,
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<SandboxExecutionResult>;
  close(): Promise<void>;
}

class TailCapture {
  private readonly retained: Buffer;
  private retainedBytes = 0;
  private writeOffset = 0;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    this.retained = Buffer.allocUnsafe(maxBytes);
  }

  append(stream: 'stdout' | 'stderr', chunk: Buffer): boolean {
    const decorated = stream === 'stderr'
      ? Buffer.concat([Buffer.from('\n[stderr] '), chunk])
      : chunk;
    this.totalBytes += decorated.length;
    if (decorated.length >= this.maxBytes) {
      decorated.copy(this.retained, 0, decorated.length - this.maxBytes);
      this.retainedBytes = this.maxBytes;
      this.writeOffset = 0;
      return this.totalBytes > this.maxBytes;
    }
    const first = Math.min(decorated.length, this.maxBytes - this.writeOffset);
    decorated.copy(this.retained, this.writeOffset, 0, first);
    if (first < decorated.length) decorated.copy(this.retained, 0, first);
    this.writeOffset = (this.writeOffset + decorated.length) % this.maxBytes;
    this.retainedBytes = Math.min(this.maxBytes, this.retainedBytes + decorated.length);
    return this.totalBytes > this.maxBytes;
  }

  result(): { output: string; truncated: boolean } {
    const truncated = this.totalBytes > this.retainedBytes;
    const start = this.retainedBytes === this.maxBytes ? this.writeOffset : 0;
    const bytes = start === 0
      ? this.retained.subarray(0, this.retainedBytes)
      : Buffer.concat([this.retained.subarray(start), this.retained.subarray(0, start)]);
    const prefix = truncated
      ? `[output limit exceeded; showing last ${this.retainedBytes} bytes]\n`
      : '';
    return { output: prefix + bytes.toString('utf8'), truncated };
  }
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function mountDirectories(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const target of paths) {
    let current = target;
    while (current !== '/' && current !== '/work' && current !== '/home') {
      dirs.add(current);
      current = dirname(current);
    }
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
}

function safeChildEnv(base: NodeJS.ProcessEnv, marker: string): NodeJS.ProcessEnv {
  const home = '/tmp/openswarm-home';
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_CACHE_HOME: `${home}/.cache`,
    XDG_DATA_HOME: `${home}/.local/share`,
    TMPDIR: '/tmp',
    TMP: '/tmp',
    TEMP: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    LC_CTYPE: 'C.UTF-8',
    NO_COLOR: '1',
    TZ: base.TZ ?? 'UTC',
    PYTHONDONTWRITEBYTECODE: '1',
    UV_PYTHON_INSTALL_DIR: '/home/openswarm/.local/share/uv/python',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
    ...(base.CI !== undefined ? { CI: base.CI } : {}),
    OPENSWARM_SANDBOX_PROCESS_MARKER: marker,
  };
}

async function directoryIdentity(path: string): Promise<WorkspaceIdentity> {
  const canonical = await realpath(path);
  const metadata = await stat(canonical, { bigint: true });
  if (!metadata.isDirectory()) throw new Error(`Sandbox workspace is not a directory: ${path}`);
  return { path: canonical, dev: metadata.dev, ino: metadata.ino };
}

async function gitCommonDirectory(workspace: string): Promise<string | undefined> {
  const dotGit = join(workspace, '.git');
  try {
    const metadata = await lstat(dotGit);
    if (metadata.isDirectory()) return dotGit;
    if (!metadata.isFile()) return undefined;
    const declaration = (await readFile(dotGit, 'utf8')).trim();
    const match = declaration.match(/^gitdir:\s*(.+)$/i);
    if (!match) return undefined;
    const gitDir = await realpath(resolve(workspace, match[1]));
    try {
      const common = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
      return await realpath(join(gitDir, common));
    } catch {
      return gitDir;
    }
  } catch {
    return undefined;
  }
}

async function dependencyTargets(workspace: string, roots: string[]): Promise<string[]> {
  const targets: string[] = [];
  for (const name of ['node_modules', '.venv-verify', '.venv', 'venv']) {
    try {
      const entry = join(workspace, name);
      const entryMetadata = await lstat(entry);
      if (!entryMetadata.isSymbolicLink() && !entryMetadata.isDirectory()) continue;
      const target = entryMetadata.isSymbolicLink() ? await realpath(entry) : entry;
      if (!roots.some((root) => pathInside(root, target))) continue;
      if ((await stat(target)).isDirectory()) targets.push(target);
    } catch {
      // Optional dependency path is absent or broken.
    }
  }
  return [...new Set(targets)];
}

export interface SecretMask { path: string; kind: 'file' | 'directory' }

const SECRET_DIRECTORIES = new Set(['.aws', '.ssh', '.gnupg', '.kube', '.docker']);
const SKIP_SCAN_DIRECTORIES = new Set(['.git', 'node_modules', '.venv', '.venv-verify', 'venv', 'target', 'dist', 'build']);

function looksSensitiveFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === '.env' || (lower.startsWith('.env.')
      && !['.env.example', '.env.sample', '.env.template'].includes(lower))) return true;
  if (['.dev.vars', '.envrc', '.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json', 'service-account.json',
    'id_rsa', 'id_ed25519'].includes(lower)) return true;
  return /\.(?:pem|key|p12|pfx)$/.test(lower)
    || /(?:credential|service-account|private-key).+\.json$/.test(lower);
}

export async function discoverWorkspaceSecretMasks(workspace: string, roots: string[]): Promise<SecretMask[]> {
  const masks: SecretMask[] = [];
  const pending = [workspace];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > 100_000) throw new Error('Sandbox secret-mask preflight exceeded its workspace scan ceiling');
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SECRET_DIRECTORIES.has(entry.name)) masks.push({ path: candidate, kind: 'directory' });
        else if (!SKIP_SCAN_DIRECTORIES.has(entry.name)) pending.push(candidate);
        continue;
      }
      const sensitiveDirectoryLink = entry.isSymbolicLink() && SECRET_DIRECTORIES.has(entry.name);
      if (!sensitiveDirectoryLink && !looksSensitiveFile(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        let target: string;
        try { target = await realpath(candidate); } catch { continue; }
        if (!roots.some((root) => pathInside(root, target))) {
          throw new Error(`Sensitive workspace link escapes sandbox roots: ${candidate}`);
        }
        const targetMetadata = await stat(target);
        if (targetMetadata.isDirectory()) masks.push({ path: target, kind: 'directory' });
        else if (targetMetadata.isFile() && targetMetadata.size > 0) masks.push({ path: target, kind: 'file' });
      } else if (entry.isFile() && (await stat(candidate)).size > 0) {
        masks.push({ path: candidate, kind: 'file' });
      }
      if (masks.length > 512) throw new Error('Sandbox secret-mask preflight exceeded its mask ceiling');
    }
  }
  const unique = new Map(masks.map((mask) => [`${mask.kind}:${mask.path}`, mask]));
  return [...unique.values()];
}

function noExternalIpv4Routes(routeTable: string): boolean {
  return routeTable.split('\n').slice(1).filter(Boolean).every((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[0] === 'lo';
  });
}

function noExternalIpv6Routes(routeTable: string): boolean {
  return routeTable.split('\n').filter(Boolean).every((line) => line.trim().split(/\s+/).at(-1) === 'lo');
}

async function proveLoopbackWorks(): Promise<boolean> {
  return await new Promise((resolveProof) => {
    const server = net.createServer((socket) => socket.end('ok'));
    const finish = (ok: boolean) => server.close(() => resolveProof(ok));
    server.once('error', () => resolveProof(false));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return finish(false);
      const client = net.createConnection({ host: '127.0.0.1', port: address.port });
      const timer = setTimeout(() => { client.destroy(); finish(false); }, 500);
      client.once('data', () => { clearTimeout(timer); client.destroy(); finish(true); });
      client.once('error', () => { clearTimeout(timer); finish(false); });
    });
  });
}

async function externalTcpFails(): Promise<boolean> {
  return await new Promise((resolveProof) => {
    const socket = net.createConnection({ host: '1.1.1.1', port: 443 });
    const finish = (failed: boolean) => { socket.destroy(); resolveProof(failed); };
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
    setTimeout(() => finish(true), 500);
  });
}

async function externalUdpFails(): Promise<boolean> {
  return await new Promise((resolveProof) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      socket.close();
      resolveProof(failed);
    };
    socket.once('error', () => finish(true));
    socket.send(Buffer.from([0]), 53, '1.1.1.1', (error) => finish(error !== null));
    setTimeout(() => finish(true), 500);
  });
}

async function externalDnsFails(): Promise<boolean> {
  const resolver = new dns.Resolver();
  resolver.setServers(['1.1.1.1']);
  try {
    return await Promise.race([
      resolver.resolve4('example.com').then(() => false, () => true),
      new Promise<boolean>((resolveProof) => setTimeout(() => resolveProof(true), 750)),
    ]);
  } catch {
    return true;
  } finally {
    resolver.cancel();
  }
}

async function proveNetworkNone(): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Sandbox executor is supported only on Linux');
  const interfaces = (await readdir('/sys/class/net')).sort();
  const [ipv4, ipv6, loopback, tcpFailed, udpFailed, dnsFailed] = await Promise.all([
    readFile('/proc/net/route', 'utf8'),
    readFile('/proc/net/ipv6_route', 'utf8').catch(() => ''),
    proveLoopbackWorks(),
    externalTcpFails(),
    externalUdpFails(),
    externalDnsFails(),
  ]);
  if (interfaces.length !== 1 || interfaces[0] !== 'lo'
      || !noExternalIpv4Routes(ipv4) || !noExternalIpv6Routes(ipv6)
      || !loopback || !tcpFailed || !udpFailed || !dnsFailed) {
    throw new Error('Sandbox executor network proof failed: require loopback-only with no external TCP/UDP/DNS reachability');
  }
}

export class BubblewrapSandboxBackend implements SandboxIsolationBackend {
  private readonly active = new Set<ReturnType<typeof spawn>>();
  private allowedRoots: string[] = [];

  async prove(allowedRoots: string[], socketPath: string): Promise<void> {
    await access('/usr/bin/bwrap', constants.X_OK);
    await proveNetworkNone();
    this.allowedRoots = [...allowedRoots];
    const root = allowedRoots[0];
    const probeDir = await mkdtemp(join(root, '.openswarm-sandbox-probe-'));
    const sibling = join(root, `.openswarm-sandbox-sibling-${randomUUID()}`);
    try {
      await Promise.all([
        mkdir(join(probeDir, '.git')),
        writeFile(join(probeDir, 'inside'), 'inside\n'),
        writeFile(sibling, 'outside\n'),
      ]);
      const identity = await directoryIdentity(probeDir);
      const parentPidNs = await readlink('/proc/self/ns/pid');
      const parentMountNs = await readlink('/proc/self/ns/mnt');
      const command = [
        `test "$(cat inside)" = inside`,
        'test -w .',
        'touch child-write',
        'test ! -s .env.intrect',
        `test ! -e ${shellQuote(sibling)}`,
        `test ! -e ${shellQuote(socketPath)}`,
        'test ! -e /var/run/docker.sock',
        'command -v curl ssh psql docker >/dev/null',
        '! curl -sS --connect-timeout 1 --max-time 2 -o /dev/null http://1.1.1.1',
        '! ssh -o BatchMode=yes -o ConnectTimeout=1 1.1.1.1 true >/dev/null 2>&1',
        '! PGCONNECT_TIMEOUT=1 PGPASSWORD=none psql -h 1.1.1.1 -p 5432 -U none -d none -c "select 1" >/dev/null 2>&1',
        '! docker version >/dev/null 2>&1',
        'test ! -e /home/openswarm/.gitconfig',
        'test "$HOME" = /tmp/openswarm-home',
        `test "$(readlink /proc/self/ns/pid)" != ${shellQuote(parentPidNs)}`,
        `test "$(readlink /proc/self/ns/mnt)" != ${shellQuote(parentMountNs)}`,
        "test \"$(awk -F: 'NR > 2 {gsub(/ /, \"\", $1); print $1}' /proc/net/dev)\" = lo",
      ].join(' && ');
      await writeFile(join(probeDir, '.env.intrect'), 'HUMAN_API_TOKEN=must-not-be-visible\n');
      const result = await this.execute(identity, command, 5_000, 16 * 1024);
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(`Bubblewrap isolation proof failed: ${result.output || `exit ${result.exitCode}`}`);
      }
      const escape = await this.execute(
        identity,
        "setsid /bin/sh -c 'sleep 30' >/dev/null 2>&1 & exit 0",
        2_000,
        4 * 1024,
      );
      if (escape.timedOut || escape.exitCode !== 0) {
        throw new Error(`Bubblewrap PID namespace proof failed: ${escape.output || `exit ${escape.exitCode}`}`);
      }
    } finally {
      await rm(probeDir, { recursive: true, force: true });
      await rm(sibling, { force: true });
    }
  }

  async execute(
    workspace: WorkspaceIdentity,
    command: string,
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<SandboxExecutionResult> {
    const marker = `openswarm-sandbox-${randomUUID()}`;
    const workspaceHandle = await open(
      workspace.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const handles: FileHandle[] = [workspaceHandle];
    try {
      const current = await workspaceHandle.stat({ bigint: true });
      if (!current.isDirectory() || current.dev !== workspace.dev || current.ino !== workspace.ino) {
        throw new Error('Sandbox workspace identity changed after registration');
      }
      const canonical = await realpath(workspace.path);
      if (canonical !== workspace.path || !this.allowedRoots.some((root) => pathInside(root, canonical))) {
        throw new Error('Sandbox workspace escaped its registered root');
      }

      const support: Array<{ path: string; writable: boolean; kind: 'directory' | 'file' }> = [];
      const dotGit = join(workspace.path, '.git');
      const dotGitMetadata = await lstat(dotGit).catch(() => undefined);
      const commonGit = await gitCommonDirectory(workspace.path);
      if (commonGit && !pathInside(workspace.path, commonGit)
          && this.allowedRoots.some((root) => pathInside(root, commonGit))) {
        support.push({ path: commonGit, writable: false, kind: 'directory' });
      }
      for (const target of await dependencyTargets(workspace.path, this.allowedRoots)) {
        support.push({ path: target, writable: false, kind: 'directory' });
      }
      if (dotGitMetadata?.isDirectory()) support.push({ path: dotGit, writable: false, kind: 'directory' });
      else if (dotGitMetadata?.isFile()) support.push({ path: dotGit, writable: false, kind: 'file' });
      for (const entry of support) {
        const flags = constants.O_RDONLY | constants.O_NOFOLLOW
          | (entry.kind === 'directory' ? constants.O_DIRECTORY : 0);
        handles.push(await open(entry.path, flags));
      }

      const childEnv = safeChildEnv(process.env, marker);
      const secretMasks = await discoverWorkspaceSecretMasks(workspace.path, this.allowedRoots);
      const destinations = [workspace.path, ...support.map((entry) => entry.path)];
      const args: string[] = [
        '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
        '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
      ];
      for (const systemPath of ['/usr', '/bin', '/lib', '/lib64', '/etc', '/app', '/opt']) {
        try { await access(systemPath); args.push('--ro-bind', systemPath, systemPath); } catch { /* image path absent */ }
      }
      args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/home', '--tmpfs', '/work');
      const mountPoints = [
        workspace.path,
        ...support.map((entry) => entry.kind === 'file' ? dirname(entry.path) : entry.path),
        ...secretMasks.map((mask) => mask.kind === 'file' ? dirname(mask.path) : mask.path),
      ];
      for (const directory of mountDirectories(mountPoints)) args.push('--dir', directory);
      destinations.forEach((destination, index) => {
        const writable = index === 0 || support[index - 1]?.writable === true;
        args.push(writable ? '--bind' : '--ro-bind', `/proc/self/fd/${index + 3}`, destination);
      });
      for (const mask of secretMasks) {
        args.push(mask.kind === 'file' ? '--ro-bind' : '--tmpfs', ...(mask.kind === 'file' ? ['/dev/null', mask.path] : [mask.path]));
      }
      const uvPython = '/home/openswarm/.local/share/uv/python';
      try {
        await access(uvPython);
        for (const directory of mountDirectories([uvPython])) args.push('--dir', directory);
        args.push('--ro-bind', uvPython, uvPython);
      } catch { /* distribution Python remains available */ }
      args.push('--dir', '/tmp/openswarm-home');
      for (const [key, value] of Object.entries(childEnv)) {
        if (value !== undefined) args.push('--setenv', key, value);
      }
      args.push('--chdir', workspace.path, '--', '/bin/bash', '--noprofile', '--norc', '-c', command);

      const wrapperEnv: NodeJS.ProcessEnv = {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp',
        LANG: 'C.UTF-8',
        OPENSWARM_SANDBOX_PROCESS_MARKER: marker,
      };
      const spec = prepareCliProcessTreeSpawn('/usr/bin/bwrap', args, wrapperEnv);
      return await new Promise((resolveResult, rejectResult) => {
        const capture = new TailCapture(maxOutputBytes);
        const child = spawn(spec.command, spec.args, {
          cwd: '/',
          env: spec.env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe', ...handles.map((handle) => handle.fd)],
          windowsHide: true,
        });
        this.active.add(child);
        trackCliProcessTree(child);
        let timedOut = false;
        let outputLimitExceeded = false;
        let settled = false;
        const timer = setTimeout(() => {
          timedOut = true;
          terminateCliProcessTree(child);
        }, timeoutMs);
        const record = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
          if (capture.append(stream, chunk) && !outputLimitExceeded) {
            outputLimitExceeded = true;
            terminateCliProcessTree(child);
          }
        };
        child.stdout?.on('data', record('stdout'));
        child.stderr?.on('data', record('stderr'));
        child.once('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.active.delete(child);
          untrackCliProcessTree(child);
          rejectResult(error);
        });
        child.once('close', (exitCode, signal) => {
          void (async () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.active.delete(child);
            untrackCliProcessTree(child);
            await terminateProcessesWithEnvMarker(marker);
            const output = capture.result();
            resolveResult({
              output: output.output,
              truncated: output.truncated,
              exitCode,
              signal,
              timedOut,
              outputLimitExceeded,
            });
          })().catch(rejectResult);
        });
      });
    } finally {
      await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
    }
  }

  async close(): Promise<void> {
    for (const child of this.active) terminateCliProcessTree(child);
    this.active.clear();
  }
}

export async function canonicalWorkspaceIdentity(path: string, roots: string[]): Promise<WorkspaceIdentity> {
  const requested = resolve(path);
  const requestedMetadata = await lstat(requested);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error(`Sandbox workspace must be a real directory: ${path}`);
  }
  const identity = await directoryIdentity(path);
  if (identity.path !== requested) {
    throw new Error(`Sandbox workspace path must not traverse symlinks: ${path}`);
  }
  if (!roots.some((root) => pathInside(root, identity.path))) {
    throw new Error(`Sandbox workspace is outside configured roots: ${identity.path}`);
  }
  const git = await lstat(join(identity.path, '.git')).catch(() => undefined);
  if (!git || (!git.isDirectory() && !git.isFile())) {
    throw new Error(`Sandbox workspace is not a Git checkout: ${identity.path}`);
  }
  return identity;
}

export async function canonicalAllowedRoots(roots: string[]): Promise<string[]> {
  const canonical = await Promise.all(roots.map(async (root) => {
    const value = await realpath(root);
    if (!(await stat(value)).isDirectory()) throw new Error(`Sandbox allowed root is not a directory: ${root}`);
    return value;
  }));
  return [...new Set(canonical)].sort();
}
