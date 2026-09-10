import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, initLocale, t, withLocale } from './index.js';

afterEach(() => {
  initLocale('en');
});

describe('execution-scoped locale (AGT-3420)', () => {
  it('isolates concurrent withLocale scopes so siblings do not leak', async () => {
    initLocale('en');

    const seen: string[] = [];
    await Promise.all([
      withLocale('ko', async () => {
        await new Promise((r) => setTimeout(r, 20));
        seen.push(`ko:${getLocale()}:${t('common.timeAgo.justNow')}`);
      }),
      withLocale('en', async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(`en:${getLocale()}:${t('common.timeAgo.justNow')}`);
      }),
    ]);

    expect(seen).toContain('en:en:just now');
    expect(seen).toContain('ko:ko:방금 전');
    // Process default remains whatever initLocale last set — scopes must not
    // permanently flip it for other concurrent work.
    expect(getLocale()).toBe('en');
  });

  it('restores the outer locale after withLocale returns', async () => {
    initLocale('en');
    await withLocale('ko', async () => {
      expect(getLocale()).toBe('ko');
    });
    expect(getLocale()).toBe('en');
  });
});
