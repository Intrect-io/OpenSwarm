// ============================================
// OpenSwarm — session transcripts are private and redacted (AGT-4608)
// ============================================
//
// Transcripts were written 0644 inside 0755 directories, and a worker that
// grepped a repo with a `.env` recorded the live credential verbatim. These
// tests pin the file and directory modes, the startup repair of old
// transcripts, and redaction before a line reaches the file.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionRecorder, tightenSessionLogPermissions } from './sessionLog.js';
import { REDACTED, redactSecrets } from './secretRedaction.js';

const ORIGINAL_DIR = process.env.OPENSWARM_SESSION_LOG_DIR;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-perms-'));
  process.env.OPENSWARM_SESSION_LOG_DIR = join(root, 'sessions');
});

afterEach(() => {
  if (ORIGINAL_DIR === undefined) delete process.env.OPENSWARM_SESSION_LOG_DIR;
  else process.env.OPENSWARM_SESSION_LOG_DIR = ORIGINAL_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('session transcript privacy (AGT-4608)', () => {
  it('writes session files 0600 in a 0700 directory', () => {
    const recorder = createSessionRecorder({ taskId: 'AGT-1', stage: 'worker', adapter: 'test' })!;
    recorder.record({ type: 'tool', name: 'bash', output: 'ok' });
    recorder.close();
    expect(statSync(recorder.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'sessions')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'sessions', 'AGT-1')).mode & 0o777).toBe(0o700);
  });

  it('redacts a secret-shaped value from tool output before it reaches the file', () => {
    const linearKey = `lin_api_${'A1b2C3d4'.repeat(5)}`;
    const githubToken = `ghp_${'x9Y8z7W6'.repeat(5)}`;
    const recorder = createSessionRecorder({ taskId: 'AGT-2', stage: 'worker', adapter: 'test' })!;
    recorder.record({
      type: 'tool',
      name: 'bash',
      output: `.env:LINEAR_API_KEY=${linearKey}\nAuthorization: Bearer abcdefghijklmnop123\nGH=${githubToken}`,
      args: [`OPENAI_API_KEY="sk-proj-${'q'.repeat(30)}"`],
    });
    recorder.close();
    const text = readFileSync(recorder.path, 'utf8');
    expect(text).not.toContain(linearKey);
    expect(text).not.toContain(githubToken);
    expect(text).not.toContain('abcdefghijklmnop123');
    expect(text).not.toContain('q'.repeat(30));
    expect(text).toContain(REDACTED);
    for (const line of text.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('tightens an existing world-readable session directory at startup', () => {
    const dir = join(root, 'sessions');
    const task = join(dir, 'AGT-3');
    mkdirSync(task, { recursive: true });
    const file = join(task, 'old.jsonl');
    writeFileSync(file, '{}\n');
    chmodSync(dir, 0o755);
    chmodSync(task, 0o755);
    chmodSync(file, 0o644);
    expect(tightenSessionLogPermissions(dir)).toBe(3);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(task).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(tightenSessionLogPermissions(dir)).toBe(0);
    expect(readdirSync(task)).toEqual(['old.jsonl']);
  });
});

describe('redactSecrets', () => {
  it('leaves ordinary output alone', () => {
    const text = 'npm test\n✓ 42 passed\nconst token = getToken();\nPASSWORD_MIN_LENGTH';
    expect(redactSecrets(text)).toBe(text);
  });

  it('replaces a private key block', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactSecrets(`key:\n${pem}\ndone`)).toBe(`key:\n${REDACTED}\ndone`);
  });
});
