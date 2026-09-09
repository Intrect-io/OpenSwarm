// OpenRouter provider preferences: nitro-speed routing with a price ceiling.
//
// `:nitro` on the model slug also unlocks paid priority tiers. We keep the
// model id unchanged and send equivalent routing in `provider` so a cheap
// model cannot jump to a 10× Cerebras-class endpoint (AX-568 / AGT-2853).
// Score when live metrics exist: (throughput / latency) / blended price.

export const DEFAULT_PRICE_MULTIPLIER = 3;
export const DEFAULT_PREFERRED_MAX_LATENCY_S = 2;
export const PRICE_CAP_CACHE_TTL_MS = 5 * 60 * 1000;
const ENDPOINTS_TIMEOUT_MS = 2_500;
const TOKENS_PER_MILLION = 1_000_000;
const OUTPUT_WEIGHT = 2;
const MIN_LATENCY_S = 0.05;

export interface OpenRouterMaxPrice {
  prompt: number;
  completion: number;
}

export interface OpenRouterEndpointQuote {
  provider: string;
  promptUsdPerMillion: number;
  completionUsdPerMillion: number;
  throughputTokPerSec?: number | null;
  latencySec?: number | null;
}

export interface OpenRouterProviderPreferences {
  only?: string[];
  allow_fallbacks?: boolean;
  data_collection?: 'deny';
  sort?: 'throughput';
  preferred_max_latency?: number;
  max_price?: OpenRouterMaxPrice;
  order?: string[];
}

export interface BuildOpenRouterProviderInput {
  model: string;
  pinnedProviders?: string[];
  maxPrice?: OpenRouterMaxPrice;
  order?: string[];
  preferredMaxLatency?: number;
}

type CacheEntry = { at: number; cap?: OpenRouterMaxPrice; order?: string[] };

const priceCapCache = new Map<string, CacheEntry>();

export function resetOpenRouterPriceCapCache(): void {
  priceCapCache.clear();
}

export function canonicalOpenRouterModelId(model: string): string {
  return model.split(':')[0] ?? model;
}

export function isOpenAiRoutedModel(model: string): boolean {
  return /^openai\//i.test(canonicalOpenRouterModelId(model));
}

export function usdPerMillion(perToken: string | number | null | undefined): number | undefined {
  if (perToken === null || perToken === undefined || perToken === '') return undefined;
  const n = typeof perToken === 'number' ? perToken : Number(perToken);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n * TOKENS_PER_MILLION;
}

export function blendedUsdPerMillion(prompt: number, completion: number): number {
  return prompt + OUTPUT_WEIGHT * completion;
}

/** (tok/s ÷ latency) ÷ blended $/M — higher is faster per dollar. */
export function scoreOpenRouterEndpoint(ep: {
  throughputTokPerSec: number;
  latencySec: number;
  promptUsdPerMillion: number;
  completionUsdPerMillion: number;
}): number {
  const price = Math.max(blendedUsdPerMillion(ep.promptUsdPerMillion, ep.completionUsdPerMillion), 1e-9);
  const speed = ep.throughputTokPerSec / Math.max(ep.latencySec, MIN_LATENCY_S);
  return speed / price;
}

export function priceCapFromEndpoints(
  endpoints: OpenRouterEndpointQuote[],
  multiplier = readPriceMultiplier(),
): OpenRouterMaxPrice | undefined {
  const priced = endpoints.filter((ep) => ep.promptUsdPerMillion > 0 && ep.completionUsdPerMillion > 0);
  if (priced.length === 0) return undefined;
  const factor = Number.isFinite(multiplier) && multiplier >= 1 ? multiplier : DEFAULT_PRICE_MULTIPLIER;
  const prompt = Math.min(...priced.map((ep) => ep.promptUsdPerMillion)) * factor;
  const completion = Math.min(...priced.map((ep) => ep.completionUsdPerMillion)) * factor;
  return {
    prompt: roundUsd(prompt),
    completion: roundUsd(completion),
  };
}

