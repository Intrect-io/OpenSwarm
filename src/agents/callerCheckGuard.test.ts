import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_REFERENCE_HITS, importsSymbol, removedPublicSymbols, runCallerCheckGuard } from './callerCheckGuard.js';

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

describe('a removed name that is still defined elsewhere', () => {
  it('does not flag callers of a same-named definition in an untouched file', async () => {
    write('tools/a.py', 'def main():\n    pass\n');
    write('tools/b.py', 'def main():\n    pass\n\nmain()\n');
    write('src/config.ts', 'export const config = 1;\n');
    write('src/other.ts', 'export const config = 2;\nconsole.log(config);\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    write('tools/a.py', '# retired\n');
    write('src/config.ts', '// retired\n');
    const res = await runCallerCheckGuard(repo);
    expect(res.issues).toEqual([]);
  });
});

function commitBase(): void {
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
}

describe('only files that import the removed symbol are callers', () => {
  beforeEach(() => {
    write('src/a.tsx', 'export interface Props { id: string }\nexport function helper() {}\n');
    write('src/own.tsx', 'interface Props { name: string }\nexport const View = (p: Props) => p.name;\n');
    write('src/notes.ts', '// Props used to live in a.tsx\nexport const label = "Props";\n');
    write('src/user.tsx', "import { Props } from './a';\nexport const f = (p: Props) => p.id;\n");
    write('src/ns.ts', "import * as A from './a';\nA.helper();\n");
    write('src/req.cjs', "const { helper } = require('./a');\nhelper();\n");
    write('src/bare.ts', 'export function run() { helper(); }\n');
    commitBase();
    write('src/a.tsx', '// emptied\n');
  });

  it('reports importers and ignores own definitions, comments and strings', async () => {
    const res = await runCallerCheckGuard(repo);
    const text = res.issues.join('\n');
    expect(text).toContain('[src/user.tsx:1] still references removed public symbol "Props"');
    expect(text).toContain('[src/user.tsx:2] still references removed public symbol "Props"');
    expect(text).toContain('[src/ns.ts:2] still references removed public symbol "helper"');
    expect(text).toContain('[src/req.cjs:1] still references removed public symbol "helper"');
    expect(text).not.toMatch(/own\.tsx|notes\.ts|bare\.ts/);
    expect(res.issues).toHaveLength(5);
  });
});

describe('importsSymbol', () => {
  it('recognises TS/JS import forms', () => {
    expect(importsSymbol('x.ts', "import {\n  a,\n  Props as P,\n} from '../a';", 'Props', 'a.ts')).toBe(true);
    expect(importsSymbol('x.ts', "import type { Props } from './a';", 'Props', 'a.ts')).toBe(true);
    expect(importsSymbol('x.ts', "export { Props } from './a';", 'Props', 'a.ts')).toBe(true);
    expect(importsSymbol('x.js', "const lib = require('./a');\nlib.helper();", 'helper', 'a.js')).toBe(true);
    expect(importsSymbol('x.ts', "// import { Props } from './a';\nconst Props = 1;", 'Props', 'a.ts')).toBe(false);
    expect(importsSymbol('x.ts', "import './side';\nconst s = 'Props';\nimport b from 'b';", 'Props', 'a.ts')).toBe(false);
    // Semicolon-free code: the clause must not span from an unrelated statement to a later `from`.
    expect(importsSymbol('x.ts', "interface Props { name: string }\nexport const View = (p: Props) => p.name\nexport { other } from './other'", 'Props', 'a.ts')).toBe(false);
    expect(importsSymbol('x.ts', "export class A extends Props {}\nexport { x } from './y'", 'Props', 'a.ts')).toBe(false);
    // A module alias counts only when it names the defining module (review: `requests.get` vs a removed `get`).
    expect(importsSymbol('x.py', 'import requests\nrequests.get(url)\n', 'get', 'pkg/api.py')).toBe(false);
    expect(importsSymbol('x.py', 'import pkg.api as a\na.get(url)\n', 'get', 'pkg/api.py')).toBe(true);
    expect(importsSymbol('x.py', 'from pkg import api\napi.get(url)\n', 'get', 'pkg/api.py')).toBe(true);
    expect(importsSymbol('x.py', 'from pkg import util\nutil.get(url)\n', 'get', 'pkg/api.py')).toBe(false);
    expect(importsSymbol('x.ts', "import D, { Props } from './a'", 'Props', 'a.ts')).toBe(true);
  });

  it('recognises Python import forms', () => {
    expect(importsSymbol('x.py', 'from cgf.a2_inputs import (\n    FixedExpense,\n    read_bank_accounts,\n)', 'read_bank_accounts', 'cgf/a2_inputs.py')).toBe(true);
    expect(importsSymbol('x.py', 'import cgf.a2_inputs as ai\nai.read_bank_accounts()', 'read_bank_accounts', 'cgf/a2_inputs.py')).toBe(true);
    expect(importsSymbol('x.py', 'import cgf.a2_inputs\ncgf.a2_inputs.read_bank_accounts()', 'read_bank_accounts', 'cgf/a2_inputs.py')).toBe(true);
    expect(importsSymbol('x.py', 'from cgf import a2_inputs\na2_inputs.read_bank_accounts()', 'read_bank_accounts', 'cgf/a2_inputs.py')).toBe(true);
    expect(importsSymbol('x.py', 'from cgf.a2_inputs import *\nread_bank_accounts()', 'read_bank_accounts', 'cgf/a2_inputs.py')).toBe(true);
    expect(importsSymbol('x.py', '# from cgf.a2_inputs import read_bank_accounts\nx = "read_bank_accounts"', 'read_bank_accounts', 'cgf/a2_inputs.py')).toBe(false);
  });
});

describe('user git config cannot blind the diff parser', () => {
  it('still catches the caller with diff.noprefix and color.ui=always', async () => {
    write('lib.ts', 'export function load() {}\n');
    write('use.ts', "import { load } from './lib';\nload();\n");
    commitBase();
    git('config', 'diff.noprefix', 'true');
    git('config', 'diff.mnemonicPrefix', 'true');
    git('config', 'color.ui', 'always');
    git('config', 'diff.relative', 'true');
    git('config', 'grep.column', 'true');
    write('lib.ts', 'export function fetchAll() {}\n');
    const res = await runCallerCheckGuard(repo);
    expect(res.issues).toEqual([
      expect.stringContaining('[use.ts:1] still references removed public symbol "load"'),
      expect.stringContaining('[use.ts:2] still references removed public symbol "load"'),
    ]);
  });
});

describe('JavaScript and stub files', () => {
  it('scans .js/.mjs/.jsx/.pyi definitions and callers', async () => {
    write('lib.js', 'export function legacy() {}\n');
    write('app.mjs', "import { legacy } from './lib.js';\nlegacy();\n");
    write('view.jsx', "import { legacy } from './lib.js';\n");
    write('pkg/api.pyi', 'def fetch(x: int) -> int: ...\n');
    write('pkg/use.pyi', 'from pkg.api import fetch\n');
    commitBase();
    write('lib.js', '// gone\n');
    write('pkg/api.pyi', '# gone\n');
    const text = (await runCallerCheckGuard(repo)).issues.join('\n');
    expect(text).toContain('[app.mjs:1] still references removed public symbol "legacy"');
    expect(text).toContain('[app.mjs:2] still references removed public symbol "legacy"');
    expect(text).toContain('[view.jsx:1] still references removed public symbol "legacy"');
    expect(text).toContain('[pkg/use.pyi:1] still references removed public symbol "fetch"');
  });
});

describe('files the worker touched', () => {
  it('flags a changed file that still imports the removed symbol, not the defining file', async () => {
    write('mod.py', 'def old_name():\n    pass\n');
    write('caller.py', 'from mod import old_name\nold_name()\n');
    commitBase();
    write('mod.py', 'def new_name():\n    pass\n\n# old_name was renamed\n');
    write('caller.py', 'from mod import old_name\nold_name()\nprint("touched")\n');
    const res = await runCallerCheckGuard(repo);
    expect(res.issues).toEqual([
      expect.stringContaining('[caller.py:1] still references removed public symbol "old_name"'),
      expect.stringContaining('[caller.py:2] still references removed public symbol "old_name"'),
    ]);
  });
});

describe('a project that is a subdirectory of its repository', () => {
  it('reports paths relative to the project and still finds the caller', async () => {
    write('outside/x.ts', "import { shared } from '../pkg/src/lib';\nshared();\n");
    write('pkg/src/lib.ts', 'export const shared = 1;\n');
    write('pkg/src/use.ts', "import { shared } from './lib';\nconsole.log(shared);\n");
    commitBase();
    write('pkg/src/lib.ts', 'export const renamed = 1;\n');
    const res = await runCallerCheckGuard(join(repo, 'pkg'));
    expect(res.issues).toEqual([
      expect.stringContaining('[src/use.ts:1] still references removed public symbol "shared" (removed from src/lib.ts)'),
      expect.stringContaining('[src/use.ts:2] still references removed public symbol "shared" (removed from src/lib.ts)'),
    ]);
  });
});

describe('reference cap', () => {
  it('reports one fail-closed note when the removed symbols have too many hits', async () => {
    write('lib.ts', 'export function hot() {}\n');
    write('many.ts', "import { hot } from './lib';\n" + 'hot();\n'.repeat(MAX_REFERENCE_HITS));
    commitBase();
    write('lib.ts', '// gone\n');
    const res = await runCallerCheckGuard(repo);
    expect(res.passed).toBe(false);
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0]).toMatch(/exceed the 2000-hit cap/);
  });

  it('does not count hits of a symbol that is still defined elsewhere against the cap', async () => {
    write('lib.ts', 'export function hot() {}\nexport function rare() {}\n');
    write('twin.ts', 'export function hot() {}\n' + 'hot();\n'.repeat(MAX_REFERENCE_HITS));
    write('use.ts', "import { rare } from './lib';\n");
    commitBase();
    write('lib.ts', '// gone\n');
    const res = await runCallerCheckGuard(repo);
    expect(res.issues).toEqual([expect.stringContaining('[use.ts:1] still references removed public symbol "rare"')]);
  });
});

describe('real git errors', () => {
  it('fails closed outside a repository', async () => {
    const res = await runCallerCheckGuard(tmpdir());
    expect(res.passed).toBe(false);
    expect(res.issues[0]).toMatch(/^Unable to verify surviving callers/);
  });
});

describe('removedPublicSymbols', () => {
  it('records the name of an exported const enum', () => {
    const diff = ['--- a/c.ts', '+++ b/c.ts', '@@ -1 +0,0 @@', '-export const enum Color { Red }', '-export declare const enum Shade { Dark }'].join('\n');
    expect(Object.fromEntries(removedPublicSymbols(diff))).toEqual({ Color: 'c.ts', Shade: 'c.ts' });
  });

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
