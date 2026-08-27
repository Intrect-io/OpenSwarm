import type { ChildProcess } from 'node:child_process';
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
      '-EncodedCommand',
      WINDOWS_JOB_SUPERVISOR_ENCODED,
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

export function trackCliProcessTree(proc: KillableProcess): void {
  if (process.platform === 'win32') return;
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

/** Send one signal to a CLI wrapper and every descendant it launched. */
export function signalCliProcessTree(
  proc: KillableProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    // ChildProcess.kill() uses the process handle Node retained at spawn time.
    // The child is our Job Object supervisor; terminating that exact handle
    // closes the job and lets Windows kill only the target tree it owns.
    proc.kill(signal);
    return;
  }
  if (proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // The process may have exited before the signal or failed to form a group.
    }
  }
  proc.kill(signal);
}

/** Force-kill a CLI process tree. */
export function terminateCliProcessTree(
  proc: KillableProcess,
  platform: NodeJS.Platform = process.platform,
): void {
  signalCliProcessTree(proc, 'SIGKILL', platform);
}
