import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyBranchRisk,
  classifyChangeRisk,
  publicationRisk,
  changeRiskSection,
  parseNumstat,
  type ChangeRiskLevel,
  type ChangeRiskRules,
  type DiffFileStat,
} from './changeRisk.js';

/** n files of `lines` changed lines each, under `dir/`. */
function files(n: number, lines: number, dir = 'src/feature'): DiffFileStat[] {
  return Array.from({ length: n }, (_, i) => ({ path: `${dir}/file${i}.ts`, added: lines, deleted: 0 }));
}

function stat(path: string, added = 1, deleted = 0): DiffFileStat {
  return { path, added, deleted };
}

/**
 * One row per rule. Each row is the smallest diff that should land in its
 * class, so removing or loosening a rule turns its row red.
 */
const table: Array<{ name: string; diff: DiffFileStat[] | null; rules?: ChangeRiskRules; protectedFiles?: string[]; level: ChangeRiskLevel; reason?: RegExp }> = [
  // size
  { name: 'small source change', diff: [stat('src/a.ts', 10, 2), stat('src/a.test.ts', 20)], level: 'low' },
  { name: 'empty diff', diff: [], level: 'low' },
  { name: 'past the low file limit', diff: files(6, 1), level: 'medium', reason: /^size/ },
  { name: 'past the low line limit', diff: files(1, 151), level: 'medium', reason: /^size/ },
  { name: 'past the medium file limit', diff: files(21, 1), level: 'high', reason: /^size/ },
  { name: 'past the medium line limit', diff: files(2, 301), level: 'high', reason: /^size/ },
  { name: 'large docs-only change stays medium', diff: files(30, 40, 'docs'), level: 'medium', reason: /^size/ },
  // deploy / infra / CI
  { name: 'Dockerfile', diff: [stat('Dockerfile')], level: 'high', reason: /^deploy\/infra/ },
  { name: 'compose file', diff: [stat('deploy/docker-compose.prod.yml')], level: 'high', reason: /^deploy\/infra/ },
  { name: 'terraform', diff: [stat('ops/main.tf')], level: 'high', reason: /^deploy\/infra/ },
  { name: 'infra directory', diff: [stat('infra/nas/schedules.json')], level: 'high', reason: /^deploy\/infra/ },
  { name: 'release script', diff: [stat('scripts/release.sh')], level: 'high', reason: /^deploy\/infra/ },
  { name: 'wrangler config', diff: [stat('workers/api/wrangler.toml')], level: 'high', reason: /^deploy\/infra/ },
  { name: 'README under infra is docs', diff: [stat('infra/nas/README.md')], level: 'low' },
  { name: 'GitHub workflow', diff: [stat('.github/workflows/ci.yml')], level: 'high', reason: /^CI/ },
  { name: 'git hook', diff: [stat('.githooks/pre-commit')], level: 'high', reason: /^CI/ },
  // migrations
  { name: 'migration directory', diff: [stat('db/migrations/0042_add_col.py')], level: 'high', reason: /^migration/ },
  { name: 'SQL file', diff: [stat('warehouse/141_backfill.sql')], level: 'high', reason: /^migration/ },
  // auth / secrets
  { name: 'auth module', diff: [stat('src/auth/session.ts')], level: 'high', reason: /^auth\/secrets/ },
  { name: 'secrets file', diff: [stat('config/secrets.yaml')], level: 'high', reason: /^auth\/secrets/ },
  { name: '.env example', diff: [stat('apps/api/.env.example')], level: 'high', reason: /^auth\/secrets/ },
  { name: 'key rotation script', diff: [stat('scripts/rotate_slack_key.py')], level: 'high', reason: /^auth\/secrets/ },
  { name: 'private key', diff: [stat('certs/server.pem')], level: 'high', reason: /^auth\/secrets/ },
  { name: '"author" is not auth', diff: [stat('src/author.ts')], level: 'low' },
  // dependencies
  { name: 'package manifest', diff: [stat('package.json')], level: 'medium', reason: /^dependencies/ },
  { name: 'lockfile only', diff: [stat('package-lock.json', 400, 300)], level: 'high', reason: /^size/ },
  { name: 'small lockfile change', diff: [stat('uv.lock', 3, 3)], level: 'medium', reason: /^dependencies/ },
  { name: 'Cargo.toml', diff: [stat('crates/x/Cargo.toml')], level: 'medium', reason: /^dependencies/ },
  // protected files
  { name: "the run's protected file", diff: [stat('src/a.test.ts')], protectedFiles: ['src/a.test.ts'], level: 'high', reason: /^protected file/ },
  { name: "the project's protected path glob", diff: [stat('src/billing/charge.ts')], rules: { protectedPaths: ['src/billing/**'] }, level: 'high', reason: /^protected file/ },
  // per-project rules
  { name: 'project high-risk path', diff: [stat('src/orders/place.ts')], rules: { highPaths: ['src/orders/**'] }, level: 'high', reason: /^project high-risk path/ },
  { name: 'project medium-risk path', diff: [stat('src/ui/theme.ts')], rules: { mediumPaths: ['src/ui/*.ts'] }, level: 'medium', reason: /^project medium-risk path/ },
  { name: 'project raises the low limit', diff: files(8, 1), rules: { lowMaxFiles: 10 }, level: 'low' },
  { name: 'project lowers the medium limit', diff: files(3, 1), rules: { lowMaxFiles: 1, mediumMaxFiles: 2 }, level: 'high', reason: /^size/ },
  // unknown
  { name: 'unreadable diff', diff: null, level: 'medium', reason: /^unknown/ },
  { name: 'binary file', diff: [{ path: 'assets/logo.png', added: null, deleted: null }], level: 'medium', reason: /binary/ },
];

