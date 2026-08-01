// ============================================
// OpenSwarm telemetry collector — Cloudflare Worker → D1
// ============================================
//
// Receives anonymous usage events from the OpenSwarm CLI/daemon and appends them
// to D1 `intrect-telemetry.openswarm_events`. (INT-1992)
//
// Defense in depth: even though the client only sends a flat anonymous payload,
// this worker re-whitelists fields and clamps lengths so nothing unexpected (PII,
// oversized blobs) can be smuggled into the table.

export interface Env {
  DB: D1Database;
}

/** Coerce to a trimmed string of bounded length, or null. */
function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Failed-check names, re-whitelisted here.
 *
 * The client already filters this, and that is not a reason to trust it: this
 * endpoint is public, so anything accepted here is something an arbitrary
 * caller can write into the table. The list is duplicated rather than shared
 * because the two sides are deployed independently — a client rollout must not
 * be able to widen what the collector stores.
 */
const ALLOWED_DETAILS = new Set([
  'node', 'native-deps', 'providers', 'config', 'linear', 'ports', 'git', 'gh',
]);

function detail(v: unknown): string | null {
  const raw = str(v, 200);
  if (!raw) return null;
  const names = raw.split(',').map((n) => n.trim().toLowerCase()).filter((n) => ALLOWED_DETAILS.has(n));
  return names.length ? [...new Set(names)].slice(0, 8).join(',') : null;
}

/** Milliseconds, bounded — a day is already far beyond any real command. */
function duration(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.min(Math.round(v), 86_400_000);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return new Response('bad json', { status: 400 });
    }

    const installId = str(body.installId, 64);
    if (!installId) return new Response('missing installId', { status: 400 });

    // Cloudflare-provided coarse geo (country only — no IP is stored).
    const country = req.headers.get('cf-ipcountry');

    try {
      await env.DB.prepare(
        `INSERT INTO openswarm_events
           (install_id, event, version, platform, arch, node_version, command, adapter, is_error, country, detail, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          installId,
          str(body.event, 32) ?? 'invoke',
          str(body.version, 32),
          str(body.platform, 16),
          str(body.arch, 16),
          str(body.nodeVersion, 16),
          str(body.command, 32),
          str(body.adapter, 32),
          body.isError ? 1 : 0,
          country && country !== 'XX' ? country.slice(0, 2) : null,
          detail(body.detail),
          duration(body.durationMs),
        )
        .run();
    } catch {
      return new Response('db error', { status: 500 });
    }

    return new Response(null, { status: 204 });
  },
};
