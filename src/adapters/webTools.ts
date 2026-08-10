// ============================================
// OpenSwarm - Web tools (web_fetch + web_search)
// ============================================
//
// First-class web capability for the agentic loop, shared by every adapter
// (openrouter/gpt/local) — the `claude -p` harness used to provide this for
// free (INT-1573). The model calls these deliberately, like `bash`.
//
// web_fetch is keyless. web_search has a pluggable backend: Tavily or Brave
// when a key is set, else a keyless (and fragile) DuckDuckGo fallback.

import type { ToolDefinition } from './tools.js';
import { publicFetch } from '../support/outboundUrl.js';

export const WEB_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a URL and return its readable text (HTML stripped to text). Use when you already have a URL (docs, a page) and want its content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http(s) URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web and return ranked results (title, url, snippet). Use to find documentation, API usage, library versions, or current facts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Max results to return (default 5, max 10)' },
        },
        required: ['query'],
      },
    },
  },
];

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_CHARS = 20_000;
const USER_AGENT = 'OpenSwarm/0.6 (+https://github.com/unohee/openswarm)';

interface BoundedResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
}

/**
 * `truncate` keeps the prefix that fits — right for page text, which webFetch
 * shortens anyway. `error` is for JSON endpoints, where half a document parses
 * into a confusing failure rather than a partial answer.
 */
type OverflowPolicy = 'truncate' | 'error';

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  onOverflow: OverflowPolicy,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('response body exceeds limit');
      if (onOverflow === 'error') throw new Error(`Response body exceeds ${maxBytes} bytes`);
      const keep = value.byteLength - (total - maxBytes);
      if (keep > 0) chunks.push(value.subarray(0, keep));
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchWithTimeout(
  inputUrl: string,
  init: RequestInit = {},
  options: { maxBytes?: number; onOverflow?: OverflowPolicy } = {},
): Promise<BoundedResponse> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, ac.signal]) : ac.signal;
  let current = inputUrl;
  const initialOrigin = new URL(inputUrl).origin;
  const carriesSensitiveRequestData = init.body != null || (() => {
    const headers = new Headers(init.headers);
    return ['authorization', 'proxy-authorization', 'x-subscription-token', 'x-api-key']
      .some((name) => headers.has(name));
  })();
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      // publicFetch re-validates every hop, so a redirect cannot walk the
      // request from a public host onto a private one.
      const response = await publicFetch(current, {
        ...init,
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': USER_AGENT, ...init.headers },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirect response has no location');
        await response.body?.cancel();
        const next = new URL(location, current);
        if (carriesSensitiveRequestData && next.origin !== initialOrigin) {
          throw new Error('Refusing to forward credentials or request body across origins');
        }
        current = next.toString();
        continue;
      }
      const body = await readBoundedBody(
        response,
        options.maxBytes ?? 2 * 1024 * 1024,
        options.onOverflow ?? 'error',
      );
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body,
      };
    }
    throw new Error('Too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

// Decode HTML entities in a SINGLE left-to-right pass. A chain of .replace()
// calls (e.g. &amp; → & before &lt; → <) double-unescapes crafted input like
// "&amp;lt;" → "<"; one pass over the original string never re-scans its own
// output, so "&amp;lt;" correctly yields the literal "&lt;". (CodeQL js/double-escaping)
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1].toLowerCase() === 'x'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 1 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

// Remove every HTML tag, repeating to a fixpoint. A single pass of /<[^>]*>/ can
// leave a tag reconstructed from the removal (e.g. "<<b>script>" → "<script>"),
// so iterate until the string stops changing. (CodeQL js/incomplete-multi-character-sanitization)
function stripAllTags(s: string): string {
  let prev: string;
  let out = s;
  do { prev = out; out = out.replace(/<[^>]*>/g, ''); } while (out !== prev);
  return out;
}

function stripTags(s: string): string {
  return decodeEntities(stripAllTags(s)).replace(/\s+/g, ' ').trim();
}

