import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { win32 } from 'node:path';

type KillableProcess = Pick<ChildProcess, 'pid' | 'kill'>;

const WINDOWS_JOB_SPEC_ENV = 'OPENSWARM_WINDOWS_JOB_SPEC';
const require = createRequire(import.meta.url);
const CROSS_SPAWN_PATH = require.resolve('cross-spawn');

// The Node supervisor owns the target's stdio pipes, so target descendants do
// not inherit the PowerShell/C# relay handles. cross-spawn preserves npm .cmd
// shim support while keeping target arguments out of a command shell string.
const WINDOWS_NODE_SUPERVISOR = String.raw`
const specEnv = '${WINDOWS_JOB_SPEC_ENV}';
const encodedSpec = process.env[specEnv];
if (!encodedSpec) throw new Error('OpenSwarm Windows Node supervisor received no command specification');
delete process.env[specEnv];
const spec = JSON.parse(Buffer.from(encodedSpec, 'base64').toString('utf8'));
const crossSpawn = require(spec.crossSpawnPath);
const target = crossSpawn(spec.command, spec.args, {
  env: process.env,
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let settled = false;
let exitDrainTimer = null;

target.stdin?.on('error', () => {});
process.stdin.on('error', () => {});
if (target.stdin) process.stdin.pipe(target.stdin);
if (target.stdout) target.stdout.pipe(process.stdout, { end: false });
if (target.stderr) target.stderr.pipe(process.stderr, { end: false });

function finish(code) {
  if (settled) return;
  settled = true;
  if (exitDrainTimer) clearTimeout(exitDrainTimer);
  if (target.stdin) process.stdin.unpipe(target.stdin);
  process.stdin.pause();
  target.stdout?.unpipe(process.stdout);
  target.stderr?.unpipe(process.stderr);
  target.stdin?.destroy();
  target.stdout?.destroy();
  target.stderr?.destroy();
  process.exitCode = Number.isInteger(code) ? code : 1;
}

target.once('error', (error) => {
  process.stderr.write('OpenSwarm supervised CLI spawn failed: ' + error.message + '\n');
  finish(1);
});
target.once('exit', (code) => {
  process.exitCode = Number.isInteger(code) ? code : 1;
  // close waits for stdio. If a descendant retained the target-facing pipe,
  // stop waiting after the same bounded drain used by the POSIX caller.
  exitDrainTimer = setTimeout(() => finish(code), 1000);
});
target.once('close', (code) => finish(code));
`;

