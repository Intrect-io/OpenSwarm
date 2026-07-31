import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBEDDING_MODEL,
  characterGuard,
  embeddingSignature,
  embeddingTextFor,
  modelCacheDir,
  readStoredSignature,
  resolveEmbeddingConfig,
  writeStoredSignature,
} from './embeddingConfig.js';

describe('resolveEmbeddingConfig', () => {
  it('defaults to the measured multilingual-e5-base setup', () => {
    const spec = resolveEmbeddingConfig({});
    expect(spec.id).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(spec.dim).toBe(768);
    expect(spec.maxTokens).toBe(512);
    expect(spec.dtype).toBe('q8');
  });

  it('applies the E5 asymmetric retrieval convention', () => {
    const spec = resolveEmbeddingConfig({});
    expect(spec.passagePrefix).toBe('passage: ');
    expect(spec.queryPrefix).toBe('query: ');
    expect(spec.passagePrefix).not.toBe(spec.queryPrefix);
  });

  it('resolves other known models with their own dimension', () => {
    expect(resolveEmbeddingConfig({ OPENSWARM_EMBEDDING_MODEL: 'Xenova/multilingual-e5-small' }).dim).toBe(384);
    expect(resolveEmbeddingConfig({ OPENSWARM_EMBEDDING_MODEL: 'Xenova/multilingual-e5-large' }).dim).toBe(1024);
  });

  it('refuses an unknown model without an explicit dimension', () => {
    // Guessing would build a table whose vectors can never be searched.
    expect(() => resolveEmbeddingConfig({ OPENSWARM_EMBEDDING_MODEL: 'some-org/mystery-embedder' }))
      .toThrow(/OPENSWARM_EMBEDDING_DIM/);
  });

  it('accepts an unknown model once its dimension is declared', () => {
    const spec = resolveEmbeddingConfig({
      OPENSWARM_EMBEDDING_MODEL: 'some-org/mystery-embedder',
      OPENSWARM_EMBEDDING_DIM: '1024',
    });
    expect(spec.dim).toBe(1024);
    expect(spec.id).toBe('some-org/mystery-embedder');
  });

  it('rejects malformed dimensions and dtypes instead of silently defaulting', () => {
    expect(() => resolveEmbeddingConfig({ OPENSWARM_EMBEDDING_DIM: '0' })).toThrow(/positive integer/);
    expect(() => resolveEmbeddingConfig({ OPENSWARM_EMBEDDING_DIM: 'wide' })).toThrow(/positive integer/);
    expect(() => resolveEmbeddingConfig({ OPENSWARM_EMBEDDING_DTYPE: 'int3' })).toThrow(/not supported/);
  });
});

describe('characterGuard', () => {
  it('stays well above the characters that fit in the token ceiling', () => {
    const spec = resolveEmbeddingConfig({});
    // Measured on this store: ~4.6 chars/token for English, ~1.5 for Korean. The
    // guard must not cut text the encoder would have accepted.
    expect(characterGuard(spec)).toBeGreaterThan(spec.maxTokens * 4.6);
  });
});

describe('embeddingTextFor', () => {
  it('combines a distinct title with the content', () => {
    expect(embeddingTextFor('Review rejection: login', 'Do not remove CSRF validation.'))
      .toBe('Review rejection: login\nDo not remove CSRF validation.');
  });

  it('drops a title that is merely the head of the content', () => {
    // saveCognitiveMemory derives title = content.slice(0, 100); concatenating would
    // double-weight the opening of every cognitive record.
    const content = 'The daemon must never process an issue claimed by another host.';
    expect(embeddingTextFor(content.slice(0, 20), content)).toBe(content);
  });

  it('tolerates either side being empty', () => {
    expect(embeddingTextFor('', 'content only')).toBe('content only');
    expect(embeddingTextFor('title only', '')).toBe('title only');
    expect(embeddingTextFor('', '')).toBe('');
  });
});

describe('embeddingSignature', () => {
  it('changes when anything that alters the vector space changes', () => {
    const base = resolveEmbeddingConfig({});
    const baseline = embeddingSignature(base);

    expect(embeddingSignature({ ...base, dtype: 'fp16' })).not.toBe(baseline);
    expect(embeddingSignature({ ...base, dim: 1024 })).not.toBe(baseline);
    expect(embeddingSignature({ ...base, maxTokens: 2048 })).not.toBe(baseline);
    expect(embeddingSignature({ ...base, passagePrefix: 'query: ' })).not.toBe(baseline);
    expect(embeddingSignature({ ...base, id: 'other/model' })).not.toBe(baseline);
  });

  it('is stable for an unchanged configuration', () => {
    expect(embeddingSignature(resolveEmbeddingConfig({}))).toBe(embeddingSignature(resolveEmbeddingConfig({})));
  });
});

describe('signature sidecar', () => {
  it('round-trips a signature through the store directory', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'openswarm-embed-'));
    expect(readStoredSignature(dir)).toBeNull();

    writeStoredSignature(dir, 'model|dtype=q8');
    expect(readStoredSignature(dir)?.signature).toBe('model|dtype=q8');
    expect(readStoredSignature(dir)?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('treats a corrupt sidecar as "unknown" rather than throwing', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'openswarm-embed-'));
    writeFileSync(resolve(dir, 'embedding.json'), '{ not json');
    expect(readStoredSignature(dir)).toBeNull();
  });

  it('writes valid JSON', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'openswarm-embed-'));
    writeStoredSignature(dir, 'sig');
    expect(() => JSON.parse(readFileSync(resolve(dir, 'embedding.json'), 'utf8'))).not.toThrow();
  });
});

describe('modelCacheDir', () => {
  it('keeps weights outside node_modules so reinstalls do not discard them', () => {
    expect(modelCacheDir({})).toMatch(/\.openswarm[/\\]models$/);
    expect(modelCacheDir({})).not.toMatch(/node_modules/);
  });

  it('honours an explicit override', () => {
    expect(modelCacheDir({ OPENSWARM_MODEL_CACHE_DIR: '/var/cache/os-models' })).toBe('/var/cache/os-models');
  });
});
