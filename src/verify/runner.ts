import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isInfraError } from '../adapters/errorClassification.js';
import { describeLinuxSandbox, formatSandboxUnavailable, makeSandboxCache, makeSystemProbe } from './sandboxDiagnostics.js';
import { copyIsolatedPath } from '../support/isolatedPath.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { resolveSharedPaths } from '../support/worktreeManager.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { terminateProcessesWithEnvMarker } from '../adapters/processTree.js';
import type { SandboxExecutorSession } from '../sandboxExecutor/protocol.js';
import type { VerifyCommand } from './manifest.js';

const OUTPUT_TAIL_BYTES = 8 * 1024;
const FINGERPRINT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);
const DEPENDENCY_INPUTS = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml',
  'uv.lock', 'poetry.lock',
]);

export interface VerifyEvidence {
  command: VerifyCommand;
  baseStatus: 'pass' | 'fail' | 'infra' | 'skipped';
  headStatus: 'pass' | 'fail' | 'infra';
  newFailure: boolean;
  /** A containment/attestation failure that policy must never make non-blocking. */
  securityFailure?: boolean;
  rawOutputTail: string;
  durationMs: number;
}

export interface RunVerifyOptions {
  projectPath: string;
  commands: VerifyCommand[];
  baseRef: string;
  trustedPackageJsonByDirectory?: Record<string, string>;
  /** Strict-mode companion seam. When present, Linux/macOS host execution is bypassed. */
  sandboxExecutorSessionFactory?: (workspace: string) => Promise<SandboxExecutorSession>;
  /** Parent for disposable Git sandboxes; must be inside the companion's allowed root. */
  sandboxScratchRoot?: string;
}

interface CommandResult {
  status: 'pass' | 'fail' | 'infra';
  output: string;
  securityFailure?: boolean;
  environmentFailure?: boolean;
  baselineEnvironmentChanged?: boolean;
}

async function verificationSharedPaths(projectPath: string, commands: VerifyCommand[]): Promise<string[]> {
  const shared: string[] = [];
  for (const cmd of commands) {
    if (cmd.sharedPaths) shared.push(...cmd.sharedPaths);
  }
  const resolved = await resolveSharedPaths(projectPath, shared);
  return resolved;
}

function isPrivateEnvironmentPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes('.env') || lower.includes('credentials') || lower.includes('secret') || lower.includes('token');
}

function sharedPathSecretFilter(sharedPath: string): (path: string) => boolean {
  return (path: string) => {
    if (isPrivateEnvironmentPath(path)) return false;
    const relativePath = relative(sharedPath, path);
    return !relativePath.startsWith('..') && !isAbsolute(relativePath);
  };
}

function omitVerificationSource(path: string, sharedPaths: string[]): boolean {
  return sharedPaths.some((sp) => {
    const rel = relative(sp, path);
    return !rel.startsWith('..') && !isAbsolute(rel);
  });
}

async function removePrivateEnvironmentFiles(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await removePrivateEnvironmentFiles(fullPath);
    } else if (isPrivateEnvironmentPath(entry.name)) {
      await rm(fullPath, { force: true });
    }
  }
}

function pathCoveredBy(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return !rel.startsWith('..') && !isAbsolute(rel);
  });
}

function isEphemeralVerificationArtifact(path: string): boolean {
  return path.startsWith('/tmp/') || path.includes('/.openswarm/');
}

function hasSameFailure(base: CommandResult, head: CommandResult): boolean {
  if (base.status !== 'fail' || head.status !== 'fail') return false;
  return base.output === head.output;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeFailureOutput(output: string, paths: Array<[string, string]>): string {
  let result = output;
  for (const [from, to] of paths) {
    result = result.replaceAll(from, to);
  }
  return result;
}

function isEnvironmentFailure(output: string): boolean {
  return output.includes('ENOENT') || output.includes('EACCES') || output.includes('Module not found');
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= OUTPUT_TAIL_BYTES ? combined : combined.subarray(combined.length - OUTPUT_TAIL_BYTES);
}

async function terminateVerificationProcesses(processGroupId: number | undefined, marker: string): Promise<void> {
  if (processGroupId && process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(processGroupId), '/T', '/F'], { timeout: 10_000 }).catch(() => {});
    return;
  }
  if (processGroupId && process.platform !== 'win32') {
    try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* already exited */ }
  }
  await validateSandboxSymlinks(projectPath, sharedPaths);
  await terminateProcessesWithEnvMarker(marker);
}