// Windows has no POSIX-style process groups. Run the requested command inside
// a small supervisor that joins a Job Object *before* it launches the real CLI.
// The supervisor owns the only non-inheritable job handle, configured with
// KILL_ON_JOB_CLOSE. Node can therefore terminate its existing ChildProcess
// handle safely; when the supervisor exits, Windows reaps the exact job members
// without looking up a possibly-reused PID or walking stale PPID relationships.
const WINDOWS_JOB_SUPERVISOR = String.raw`
$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class OpenSwarmJobObject {
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(
        IntPtr job,
        int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info,
        uint length
    );

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    // Match libuv's Windows argv quoting instead of letting Windows PowerShell
    // 5.1 reinterpret quotes and backslashes for a native command.
    private static string QuoteArgument(string argument) {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return argument;

        StringBuilder quoted = new StringBuilder(argument.Length + 2);
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in argument) {
            if (character == '\\') {
                backslashes++;
            } else if (character == '"') {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
            } else {
                quoted.Append('\\', backslashes);
                quoted.Append(character);
                backslashes = 0;
            }
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static string BuildCommandLine(string[] arguments) {
        StringBuilder commandLine = new StringBuilder();
        foreach (string argument in arguments) {
            if (commandLine.Length > 0) commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        return commandLine.ToString();
    }

    public static int RunTarget(string command, string[] arguments) {
        using (Process target = new Process()) {
            target.StartInfo = new ProcessStartInfo {
                FileName = command,
                Arguments = BuildCommandLine(arguments),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            if (!target.Start()) throw new InvalidOperationException("Failed to start the supervised CLI");

            // Relay bytes rather than PowerShell strings. This preserves native
            // UTF-8 JSON exactly and drains both output pipes while stdin copies.
            Task stdout = target.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            Task stderr = target.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            try {
                Console.OpenStandardInput().CopyTo(target.StandardInput.BaseStream);
            } catch (IOException) {
                // The target can legitimately close stdin before consuming it.
            } finally {
                try { target.StandardInput.Close(); } catch (IOException) { }
            }

            target.WaitForExit();
            // The Node supervisor owns the target-facing pipes and closes its
            // own relay handles only after normal output has drained.
            Task.WaitAll(new Task[] { stdout, stderr });
            return target.ExitCode;
        }
    }
}
'@

$encodedSpec = [Environment]::GetEnvironmentVariable('${WINDOWS_JOB_SPEC_ENV}', 'Process')
if ([String]::IsNullOrWhiteSpace($encodedSpec)) {
    throw 'OpenSwarm Windows job supervisor received no command specification'
}
$specJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedSpec))
$spec = $specJson | ConvertFrom-Json
if ([String]::IsNullOrWhiteSpace([string]$spec.command)) {
    throw 'OpenSwarm Windows job supervisor received an empty command'
}

$job = [OpenSwarmJobObject]::CreateJobObjectW([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) {
    throw "CreateJobObjectW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

$limits = New-Object OpenSwarmJobObject+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
$limits.BasicLimitInformation.LimitFlags = 0x00002000
$limitsSize = [Runtime.InteropServices.Marshal]::SizeOf([type][OpenSwarmJobObject+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
if (-not [OpenSwarmJobObject]::SetInformationJobObject($job, 9, [ref]$limits, $limitsSize)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [void][OpenSwarmJobObject]::CloseHandle($job)
    throw "SetInformationJobObject failed: $errorCode"
}
if (-not [OpenSwarmJobObject]::AssignProcessToJobObject($job, [OpenSwarmJobObject]::GetCurrentProcess())) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [void][OpenSwarmJobObject]::CloseHandle($job)
    throw "AssignProcessToJobObject failed: $errorCode"
}

# Start the Node supervisor inside the job. It clears the encoded target spec
# before launching the real CLI, supports npm command shims, and owns the
# target-facing pipes. Do not close the job handle manually: process exit closes
# the final handle and reaps descendants.
$supervisorArgs = [string[]]@('-e', [string]$spec.nodeSupervisor)
$targetExitCode = [OpenSwarmJobObject]::RunTarget([string]$spec.nodePath, $supervisorArgs)
[Environment]::Exit([int]$targetExitCode)
`;

const WINDOWS_JOB_SUPERVISOR_ENCODED = Buffer
  .from(WINDOWS_JOB_SUPERVISOR, 'utf16le')
  .toString('base64');
// Windows PowerShell 5.1 serializes redirected stderr as CLIXML whenever
// -EncodedCommand is used, even with -OutputFormat Text. Decode the fixed,
// user-data-free supervisor inside a regular -Command invocation instead.
const WINDOWS_JOB_SUPERVISOR_COMMAND =
  `[ScriptBlock]::Create([Text.Encoding]::Unicode.GetString(`
  + `[Convert]::FromBase64String('${WINDOWS_JOB_SUPERVISOR_ENCODED}'))).Invoke()`;

export interface CliProcessTreeSpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Wrap a Windows CLI in a Job Object supervisor. POSIX callers are unchanged.
 * The command specification travels through a short-lived environment entry,
 * not interpolated PowerShell source, and the supervisor clears it before the
 * target is launched.
 */
export function prepareCliProcessTreeSpawn(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): CliProcessTreeSpawnSpec {
  if (platform !== 'win32') return { command, args, env };

  const encodedSpec = Buffer.from(JSON.stringify({
    command,
    args,
    nodePath: process.execPath,
    nodeSupervisor: WINDOWS_NODE_SUPERVISOR,
    crossSpawnPath: CROSS_SPAWN_PATH,
  }), 'utf8').toString('base64');
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  return {
    command: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-InputFormat',
      'Text',
      '-OutputFormat',
      'Text',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_JOB_SUPERVISOR_COMMAND,
    ],
    env: { ...env, [WINDOWS_JOB_SPEC_ENV]: encodedSpec },
  };
}

