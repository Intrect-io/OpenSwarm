import { describe, expect, it } from 'vitest';
import { citedPathsAreEphemeral, ephemeralPathspecRoots, isEphemeralWorktreeArtifact } from './worktreeEphemeral.js';

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
    expect(isEphemeralWorktreeArtifact('pytest-local/test_case_current')).toBe(true);
    expect(isEphemeralWorktreeArtifact('.trash/AX-1/pytest-a3/out')).toBe(true);
  });

  // cgf-portal AX-868 (2026-09-02): a worker ran `uv venv .venv_test` and the
  // publication commit tracked 11,026 files under it. The purge commit that
  // followed removed nothing because only the bare `.venv` link was known, so
  // every later attempt died on the publication fence.
  it('drops any virtualenv directory by name, at any depth', () => {
    for (const file of [
      '.venv_test/bin/activate',
      '.venv_test/pyvenv.cfg',
      '.venv/lib/python3.12/site-packages/x.py',
      '.venv-verify/bin/ruff',
      '.venv.bak/bin/python',
      'venv/bin/python',
      'apps/pipelines/.venv/pyvenv.cfg',
      '.test_venv/lib/python3.11/site-packages/_pytest/_code/code.py',
      'test_venv/pyvenv.cfg',
      '.test_venv',
      'test_venv',
      '.venv',
      'venv',
    ]) {
      expect(isEphemeralWorktreeArtifact(file), file).toBe(true);
    }
    for (const file of ['src/venv_tools.py', 'docs/venv.md', 'convenv/x.py', 'src/env/config.py']) {
      expect(isEphemeralWorktreeArtifact(file), file).toBe(false);
    }
  });
});

describe('ephemeralPathspecRoots', () => {
  it('collapses pytest basetemp paths to their root and keeps single files', () => {
    expect(ephemeralPathspecRoots([
      'pytest-of-openswarm/pytest-3/a', 'pytest-of-openswarm/pytest-3/b', 'apps/pipelines/.coverage',
    ])).toEqual(['apps/pipelines/.coverage', 'pytest-of-openswarm']);
  });

  it('collapses a virtualenv to its directory so the purge is one rm -r', () => {
    expect(ephemeralPathspecRoots([
      '.venv_test/bin/activate', '.venv_test/lib/python3.12/site-packages/a.py', 'apps/x/.venv/pyvenv.cfg', '.venv',
    ])).toEqual(['.venv', '.venv_test', 'apps/x/.venv']);
  });
});

describe('citedPathsAreEphemeral', () => {
  it('treats a BS-guard dump that only names .test_venv as ephemeral', () => {
    const detail = 'Pipeline guard failed: [WARNING] .test_venv/lib/python3.11/site-packages/_pytest/_code/code.py:98 — TODO/FIXME';
    expect(citedPathsAreEphemeral(detail)).toBe(true);
  });

  it('treats a publication-scope list that is only pytest-local as ephemeral', () => {
    const detail = 'publication-scope: branch contains files outside reserved write scope: pytest-local/test_all_zero_token_samples_recurrent.py';
    expect(citedPathsAreEphemeral(detail)).toBe(true);
  });

  it('does not treat a mixed source + venv failure as ephemeral', () => {
    const detail = '[WARNING] src/ci_guard.py:12 — TODO/FIXME; [WARNING] .test_venv/lib/x.py:1 — TODO/FIXME';
    expect(citedPathsAreEphemeral(detail)).toBe(false);
  });

  it('does not treat an operator-question park as ephemeral', () => {
    expect(citedPathsAreEphemeral('[operator-question] asked 2 times with no answer — stopped retrying automatically')).toBe(false);
  });
});
