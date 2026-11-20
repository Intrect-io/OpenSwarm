import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHARED_PATH_SCAN_DEPTH,
  detectSharedPaths,
  emptyDetectionWarning,
  resolveSharedPaths,
  secretSharedPathComponents,
  secretSharedPathsWarning,
  unsharedGitignoredPaths,
  gitignoredPathsWarning,
  warnGitignoredPathsOnce,
} from './sharedPathDetection.js';

describe('detectSharedPaths (AGT-4043)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openswarm-shared-detect-'));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const dir = (...rel: string[]) => mkdirSync(join(repo, ...rel), { recursive: true });
  const file = (rel: string, content = '') => {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
  };

  it('finds workspace dependency dirs in a monorepo whose root has none', () => {
    // The cgf-portal shape: no root manifest, no root deps.
    file('apps/portal/package.json', '{}');
    dir('apps', 'portal', 'node_modules');
    file('apps/pipelines/pyproject.toml');
    dir('apps', 'pipelines', '.venv');

    const detection = detectSharedPaths(repo);
    expect(detection.shared.sort()).toEqual(['apps/pipelines/.venv', 'apps/portal/node_modules']);
    expect(detection.unlinked).toEqual([]);
    expect(resolveSharedPaths(repo, null).sort()).toEqual(['apps/pipelines/.venv', 'apps/portal/node_modules']);
  });

  it('keeps the single-repo behaviour: root dependency dirs qualify without a manifest', () => {
    dir('node_modules');
    dir('.venv');
    expect(detectSharedPaths(repo).shared.sort()).toEqual(['.venv', 'node_modules']);
    expect(resolveSharedPaths(repo, null).sort()).toEqual(['.venv', 'node_modules']);
  });

  it('lists root dependency dirs before workspace ones', () => {
    dir('node_modules');
    file('apps/api/package.json', '{}');
    dir('apps', 'api', 'node_modules');
    expect(detectSharedPaths(repo).shared).toEqual(['node_modules', 'apps/api/node_modules']);
  });

  it('does not qualify a dependency-named dir that sits in a directory without a manifest', () => {
    dir('fixtures', 'sample', 'venv'); // fixture data, not a toolchain
    const detection = detectSharedPaths(repo);
    expect(detection.shared).toEqual([]);
    expect(detection.unlinked).toEqual(['fixtures/sample/venv']);
  });

  it('honours the depth bound and reports what lies one level past it', () => {
    expect(SHARED_PATH_SCAN_DEPTH).toBe(3);
    // depth 3: a/b/c carries a manifest → its .venv qualifies.
    file('a/b/c/pyproject.toml');
    dir('a', 'b', 'c', '.venv');
    // depth 4: a/b/c/d carries a manifest too, but the walk stops at 3.
    file('a/b/c/d/pyproject.toml');
    dir('a', 'b', 'c', 'd', 'node_modules');
    // depth 5: invisible even to the "one past" look.
    file('a/b/c/d/e/pyproject.toml');
    dir('a', 'b', 'c', 'd', 'e', 'venv');

    const detection = detectSharedPaths(repo);
    expect(detection.shared).toEqual(['a/b/c/.venv']);
    expect(detection.unlinked).toEqual(['a/b/c/d/node_modules']);
  });

  it('never descends into dependency payloads, hidden dirs, build output or worktrees', () => {
    file('package.json', '{}');
    dir('node_modules');
    file('node_modules/dep/package.json', '{}');
    dir('node_modules', 'dep', 'node_modules'); // nested dep of a dep
    file('.hidden/package.json', '{}');
    dir('.hidden', 'node_modules');
    file('dist/package.json', '{}');
    dir('dist', 'node_modules');
    file('worktree/other-task/package.json', '{}');
    dir('worktree', 'other-task', 'node_modules'); // another task's checkout

    const detection = detectSharedPaths(repo);
    expect(detection.shared).toEqual(['node_modules']);
    expect(detection.unlinked).toEqual([]);
  });

  it('accepts every workspace manifest kind', () => {
    for (const [workspace, manifest] of [['w1', 'package.json'], ['w2', 'pyproject.toml'], ['w3', 'uv.lock'], ['w4', 'requirements.txt']]) {
      file(`${workspace}/${manifest}`);
      dir(workspace, '.venv');
    }
    expect(detectSharedPaths(repo).shared).toEqual(['w1/.venv', 'w2/.venv', 'w3/.venv', 'w4/.venv']);
  });
});