// POSIX children are detached into their own process groups, so the terminal no
// longer forwards Ctrl+C to them automatically. Keep one process-level relay,
// while remembering whether installing it displaced Node's default handling.
const activeCliProcessTrees = new Set<KillableProcess>();
let sigintInstalledWithoutOtherHandler = false;
let sigtermInstalledWithoutOtherHandler = false;

const relayParentSignal = (signal: NodeJS.Signals): void => {
  const ownHandler = signal === 'SIGINT' ? onParentSigint : onParentSigterm;
  const installedWithoutOtherHandler = signal === 'SIGINT'
    ? sigintInstalledWithoutOtherHandler
    : sigtermInstalledWithoutOtherHandler;
  const hasOtherHandlerNow = process.listeners(signal).some((listener) => listener !== ownHandler);
  for (const proc of activeCliProcessTrees) terminateCliProcessTree(proc);
  process.removeListener('SIGINT', onParentSigint);
  process.removeListener('SIGTERM', onParentSigterm);
  activeCliProcessTrees.clear();
  sigintInstalledWithoutOtherHandler = false;
  sigtermInstalledWithoutOtherHandler = false;
  // A pre-existing once() handler is removed before this later listener runs,
  // so checking only the live listener list misclassifies graceful shutdown as
  // absent. Re-raise only when installation itself observed no owner and none
  // appeared afterward.
  if (!installedWithoutOtherHandler || hasOtherHandlerNow) return;
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
  }
};
const onParentSigint = (): void => relayParentSignal('SIGINT');
const onParentSigterm = (): void => relayParentSignal('SIGTERM');

// Group ownership proven while the child was alive. A detached child leads its
// own group (pgid == pid) and is our direct child (ppid == us); once that
// leader exits, /proc and ps(1) have nothing left to report, yet its orphaned
// descendants keep the group id reserved and are reachable only by the group
// signal. Keyed by the handle in a WeakMap so callers that untrack before
// terminating (codexUserMcp does) cannot drop the record. exitedAt marks when
// the leader died: any group member started before that instant predates any
// possible reuse of the pid, which is what the kill path re-verifies.
interface DetachedLeaderRecord {
  pid: number;
  exitedAt?: number;
}
const verifiedDetachedLeaders = new WeakMap<KillableProcess, DetachedLeaderRecord>();

export function trackCliProcessTree(
  proc: KillableProcess,
  lookupOwnership: (pid: number) => ProcessOwnership | null = lookupProcessOwnership,
): void {
  if (process.platform === 'win32') return;
  if (proc.pid && proc.pid > 1 && proc.pid !== process.pid) {
    const owner = lookupOwnership(proc.pid);
    if (owner && owner.pgid === proc.pid && owner.ppid === process.pid) {
      const record: DetachedLeaderRecord = { pid: proc.pid };
      verifiedDetachedLeaders.set(proc, record);
      (proc as Partial<ChildProcess>).once?.('exit', () => {
        record.exitedAt = Date.now();
      });
    }
  }
  if (activeCliProcessTrees.size === 0) {
    sigintInstalledWithoutOtherHandler = process.listenerCount('SIGINT') === 0;
    sigtermInstalledWithoutOtherHandler = process.listenerCount('SIGTERM') === 0;
    process.once('SIGINT', onParentSigint);
    process.once('SIGTERM', onParentSigterm);
  }
  activeCliProcessTrees.add(proc);
}

export function untrackCliProcessTree(proc: KillableProcess): void {
  if (process.platform === 'win32') return;
  activeCliProcessTrees.delete(proc);
  if (activeCliProcessTrees.size === 0) {
    process.removeListener('SIGINT', onParentSigint);
    process.removeListener('SIGTERM', onParentSigterm);
    sigintInstalledWithoutOtherHandler = false;
    sigtermInstalledWithoutOtherHandler = false;
  }
}

/** Where a pid sits in the process tree: its group and its parent. */
export interface ProcessOwnership {
  pgid: number;
  ppid: number;
}

/**
 * The group and parent of a pid, or null when the process no longer exists.
 *
 * Node has no getpgid()/getppid(pid), so ask the OS: /proc on Linux, ps(1)
 * elsewhere. Runs at spawn and kill time, which is per-stage, not per-event.
 */
