// ============================================
// OpenSwarm - Sandbox network-denial detector (AGT-4809)
// ============================================
//
// One detector for "a worker's shell reached for the network and the sandbox
// refused it", shared by every place that sees command output:
//
// - the agentic-loop bash tool (src/adapters/tools.ts via osSandbox's
//   `noteSandboxDenial`), which sees each failed command directly;
// - the CLI adapters, through `createCliNetworkScanner` in spawnCli
//   (src/adapters/base.ts), which reads the adapter's event stream:
//     codex  — `item.completed` / `command_execution` (`command`,
//              `aggregated_output`, `exit_code`; the field names codex's own
//              exec output carries in ~/.codex/sessions — no recorded
//              `exec --json` stream of a failed network command was available);
//     claude — stream-json `tool_use` (name `Bash`, `input.command`) paired by
//              id with the `tool_result` that answers it (`is_error`, content);
//     cursor — stream-json `tool_call` / `shellToolCall` (`args.command`,
//              `result.success|failure` with `stdout`/`stderr`/`exitCode`).
//              The cursor shape is taken from cursor-agent's stream-json
//              format; no recorded cursor session was available to confirm it.
//   Adapters that answer over an API (codex-responses, gpt, openrouter, local,
//   ollama) run their shell through tools.ts and are covered there.
//
// Only failed commands are read: a passing `grep` over a file that happens to
// contain "Could not resolve host" is not a worker reaching for the network.
// Nothing is recorded when the worker network policy is `open` (the write
// fence is still on there, but a remote connect is allowed and expected), nor
// in a process that never declared a policy (chat, ad-hoc runs).
//
// Known limits: claude and cursor do not network-fence their own shells (only
// codex's `workspace-write` sandbox does), so under the loopback policy a
// failed connect there is read as a worker reaching for the network even when
// the host itself is offline; and a failed command whose output merely quotes
// one of these messages (a test fixture, a log) is read the same way.

import { getWorkerNetworkPolicy, isWorkerNetworkPolicyConfigured } from './osSandbox.js';

const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|localhost|\[::1\])$/i;

/**
 * The non-loopback target a sandboxed command was refused, if its output says
 * so. The refusal differs by sandbox: macOS sandbox-exec answers EPERM; Linux
 * bwrap's empty network namespace answers ENETUNREACH for an address (measured
 * on vela: Node `connect ENETUNREACH 192.168.x.x:443`, curl exit 7 "Could not
 * connect to server") and a name-resolution failure for a hostname, because
 * there is no resolver in the namespace: curl `(6) Could not resolve host: X`,
 * git `Could not resolve host: X`, Node `getaddrinfo ENOTFOUND X` /
 * `getaddrinfo EAI_AGAIN X`, glibc `X: Temporary failure in name resolution`.
 * For those the hostname is the target.
 */
export function nonLoopbackConnectDenial(output: string): string | undefined {
  const node = /connect (?:EPERM|ENETUNREACH|EACCES) (\[[^\]]+\]|[0-9A-Fa-f:.]+?)(?::(\d+))?(?=\s|$)/.exec(output);
  if (node && !LOOPBACK.test(node[1])) return node[2] ? `${node[1]}:${node[2]}` : node[1];
  const curl = /Failed to connect to (\S+) port (\d+)[^\n]*(?:Operation not permitted|Network is unreachable|Could not connect to server)/i.exec(output);
  if (curl && !LOOPBACK.test(curl[1])) return `${curl[1]}:${curl[2]}`;
  const resolve = /Could not resolve host:?\s+'?([A-Za-z0-9.-]+)/i.exec(output)
    ?? /getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([A-Za-z0-9.-]+)/.exec(output)
    ?? /([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d+)?: Temporary failure in name resolution/i.exec(output);
  if (resolve && !LOOPBACK.test(resolve[1])) return resolve[1];
  // Python/pip print the glibc error without the name in front (`[Errno -3] Temporary failure in name
  // resolution`); urllib3 names it as `host='x'` elsewhere in the same message.
  if (/Temporary failure in name resolution/i.test(output)) {
    const host = /host='([A-Za-z0-9.-]+)'/.exec(output)?.[1];
    if (!host) return 'unresolved host';
    if (!LOOPBACK.test(host)) return host;
  }
  return undefined;
}

