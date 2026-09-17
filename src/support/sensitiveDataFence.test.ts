import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanAddedText, sensitiveDataOnBranch } from './sensitiveDataFence.js';
import { commitAndCreatePRWithHead, type WorktreeInfo } from './worktreeManager.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
}

describe('scanAddedText (AGT-4188)', () => {
  it('finds the #215 shapes: Luhn-valid card numbers, account-number clusters, plaintext passwords, resident ids', () => {
    const lines = [
      'card,4111 1111 1111 1111,홍길동',          // Luhn-valid test PAN
      'card,4111-1111-1111-1112,x',                // Luhn-invalid: not counted
      '110-123-456789 / 302-0987-6543-21 / 333-44-555555',
      'login,shinhan,pw: hunter2secret',
      'user,900101-1234567',
    ];
    const kinds = scanAddedText('tests/fixtures/card.csv', lines).map((f) => f.kind).sort();
    expect(kinds).toEqual(['account-number', 'card-number', 'plaintext-password', 'resident-id']);
  });

  it('leaves ordinary code and placeholders alone', () => {
    const lines = [
      'password: ${NAS_PASSWORD}',
      'PASSWORD = "<redacted>"',
      'const timeout = 1234567890123456;',   // 16 digits but Luhn-invalid
      'phone: 010-1234-5678',                // one dashed number is not a ledger
      'date range 2026-09-01..2026-09-30',
    ];
    expect(scanAddedText('src/config.py', lines)).toEqual([]);
  });
});

describe('sensitiveDataOnBranch / publication (AGT-4188)', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  function repository(branchName: string): { repo: string; origin: string; info: WorktreeInfo } {
    root = mkdtempSync(join(tmpdir(), 'openswarm-sensitive-'));
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/app.py'), 'print(1)\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'initial');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    git(repo, 'checkout', '-qb', branchName);
    return { repo, origin, info: { worktreePath: repo, originalPath: repo, branchName, issueId: 'AGT-SENS' } };
  }

  it('names an opaque spreadsheet fixture, a masked copy identical to its original, and a credential ledger', async () => {
    const { repo } = repository('swarm/AGT-SENS-a');
    mkdirSync(join(repo, 'tests/fixtures/card'), { recursive: true });
    writeFileSync(join(repo, 'tests/fixtures/card/card_sample.xlsx'), Buffer.from([0x50, 0x4b, 3, 4, 9, 9]));
    writeFileSync(join(repo, 'tests/fixtures/card_sample_masked.xlsx'), Buffer.from([0x50, 0x4b, 3, 4, 9, 9]));
    writeFileSync(join(repo, 'tests/fixtures/logins.csv'), 'issuer,id,비밀번호\nshinhan,cgf01,Qwerty!234\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'fixtures');

    const findings = await sensitiveDataOnBranch(repo, 'origin/main');
    const byFile = Object.fromEntries(findings.map((f) => [`${f.file}:${f.kind}`, f.detail]));
    expect(Object.keys(byFile).sort()).toEqual([
      'tests/fixtures/card/card_sample.xlsx:opaque-spreadsheet',
      'tests/fixtures/card_sample_masked.xlsx:masked-copy-identical',
      'tests/fixtures/card_sample_masked.xlsx:opaque-spreadsheet',
      'tests/fixtures/logins.csv:plaintext-password',
    ]);
    expect(byFile['tests/fixtures/card_sample_masked.xlsx:masked-copy-identical']).toContain('card/card_sample.xlsx');
  });

  it('stops the push before anything leaves the machine', async () => {
    const branchName = 'swarm/AGT-SENS-b';
    const { repo, origin, info } = repository(branchName);
    mkdirSync(join(repo, 'tests/fixtures'), { recursive: true });
    writeFileSync(join(repo, 'tests/fixtures/bank.csv'), '110-123-456789,1000\n302-0987-6543-21,2000\n333-44-555555,3000\n');

    await expect(commitAndCreatePRWithHead(info, 'Add fixtures', 'AGT-SENS', ''))
      .rejects.toThrow(/sensitive-data: .*tests\/fixtures\/bank\.csv \(account-number/);
    expect(execFileSync('git', ['ls-remote', '--heads', origin, branchName], { encoding: 'utf8' }).trim()).toBe('');
  });

  it('lets an ordinary source change through', async () => {
    const { repo } = repository('swarm/AGT-SENS-c');
    writeFileSync(join(repo, 'src/app.py'), 'print(2)\n');
    writeFileSync(join(repo, 'src/new.py'), 'TIMEOUT = 30\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'change');
    expect(await sensitiveDataOnBranch(repo, 'origin/main')).toEqual([]);
  });
});