export function lookupProcessOwnership(pid: number): ProcessOwnership | null {
  try {
    if (process.platform === 'linux') {
      // /proc/<pid>/stat: pid (comm) state ppid pgrp ... — comm may contain
      // spaces/parens, so parse from the LAST ')'.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(rest[1]);
      const pgid = Number(rest[2]);
      if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || pgid <= 0) return null;
      return { pgid, ppid };
    }
    const out = execFileSync('ps', ['-o', 'ppid=,pgid=', '-p', String(pid)], { encoding: 'utf8' });
    const [ppid, pgid] = out.trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || pgid <= 0) return null;
    return { pgid, ppid };
  } catch {
    return null;
  }
}

/** A live process in some group, with how long ago it started. */
export interface ProcessGroupMember {
  pid: number;
  elapsedMs: number;
}

/**
 * Every live member of the given process group with its age. Empty on any
 * enumeration failure: refusing to enumerate means refusing to sweep — leak,
 * never misfire.
 */
function listProcessGroupMembers(pgid: number): ProcessGroupMember[] {
  const members: ProcessGroupMember[] = [];
  try {
    if (process.platform === 'linux') {
      // starttime (field 22 of /proc/<pid>/stat) counts in USER_HZ ticks since
      // boot; USER_HZ is 100 on mainstream Linux and the sweep's clock fuzz
      // absorbs any rounding. Avoids depending on ps(1) in slim containers.
      const uptimeSec = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
          const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          if (Number(rest[2]) !== pgid) continue;
          members.push({ pid: Number(entry), elapsedMs: (uptimeSec - Number(rest[19]) / 100) * 1_000 });
        } catch {
          // The process exited mid-scan; keep scanning.
        }
      }
      return members;
    }
    const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,etime='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      // etime is [[dd-]hh:]mm:ss.
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
      if (!match || Number(match[2]) !== pgid) continue;
      members.push({
        pid: Number(match[1]),
        elapsedMs: (Number(match[3] ?? 0) * 86_400 + Number(match[4] ?? 0) * 3_600
          + Number(match[5]) * 60 + Number(match[6])) * 1_000,
      });
    }
    return members;
  } catch {
    return [];
  }
}

// Absorbs the measurement granularity of process ages plus clock skew against
// our Date.now() exit stamp: /proc starttime ticks at 10ms on Linux, ps etime
// truncates to whole seconds on macOS. Any acceptance rule must include this
// band or it leaks legitimate orphans born just before the leader died; a
// group id recycled inside the band would require the kernel to exhaust its
// entire pid space within it.
const GROUP_AGE_CLOCK_FUZZ_MS = process.platform === 'linux' ? 250 : 1_500;

/**
 * Kill the orphaned descendants of an exited detached leader one pid at a
 * time. kill(-pgid) is off the table here: with the leader dead, nothing can
 * re-verify the group as a whole, and the id could belong to a recycled group.
 * Instead, only members that started BEFORE the leader died are signalled —
 * POSIX reserves the group id while any original member lives, so a member
 * predating the leader's death is provably one of its descendants, while every
 * member of a recycled group is younger than that. What remains is the same
 * per-pid check-then-signal window the live path already carries.
 */
function sweepOrphanedGroupMembers(
  pgid: number,
  leaderExitedAt: number,
  signal: NodeJS.Signals,
  listMembers: (pgid: number) => ProcessGroupMember[],
): void {
  // Second pass catches a descendant forked between enumeration and the kill
  // of its parent (it still predates the leader's death only if it does).
  for (let pass = 0; pass < 2; pass += 1) {
    const sinceExitMs = Date.now() - leaderExitedAt;
    let signalled = false;
    for (const member of listMembers(pgid)) {
      if (member.pid <= 1 || member.pid === process.pid) continue;
      if (member.elapsedMs < sinceExitMs - GROUP_AGE_CLOCK_FUZZ_MS) continue;
      try {
        process.kill(member.pid, signal);
        signalled = true;
      } catch {
        // Already gone.
      }
    }
    if (!signalled) return;
  }
}