/** Working sandbox memoized, broken one re-probed — see makeSandboxCache. */
const linuxSandbox = makeSandboxCache(() => describeLinuxSandbox(makeSystemProbe({
  exists: existsSync,
  readFile: (path) => readFileSync(path, 'utf8'),
  spawn: (executable, args) => spawnSync(executable, args, { encoding: 'utf8', timeout: 10_000 }),
})));

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * VEGA's file-tool policy deliberately permits only its home, OS temp paths,
 * and explicit user roots.  Verification, however, runs a disposable checkout
 * beneath the companion's /work root; pytest's cwd-relative tmp paths therefore
 * are neither home nor /tmp.  Permit precisely that disposable checkout for
 * VEGA's own tests.  This is not inherited from the supervisor environment and
 * is never a parent sandbox directory.
 */
function vegaVerifyWorkspaceRoot(root: string): string | undefined {
  return existsSync(join(root, 'pipeline', 'path_guard.py')) ? root : undefined;
}

async function runWithSandboxExecutor(
  command: VerifyCommand,
  root: string,
  cwd: string,
  isolatedHome: string,
  isolatedTmp: string,
  sandboxExecutorSessionFactory: (workspace: string) => Promise<SandboxExecutorSession>,
): Promise<CommandResult> {
  const session = await sandboxExecutorSessionFactory(root);
  try {
    const result = await session.run({
      command: command.run,
      cwd,
      env: {
        HOME: isolatedHome,
        TMPDIR: isolatedTmp,
        ...command.env,
      },
    });
    return {
      status: result.exitCode === 0 ? 'pass' : 'fail',
      output: result.stdout + result.stderr,
    };
  } finally {
    await session.cleanup();
  }
}

async function runCommand(
  command: VerifyCommand,
  root: string,
  env: Record<string, string>,
  sandboxExecutorSessionFactory?: (workspace: string) => Promise<SandboxExecutorSession>,
): Promise<CommandResult> {
  const cwd = command.cwd ? join(root, command.cwd) : root;
  const isolatedHome = join(root, 'home');
  const isolatedTmp = join(root, 'tmp');
  if (sandboxExecutorSessionFactory) {
    return await runWithSandboxExecutor(
      command, root, cwd, isolatedHome, isolatedTmp, sandboxExecutorSessionFactory,
    );
  }
  const shell = process.env.SHELL || '/bin/sh';
  let executable = shell;
  let invocationArgs = ['-lc', command.run];
  if (process.platform === 'darwin') {
    if (!existsSync('/usr/bin/sandbox-exec')) {
      return { status: 'fail', output: '[security] macOS sandbox-exec is not available on this host; refusing to run verification unsandboxed' };
    }
    const writableRoot = (await realpath(dirname(root))).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const profile = `(version 1) (deny default) (allow process*) (allow file-read*) (allow sysctl-read) (allow file-write* (subpath "${writableRoot}") (literal "/dev/null") (literal "/dev/tty"))`;
    executable = '/usr/bin/sandbox-exec';
    invocationArgs = ['-p', profile, shell, '-lc', command.run];
  } else if (process.platform === 'linux') {
    // Still fails closed — running a worker's code unsandboxed to decide whether
    // to trust it defeats the point. What changed is that the message now names
    // which of the two causes applies and how to fix it, instead of reporting
    // "unavailable" for a missing binary and dying at exec time with an opaque
    // error for a blocked user namespace. (INT-3103)
    const sandbox = linuxSandbox();
    if (!sandbox.available) return { status: 'fail', output: formatSandboxUnavailable(sandbox) };
    executable = sandbox.executable;
    const writableRoot = dirname(root);
    invocationArgs = ['--ro-bind', '/', '/', '--bind', writableRoot, writableRoot, '--unshare-net', '--dev', '/dev', '--proc', '/proc', '--', shell, '-lc', command.run];
  } else if (process.platform === 'win32') {
    return { status: 'fail', output: '[security] OS verification sandbox is unavailable on this Windows host' };
  }
  return await new Promise((resolveResult) => {
    let output = Buffer.alloc(0);
    const proc = spawn(executable, invocationArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    proc.stdout.on('data', (chunk: Buffer) => { output = appendTail(output, chunk); });
    proc.stderr.on('data', (chunk: Buffer) => { output = appendTail(output, chunk); });
    const timer = setTimeout(() => {
      try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* already exited */ }
      resolveResult({ status: 'infra', output: output.toString('utf8') + '\n[infra] verification command timed out' });
    }, command.timeoutMs ?? 120_000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveResult({ status: 'pass', output: output.toString('utf8') });
      } else {
        resolveResult({ status: 'fail', output: output.toString('utf8') });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolveResult({ status: 'infra', output: `[infra] failed to spawn verification command: ${err.message}` });
    });
  });
}

