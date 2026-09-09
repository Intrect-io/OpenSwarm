import { afterEach, describe, expect, it } from 'vitest';
import {
  buildOpenRouterProviderPreferences,
  canonicalOpenRouterModelId,
  lookupOpenRouterPriceCap,
  parseOpenRouterEndpoints,
  priceCapFromEndpoints,
  rankOpenRouterProviders,
  resetOpenRouterPriceCapCache,
  scoreOpenRouterEndpoint,
  usdPerMillion,
} from './openrouterProvider.js';

afterEach(() => {
  resetOpenRouterPriceCapCache();
  delete process.env.OPENROUTER_PROVIDER_ONLY;
  delete process.env.OPENROUTER_PRICE_MULTIPLIER;
  delete process.env.OPENROUTER_PREFERRED_MAX_LATENCY;
});

describe('openrouterProvider scoring', () => {
  it('converts per-token prices to USD per million', () => {
    expect(usdPerMillion('0.0000000679')).toBeCloseTo(0.0679, 6);
    expect(usdPerMillion(0.000000168)).toBeCloseTo(0.168, 6);
  });

  it('caps max_price at floor × multiplier so a 10× premium is refused', () => {
    const cap = priceCapFromEndpoints([
      { provider: 'DeepInfra', promptUsdPerMillion: 0.24, completionUsdPerMillion: 0.24 },
      { provider: 'Cerebras', promptUsdPerMillion: 2.26, completionUsdPerMillion: 2.26 },
    ], 3);
    expect(cap).toEqual({ prompt: 0.72, completion: 0.72 });
    expect(2.26 > (cap?.prompt ?? 0)).toBe(true);
  });

  it('ranks the faster cheaper endpoint above a slow expensive one', () => {
    const cheapFast = scoreOpenRouterEndpoint({
      throughputTokPerSec: 800,
      latencySec: 0.4,
      promptUsdPerMillion: 0.24,
      completionUsdPerMillion: 0.24,
    });
    const priceyFast = scoreOpenRouterEndpoint({
      throughputTokPerSec: 2000,
      latencySec: 0.2,
      promptUsdPerMillion: 2.26,
      completionUsdPerMillion: 2.26,
    });
    expect(cheapFast).toBeGreaterThan(priceyFast);
  });

  it('orders providers by score and drops those over the cap', () => {
    const order = rankOpenRouterProviders(
      [
        {
          provider: 'Cerebras',
          promptUsdPerMillion: 2.26,
          completionUsdPerMillion: 2.26,
          throughputTokPerSec: 2000,
          latencySec: 0.2,
        },
        {
          provider: 'DeepInfra',
          promptUsdPerMillion: 0.24,
          completionUsdPerMillion: 0.24,
          throughputTokPerSec: 800,
          latencySec: 0.4,
        },
        {
          provider: 'Novita',
          promptUsdPerMillion: 0.3,
          completionUsdPerMillion: 0.3,
          throughputTokPerSec: 160,
          latencySec: 1.2,
        },
      ],
      { prompt: 0.72, completion: 0.72 },
    );
    expect(order).toEqual(['DeepInfra', 'Novita']);
  });

  it('skips offline endpoints when parsing', () => {
    const quotes = parseOpenRouterEndpoints({
      data: {
        endpoints: [
          {
            provider_name: 'StreamLake',
            status: -2,
            pricing: { prompt: '0.0000001', completion: '0.0000002' },
          },
          {
            provider_name: 'DeepInfra',
            status: 0,
            pricing: { prompt: '0.00000009', completion: '0.00000018' },
            throughput_last_30m: 500,
            latency_last_30m: 0.3,
          },
        ],
      },
    });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.provider).toBe('DeepInfra');
  });
});

describe('buildOpenRouterProviderPreferences', () => {
  it('uses throughput + latency (nitro) and ZDR for non-OpenAI models', () => {
    expect(buildOpenRouterProviderPreferences({
      model: 'deepseek/deepseek-v4-flash',
      maxPrice: { prompt: 0.2, completion: 0.5 },
    })).toEqual({
      data_collection: 'deny',
      sort: 'throughput',
      preferred_max_latency: 2,
      max_price: { prompt: 0.2, completion: 0.5 },
    });
  });

  it('keeps OpenAI models off ZDR but still speed+price routes them', () => {
    expect(buildOpenRouterProviderPreferences({
      model: 'openai/gpt-5',
      maxPrice: { prompt: 3, completion: 6 },
    })).toEqual({
      sort: 'throughput',
      preferred_max_latency: 2,
      max_price: { prompt: 3, completion: 6 },
    });
  });

  it('lets OPENROUTER_PROVIDER_ONLY replace routing prefs', () => {
    process.env.OPENROUTER_PROVIDER_ONLY = 'atlas-cloud,deepinfra';
    expect(buildOpenRouterProviderPreferences({
      model: 'deepseek/deepseek-v4-flash',
      maxPrice: { prompt: 1, completion: 2 },
    })).toEqual({ only: ['atlas-cloud', 'deepinfra'], allow_fallbacks: false });
  });

  it('strips :nitro from the catalog id so we do not unlock priority tiers', () => {
    expect(canonicalOpenRouterModelId('deepseek/deepseek-v4-flash:nitro')).toBe(
      'deepseek/deepseek-v4-flash',
    );
  });
});

describe('lookupOpenRouterPriceCap', () => {
  it('returns floor × 3 and caches the result', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        data: {
          endpoints: [
            {
              provider_name: 'DigitalOcean',
              status: 0,
              pricing: { prompt: '0.0000001', completion: '0.0000002' },
            },
            {
              provider_name: 'Azure',
              status: 0,
              pricing: { prompt: '0.0000003', completion: '0.0000006' },
            },
          ],
        },
      }));
    }) as typeof fetch;

    const first = await lookupOpenRouterPriceCap('sk-or-test', 'deepseek/deepseek-v4-flash:nitro', fetchImpl);
    const second = await lookupOpenRouterPriceCap('sk-or-test', 'deepseek/deepseek-v4-flash', fetchImpl);
    expect(first?.maxPrice).toEqual({ prompt: 0.3, completion: 0.6 });
    expect(second?.maxPrice).toEqual(first?.maxPrice);
    expect(calls).toBe(1);
  });

  it('fails open when the endpoints probe errors', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(lookupOpenRouterPriceCap('sk-or-test', 'openai/gpt-5', fetchImpl)).resolves.toBeUndefined();
  });
});