/** Send one signal to a CLI wrapper and every descendant it launched. */
export function signalCliProcessTree(
  proc: KillableProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  lookupOwnership?: (pid: number) => ProcessOwnership | null,
  listGroupMembers?: (pgid: number) => ProcessGroupMember[],
): void {
  if (platform === 'win32') {
    // ChildProcess.kill() uses the process handle Node retained at spawn time.
    // The child is our Job Object supervisor; terminating that exact handle
    // closes the job and lets Windows kill only the target tree it owns.
    proc.kill(signal);
    return;
  }
  // Prove ownership before signalling a whole group. kill(-1) addresses every
  // process on the host, our own group would take the daemon down with the
  // child, and a stale or fabricated pid addresses whoever holds that group
  // now. All three are real: unit tests handed fake pids (1, 321) to the close
  // handler, and the resulting kill(-1, SIGKILL) wiped every application in
  // the operator's login session and severed the SSH connection running the
  // suite on a remote host. Only a child we spawned detached — one that leads
  // its own group (pgid == pid) and is our direct child (ppid == us) — may be
  // group-killed.
  if (proc.pid && proc.pid > 1 && proc.pid !== process.pid && proc.pid !== ownProcessGroup()) {
    const owner = (lookupOwnership ?? lookupProcessOwnership)(proc.pid);
    if (owner) {
      // The leader is alive, so the OS can vouch for it directly, and the
      // group id is guaranteed unrecycled while it lives.
      if (owner.pgid === proc.pid && owner.ppid === process.pid) {
        try {
          process.kill(-proc.pid, signal);
          return;
        } catch {
          // The group drained between lookup and kill.
        }
      }
    } else {
      // The leader already exited. Never group-signal here — sweep only the
      // members that provably predate the leader's death, one pid at a time.
      const record = verifiedDetachedLeaders.get(proc);
      if (record?.pid === proc.pid) {
        // A kill can observe the death before the 'exit' event has fired
        // (abort handlers run in the same loop turn as the reap). This first
        // observation of the death is then the tightest stamp available.
        record.exitedAt ??= Date.now();
        sweepOrphanedGroupMembers(
          proc.pid,
          record.exitedAt,
          signal,
          listGroupMembers ?? listProcessGroupMembers,
        );
      }
    }
  }
  proc.kill(signal);
}

let cachedOwnProcessGroup: number | null | undefined;
function ownProcessGroup(): number | null {
  // Our own pgid cannot change: Node exposes no setpgid/setsid for a running
  // process, so one lookup per process lifetime is enough.
  if (cachedOwnProcessGroup === undefined) {
    cachedOwnProcessGroup = lookupProcessOwnership(process.pid)?.pgid ?? null;
  }
  return cachedOwnProcessGroup;
}

/** Force-kill a CLI process tree. */
export function terminateCliProcessTree(
  proc: KillableProcess,
  platform: NodeJS.Platform = process.platform,
  lookupOwnership?: (pid: number) => ProcessOwnership | null,
  listGroupMembers?: (pgid: number) => ProcessGroupMember[],
): void {
  signalCliProcessTree(proc, 'SIGKILL', platform, lookupOwnership, listGroupMembers);
}

/**
 * Reap descendants that deliberately created a new session and escaped the
 * detached process group. The opaque marker is inherited through ordinary
 * forks. This supplements (never replaces) process-group/PID-namespace
 * ownership: failure to enumerate leaks a process rather than signalling an
 * unrelated PID.
 */
export async function terminateProcessesWithEnvMarker(marker: string): Promise<void> {
  if (process.platform === 'win32' || marker.length < 24) return;
  const childProcess = await import('node:child_process');
  if (typeof childProcess.execFile !== 'function') return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let stdout = '';
    try {
      stdout = await new Promise<string>((resolveOutput, rejectOutput) => {
        childProcess.execFile('ps', ['eww', '-axo', 'pid=,command='], {
          encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 5_000,
        }, (error, output) => error ? rejectOutput(error) : resolveOutput(output));
      });
    } catch {
      return;
    }
    const pids = stdout.split('\n')
      .filter((line) => line.includes(marker))
      .map((line) => Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* raced with exit */ }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}
