import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removedPublicSymbols, runCallerCheckGuard } from './callerCheckGuard.js';

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function write(path: string, text: string): void {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), text);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'osw-caller-check-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe('cgf-portal #215 fixture', () => {
  // a2_inputs.py: AccountingRule deleted, read_bank_accounts renamed, FixedExpense kept.
  // Four consumers; the worker updated three and left reports/monthly.py untouched.
  beforeEach(() => {
    write('cgf/a2_inputs.py', [
      'class AccountingRule:', '    pass', '',
      'class FixedExpense:', '    amount: int', '',
      'def read_bank_accounts(path):', '    return []', '',
    ].join('\n'));
    write('cgf/cli.py', 'from cgf.a2_inputs import read_bank_accounts\nread_bank_accounts("x")\n');
    write('cgf/ledger.py', 'from cgf.a2_inputs import AccountingRule\n');
    write('cgf/budget.py', 'from cgf.a2_inputs import FixedExpense\n');
    write('reports/monthly.py', 'from cgf.a2_inputs import read_bank_accounts\n\nrows = read_bank_accounts("bank.csv")\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    write('cgf/a2_inputs.py', [
      'class FixedExpense:', '    amount: int', '    vat: int', '',
      'def load_bank_accounts(path):', '    return []', '',
    ].join('\n'));
    write('cgf/cli.py', 'from cgf.a2_inputs import load_bank_accounts\nload_bank_accounts("x")\n');
    write('cgf/ledger.py', '# AccountingRule retired\n');
  });

  it('names the untouched consumer of the renamed function', async () => {
    const res = await runCallerCheckGuard(repo);
    expect(res.passed).toBe(false);
    expect(res.blocking).toBe(true);
    expect(res.issues).toEqual([
      expect.stringContaining('[reports/monthly.py:1] still references removed public symbol "read_bank_accounts"'),
      expect.stringContaining('[reports/monthly.py:3] still references removed public symbol "read_bank_accounts"'),
    ]);
    // Changed files are the worker's own edits; FixedExpense was kept, so budget.py is fine.
    expect(res.issues.join('\n')).not.toMatch(/budget\.py|ledger\.py|cli\.py|FixedExpense/);
  });

  it('passes once the last consumer is updated', async () => {
    write('reports/monthly.py', 'from cgf.a2_inputs import load_bank_accounts\n\nrows = load_bank_accounts("bank.csv")\n');
    const res = await runCallerCheckGuard(repo);
    expect(res).toEqual({ passed: true, guard: 'callerCheck', issues: [], blocking: true });
  });
});

describe('removedPublicSymbols', () => {
  it('does not treat a signature change as a removal', () => {
    const diff = [
      '--- a/api.py', '+++ b/api.py', '@@ -1 +1 @@',
      '-def read_bank_accounts(path):', '+def read_bank_accounts(path, *, strict=False):',
      '--- a/lib.ts', '+++ b/lib.ts', '@@ -1 +1 @@',
      '-export function load(a: string) {}', '+export async function load(a: string, b = 1) {}',
    ].join('\n');
    expect([...removedPublicSymbols(diff).keys()]).toEqual([]);
  });

  it('treats a move to another file as not removed', () => {
    const diff = [
      '--- a/old.ts', '+++ b/old.ts', '@@ -1 +0,0 @@', '-export const LIMIT = 3;',
      '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1 @@', '+export const LIMIT = 3;',
    ].join('\n');
    expect(removedPublicSymbols(diff).size).toBe(0);
  });

  it('attributes symbols from a deleted file to that file', () => {
    const diff = ['--- a/gone.py', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-class AccountingRule:', '-    pass'].join('\n');
    expect(Object.fromEntries(removedPublicSymbols(diff))).toEqual({ AccountingRule: 'gone.py' });
  });

  it('ignores methods and nested definitions', () => {
    const diff = ['--- a/m.py', '+++ b/m.py', '@@ -1,2 +1 @@', '-    def run(self):', '-        pass'].join('\n');
    expect(removedPublicSymbols(diff).size).toBe(0);
  });
});