describe('classifyChangeRisk (AGT-4804)', () => {
  it.each(table)('$name → $level', ({ diff, rules, protectedFiles, level, reason }) => {
    const risk = classifyChangeRisk(diff, rules, protectedFiles);
    expect(risk.level).toBe(level);
    if (reason) expect(risk.reasons.some((r) => reason.test(r))).toBe(true);
    if (level === 'low') expect(risk.reasons).toEqual([]);
  });

  it('lists high reasons before medium ones', () => {
    const risk = classifyChangeRisk([stat('package.json'), stat('Dockerfile')]);
    expect(risk.level).toBe('high');
    expect(risk.reasons[0]).toMatch(/^deploy\/infra/);
    expect(risk.reasons[1]).toMatch(/^dependencies/);
  });

  it('is deterministic', () => {
    const diff = [stat('src/auth/x.ts'), ...files(7, 30)];
    expect(classifyChangeRisk(diff)).toEqual(classifyChangeRisk(diff));
  });
});

describe('parseNumstat', () => {
  it('reads counts, binary files and renames', () => {
    const parsed = parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg/x.png\n2\t2\tsrc/{old => new}/b.ts\n0\t0\told.ts => new.ts\n');
    expect(parsed).toEqual([
      { path: 'src/a.ts', added: 3, deleted: 1 },
      { path: 'img/x.png', added: null, deleted: null },
      { path: 'src/new/b.ts', previousPath: 'src/old/b.ts', added: 2, deleted: 2 },
      { path: 'new.ts', previousPath: 'old.ts', added: 0, deleted: 0 },
    ]);
  });

  it('returns null for text that is not numstat, which classifies as medium', () => {
    const parsed = parseNumstat('fatal: bad revision\n');
    expect(parsed).toBeNull();
    expect(classifyChangeRisk(parsed).level).toBe('medium');
  });
});

