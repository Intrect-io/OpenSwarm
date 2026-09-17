// ============================================
// OpenSwarm — every credential the daemon hands to agents is probed at boot (AGT-4075)
// ============================================
//
// vela 2026-08-29: a dead LINEAR_API_KEY sat in the agents' environment for
// 27 hours while the daemon ran on OAuth and never touched it; one run parked
// on an operator question about it. 36 of 70 unanswered operator questions
// were the same class — "this worktree has no live access to X". A dead key
// is not a policy question; it is an infrastructure fault the daemon can see
// in milliseconds. Each probe is one read-only call; the result is logged by
// NAME only, published on /api/health, and never blocks startup.
import { markWorkerEnvKeyDead } from '../adapters/envPath.js';
import { probeCondemnsKey, probeLinearApiKey, type LinearKeyProbe } from '../linear/credentialProbe.js';

export type CredentialStatus = 'ok' | 'dead' | 'unreachable';

export interface CredentialProbeResult {
  name: string;
  status: CredentialStatus;
  /** Who the key authenticates as, when the service says; never the value. */
  identity?: string;
  reason?: string;
}

/** A read-only HTTP call whose 401/403 (or 400 bearer-misuse) condemns the key. */
async function probeHttp(
  name: string,
  url: string,
  headers: Record<string, string>,
  identityOf: (body: unknown) => string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<CredentialProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    const text = await response.text();
    if (response.status === 401 || response.status === 403 || response.status === 400) {
      return { name, status: 'dead', reason: `HTTP ${response.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}` };
    }
    if (!response.ok) return { name, status: 'unreachable', reason: `HTTP ${response.status}` };
    let identity: string | undefined;
    try { identity = identityOf(JSON.parse(text)); } catch { /* an ok answer without a parseable body still means the key works */ }
    return { name, status: 'ok', identity };
  } catch (error) {
    return { name, status: 'unreachable', reason: `probe did not complete: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function fromLinear(probe: LinearKeyProbe): CredentialProbeResult {
  if (probe.ok) return { name: 'LINEAR_API_KEY', status: 'ok', identity: probe.viewer };
  return { name: 'LINEAR_API_KEY', status: probeCondemnsKey(probe) ? 'dead' : 'unreachable', reason: probe.reason };
}

/**
 * Probe every agent-facing credential present in `env`. Absent keys are not
 * reported: nothing to hand out means nothing to condemn.
 */
export async function probeAgentCredentials(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<CredentialProbeResult[]> {
  const probes: Array<Promise<CredentialProbeResult>> = [];
  const key = (name: string) => env[name]?.trim();

  if (key('LINEAR_API_KEY')) probes.push(probeLinearApiKey(key('LINEAR_API_KEY')!, fetchImpl, timeoutMs).then(fromLinear));
  if (key('OPENROUTER_API_KEY')) {
    probes.push(probeHttp('OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1/auth/key',
      { Authorization: `Bearer ${key('OPENROUTER_API_KEY')}` },
      (body) => (body as { data?: { label?: string } })?.data?.label, fetchImpl, timeoutMs));
  }
  if (key('NOTION_API_KEY')) {
    probes.push(probeHttp('NOTION_API_KEY', 'https://api.notion.com/v1/users/me',
      { Authorization: `Bearer ${key('NOTION_API_KEY')}`, 'Notion-Version': '2022-06-28' },
      (body) => (body as { name?: string })?.name, fetchImpl, timeoutMs));
  }
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    if (!key(name)) continue;
    probes.push(probeHttp(name, 'https://api.github.com/user',
      { Authorization: `Bearer ${key(name)}`, Accept: 'application/vnd.github+json', 'User-Agent': 'openswarm' },
      (body) => (body as { login?: string })?.login, fetchImpl, timeoutMs));
  }
  return Promise.all(probes);
}

const latest = new Map<string, CredentialProbeResult>();

/** The last boot's probe results by credential name, for /api/health. */
export function credentialProbeSnapshot(): Record<string, { status: CredentialStatus; identity?: string; reason?: string }> {
  const out: Record<string, { status: CredentialStatus; identity?: string; reason?: string }> = {};
  for (const [name, r] of latest) out[name] = { status: r.status, ...(r.identity ? { identity: r.identity } : {}), ...(r.reason ? { reason: r.reason } : {}) };
  return out;
}

/** Tests need the snapshot back at its initial state. */
export function resetCredentialProbeSnapshotForTests(): void {
  latest.clear();
}

/**
 * Boot-time entry: probe, remember, log by name, and withhold dead keys from
 * workers. Never throws — a probe that breaks must not keep the daemon down.
 */
export async function probeAndReportAgentCredentials(
  env: NodeJS.ProcessEnv = process.env,
  probe: (env: NodeJS.ProcessEnv) => Promise<CredentialProbeResult[]> = probeAgentCredentials,
): Promise<CredentialProbeResult[]> {
  let results: CredentialProbeResult[] = [];
  try {
    results = await probe(env);
  } catch (error) {
    console.warn('⚠️ Credential probes did not run:', error instanceof Error ? error.message : error);
    return results;
  }
  for (const r of results) {
    latest.set(r.name, r);
    if (r.status === 'ok') {
      console.log(`✅ ${r.name} answers${r.identity ? ` as ${r.identity}` : ''} — workers may use it`);
    } else if (r.status === 'dead') {
      markWorkerEnvKeyDead(r.name, r.reason ?? 'rejected');
      console.warn(`⚠️ ${r.name} is rejected by its service (${r.reason}) — withheld from workers; rotate it in .env`);
    } else {
      console.warn(`⚠️ ${r.name} could not be probed (${r.reason}) — left in place`);
    }
  }
  return results;
}
