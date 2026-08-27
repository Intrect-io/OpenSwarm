import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstructionCapsule } from './instructionCapsule.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'osw-instructions-'));
  const user = join(root, 'user');
  const repo = join(root, 'repo');
  mkdirSync(join(user, 'rules'), { recursive: true });
  mkdirSync(join(repo, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(user, 'CLAUDE.md'), 'GLOBAL');
  writeFileSync(join(user, 'rules', 'all.md'), 'ALL RULE');
  writeFileSync(join(repo, 'CLAUDE.md'), 'PROJECT');
  writeFileSync(join(repo, 'AGENTS.md'), 'AGENTS');
  writeFileSync(join(repo, '.claude', 'rules', 'typescript.md'), '---\npaths:\n  - "src/**/*.ts"\n---\nTS RULE');
  return { root, user, repo };
}

describe('buildInstructionCapsule', () => {
  it('applies global then project instructions and matching conditional rules', () => {
    const f = fixture();
    try {
      const capsule = buildInstructionCapsule(f.repo, ['src/a.ts'], { userClaudeDir: f.user });
      expect(capsule.text.indexOf('GLOBAL')).toBeLessThan(capsule.text.indexOf('PROJECT'));
      expect(capsule.text).toContain('AGENTS');
      expect(capsule.text).toContain('TS RULE');
      expect(capsule.digest).toMatch(/^[a-f0-9]{64}$/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('skips conditional rules that do not match the run scope', () => {
    const f = fixture();
    try {
      expect(buildInstructionCapsule(f.repo, ['README.md'], { userClaudeDir: f.user }).text).not.toContain('TS RULE');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('freezes an immutable snapshot for the run', () => {
    const f = fixture();
    try {
      const first = buildInstructionCapsule(f.repo, [], { userClaudeDir: f.user });
      writeFileSync(join(f.repo, 'CLAUDE.md'), 'CHANGED');
      expect(first.text).toContain('PROJECT');
      expect(first.text).not.toContain('CHANGED');
      expect(buildInstructionCapsule(f.repo, [], { userClaudeDir: f.user }).digest).not.toBe(first.digest);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects symlinked instruction sources without loading their contents', () => {
    const f = fixture();
    try {
      const secret = join(f.root, 'secret.md');
      writeFileSync(secret, 'DO NOT LOAD');
      symlinkSync(secret, join(f.user, 'rules', 'linked.md'));
      const capsule = buildInstructionCapsule(f.repo, [], { userClaudeDir: f.user });
      expect(capsule.text).not.toContain('DO NOT LOAD');
      expect(capsule.errors.join(' ')).toContain('symbolic links');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('fails closed when the combined rules exceed the configured bound', () => {
    const f = fixture();
    try {
      expect(() => buildInstructionCapsule(f.repo, [], { userClaudeDir: f.user, maxChars: 10 })).toThrow('could not be built');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
