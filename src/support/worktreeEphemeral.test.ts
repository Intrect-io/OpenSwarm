import { describe, expect, it } from 'vitest';
import { ephemeralPathspecRoots, isEphemeralWorktreeArtifact } from './worktreeEphemeral.js';

describe('isEphemeralWorktreeArtifact', () => {
  // cgf-portal#207 (2026-09-02) shipped `apps/pipelines/.coverage`: the repo
  // ignores only `coverage/`, so pytest-cov's data file was trackable and the
  // WIP preserve committed it.
  it('drops Python test-run output at any depth', () => {
    for (const file of [
      '.coverage',
      'apps/pipelines/.coverage',
      'apps/pipelines/.coverage.runner.12345.XyZ',
      'apps/pipelines/.full-pytest.status',
      '.pytest_cache/v/cache/nodeids',
      'src/pkg/__pycache__/mod.cpython-312.pyc',
      'htmlcov/index.html',
      '.hypothesis/examples/abc',
    ]) {
      expect(isEphemeralWorktreeArtifact(file), file).toBe(true);
    }
  });

  it('keeps source that merely resembles test output', () => {
    for (const file of [
      'src/coverage.ts',
      'docs/coverage-report.md',
      'tests/test_loader.py',
      'apps/pipelines/src/cgf_pipelines/a3_messaging.py',
      'coverage/README.md',
    ]) {
      expect(isEphemeralWorktreeArtifact(file), file).toBe(false);
    }
  });

  it('still recognises the worktree-level scratch it always did', () => {
    expect(isEphemeralWorktreeArtifact('.venv')).toBe(true);
    expect(isEphemeralWorktreeArtifact('pytest-of-openswarm/pytest-3/x')).toBe(true);
    expect(isEphemeralWorktreeArtifact('.trash/AX-1/pytest-a3/out')).toBe(true);
  });
});

describe('ephemeralPathspecRoots', () => {
  it('collapses pytest basetemp paths to their root and keeps single files', () => {
    expect(ephemeralPathspecRoots([
      'pytest-of-openswarm/pytest-3/a', 'pytest-of-openswarm/pytest-3/b', 'apps/pipelines/.coverage',
    ])).toEqual(['apps/pipelines/.coverage', 'pytest-of-openswarm']);
  });
});
