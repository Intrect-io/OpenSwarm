// ============================================
// OpenSwarm - Web tools under the worker network fence (AGT-4815)
// ============================================
//
// `autonomous.workerNetwork: loopback` (AGT-4798) fences the worker's shell to
// 127.0.0.1/::1, but `web_fetch` and `web_search` run inside the daemon
// process, outside that fence. A worker that could not `curl` a remote could
// still fetch one, and a fetch URL is an outbound channel for anything the
// worker can read. So whenever the bash tool would run network-fenced, the web
// tools are withheld from the model and refused if called anyway.

import { getWorkerNetworkPolicy } from '../support/osSandbox.js';
import type { ToolResult } from './tools.js';

const WEB_TOOL_NAMES = new Set(['web_fetch', 'web_search']);

/**
 * True when the worker network is loopback-only for a run with this sandbox
 * mode: the same condition under which the bash tool unshares the network.
 */
export function webToolsBlockedByNetwork(sandbox: 'on' | 'off' | undefined): boolean {
  return sandbox === 'on' && getWorkerNetworkPolicy() !== 'open';
}

/** The refusal for a web tool call under the loopback network, or null when it may run. */
export function webToolNetworkDenial(name: string, callId: string, sandbox: 'on' | 'off' | undefined): ToolResult | null {
  if (!WEB_TOOL_NAMES.has(name) || !webToolsBlockedByNetwork(sandbox)) return null;
  return {
    tool_call_id: callId,
    content: `NETWORK_FENCED: ${name} is refused because the worker network is loopback-only `
      + '(autonomous.workerNetwork: loopback). Work from the repository and local docs; '
      + 'dependencies belong to the project setup step, which runs with the network open.',
    is_error: true,
  };
}
