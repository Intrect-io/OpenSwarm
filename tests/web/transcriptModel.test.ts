// Transcript classification, tool grouping, and bounded history (INT-3402).

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { TranscriptModel, classifyLine, summarizeToolGroup } from '../../web/static/js/transcriptModel.mjs';

type Entry = { kind: string; type?: string; text?: string; stage?: string; lines?: string[] };

describe('classifyLine', () => {
  it('recognizes thinking and tool prefixes, defaulting to plain', () => {
    expect(classifyLine('💭 reading the file')).toBe('thinking');
    expect(classifyLine('  🔧 read_file: a.ts')).toBe('tool'); // leading space tolerated
    expect(classifyLine('git add -A')).toBe('plain');
    expect(classifyLine(undefined)).toBe('plain');
  });
});

describe('summarizeToolGroup', () => {
  it('names a single call, counts a same-verb run, and falls back when mixed', () => {
    expect(summarizeToolGroup(['🔧 read_file: a.ts'])).toBe('read_file: a.ts');
    expect(summarizeToolGroup(['🔧 read_file: a.ts', '🔧 read_file: b.ts'])).toBe('read_file ×2');
    expect(summarizeToolGroup(['🔧 read_file: a.ts', '🔧 bash: ls', '🔧 edit_file: c.ts'])).toBe('3 tool calls');
  });
});

describe('TranscriptModel', () => {
  it('collapses consecutive tool lines into one group and breaks on a non-tool line', () => {
    const model = new TranscriptModel();
    model.append('t1', { stage: 'worker', line: '💭 planning' });
    model.append('t1', { stage: 'worker', line: '🔧 read_file: a.ts' });
    model.append('t1', { stage: 'worker', line: '🔧 read_file: b.ts' });
    model.append('t1', { stage: 'worker', line: '💭 now editing' });
    model.append('t1', { stage: 'worker', line: '🔧 edit_file: a.ts' });

    const kinds = model.entries('t1').map((e: Entry) => e.kind);
    expect(kinds).toEqual(['stage', 'line', 'tools', 'line', 'tools']);
    expect(model.entries('t1')[2].lines).toHaveLength(2);
    expect(model.entries('t1')[4].lines).toHaveLength(1);
  });

  it('inserts a stage marker on change and never merges groups across stages', () => {
    const model = new TranscriptModel();
    model.append('t1', { stage: 'worker', line: '🔧 read_file: a.ts' });
    model.append('t1', { stage: 'reviewer', line: '🔧 bash: git diff' });

    const entries = model.entries('t1');
    expect(entries.map((e: Entry) => e.kind)).toEqual(['stage', 'tools', 'stage', 'tools']);
    expect(entries[0].stage).toBe('worker');
    expect(entries[2].stage).toBe('reviewer');
  });

  it('bounds history by whole entries, never half a tool group', () => {
    const model = new TranscriptModel({ maxEntries: 3 });
    for (let i = 0; i < 10; i++) {
      model.append('t1', { stage: 'worker', line: `💭 thought ${i}` });
    }
    const entries = model.entries('t1');
    expect(entries).toHaveLength(3);
    expect(entries.at(-1).text).toBe('💭 thought 9');
  });

  it('stops appending to an evicted tool group', () => {
    const model = new TranscriptModel({ maxEntries: 2 });
    model.append('t1', { stage: 'worker', line: '🔧 read_file: a.ts' }); // stage + tools
    model.append('t1', { stage: 'worker', line: '💭 pushes the group out' });
    model.append('t1', { stage: 'worker', line: '🔧 edit_file: a.ts' });

    const entries = model.entries('t1');
    // The new tool line starts a FRESH group rather than mutating the evicted one.
    expect(entries.at(-1).kind).toBe('tools');
    expect(entries.at(-1).lines).toEqual(['🔧 edit_file: a.ts']);
  });

  it('keeps tasks isolated', () => {
    const model = new TranscriptModel();
    model.append('t1', { stage: 'worker', line: 'a' });
    model.append('t2', { stage: 'worker', line: 'b' });
    expect(model.entries('t1').filter((e: Entry) => e.kind === 'line')).toHaveLength(1);
    expect(model.entries('t2').filter((e: Entry) => e.kind === 'line')).toHaveLength(1);
    expect(model.entries('missing')).toEqual([]);
  });

  it('replace() swaps history wholesale and emits once, not per line', () => {
    const model = new TranscriptModel();
    model.append('t1', { stage: 'worker', line: 'live line' });

    let appends = 0;
    let replaces = 0;
    model.addEventListener('append', () => appends++);
    model.addEventListener('replace', () => replaces++);

    model.replace('t1', [
      { stage: 'worker', line: 'from REST 1' },
      { stage: 'worker', line: 'from REST 2' },
    ]);

    const texts = model.entries('t1').filter((e: Entry) => e.kind === 'line').map((e: Entry) => e.text);
    expect(texts).toEqual(['from REST 1', 'from REST 2']); // the live line is gone
    expect(appends).toBe(0);
    expect(replaces).toBe(1);
  });

  it('ignores a line it has already seen, by daemon sequence', () => {
    const model = new TranscriptModel();
    model.append('t1', { stage: 'worker', line: 'one', seq: 1 });
    model.append('t1', { stage: 'worker', line: 'two', seq: 2 });
    // The SSE replay hands back lines the live stream already delivered.
    model.append('t1', { stage: 'worker', line: 'one', seq: 1 });
    model.append('t1', { stage: 'worker', line: 'two', seq: 2 });
    model.append('t1', { stage: 'worker', line: 'three', seq: 3 });

    const texts = model.entries('t1').filter((e: Entry) => e.kind === 'line').map((e: Entry) => e.text);
    expect(texts).toEqual(['one', 'two', 'three']);
  });

  it('still accepts lines from a daemon that stamps no sequence', () => {
    const model = new TranscriptModel();
    model.append('t1', { stage: 'worker', line: 'a' });
    model.append('t1', { stage: 'worker', line: 'b' });
    expect(model.entries('t1').filter((e: Entry) => e.kind === 'line')).toHaveLength(2);
  });

  it('carries the sequence high-water mark through replace()', () => {
    const model = new TranscriptModel();
    model.append('t1', { stage: 'worker', line: 'live', seq: 7 });
    model.replace('t1', [
      { stage: 'worker', line: 'history', seq: 5 },
      { stage: 'worker', line: 'live', seq: 7 },
    ]);
    // A replayed line at or below the snapshot's last sequence is a duplicate.
    model.append('t1', { stage: 'worker', line: 'live', seq: 7 });
    model.append('t1', { stage: 'worker', line: 'newer', seq: 8 });

    const texts = model.entries('t1').filter((e: Entry) => e.kind === 'line').map((e: Entry) => e.text);
    expect(texts).toEqual(['history', 'live', 'newer']);
  });

  it('ignores empty lines', () => {
    const model = new TranscriptModel();
    model.append('t1', { stage: 'worker', line: '' });
    model.append('t1', { stage: 'worker', line: undefined as unknown as string });
    expect(model.has('t1')).toBe(false);
  });
});