function htmlToText(html: string): string {
  // Drop script/style blocks and comments first, to a fixpoint. The closing-tag
  // matcher uses \b + [^>]* so it can't be bypassed by whitespace/attributes
  // before ">" ("</script >", "</script bar>"). (CodeQL js/bad-tag-filter)
  let prev: string;
  let out = html;
  do {
    prev = out;
    out = out
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
  } while (out !== prev);
  return decodeEntities(stripAllTags(out))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Fetch a URL → readable text (HTML stripped). Returns an error string on failure (never throws). */
export async function webFetch(url: string): Promise<string> {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return `Invalid URL: ${url} (must start with http:// or https://)`;
  }
  let res: BoundedResponse;
  try {
    // Real pages routinely exceed a text-sized budget, so keep a generous raw
    // cap and shorten the extracted text below instead of failing the fetch.
    res = await fetchWithTimeout(url, {}, { maxBytes: 2 * 1024 * 1024, onOverflow: 'truncate' });
  } catch (err) {
    return `Fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!res.ok) return `Fetch ${url} → HTTP ${res.status} ${res.statusText}`;
  const ctype = res.headers.get('content-type') ?? '';
  const body = res.body;
  const text = ctype.includes('html') || /^\s*</.test(body) ? htmlToText(body) : body;
  return text.length > MAX_FETCH_CHARS
    ? `${text.slice(0, MAX_FETCH_CHARS)}\n... (truncated, ${text.length} chars total)`
    : text || '(empty response)';
}

interface SearchResult { title: string; url: string; snippet: string }

/** Which search backend is active (for diagnostics). */
export function searchBackend(): 'tavily' | 'brave' | 'duckduckgo' {
  if (process.env.TAVILY_KEY) return 'tavily';
  if (process.env.BRAVE_SEARCH_KEY) return 'brave';
  return 'duckduckgo';
}

/** Search the web → formatted result list. Returns an error string on failure (never throws). */
export async function webSearch(query: string, maxResults = 5): Promise<string> {
  if (typeof query !== 'string' || !query.trim()) return 'Invalid query: a non-empty search query is required.';
  const n = Math.min(Math.max(Number(maxResults) || 5, 1), 10);
  try {
    const backend = searchBackend();
    const results =
      backend === 'tavily' ? await tavilySearch(query, n)
      : backend === 'brave' ? await braveSearch(query, n)
      : await ddgSearch(query, n);
    if (results.length === 0) return `No results for "${query}".`;
    return results.map((r, i) => `${i + 1}. ${r.title.slice(0, 500)}\n   ${r.url.slice(0, 2_000)}${r.snippet ? `\n   ${r.snippet.slice(0, 500)}` : ''}`).join('\n\n');
  } catch (err) {
    const keyed = process.env.TAVILY_KEY || process.env.BRAVE_SEARCH_KEY;
    const hint = keyed ? '' : ' (the keyless DuckDuckGo backend is fragile — set TAVILY_KEY or BRAVE_SEARCH_KEY for reliable search)';
    return `Search failed for "${query}": ${err instanceof Error ? err.message : String(err)}${hint}`;
  }
}

async function tavilySearch(query: string, n: number): Promise<SearchResult[]> {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.TAVILY_KEY, query, max_results: n }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = JSON.parse(res.body) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, n).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 300),
  }));
}

async function braveSearch(query: string, n: number): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'X-Subscription-Token': process.env.BRAVE_SEARCH_KEY ?? '', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = JSON.parse(res.body) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (data.web?.results ?? []).slice(0, n).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: stripTags(r.description ?? '').slice(0, 300),
  }));
}

async function ddgSearch(query: string, n: number): Promise<SearchResult[]> {
  const res = await fetchWithTimeout(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {},
  );
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = res.body;

  const results: SearchResult[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && results.length < n) {
    results.push({ title: stripTags(m[2]), url: decodeDdgUrl(m[1]), snippet: '' });
  }

  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let i = 0;
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html)) !== null && i < results.length) {
    results[i].snippet = stripTags(sm[1]).slice(0, 300);
    i++;
  }
  return results;
}

function decodeDdgUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}