async function runWithPackageGuard(
  command: VerifyCommand,
  root: string,
  env: Record<string, string>,
  sandboxExecutorSessionFactory?: (workspace: string) => Promise<SandboxExecutorSession>,
): Promise<CommandResult> {
  if (!command.trustedScripts) return await runCommand(command, root, env, sandboxExecutorSessionFactory);
  const cwd = command.cwd ? join(root, command.cwd) : root;
  let directory = cwd;
  const projectRoot = root;
  let trustedPackageJson: string | undefined;
  while (true) {
    try {
      const handle = await open(join(directory, 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (stat.isFile()) {
          trustedPackageJson = await handle.readFile('utf8');
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (trustedPackageJson !== undefined) break;
    if (directory === projectRoot) break;
    directory = dirname(directory);
  }
  if (!trustedPackageJson) return await runCommand(command, root, env, sandboxExecutorSessionFactory);
  const packagePath = join(directory, 'package.json');
  const current = await readFile(packagePath, 'utf8');
  const currentPackage = JSON.parse(current) as Record<string, unknown>;
  const trustedPackage = JSON.parse(trustedPackageJson) as { scripts?: unknown };
  // The verification checkout is disposable, so no restoration is necessary.
  // Atomic replacement also cannot follow a package.json symlink introduced in
  // a race between validation and this write.
  atomicWriteFileSync(packagePath, `${JSON.stringify({ ...currentPackage, scripts: trustedPackage.scripts }, null, 2)}\n`);
  return await runCommand(command, root, env, sandboxExecutorSessionFactory);
}

async function validateSandboxSymlinks(projectPath: string, sharedPaths: string[]): Promise<void> {
  const projectRoot = await realpath(projectPath);
  for (const sharedPath of sharedPaths) {
    const resolved = await realpath(sharedPath).catch(() => sharedPath);
    if (!resolved.startsWith(projectRoot)) {
      throw new Error(`Shared path ${sharedPath} is outside project root ${projectRoot}`);
    }
  }
}

async function prepareSandbox(
  projectPath: string,
  baseRef: string,
  commands: VerifyCommand[],
  sandboxScratchRoot?: string,
): Promise<{
  root: string;
  env: Record<string, string>;
  sharedPaths: string[];
}> {
  const scratchRoot = sandboxScratchRoot ?? tmpdir();
  const root = await mkdtemp(join(scratchRoot, 'verify-'));
  const env: Record<string, string> = {
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  };
  const sharedPaths = await verificationSharedPaths(projectPath, commands);
  // Clone the repo at the base ref
  await execFileAsync('git', ['clone', '--no-checkout', '--shared', projectPath, join(root, 'repo')], { timeout: GIT_TIMEOUT_MS });
  await execFileAsync('git', ['-C', join(root, 'repo'), 'checkout', '-f', baseRef], { timeout: GIT_TIMEOUT_MS });
  // Copy shared paths into sandbox
  for (const sharedPath of sharedPaths) {
    const dest = join(root, 'shared', relative(projectPath, sharedPath));
    await mkdir(dirname(dest), { recursive: true });
    await cp(sharedPath, dest, { recursive: true, force: true });
  }
  return { root, env, sharedPaths };
}

async function runVerifyCommand(
  command: VerifyCommand,
  projectPath: string,
  baseRef: string,
  sandboxExecutorSessionFactory?: (workspace: string) => Promise<SandboxExecutorSession>,
  sandboxScratchRoot?: string,
): Promise<CommandResult> {
  const { root, env, sharedPaths } = await prepareSandbox(projectPath, baseRef, [command], sandboxScratchRoot);
  try {
    return await runWithPackageGuard(command, root, env, sandboxExecutorSessionFactory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runVerify(
  options: RunVerifyOptions,
): Promise<VerifyEvidence[]> {
  const { projectPath, commands, baseRef, trustedPackageJsonByDirectory, sandboxExecutorSessionFactory, sandboxScratchRoot } = options;
  const evidence: VerifyEvidence[] = [];
  for (const command of commands) {
    const started = Date.now();
    const sandbox = await prepareSandbox(projectPath, baseRef, [command], sandboxScratchRoot);
    try {
      const base = await runWithPackageGuard(command, sandbox.root, sandbox.env, sandboxExecutorSessionFactory);
      const head = await runWithPackageGuard(command, sandbox.root, sandbox.env, sandboxExecutorSessionFactory);
      const rawOutputTail = head.output.slice(-OUTPUT_TAIL_BYTES);
      const sameFailure = hasSameFailure(base, head);
      const sameEnvironmentFailure = !!(sameFailure && base.environmentFailure && head.environmentFailure);
      evidence.push({
        command,
        baseStatus: base.status,
        headStatus: head.status,
        securityFailure: base.securityFailure || undefined,
        newFailure: base.status === 'pass'
          || (base.status === 'fail' && (!sameFailure || (!!base.baselineEnvironmentChanged && !sameEnvironmentFailure))),
        rawOutputTail,
        durationMs: Date.now() - started,
      });
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }
  return evidence;
}