/** Cheap pre-filter, so the database module is loaded only when it may matter. */
const MAYBE_NETWORK = /ENETUNREACH|EPERM|EACCES|Failed to connect to|Could not resolve host|getaddrinfo|name resolution/i;

/**
 * Whether a denial should be recorded at all: only in a process that declared
 * its worker network policy (the daemon, `openswarm work`), and only when that
 * policy is loopback-only.
 */
export function networkDenialsRecorded(): boolean {
  return isWorkerNetworkPolicyConfigured() && getWorkerNetworkPolicy() === 'loopback';
}

/**
 * Record a refused non-loopback connect for the anomaly monitor, which pauses
 * the repository and alerts once. Fire-and-forget; never throws. Returns the
 * target it recorded, if any (for tests and callers that log).
 */
export function noteNetworkDenial(output: string, command: string, cwd: string): string | undefined {
  if (!networkDenialsRecorded() || !MAYBE_NETWORK.test(output)) return undefined;
  const target = nonLoopbackConnectDenial(output);
  if (!target) return undefined;
  void import('../automation/anomalyPause.js').then(({ recordFactorySignal }) => {
    recordFactorySignal({ projectPath: cwd, kind: 'sandbox_network', detail: `${target}\n${command.slice(0, 500)}` });
  }).catch(() => { /* bookkeeping only */ });
  return target;
}

export interface FailedCommand {
  command: string;
  output: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => str(obj(c)?.text)).join('\n');
}

/**
 * Reads one adapter's event stream line by line and returns the failed shell
 * commands it reports. Stateful only for claude, whose result arrives in a
 * later event than the command it answers.
 */
export class CliCommandOutputReader {
  private readonly bashCalls = new Map<string, string>();

  read(line: string): FailedCommand | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return undefined;
    let event: Json;
    try {
      event = JSON.parse(trimmed) as Json;
    } catch {
      return undefined;
    }
    // codex
    const item = obj(event.item);
    if (event.type === 'item.completed' && item?.type === 'command_execution') {
      const failed = typeof item.exit_code === 'number' ? item.exit_code !== 0 : item.status === 'failed';
      return failed ? { command: str(item.command), output: str(item.aggregated_output) } : undefined;
    }
    // cursor
    const shell = obj(obj(event.tool_call)?.shellToolCall);
    if (event.type === 'tool_call' && shell) {
      const result = obj(shell.result);
      const outcome = obj(result?.failure) ?? obj(result?.success);
      const exitCode = outcome?.exitCode;
      const failed = !!result?.failure || (typeof exitCode === 'number' && exitCode !== 0);
      if (!failed || !outcome) return undefined;
      return { command: str(obj(shell.args)?.command), output: `${str(outcome.stdout)}\n${str(outcome.stderr)}` };
    }
    // claude
    const content = obj(event.message)?.content;
    if (!Array.isArray(content)) return undefined;
    for (const part of content.map(obj)) {
      if (part?.type === 'tool_use' && part.name === 'Bash' && typeof part.id === 'string') {
        this.bashCalls.set(part.id, str(obj(part.input)?.command));
      } else if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
        const command = this.bashCalls.get(part.tool_use_id);
        if (command === undefined) continue;
        this.bashCalls.delete(part.tool_use_id);
        const output = contentText(part.content);
        if (part.is_error === true || /^Exit code [1-9]/.test(output)) return { command, output };
      }
    }
    return undefined;
  }
}

/**
 * A per-run scanner for spawnCli: feed it stdout chunks as they arrive (the
 * retained stdout is bounded, so scanning at the end could miss a refusal in
 * a long run). Records at most one denial per run; one is enough to trip.
 */
export function createCliNetworkScanner(cwd: string): { push(chunk: string): void; flush(): void } {
  const reader = new CliCommandOutputReader();
  let buffer = '';
  let recorded = false;
  const scan = (line: string): void => {
    if (recorded) return;
    const failed = reader.read(line);
    if (failed && noteNetworkDenial(failed.output, failed.command, cwd)) recorded = true;
  };
  return {
    push(chunk: string): void {
      if (recorded) return;
      const lines = (buffer + chunk).split('\n');
      buffer = lines.pop() ?? '';
      // A single unterminated line larger than this is not an event worth parsing.
      if (buffer.length > 4 * 1024 * 1024) buffer = '';
      for (const line of lines) scan(line);
    },
    flush(): void {
      if (buffer) scan(buffer);
      buffer = '';
    },
  };
}