describe('unsharedGitignoredPaths (AGT-4041)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openswarm-ignored-paths-'));
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, '.gitignore'), 'ignored-data\nignored-dir/\npartial\nlocked\n');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));
  it('returns none when no ignored paths exist', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'x');
    expect(unsharedGitignoredPaths(repo)).toEqual({ missing: [], unreadable: [] });
  });
  it('counts ignored paths not included in sharedPaths', () => {
    mkdirSync(join(repo, 'ignored-data'));
    writeFileSync(join(repo, 'partial'), 'x');
    expect(unsharedGitignoredPaths(repo, ['partial']).missing).toEqual(['ignored-data']);
  });
  it('reports a partially shared ignored path: sharing a child leaves the rest missing', () => {
    mkdirSync(join(repo, 'ignored-dir', 'a'), { recursive: true });
    mkdirSync(join(repo, 'ignored-dir', 'b'), { recursive: true });
    writeFileSync(join(repo, 'ignored-dir', 'b', 'x.csv'), 'x');
    expect(unsharedGitignoredPaths(repo, ['ignored-dir/a']).missing).toEqual(['ignored-dir']);
    expect(unsharedGitignoredPaths(repo, ['ignored-dir'])).toEqual({ missing: [], unreadable: [] });
    expect(gitignoredPathsWarning({ missing: ['ignored-dir'], unreadable: [] })).toContain('1 gitignored path(s)');
  });

  it('finds an ignored data dir nested under a tracked directory (docs/CGF_data)', () => {
    writeFileSync(join(repo, '.gitignore'), 'docs/CGF_data/\n');
    mkdirSync(join(repo, 'docs', 'CGF_data'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'README.md'), 'tracked');
    for (let i = 0; i < 3; i++) writeFileSync(join(repo, 'docs', 'CGF_data', `f${i}.pdf`), 'x');
    execFileSync('git', ['-C', repo, 'add', '.gitignore', 'docs/README.md']);
    expect(unsharedGitignoredPaths(repo).missing).toEqual(['docs/CGF_data']);
    expect(unsharedGitignoredPaths(repo, ['docs/CGF_data'])).toEqual({ missing: [], unreadable: [] });
  });

  it('skips a nested checkout parked inside the repository', () => {
    mkdirSync(join(repo, '.worktrees', 't1', 'data'), { recursive: true });
    writeFileSync(join(repo, '.worktrees', 't1', '.git'), 'gitdir: elsewhere');
    writeFileSync(join(repo, '.worktrees', 't1', '.gitignore'), 'data/\n');
    writeFileSync(join(repo, '.gitignore'), 'ignored-data\n');
    mkdirSync(join(repo, 'ignored-data'));
    expect(unsharedGitignoredPaths(repo).missing).toEqual(['ignored-data']);
  });

  it('caps the listed names in the warning but counts them all', () => {
    const many = Array.from({ length: 25 }, (_, i) => `p${i}`);
    const warning = gitignoredPathsWarning({ missing: many, unreadable: [] })!;
    expect(warning).toContain('25 gitignored path(s)');
    expect(warning).toContain('+5 more');
  });
  it('counts ignored paths with no read permission even when running as root', () => {
    mkdirSync(join(repo, 'locked'));
    chmodSync(join(repo, 'locked'), 0);
    try {
      // Shared (linked) but unreadable still counts: the worktree sees a name and no content.
      expect(unsharedGitignoredPaths(repo, ['locked'])).toEqual({ missing: [], unreadable: ['locked'] });
    } finally {
      chmodSync(join(repo, 'locked'), 0o755);
    }
  });

  it('reports a daemon-owned 0700 dir as unreadable when the sandbox runs as another uid (the incident)', () => {
    mkdirSync(join(repo, 'locked'));
    chmodSync(join(repo, 'locked'), 0o700);
    const self = process.getuid!();
    // Same uid as the daemon (the bubblewrap sandbox): readable.
    expect(unsharedGitignoredPaths(repo, ['locked'])).toEqual({ missing: [], unreadable: [] });
    // A container mapping the worker to another uid needs the "other" read bit.
    expect(unsharedGitignoredPaths(repo, ['locked'], { uid: self + 1 }).unreadable).toEqual(['locked']);
    // Group read counts only when the sandbox gid matches the owning group.
    chmodSync(join(repo, 'locked'), 0o750);
    expect(unsharedGitignoredPaths(repo, ['locked'], { uid: self + 1, gid: process.getgid!() }).unreadable).toEqual([]);
    expect(unsharedGitignoredPaths(repo, ['locked'], { uid: self + 1, gid: process.getgid!() + 1 }).unreadable).toEqual(['locked']);
    chmodSync(join(repo, 'locked'), 0o755);
    expect(unsharedGitignoredPaths(repo, ['locked'], { uid: self + 1 }).unreadable).toEqual([]);
  });

  it('reads the sandbox uid from OPENSWARM_SANDBOX_UID when no reader is passed', () => {
    mkdirSync(join(repo, 'locked'));
    chmodSync(join(repo, 'locked'), 0o700);
    vi.stubEnv('OPENSWARM_SANDBOX_UID', String(process.getuid!() + 1));
    try {
      expect(unsharedGitignoredPaths(repo, ['locked']).unreadable).toEqual(['locked']);
    } finally { vi.unstubAllEnvs(); chmodSync(join(repo, 'locked'), 0o755); }
  });

  it('lists an ignored directory once even when git also lists the files under it', () => {
    writeFileSync(join(repo, '.gitignore'), 'data/**\n');
    mkdirSync(join(repo, 'data', 'sub'), { recursive: true });
    writeFileSync(join(repo, 'data', 'f'), 'x');
    writeFileSync(join(repo, 'data', 'sub', 'g'), 'x');
    const listing = execFileSync('git', ['-C', repo, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], { encoding: 'utf8' });
    expect(listing).toContain('data/f'); // the duplicate git really emits
    expect(unsharedGitignoredPaths(repo).missing).toEqual(['data']);
  });

  it('skips an ignored directory that holds nested checkouts (worktrees/<id>/.git) or is one', () => {
    writeFileSync(join(repo, '.gitignore'), 'worktrees/\nworktree/\nclone/\nignored-data\n');
    for (const parked of ['worktrees/t1', 'worktree/AGT-1']) {
      mkdirSync(join(repo, parked, 'src'), { recursive: true });
      writeFileSync(join(repo, parked, '.git'), 'gitdir: elsewhere');
    }
    mkdirSync(join(repo, 'clone', '.git'), { recursive: true });
    mkdirSync(join(repo, 'ignored-data'));
    expect(unsharedGitignoredPaths(repo).missing).toEqual(['ignored-data']);
  });

  it('still lists an ignored dir that mixes a nested clone with real data', () => {
    writeFileSync(join(repo, '.gitignore'), 'ignored-data/\n');
    mkdirSync(join(repo, 'ignored-data', 'clone', '.git'), { recursive: true });
    mkdirSync(join(repo, 'ignored-data', 'csv'), { recursive: true });
    expect(unsharedGitignoredPaths(repo).missing).toEqual(['ignored-data']);
  });

  it('lists missing and unreadable separately in the warning', () => {
    const warning = gitignoredPathsWarning({ missing: ['docs/CGF_data'], unreadable: ['private'] })!;
    expect(warning).toContain('1 gitignored path(s) from the source are absent from this worktree (docs/CGF_data)');
    expect(warning).toContain('1 shared gitignored path(s) are unreadable by the sandbox identity (private)');
    expect(gitignoredPathsWarning({ missing: [], unreadable: [] })).toBeNull();
  });

  it('warns once per repository and gap list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnGitignoredPathsOnce(repo, { missing: ['a'], unreadable: [] });
      warnGitignoredPathsOnce(repo, { missing: ['a'], unreadable: [] });
      expect(warn).toHaveBeenCalledTimes(1);
      warnGitignoredPathsOnce(repo, { missing: ['a', 'b'], unreadable: [] });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });

  it('bounds the git listing with a timeout', () => {
    const source = readFileSync(join(__dirname, 'sharedPathDetection.ts'), 'utf8');
    expect(source).toMatch(/'ls-files', '--others'[^\n]*\n[^\n]*timeout: 10_000/);
  });
});

