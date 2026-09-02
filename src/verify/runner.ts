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
  outputFingerprint?: string;
  environmentFailure?: boolean;
  baselineEnvironmentChanged?: boolean;
}

async function verificationSharedPaths(projectPath: string, commands: VerifyCommand[]): Promise<string[]> {
  let metadata = null;
  try { metadata = await loadRepoMetadata(projectPath); } catch { metadata = null; }
  const paths = new Set(resolveSharedPaths(projectPath, metadata));
  for (const command of commands) {
    const directory = command.cwd ?? '';
    const nodeModules = join(directory, 'node_modules');
    try {
      await access(join(projectPath, nodeModules));
      paths.add(nodeModules);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return [...paths];
}

function pathCoveredBy(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

/**
 * Worker retries can leave pytest's numbered temporary directory in a preserved
 * worktree. Its `*-current` convenience link intentionally points outside that
 * worktree, but it is neither source nor an input to verification. Do not turn
 * that known test byproduct into a blanket exception for escaping symlinks.
 */
function isEphemeralVerificationArtifact(path: string): boolean {
  const segments = path.split(sep);
  const root = segments[0] ?? '';
  // Root-scoped scratch that must never enter the verification checkout or
  // count as a worker source edit. Measured on vela: preserved worktrees carried
  // hundreds of pytest-of-* / .venv paths, so head verify failed in 1–4s and PR
  // publication never ran.
  return root === '.venv'
    || root === '.venv-verify'
    || root === '.venv.bak'
    || root === 'pytest-local'
    || root === '.pytest-lathe'
    || root === '.trash'
    || /^pytest-of-[^/]+$/.test(root)
    || /^int\d+_[a-z0-9_]{8,}$/i.test(root)
    || /^tmp[a-z0-9_]{8,}$/i.test(root)
    || /^\.openswarm-trash\/[^/]*-(?:pytest|verify)(?:-|\/|$)/.test(path)
    || /^\.openswarm\/(?:repo-snapshot\.json|repo\.graphql)$/.test(path)
    || /^\.trash\/(?:atomic-verify-[^/]+|pytest-of-[^/]+)(?:\/|$)/.test(path)
    || /(?:^|\/)pytest-of-[^/]+\//.test(path);
}

function hasSameFailure(base: CommandResult, head: CommandResult): boolean {
  // A shared non-zero exit code is not enough to prove that the failure is
  // pre-existing: HEAD may contain the old failure plus a new regression.
  // Only waive the failure when the observable failure output is identical.
  // Commands with unstable output therefore fail closed and require review.
  return base.outputFingerprint !== undefined && base.outputFingerprint === head.outputFingerprint;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every run-specific absolute path with a stable placeholder.
 *
 * `paths` is applied longest-first so a nested path is substituted before the
 * ancestor containing it; doing the ancestor first would rewrite the shared
 * prefix and leave the more specific label unreachable.
 *
 * This previously received only the command's `cwd`. When a command declared a
 * subdirectory cwd, every path OUTSIDE that subdirectory — sibling source files,
 * and the sandbox's isolated HOME/TMPDIR, which sit beside the project root —
 * kept its randomly-named sandbox prefix. Base and head run in different
 * `mkdtemp` directories, so those prefixes survived into the fingerprint and made
 * two runs of the SAME pre-existing failure hash differently. `hasSameFailure`
 * then reported it as a new regression — exactly what that check exists to
 * prevent.
 */
export function normalizeFailureOutput(output: string, paths: Array<[string, string]>): string {
  let normalized = output;
  const ordered = [...paths]
    .filter(([path]) => path.length > 0)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [path, label] of ordered) {
    normalized = normalized.replace(new RegExp(escapeForRegExp(path), 'g'), label);
  }
  normalized = normalized
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
    .replace(/(=+ .*? in )\d+(?:\.\d+)?s( =+)/g, '$1<DURATION>$2')
    // The discovered pytest command runs with `-q`, whose final summary line
    // carries no `=` decoration: `3 skipped, 1 error in 1.54s`. Left alone,
    // base and head fingerprints differed by timing alone, and every
    // pre-existing failure read as a new regression (vega-agent AGT-4118:
    // the same ModuleNotFoundError on both sides, 1.93s vs 1.54s).
    .replace(/^(\d+ [a-z]+(?:, \d+ [a-z]+)* in )\d+(?:\.\d+)?s$/gm, '$1<DURATION>')
    .replace(/(Ran \d+ tests? in )\d+(?:\.\d+)?s/g, '$1<DURATION>')
    .replace(/(finished in )\d+(?:\.\d+)?s/gi, '$1<DURATION>')
    // pytest-xdist assigns the same failure to different workers on base and
    // head.  A worker number is scheduler noise, not failure evidence.
    .replace(/\[gw\d+\]/g, '[gw<WORKER>]');

  // xdist also completes failing workers in nondeterministic order.  Preserve
  // every traceback (so a changed assertion still differs), but compare their
  // order-insensitive set.  The short summary is normalized for the same reason.
  const failureMatch = /^(={3,} FAILURES ={3,})\n/m.exec(normalized);
  if (failureMatch?.index !== undefined) {
    const bodyStart = failureMatch.index + failureMatch[0].length;
    const nextHeading = /^(={3,} (?:warnings summary|short test summary info) ={3,})$/m
      .exec(normalized.slice(bodyStart));
    const bodyEnd = nextHeading?.index === undefined ? normalized.length : bodyStart + nextHeading.index;
    const body = normalized.slice(bodyStart, bodyEnd);
    const blocks = body.split(/(?=^_{8,}.*$)/m).filter(Boolean);
    normalized = normalized.slice(0, bodyStart) + blocks.sort().join('') + normalized.slice(bodyEnd);
  }
  const summaryMatch = /^(={3,} short test summary info ={3,})\n/m.exec(normalized);
  if (summaryMatch?.index !== undefined) {
    const bodyStart = summaryMatch.index + summaryMatch[0].length;
    const nextHeading = /^(={3,} .* ={3,})$/m.exec(normalized.slice(bodyStart));
    const bodyEnd = nextHeading?.index === undefined ? normalized.length : bodyStart + nextHeading.index;
    const lines = normalized.slice(bodyStart, bodyEnd).split('\n').filter(Boolean).sort();
    normalized = normalized.slice(0, bodyStart) + lines.join('\n') + (lines.length ? '\n' : '') + normalized.slice(bodyEnd);
  }
  return normalized;
}

function isEnvironmentFailure(output: string): boolean {
  return [
    /ModuleNotFoundError:\s*No module named\b/i,
    /ImportError:\s*No module named\b/i,
    /Cannot find module ['"]/i,
    /could not find [`']?Cargo\.toml/i,
    /failed to (?:load|read) manifest for workspace member/i,
    /Cargo\.toml.*(?:No such file or directory|os error 2)/i,
  ].some((pattern) => pattern.test(output));
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
  createSession: (workspace: string) => Promise<SandboxExecutorSession>,
): Promise<CommandResult> {
  const timeoutMs = command.timeoutMs ?? 300_000;
  try {
    const session = await createSession(root);
    const cwdBin = join(cwd, 'node_modules', '.bin');
    const rootBin = join(root, 'node_modules', '.bin');
    const relativeCwd = relative(root, cwd) || '.';
    const vegaWorkspace = vegaVerifyWorkspaceRoot(root);
    const result = await session.execute([
      `cd -- ${shellQuote(relativeCwd)}`,
      `export PATH=${shellQuote(`${cwdBin}${delimiter}${rootBin}`)}:"$PATH"`,
      ...(vegaWorkspace ? [`export VEGA_EXTRA_PATHS=${shellQuote(vegaWorkspace)}`] : []),
      // Bundled VEGA toolsets intentionally use the narrower headless-workspace
      // contract instead of VEGA_EXTRA_PATHS.  Both settings name this same
      // disposable checkout; neither admits its parent /work directory.
      ...(vegaWorkspace ? ['export VEGA_HEADLESS=1', `export VEGA_CWD=${shellQuote(vegaWorkspace)}`] : []),
      command.run,
    ].join(' && '), timeoutMs);
    let status: CommandResult['status'];
    let extra = '';
    let output = result.output;
    if (result.outputLimitExceeded || result.truncated) {
      status = 'fail';
      output = `[security] verification output exceeded the strict sandbox limit\n${result.output}`;
    } else if (result.timedOut) {
      const error = new Error(`timeout after ${timeoutMs}ms`);
      status = isInfraError(error) ? 'infra' : 'fail';
      extra = `\n${error.message}`;
    } else if (result.exitCode === 0) {
      status = 'pass';
    } else if (result.exitCode === 126 || result.exitCode === 127 || result.signal) {
      const error = new Error(
        `spawn command exited with code ${result.exitCode ?? 'null'}${result.signal ? ` signal ${result.signal}` : ''}`,
      );
      status = isInfraError(error) ? 'infra' : 'fail';
      extra = `\n${error.message}`;
    } else {
      status = 'fail';
    }
    output += extra;
    return {
      status,
      output,
      securityFailure: result.outputLimitExceeded || result.truncated || undefined,
      outputFingerprint: createHash('sha256').update(normalizeFailureOutput(output, [
        [root, '<PROJECT>'], [isolatedHome, '<HOME>'], [isolatedTmp, '<TMP>'],
        [dirname(root), '<SANDBOX>'],
      ])).digest('hex'),
      environmentFailure: status === 'fail' && isEnvironmentFailure(output),
    };
  } catch (error) {
    return {
      status: 'fail',
      output: `[security] strict verification sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`,
      securityFailure: true,
    };
  }
}

async function runCommand(
  command: VerifyCommand,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  sandboxExecutorSessionFactory?: (workspace: string) => Promise<SandboxExecutorSession>,
): Promise<CommandResult> {
  const candidate = command.cwd ? resolve(root, command.cwd) : root;
  let cwd: string;
  try {
    const [realRoot, realCwd] = await Promise.all([realpath(root), realpath(candidate)]);
    if (realCwd !== realRoot && !realCwd.startsWith(`${realRoot}${sep}`)) {
      return { status: 'fail', output: `[security] verify cwd escapes project root: ${command.cwd ?? '.'}` };
    }
    cwd = realCwd;
  } catch (error) {
    return { status: 'infra', output: error instanceof Error ? error.message : String(error) };
  }
  const isolatedHome = join(dirname(root), 'home');
  const isolatedTmp = join(dirname(root), 'tmp');
  await Promise.all([mkdir(isolatedHome, { recursive: true }), mkdir(isolatedTmp, { recursive: true })]);
  const processMarker = `openswarm-verify-${randomUUID()}`;
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_CACHE_HOME: join(isolatedHome, '.cache'),
    XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
    TMPDIR: isolatedTmp,
    TMP: isolatedTmp,
    TEMP: isolatedTmp,
    OPENSWARM_VERIFY_PROCESS_MARKER: processMarker,
  };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI', 'TZ', 'SystemRoot', 'ComSpec', 'PATHEXT']) {
    if (env[key] !== undefined) safeEnv[key] = env[key];
  }
  const vegaWorkspace = vegaVerifyWorkspaceRoot(root);
  if (vegaWorkspace) {
    safeEnv.VEGA_EXTRA_PATHS = vegaWorkspace;
    safeEnv.VEGA_HEADLESS = '1';
    safeEnv.VEGA_CWD = vegaWorkspace;
  }
  if (sandboxExecutorSessionFactory) {
    return await runWithSandboxExecutor(
      command, root, cwd, isolatedHome, isolatedTmp, sandboxExecutorSessionFactory,
    );
  }
  const shell = process.env.SHELL || '/bin/sh';
  let executable = shell;
  let invocationArgs = ['-lc', command.run];
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
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
    let output: Buffer = Buffer.alloc(0);
    // Fingerprint bytes are kept per stream and concatenated in a fixed order at
    // the end (stdout, then stderr, then any synthetic trailer). Recording both
    // streams into one buffer as chunks arrived made the fingerprint depend on
    // OS scheduling: the same command emitting the same stdout and stderr could
    // interleave differently between the base and head runs and hash to two
    // different values, so `hasSameFailure` saw a pre-existing failure as a new
    // regression. Per-stream capture makes identical output hash identically.
    const fingerprintChunks: Record<'stdout' | 'stderr' | 'extra', Buffer[]> = {
      stdout: [], stderr: [], extra: [],
    };
    let fingerprintBytes = 0;
    let fingerprintTruncated = false;
    let settled = false;
    let timedOut = false;
    const detached = process.platform !== 'win32';
    const child = spawn(executable, invocationArgs, {
      cwd,
      env: safeEnv,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const retainForFingerprint = (stream: 'stdout' | 'stderr' | 'extra', chunk: Buffer) => {
      if (fingerprintBytes < FINGERPRINT_BYTES) {
        const retained = chunk.subarray(0, FINGERPRINT_BYTES - fingerprintBytes);
        fingerprintChunks[stream].push(retained);
        fingerprintBytes += retained.length;
        fingerprintTruncated ||= retained.length < chunk.length;
      } else fingerprintTruncated = true;
    };
    const record = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      retainForFingerprint(stream, chunk);
      // The human-facing output keeps true arrival order — interleaving is what
      // makes a log readable. Only the fingerprint needs to be order-independent.
      output = appendTail(output, chunk);
    };
    child.stdout.on('data', record('stdout'));
    child.stderr.on('data', record('stderr'));

    const finish = (status: CommandResult['status'], extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (extra) {
        retainForFingerprint('extra', Buffer.from(extra));
        output = appendTail(output, Buffer.from(extra));
      }
      const outputText = output.toString('utf8');
      const fingerprintText = Buffer.concat([
        ...fingerprintChunks.stdout, ...fingerprintChunks.stderr, ...fingerprintChunks.extra,
      ]).toString('utf8') + (fingerprintTruncated ? '\n<TRUNCATED>' : '');
      resolveResult({
        status,
        output: outputText,
        outputFingerprint: createHash('sha256').update(normalizeFailureOutput(fingerprintText, [
          [root, '<PROJECT>'], [isolatedHome, '<HOME>'], [isolatedTmp, '<TMP>'],
          [dirname(root), '<SANDBOX>'],
        ])).digest('hex'),
        environmentFailure: status === 'fail' && isEnvironmentFailure(outputText),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else if (process.platform === 'win32' && child.pid) {
        void terminateVerificationProcesses(child.pid, processMarker);
      } else {
        child.kill('SIGKILL');
      }
    }, command.timeoutMs ?? 300_000);

    child.on('error', (error) => {
      const infra = isInfraError(error) || (error as NodeJS.ErrnoException).code !== undefined;
      finish(infra ? 'infra' : 'fail', `\n${error.message}`);
    });
    child.on('close', (code, signal) => {
      void (async () => {
      await terminateVerificationProcesses(child.pid, processMarker);
      if (timedOut) {
        const error = new Error(`timeout after ${command.timeoutMs ?? 300_000}ms`);
        finish(isInfraError(error) ? 'infra' : 'fail', `\n${error.message}`);
      } else if (code === 0) {
        finish('pass');
      } else if (code === 126 || code === 127 || signal) {
        const error = new Error(`spawn command exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`);
        finish(isInfraError(error) ? 'infra' : 'fail', `\n${error.message}`);
      } else {
        finish('fail');
      }
      })();
    });
  });
}

async function runTrustedCommand(
  command: VerifyCommand,
  root: string,
  trustedPackageJsonByDirectory?: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
  sandboxExecutorSessionFactory?: (workspace: string) => Promise<SandboxExecutorSession>,
): Promise<CommandResult> {
  if (trustedPackageJsonByDirectory === undefined) {
    return await runCommand(command, root, env, sandboxExecutorSessionFactory);
  }
  const projectRoot = await realpath(root);
  const candidate = resolve(projectRoot, command.cwd ?? '.');
  let directory: string;
  try {
    directory = await realpath(candidate);
  } catch (error) {
    return { status: 'infra', output: error instanceof Error ? error.message : String(error) };
  }
  if (directory !== projectRoot && !directory.startsWith(`${projectRoot}${sep}`)) {
    return { status: 'fail', output: `[security] verify package cwd escapes project root: ${command.cwd ?? '.'}` };
  }
  let trustedPackageJson: string | undefined;
  while (directory === projectRoot || directory.startsWith(`${projectRoot}${sep}`)) {
    const key = relative(projectRoot, directory);
    const trusted = trustedPackageJsonByDirectory[key];
    const packagePath = join(directory, 'package.json');
    let actual: string | undefined;
    try {
      const handle = await open(packagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          return { status: 'fail', output: `[security] verify package.json is not a regular file for cwd: ${command.cwd ?? '.'}` };
        }
        actual = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (trusted !== undefined || actual !== undefined) {
      if (trusted === undefined || actual === undefined) {
        return { status: 'fail', output: `[security] verify package resolution changed for cwd: ${command.cwd ?? '.'}` };
      }
      trustedPackageJson = trusted;
      break;
    }
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
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const path = relative(projectRoot, source);
      if (
        path.split(sep).some((segment) => segment === '.git' || segment === 'node_modules')
        || isEphemeralVerificationArtifact(path)
        || pathCoveredBy(path, sharedPaths)
      ) continue;
      if (entry.isSymbolicLink()) {
        const target = await readlink(source);
        const resolvedTarget = resolve(dirname(source), target);
        if (isAbsolute(target) || (resolvedTarget !== projectRoot && !resolvedTarget.startsWith(`${projectRoot}${sep}`))) {
          throw new Error(`[security] verify sandbox rejects escaping symlink: ${path}`);
        }
        try {
          const realTarget = await realpath(source);
          if (realTarget !== projectRoot && !realTarget.startsWith(`${projectRoot}${sep}`)) {
            throw new Error(`[security] verify sandbox rejects escaping symlink: ${path}`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            // A missing target is not an escape when the lexical target was
            // already proven relative and contained by projectRoot above.
            // Repositories commonly track build-output links whose targets are
            // created only after a platform-specific build. Reject absolute or
            // lexically escaping links, but do not make an unchanged internal
            // dangling link render every unrelated verification impossible.
            continue;
          }
          throw error;
        }
        continue;
      }
      if (entry.isDirectory()) await visit(source);
    }
  };
  await visit(projectRoot);
}

async function createVerifySandboxRoot(prefix: string, scratchRoot?: string): Promise<string> {
  return await mkdtemp(join(scratchRoot ?? tmpdir(), prefix));
}

async function createHeadSandbox(
  projectPath: string,
  commands: VerifyCommand[],
  scratchRoot?: string,
): Promise<{ root: string; project: string }> {
  const root = await createVerifySandboxRoot('.openswarm-verify-head-', scratchRoot);
  const project = join(root, 'worktree');
  try {
    const headCommit = await git(projectPath, ['rev-parse', 'HEAD']);
    await git(projectPath, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', projectPath, project]);
    await git(project, ['checkout', '--quiet', '--detach', headCommit]);
    const sharedPaths = await verificationSharedPaths(projectPath, commands);
    await validateSandboxSymlinks(projectPath, sharedPaths);
    // Mirror the source working tree exactly, including deletions and renames,
    // while retaining only the sandbox's independent Git metadata.
    for (const entry of await readdir(project)) {
      if (entry !== '.git') await rm(join(project, entry), { recursive: true, force: true });
    }
    await cp(projectPath, project, {
      recursive: true,
      force: true,
      // Node otherwise resolves relative links against the source and writes an
      // absolute link into the sandbox, which points back at the live checkout.
      verbatimSymlinks: true,
      filter: (source) => {
        const path = relative(projectPath, source);
        return path === '' || (
          !path.split(sep).some((segment) =>
            segment === '.git'
            || segment === 'node_modules'
            ||             segment === '.venv'
            || segment === '.venv-verify'
            || segment === '.venv.bak')
          && !isEphemeralVerificationArtifact(path)
          && !pathCoveredBy(path, sharedPaths)
        );
      },
    });
    for (const sharedPath of sharedPaths) {
      await copyIsolatedPath(
        join(projectPath, sharedPath),
        join(project, sharedPath),
        project,
        sharedPath,
      );
    }
    // Validate what was actually copied, closing the source validation/copy
    // race before any repository-controlled command can execute.
    await validateSandboxSymlinks(project, sharedPaths);
    return { root, project };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function git(projectPath: string, args: string[]): Promise<string> {
  return await new Promise((resolveResult, reject) => {
    const maxOutputBytes = 4 * 1024 * 1024;
    const child = spawn('git', ['-C', projectPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
      reject(error);
    };
    timer = setTimeout(() => fail(new Error(`git ${args[0] ?? ''} timed out after ${GIT_TIMEOUT_MS}ms`)), GIT_TIMEOUT_MS);
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        fail(new Error(`git ${args[0] ?? ''} output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolveResult(stdout.trim());
      else reject(new Error(`git exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function runAtBase(
  projectPath: string,
  baseRef: string,
  command: VerifyCommand,
  trustedPackageJsonByDirectory?: Record<string, string>,
  sandboxExecutorSessionFactory?: (workspace: string) => Promise<SandboxExecutorSession>,
  scratchRoot?: string,
): Promise<CommandResult> {
  let root: string | undefined;
  let worktreePath: string | undefined;
  let worktreeAdded = false;
  try {
    const baseCommit = await git(projectPath, ['merge-base', 'HEAD', baseRef]);
    const changedFiles = await git(projectPath, ['diff', '--name-only', baseCommit, '--']);
    const untrackedFiles = await git(projectPath, ['ls-files', '--others', '--exclude-standard']);
    const dependencyChanges = `${changedFiles}\n${untrackedFiles}`.split('\n')
      .some((file) => DEPENDENCY_INPUTS.has(file.split('/').pop() ?? ''));
    root = await createVerifySandboxRoot('.openswarm-verify-base-', scratchRoot);
    worktreePath = join(root, 'worktree');
    await git(projectPath, ['worktree', 'add', '--detach', worktreePath, baseCommit]);
    worktreeAdded = true;
    // A detached worktree intentionally has no ignored dependencies/data. Copy
    // them into the base sandbox so failed-check comparison cannot mutate the
    // HEAD checkout through a shared symlink.
    const sharedPaths = await verificationSharedPaths(projectPath, [command]);
    for (const sharedPath of sharedPaths) {
      const target = join(worktreePath, sharedPath);
      try {
        await access(target);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await copyIsolatedPath(join(projectPath, sharedPath), target, worktreePath, sharedPath);
    }
    const baseBin = join(worktreePath, 'node_modules', '.bin');
    const env = { ...process.env, PATH: `${baseBin}${delimiter}${process.env.PATH ?? ''}` };
    const result = await runTrustedCommand(
      command, worktreePath, trustedPackageJsonByDirectory, env, sandboxExecutorSessionFactory,
    );
    return { ...result, baselineEnvironmentChanged: dependencyChanges };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'infra', output: message.slice(-OUTPUT_TAIL_BYTES) };
  } finally {
    let canRemoveRoot = true;
    if (worktreePath && worktreeAdded) {
      await git(projectPath, ['worktree', 'remove', '--force', worktreePath]).catch((error) => {
        canRemoveRoot = false;
        console.warn(`[Verify] Failed to remove base worktree ${worktreePath}:`, error);
        console.warn(`[Verify] Preserving ${root} so Git worktree metadata does not point at a deleted path.`);
      });
    }
    if (root && canRemoveRoot) await rm(root, { recursive: true, force: true });
  }
}

export async function runVerify(options: RunVerifyOptions): Promise<VerifyEvidence[]> {
  const evidence: VerifyEvidence[] = [];
  const scratchRoot = options.sandboxScratchRoot
    ? await realpath(options.sandboxScratchRoot)
    : undefined;
  if (scratchRoot) {
    const canonicalProject = await realpath(options.projectPath);
    const rel = relative(scratchRoot, canonicalProject);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('[security] strict verification scratch root must contain, but not equal, the project checkout');
    }
  }
  for (const command of options.commands) {
    const started = Date.now();
    let sandbox: Awaited<ReturnType<typeof createHeadSandbox>>;
    try {
      sandbox = await createHeadSandbox(options.projectPath, [command], scratchRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('[security]')) throw error;
      evidence.push({
        command, baseStatus: 'skipped', headStatus: 'fail', newFailure: true,
        securityFailure: true,
        rawOutputTail: message, durationMs: Date.now() - started,
      });
      continue;
    }
    try {
      const head = await runTrustedCommand(
        command,
        sandbox.project,
        options.trustedPackageJsonByDirectory,
        process.env,
        options.sandboxExecutorSessionFactory,
      );
      if (head.status === 'pass') {
        evidence.push({
          command,
          baseStatus: 'skipped',
          headStatus: 'pass',
          newFailure: false,
          rawOutputTail: head.output,
          durationMs: Date.now() - started,
        });
        continue;
      }
      if (head.status === 'infra') {
        evidence.push({
          command,
          baseStatus: 'skipped',
          headStatus: 'infra',
          newFailure: false,
          rawOutputTail: head.output,
          durationMs: Date.now() - started,
        });
        continue;
      }
      if (head.securityFailure || head.output.startsWith('[security]')) {
        evidence.push({
          command, baseStatus: 'skipped', headStatus: 'fail', newFailure: true,
          securityFailure: true,
          rawOutputTail: head.output, durationMs: Date.now() - started,
        });
        continue;
      }

      const base = await runAtBase(
        options.projectPath,
        options.baseRef,
        command,
        options.trustedPackageJsonByDirectory,
        options.sandboxExecutorSessionFactory,
        scratchRoot,
      );
      const rawOutputTail = Buffer.from(`[base]\n${base.output}\n[head]\n${head.output}`, 'utf8')
        .subarray(-OUTPUT_TAIL_BYTES)
        .toString('utf8');
      const sameFailure = base.status === 'fail' && hasSameFailure(base, head);
      const sameEnvironmentFailure = !!(sameFailure && base.environmentFailure && head.environmentFailure);
      evidence.push({
        command,
        baseStatus: base.status,
        headStatus: 'fail',
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