describe('changeRiskSection', () => {
  it('states the level and the reasons', () => {
    const section = changeRiskSection(classifyChangeRisk([stat('Dockerfile')]));
    expect(section).toContain('## Risk: high');
    expect(section).toContain('- deploy/infra: `Dockerfile`');
  });

  it('says why a low change is low', () => {
    expect(changeRiskSection(classifyChangeRisk([stat('src/a.ts')]))).toMatch(/## Risk: low\n1 file\(s\), 1 line\(s\)/);
  });
});

describe('classifyBranchRisk', () => {
  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }

  it('classifies what the branch changed since the base, and medium when git fails', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'openswarm-risk-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 't@example.com');
      git(repo, 'config', 'user.name', 't');
      writeFileSync(join(repo, 'a.ts'), 'a\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'base');
      git(repo, 'checkout', '-qb', 'feature');
      mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'ci');

      const risk = await classifyBranchRisk(repo, 'main', undefined);
      expect(risk.level).toBe('high');
      expect(risk.reasons[0]).toMatch(/^CI/);

      // A non-ASCII path is classified by its real name, not git's quoted form.
      git(repo, 'checkout', '-qb', 'korean');
      mkdirSync(join(repo, 'db'), { recursive: true });
      writeFileSync(join(repo, 'db', '정산_보정.sql'), 'select 1;\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'sql');
      const korean = await classifyBranchRisk(repo, 'feature', undefined);
      expect(korean.level).toBe('high');
      expect(korean.reasons).toContain('migration: `db/정산_보정.sql`');
      git(repo, 'checkout', '-q', 'feature');

      const unknown = await classifyBranchRisk(repo, 'no-such-ref', undefined);
      expect(unknown.level).toBe('medium');
      expect(unknown.reasons[0]).toMatch(/^unknown/);

      // Project rules come from the operator's checkout, not the worktree.
      writeFileSync(join(repo, 'a.ts'), 'b\n');
      git(repo, 'commit', '-qam', 'a');
      const operator = mkdtempSync(join(tmpdir(), 'openswarm-risk-operator-'));
      try {
        writeFileSync(join(operator, 'openswarm.json'), JSON.stringify({ schemaVersion: 1, publication: { risk: { protectedPaths: ['a.ts'] } } }));
        const ruled = await publicationRisk(operator, repo, 'main');
        expect(ruled.reasons).toContain('protected file: `a.ts`');
        // The worktree's own openswarm.json is not consulted.
        writeFileSync(join(repo, 'openswarm.json'), JSON.stringify({ schemaVersion: 1, publication: { risk: { protectedPaths: ['a.ts'] } } }));
        const unruled = await publicationRisk(join(operator, 'missing'), repo, 'main');
        expect(unruled.reasons).not.toContain('protected file: `a.ts`');
      } finally {
        rmSync(operator, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('change risk paths the first rules missed (#884 review)', () => {
  it.each([
    'src/authentication/login.ts', 'src/middleware/authMiddleware.ts', 'src/lib/authorization.ts', 'src/authz/policy.ts',
    'src/session.ts', 'src/jwt.ts', 'src/security/csp.ts', 'middleware.ts', 'src/userSession.ts',
    'db/migrate/20261120_add.rb', 'prisma/schema.prisma', 'db/schema.rb', 'alembic.ini',
    '.github/CODEOWNERS', 'docs/deploy.sh',
  ])('%s is high', (path) => {
    expect(classifyChangeRisk([stat(path)]).level).toBe('high');
  });

  it.each(['.npmrc', 'deno.json', '.terraform.lock.hcl'])('%s is a dependency change (medium)', (path) => {
    expect(classifyChangeRisk([stat(path)]).level).toBe('medium');
  });

  it('judges a rename on its old path too', () => {
    expect(classifyChangeRisk(parseNumstat('3\t1\tsrc/{auth => util}/x.ts')!).level).toBe('high');
  });

  it('still leaves deploy prose under docs/ low', () => {
    expect(classifyChangeRisk([stat('docs/deploy.md')]).level).toBe('low');
  });
});