describe('emptyDetectionWarning (AGT-4043)', () => {
  it('says nothing when something was shared or nothing exists', () => {
    expect(emptyDetectionWarning('/repo', { shared: ['node_modules'], unlinked: ['x/venv'] })).toBeNull();
    expect(emptyDetectionWarning('/repo', { shared: [], unlinked: [] })).toBeNull();
  });

  it('names the dependency dirs that exist but did not qualify', () => {
    const warning = emptyDetectionWarning('/repo', { shared: [], unlinked: ['fixtures/venv', 'a/b/c/d/node_modules'] });
    expect(warning).toContain('No shared dependency paths detected in /repo');
    expect(warning).toContain('fixtures/venv, a/b/c/d/node_modules');
    expect(warning).toContain('sandbox.sharedPaths');
  });
});

describe('resolveSharedPaths configured list (INT-2415)', () => {
  let repo: string;
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'openswarm-shared-config-')); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it('a configured list wins over auto-detection, even in a monorepo', () => {
    writeFileSync(join(repo, 'package.json'), '{}');
    mkdirSync(join(repo, 'apps', 'x', 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'apps', 'x', 'package.json'), '{}');
    mkdirSync(join(repo, 'data'), { recursive: true });
    expect(resolveSharedPaths(repo, { sandbox: { sharedPaths: ['data', 'apps/x/node_modules'] } }))
      .toEqual(['data', 'apps/x/node_modules']);
    expect(resolveSharedPaths(repo, { sandbox: { sharedPaths: ['data'] } })).toEqual(['data']);
  });

  it('drops absolute and parent-escaping entries', () => {
    expect(resolveSharedPaths(repo, { sandbox: { sharedPaths: ['/etc', '../secrets', 'a/../../x', ''] } })).toEqual([]);
  });
});

