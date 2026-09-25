import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_LOG_BYTE_CAP,
  SESSION_LOG_FIELD_CHARS,
  SESSION_LOG_NOTICE_FIELD_CHARS,
  SESSION_LOG_TRUNCATION_MARKER,
  createSessionRecorder,
  pruneSessionLogs,
  sessionLogDir,
  sessionLogEnabled,
} from './sessionLog.js';

let root: string;
const savedDir = process.env.OPENSWARM_SESSION_LOG_DIR;
const savedFlag = process.env.OPENSWARM_SESSION_LOG;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'osw-session-log-'));
  process.env.OPENSWARM_SESSION_LOG_DIR = root;
  delete process.env.OPENSWARM_SESSION_LOG;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.OPENSWARM_SESSION_LOG_DIR;
  else process.env.OPENSWARM_SESSION_LOG_DIR = savedDir;
  if (savedFlag === undefined) delete process.env.OPENSWARM_SESSION_LOG;
  else process.env.OPENSWARM_SESSION_LOG = savedFlag;
});

function events(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('createSessionRecorder (AGT-4442)', () => {
  it('records the prompt, a tool call with its output, and the final text in order', () => {
    const rec = createSessionRecorder({ taskId: 'AX-1556', stage: 'worker', adapter: 'openrouter', model: 'm' })!;
    rec.record({ type: 'notice', note: 'prompt', prompt: 'implement the adapter' });
    rec.record({ type: 'assistant', turn: 0, content: 'reading the schema', toolCalls: ['read_file {"path":"a.py"}'] });
    rec.record({ type: 'tool', turn: 0, name: 'read_file', output: 'class A:', isError: false });
    rec.close({ outcome: 'returned', text: 'done' });

    const log = events(rec.path);
    expect(log.map((e) => e.type)).toEqual(['start', 'notice', 'assistant', 'tool', 'end']);
    expect(log.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(log[0]).toMatchObject({ taskId: 'AX-1556', stage: 'worker', adapter: 'openrouter', model: 'm' });
    expect(log[1].prompt).toBe('implement the adapter');
    expect(log[3]).toMatchObject({ name: 'read_file', output: 'class A:', isError: false });
    expect(log[4]).toMatchObject({ outcome: 'returned', text: 'done', truncatedEvents: 0, droppedEvents: 0 });
  });

  it('gives each invocation its own file, so iterations are not conflated', () => {
    const a = createSessionRecorder({ taskId: 'AX-1556', stage: 'worker' })!;
    const b = createSessionRecorder({ taskId: 'AX-1556', stage: 'worker' })!;
    a.close(); b.close();

    expect(a.path).not.toBe(b.path);
    expect(readdirSync(join(root, 'AX-1556'))).toHaveLength(2);
  });

  it('keeps a sanitised path for an identifier that would otherwise escape it', () => {
    const rec = createSessionRecorder({ taskId: '../../etc/passwd', stage: 'worker' })!;
    rec.close();
    expect(rec.path.startsWith(`${root}/`)).toBe(true);
    expect(rec.path).not.toContain('..');
  });

  it('clips a huge field but marks the event, so a short file is never mistaken for a short session', () => {
    const rec = createSessionRecorder({ taskId: 't', stage: 'worker' })!;
    rec.record({ type: 'tool', name: 'bash', output: 'x'.repeat(SESSION_LOG_FIELD_CHARS * 3) });
    rec.close();

    const log = events(rec.path);
    expect((log[1].output as string).length).toBeLessThanOrEqual(SESSION_LOG_FIELD_CHARS);
    expect(log[1].truncated).toBe(true);
    expect(log[2]).toMatchObject({ truncatedEvents: 1 });
  });

  it('keeps both ends of a clipped field, because the tail is where the evidence is', () => {
    // The shape that started this: a reviewer prompt renders the diff under
    // review last, so head-only truncation kept the boilerplate and dropped the
    // change being judged. (AGT-4446)
    const head = 'REVIEWER INSTRUCTIONS';
    const tail = 'Diff under review\n+    if "sensitive" in a:';
    const rec = createSessionRecorder({ taskId: 't', stage: 'reviewer' })!;
    rec.record({
      type: 'notice',
      note: 'prompt',
      prompt: head + 'z'.repeat(SESSION_LOG_NOTICE_FIELD_CHARS * 2) + tail,
    });
    rec.close();

    const clipped = events(rec.path)[1].prompt as string;
    // Truncation has to have happened, or this asserts nothing.
    expect(events(rec.path)[1].truncated).toBe(true);
    expect(clipped.startsWith(head)).toBe(true);
    expect(clipped.endsWith(tail)).toBe(true);
    expect(clipped.length).toBeLessThanOrEqual(SESSION_LOG_NOTICE_FIELD_CHARS);
  });

  it('gives the prompt notice more room than a tool output, and enough for a diff-bearing prompt', () => {
    // A reviewer prompt measured at ~15k with a 6k diff and ~25k once the diff
    // reaches its own 16k ceiling; the shared cap could not hold it. (AGT-4446)
    expect(SESSION_LOG_NOTICE_FIELD_CHARS).toBeGreaterThan(25_100);

    const rec = createSessionRecorder({ taskId: 't', stage: 'reviewer' })!;
    const body = 'q'.repeat(30_000);
    rec.record({ type: 'notice', note: 'prompt', prompt: body });
    rec.record({ type: 'tool', name: 'bash', output: body });
    rec.close();

    const log = events(rec.path);
    // Same payload, two caps: the once-per-invocation notice survives whole.
    expect(log[1].prompt).toBe(body);
    expect(log[1].truncated).toBeUndefined();
    expect(log[2].truncated).toBe(true);
    expect((log[2].output as string).length).toBeLessThanOrEqual(SESSION_LOG_FIELD_CHARS);
  });

  it('names how much it dropped, so a reader is not left inferring it from a boolean', () => {
    const original = 'a'.repeat(SESSION_LOG_FIELD_CHARS * 2);
    const rec = createSessionRecorder({ taskId: 't', stage: 'worker' })!;
    rec.record({ type: 'tool', name: 'bash', output: original });
    rec.close();

    const clipped = events(rec.path)[1].output as string;
    const marker = clipped.match(/\[session-log: (\d+) chars omitted\]/);
    expect(marker).not.toBeNull();
    expect(clipped).toContain(SESSION_LOG_TRUNCATION_MARKER);
    // The count is the real remainder: what survived plus what it claims to
    // have dropped is the field that went in.
    const kept = clipped.length - marker![0].length - 2; // the marker's own newlines
    expect(kept + Number(marker![1])).toBe(original.length);
  });

  it('stops growing past the session cap but keeps counting what it dropped', () => {
    const rec = createSessionRecorder({ taskId: 't', stage: 'worker' })!;
    const chunk = 'y'.repeat(SESSION_LOG_FIELD_CHARS);
    // Each event is ~20 KB after clipping; the cap is 8 MB.
    for (let i = 0; i < Math.ceil(SESSION_LOG_BYTE_CAP / SESSION_LOG_FIELD_CHARS) + 20; i += 1) {
      rec.record({ type: 'tool', name: 'bash', output: chunk });
    }
    rec.close();

    const log = events(rec.path);
    const end = log[log.length - 1];
    expect(end.type).toBe('end');
    expect(end.droppedEvents as number).toBeGreaterThan(0);
    expect(end.bytes as number).toBeGreaterThanOrEqual(SESSION_LOG_BYTE_CAP);
  });

  it('writes nothing when the off switch is set', () => {
    process.env.OPENSWARM_SESSION_LOG = '0';
    expect(sessionLogEnabled()).toBe(false);
    expect(createSessionRecorder({ taskId: 't', stage: 'worker' })).toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
  });

  it('returns undefined rather than throwing when the directory cannot be created', () => {
    const locked = join(root, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o400);
    process.env.OPENSWARM_SESSION_LOG_DIR = join(locked, 'sessions');
    try {
      expect(createSessionRecorder({ taskId: 't', stage: 'worker' })).toBeUndefined();
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('ignores a record after close, so a late callback cannot append past the end', () => {
    const rec = createSessionRecorder({ taskId: 't', stage: 'worker' })!;
    rec.close({ outcome: 'returned' });
    rec.record({ type: 'tool', name: 'late' });
    rec.close({ outcome: 'again' });

    const log = events(rec.path);
    expect(log.filter((e) => e.type === 'end')).toHaveLength(1);
    expect(log.some((e) => e.name === 'late')).toBe(false);
  });

  it('defaults the directory under the state dir when nothing overrides it', () => {
    delete process.env.OPENSWARM_SESSION_LOG_DIR;
    expect(sessionLogDir().endsWith('/.openswarm/sessions')).toBe(true);
  });
});

describe('pruneSessionLogs (AGT-4442)', () => {
  it('drops files past the retention window and keeps the recent ones', () => {
    const dir = join(root, 'AX-1');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'old.jsonl');
    const fresh = join(dir, 'fresh.jsonl');
    writeFileSync(old, '{}\n');
    writeFileSync(fresh, '{}\n');
    const longAgo = Date.now() / 1000 - 30 * 24 * 60 * 60;
    utimesSync(old, longAgo, longAgo);

    expect(pruneSessionLogs(14, root)).toBe(1);
    expect(readdirSync(dir)).toEqual(['fresh.jsonl']);
  });

  it('never prunes inside the safety window, so a live session is not truncated', () => {
    const dir = join(root, 'AX-2');
    mkdirSync(dir, { recursive: true });
    const active = join(dir, 'active.jsonl');
    writeFileSync(active, '{}\n');
    // Retention of 0 days would otherwise make everything eligible.
    expect(pruneSessionLogs(0, root)).toBe(0);
    expect(readdirSync(dir)).toEqual(['active.jsonl']);
  });

  it('removes a task directory once it is empty, and tolerates no directory at all', () => {
    const dir = join(root, 'AX-3');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'old.jsonl');
    writeFileSync(old, '{}\n');
    const longAgo = Date.now() / 1000 - 30 * 24 * 60 * 60;
    utimesSync(old, longAgo, longAgo);

    pruneSessionLogs(14, root);
    expect(readdirSync(root)).not.toContain('AX-3');
    expect(pruneSessionLogs(14, join(root, 'missing'))).toBe(0);
  });
});