export function rankOpenRouterProviders(
  endpoints: OpenRouterEndpointQuote[],
  maxPrice?: OpenRouterMaxPrice,
): string[] {
  const eligible = endpoints.filter((ep) => {
    if (ep.promptUsdPerMillion <= 0 || ep.completionUsdPerMillion <= 0) return false;
    if (!maxPrice) return true;
    return ep.promptUsdPerMillion <= maxPrice.prompt && ep.completionUsdPerMillion <= maxPrice.completion;
  });
  const scored = eligible
    .map((ep) => {
      const throughput = ep.throughputTokPerSec;
      const latency = ep.latencySec;
      if (throughput == null || latency == null || throughput <= 0 || latency <= 0) return undefined;
      return {
        provider: ep.provider,
        score: scoreOpenRouterEndpoint({
          throughputTokPerSec: throughput,
          latencySec: latency,
          promptUsdPerMillion: ep.promptUsdPerMillion,
          completionUsdPerMillion: ep.completionUsdPerMillion,
        }),
      };
    })
    .filter((row): row is { provider: string; score: number } => row !== undefined)
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const row of scored) {
    if (seen.has(row.provider)) continue;
    seen.add(row.provider);
    order.push(row.provider);
  }
  return order;
}

export function parseOpenRouterEndpoints(payload: unknown): OpenRouterEndpointQuote[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: { endpoints?: unknown } }).data;
  const raw = Array.isArray(data?.endpoints) ? data.endpoints : [];
  const quotes: OpenRouterEndpointQuote[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as {
      provider_name?: unknown;
      status?: unknown;
      pricing?: { prompt?: unknown; completion?: unknown };
      throughput_last_30m?: unknown;
      latency_last_30m?: unknown;
    };
    if (typeof row.status === 'number' && row.status < 0) continue;
    const provider = typeof row.provider_name === 'string' ? row.provider_name.trim() : '';
    const promptUsdPerMillion = usdPerMillion(row.pricing?.prompt as string | number | undefined);
    const completionUsdPerMillion = usdPerMillion(row.pricing?.completion as string | number | undefined);
    if (!provider || promptUsdPerMillion === undefined || completionUsdPerMillion === undefined) continue;
    quotes.push({
      provider,
      promptUsdPerMillion,
      completionUsdPerMillion,
      throughputTokPerSec: asFiniteNumber(row.throughput_last_30m),
      latencySec: asFiniteNumber(row.latency_last_30m),
    });
  }
  return quotes;
}

export function buildOpenRouterProviderPreferences(
  input: BuildOpenRouterProviderInput,
): OpenRouterProviderPreferences | undefined {
  const pinned = (input.pinnedProviders ?? readPinnedProviders()).filter(Boolean);
  if (pinned.length > 0) {
    return { only: pinned, allow_fallbacks: false };
  }

  const prefs: OpenRouterProviderPreferences = {
    sort: 'throughput',
    preferred_max_latency: input.preferredMaxLatency ?? readPreferredMaxLatency(),
  };
  if (!isOpenAiRoutedModel(input.model)) {
    prefs.data_collection = 'deny';
  }
  if (input.maxPrice && input.maxPrice.prompt > 0 && input.maxPrice.completion > 0) {
    prefs.max_price = input.maxPrice;
  }
  if (input.order && input.order.length > 0) {
    prefs.order = input.order;
  }
  return prefs;
}

export async function lookupOpenRouterPriceCap(
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ maxPrice?: OpenRouterMaxPrice; order?: string[] } | undefined> {
  const cacheKey = canonicalOpenRouterModelId(model);
  const hit = priceCapCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PRICE_CAP_CACHE_TTL_MS) {
    return { maxPrice: hit.cap, order: hit.order };
  }

  try {
    const res = await fetchImpl(`${openRouterApiBase()}/models/${cacheKey}/endpoints`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(ENDPOINTS_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const quotes = parseOpenRouterEndpoints(await res.json());
    const maxPrice = priceCapFromEndpoints(quotes);
    const order = rankOpenRouterProviders(quotes, maxPrice);
    return remember(cacheKey, maxPrice, order.length > 0 ? order : undefined);
  } catch {
    return undefined;
  }
}

function remember(
  cacheKey: string,
  cap: OpenRouterMaxPrice | undefined,
  order: string[] | undefined,
): { maxPrice?: OpenRouterMaxPrice; order?: string[] } {
  priceCapCache.set(cacheKey, { at: Date.now(), cap, order });
  return { maxPrice: cap, order };
}

function readPinnedProviders(): string[] {
  return (process.env.OPENROUTER_PROVIDER_ONLY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readPriceMultiplier(): number {
  const raw = Number(process.env.OPENROUTER_PRICE_MULTIPLIER);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_PRICE_MULTIPLIER;
}

function readPreferredMaxLatency(): number {
  const raw = Number(process.env.OPENROUTER_PREFERRED_MAX_LATENCY);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PREFERRED_MAX_LATENCY_S;
}

function openRouterApiBase(): string {
  return 'https://openrouter.ai/api/v1';
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function roundUsd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
