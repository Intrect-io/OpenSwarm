// ============================================
// OpenSwarm — is this Linear API key alive? (AGT-4028 / AGT-4075)
// ============================================
//
// The daemon can run on an OAuth profile and never touch `LINEAR_API_KEY`,
// while every worker inherits that key as its only Linear credential. Nothing
// checked it. Measured on vela 2026-08-28: the exported key answered 401 to
// every agent write while the daemon's own token answered 200. One `viewer`
// query at boot is the whole check.

export type LinearKeyProbe =
  | { ok: true; viewer: string }
  | { ok: false; reason: string };

/** Linear takes a personal API key as the raw `Authorization` value (not `Bearer`). */
export async function probeLinearApiKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<LinearKeyProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer { name } }' }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}: ${text.slice(0, 160).replace(/\s+/g, ' ')}` };
    }
    let body: { data?: { viewer?: { name?: string } }; errors?: Array<{ message?: string }> };
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, reason: `unparseable response: ${text.slice(0, 120)}` };
    }
    const name = body.data?.viewer?.name;
    if (!name) return { ok: false, reason: body.errors?.[0]?.message ?? 'no viewer in response' };
    return { ok: true, viewer: name };
  } catch (error) {
    // A network failure says nothing about the key; report it as such so the
    // caller can keep the key rather than withhold a possibly good one.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `probe did not complete: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Only an answer from Linear condemns a key; a failed probe is not a verdict. */
export function probeCondemnsKey(probe: LinearKeyProbe): boolean {
  return !probe.ok && /^HTTP (400|401|403)\b/.test(probe.reason);
}
