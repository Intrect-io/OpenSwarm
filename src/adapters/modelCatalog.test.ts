import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  catalogCacheDir,
  loadModelCatalog,
  parseOpenAiModelList,
  readCachedCatalog,
  resolveDefaultModel,
  writeCachedCatalog,
  type CatalogSpec,
} from './modelCatalog.js';

const tmp = () => mkdtempSync(resolve(tmpdir(), 'openswarm-catalog-'));

function spec(overrides: Partial<CatalogSpec> = {}): CatalogSpec {
  return {
    provider: 'testprovider',
    curated: ['curated/a', 'curated/b'],
    fetchLive: async () => ['live/x', 'live/y'],
    ...overrides,
  };
}

describe('parseOpenAiModelList', () => {
  it('extracts ids from an OpenAI-shaped response', () => {
    expect(parseOpenAiModelList({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
  });

  it('de-dupes and drops empty ids', () => {
    expect(parseOpenAiModelList({ data: [{ id: 'a' }, { id: 'a' }, { id: '' }, {}] })).toEqual(['a']);
  });

  it('returns [] for malformed bodies rather than throwing', () => {
    expect(parseOpenAiModelList(null)).toEqual([]);
    expect(parseOpenAiModelList({})).toEqual([]);
    expect(parseOpenAiModelList({ data: 'nope' })).toEqual([]);
  });
});

describe('loadModelCatalog', () => {
  it('serves a fresh cache without touching the network', async () => {
    const dir = tmp();
    writeCachedCatalog('testprovider', ['cached/one'], dir);
    const fetchLive = vi.fn(async () => ['live/x']);

    const catalog = await loadModelCatalog(spec({ fetchLive }), { cacheDir: dir });

    expect(catalog.origin).toBe('cache');
    expect(catalog.models).toEqual(['cached/one']);
    expect(fetchLive).not.toHaveBeenCalled();
  });

  it('refreshes and rewrites the cache once the TTL has passed', async () => {
    const dir = tmp();
    writeCachedCatalog('testprovider', ['cached/one'], dir);
    const later = Date.now() + 7 * 60 * 60 * 1000;

    const catalog = await loadModelCatalog(spec(), { cacheDir: dir, now: later });

    expect(catalog.origin).toBe('live');
    expect(catalog.models).toEqual(['live/x', 'live/y']);
    expect(readCachedCatalog('testprovider', dir)?.models).toEqual(['live/x', 'live/y']);
  });

  it('falls back to a stale cache when the provider is unreachable', async () => {
    const dir = tmp();
    writeCachedCatalog('testprovider', ['cached/one'], dir);
    const later = Date.now() + 7 * 60 * 60 * 1000;

    const catalog = await loadModelCatalog(
      spec({ fetchLive: async () => { throw new Error('offline'); } }),
      { cacheDir: dir, now: later },
    );

    // A known-real list beats a guess, even when it is old.
    expect(catalog.origin).toBe('stale-cache');
    expect(catalog.models).toEqual(['cached/one']);
  });

  it('falls back to curated when there is neither cache nor network', async () => {
    const catalog = await loadModelCatalog(
      spec({ fetchLive: async () => { throw new Error('offline'); } }),
      { cacheDir: tmp() },
    );
    expect(catalog.origin).toBe('curated');
    expect(catalog.models).toEqual(['curated/a', 'curated/b']);
  });

  it('treats an empty live response as a failure, not an empty catalog', async () => {
    const catalog = await loadModelCatalog(spec({ fetchLive: async () => [] }), { cacheDir: tmp() });
    expect(catalog.origin).toBe('curated');
  });

  it('forceRefresh bypasses a fresh cache', async () => {
    const dir = tmp();
    writeCachedCatalog('testprovider', ['cached/one'], dir);
    const catalog = await loadModelCatalog(spec(), { cacheDir: dir, forceRefresh: true });
    expect(catalog.origin).toBe('live');
  });
});

describe('cache file handling', () => {
  it('ignores a corrupt or empty cache instead of throwing', () => {
    const dir = tmp();
    writeFileSync(resolve(dir, 'testprovider.json'), '{ not json');
    expect(readCachedCatalog('testprovider', dir)).toBeNull();

    writeFileSync(resolve(dir, 'empty.json'), JSON.stringify({ models: [] }));
    expect(readCachedCatalog('empty', dir)).toBeNull();
  });

  it('keeps a path separator in a provider name from escaping the cache dir', () => {
    const dir = tmp();
    writeCachedCatalog('../evil', ['x'], dir);
    expect(() => JSON.parse(readFileSync(resolve(dir, '.._evil.json'), 'utf8'))).not.toThrow();
  });

  it('defaults the cache under ~/.openswarm and honours an override', () => {
    expect(catalogCacheDir({})).toMatch(/\.openswarm[/\\]model-catalogs$/);
    expect(catalogCacheDir({ OPENSWARM_MODEL_CATALOG_DIR: '/var/cache/os' })).toBe('/var/cache/os');
  });
});

describe('resolveDefaultModel', () => {
  it('keeps the preferred model when the provider still serves it', async () => {
    const s = spec({ fetchLive: async () => ['live/x', 'preferred/model'] });
    const onWarn = vi.fn();
    expect(await resolveDefaultModel(s, 'preferred/model', { cacheDir: tmp(), onWarn })).toBe('preferred/model');
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('warns and substitutes a curated model the provider still serves', async () => {
    const s = spec({ fetchLive: async () => ['curated/b', 'live/x'] });
    const onWarn = vi.fn();

    const model = await resolveDefaultModel(s, 'retired/model', { cacheDir: tmp(), onWarn });

    // curated/b is preferred over live/x: catalog order is the API's, not a choice.
    expect(model).toBe('curated/b');
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('retired/model'));
  });

  it('falls back to the first catalog entry when no curated model survives', async () => {
    const s = spec({ fetchLive: async () => ['live/x', 'live/y'] });
    expect(await resolveDefaultModel(s, 'retired/model', { cacheDir: tmp(), onWarn: vi.fn() })).toBe('live/x');
  });

  it('never second-guesses the default when only the curated list is available', async () => {
    // Offline: absence of evidence is not evidence the model was retired, and
    // refusing to run would be worse than trusting the configured default.
    const s = spec({ fetchLive: async () => { throw new Error('offline'); } });
    const onWarn = vi.fn();
    expect(await resolveDefaultModel(s, 'anything/at-all', { cacheDir: tmp(), onWarn })).toBe('anything/at-all');
    expect(onWarn).not.toHaveBeenCalled();
  });
});
