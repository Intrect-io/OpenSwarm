import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backfillCoordinationLocale,
  needsCoordinationTranslation,
  projectCoordinationLocale,
} from './coordinationLocalization.js';
import type { CoordinationEvent } from './coordinationStore.js';

let root = '';
afterEach(() => {
  delete process.env.OPENSWARM_COORDINATION_TRANSLATIONS_FILE;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function event(over: Partial<CoordinationEvent> = {}): CoordinationEvent {
  return {
    id: 'event-1', seq: 1, timestamp: 1, repository: '/repo', taskId: 'task-1',
    actor: 'worker-a', kind: 'advice-response', status: 'completed', correlationId: 'c1',
    summary: 'Use the existing retry helper.', detail: 'It already handles HTTP 429.',
    fingerprint: 'fingerprint-1', ...over,
  };
}

describe('coordination transcript localization cache', () => {
  it('recognizes English prose without translating Korean agent output again', () => {
    expect(needsCoordinationTranslation('Use the existing retry helper.')).toBe(true);
    expect(needsCoordinationTranslation('기존 retry helper를 사용하세요.')).toBe(false);
    expect(needsCoordinationTranslation('AGT-4100')).toBe(false);
  });

  it('projects a cached translation while retaining the exact original text', async () => {
    root = mkdtempSync(join(tmpdir(), 'coordination-locale-'));
    process.env.OPENSWARM_COORDINATION_TRANSLATIONS_FILE = join(root, 'translations.json');
    const source = event();
    const result = await backfillCoordinationLocale([source], 'ko', async (items) => items.map((item) => ({
      id: item.id,
      summary: '기존 retry helper를 사용하세요.',
      detail: '이미 HTTP 429를 처리합니다.',
    })));

    expect(result).toMatchObject({ translated: 1, failed: 0 });
    expect(projectCoordinationLocale([source], 'ko')[0]).toMatchObject({
      summary: '기존 retry helper를 사용하세요.',
      detail: '이미 HTTP 429를 처리합니다.',
      localizedLocale: 'ko',
      originalText: {
        summary: 'Use the existing retry helper.',
        detail: 'It already handles HTTP 429.',
      },
    });
    expect(source.summary).toBe('Use the existing retry helper.');
  });

  it('does not apply a stale translation after the source fingerprint changes', async () => {
    root = mkdtempSync(join(tmpdir(), 'coordination-locale-stale-'));
    process.env.OPENSWARM_COORDINATION_TRANSLATIONS_FILE = join(root, 'translations.json');
    await backfillCoordinationLocale([event()], 'ko', async (items) => items.map((item) => ({
      id: item.id, summary: '번역됨', detail: '번역됨',
    })));

    const changed = event({ fingerprint: 'fingerprint-2', summary: 'Changed source text.' });
    const projected = projectCoordinationLocale([changed], 'ko')[0];
    expect(projected.summary).toBe('Changed source text.');
    expect(projected).not.toHaveProperty('localizedLocale');
  });

  it('accepts a detail-only translation without inventing a replacement summary', async () => {
    root = mkdtempSync(join(tmpdir(), 'coordination-locale-detail-'));
    process.env.OPENSWARM_COORDINATION_TRANSLATIONS_FILE = join(root, 'translations.json');
    const source = event({ summary: '이미 한국어인 summary', detail: 'Translate this detailed explanation.' });
    const result = await backfillCoordinationLocale([source], 'ko', async (items) => items.map((item) => ({
      id: item.id, detail: '이 상세 설명을 번역했습니다.',
    })));

    expect(result).toMatchObject({ translated: 1, failed: 0 });
    expect(projectCoordinationLocale([source], 'ko')[0]).toMatchObject({
      summary: '이미 한국어인 summary', detail: '이 상세 설명을 번역했습니다.',
    });
  });

  it('falls back to original text and refuses to overwrite a corrupt cache', async () => {
    root = mkdtempSync(join(tmpdir(), 'coordination-locale-corrupt-'));
    const path = join(root, 'translations.json');
    process.env.OPENSWARM_COORDINATION_TRANSLATIONS_FILE = path;
    writeFileSync(path, '{broken', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(projectCoordinationLocale([event()], 'ko')[0].summary).toBe('Use the existing retry helper.');
      await expect(backfillCoordinationLocale([event()], 'ko', async () => []))
        .rejects.toThrow(/JSON/);
      expect(readFileSync(path, 'utf8')).toBe('{broken');
    } finally {
      warn.mockRestore();
    }
  });
});
