import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SHARED_PATH_SCAN_DEPTH,
  detectSharedPaths,
  emptyDetectionWarning,
  resolveSharedPaths,
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