describe('secretSharedPathComponents (AGT-4813)', () => {
  it('flags paths with secret-like components and leaves ordinary dependencies alone', () => {
    expect(secretSharedPathComponents(['.env', '.env.local', 'certs/client.pem', 'keys/app.key', 'credentials.json', 'node_modules']))
      .toEqual(['.env', '.env.local', 'certs/client.pem', 'keys/app.key', 'credentials.json']);
  });

  it('returns an actionable warning when a secret-like shared path is configured', () => {
    expect(secretSharedPathsWarning(['.env'])).toContain('Remove these entries from openswarm.json sandbox.sharedPaths');
    expect(secretSharedPathsWarning(['node_modules'])).toBeNull();
  });
});

describe('resolveSharedPaths warns about secret-like entries for every consumer (#848 review)', () => {
  it('warns once from resolveSharedPaths itself, whoever calls it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'shared-secret-'));
    mkdirSync(join(repo, '.env.d'), { recursive: true });
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = { sandbox: { sharedPaths: ['node_modules', '.env.d'] } };
      expect(resolveSharedPaths(repo, config)).toEqual(['node_modules', '.env.d']);
      resolveSharedPaths(repo, config);
      const secretWarnings = warn.mock.calls.filter(([line]) => String(line).includes('may expose secret files'));
      expect(secretWarnings).toHaveLength(1);
      expect(String(secretWarnings[0][0])).toContain('.env.d');
    } finally {
      warn.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
