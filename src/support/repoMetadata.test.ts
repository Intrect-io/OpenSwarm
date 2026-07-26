// ============================================
// OpenSwarm - repoMetadata tests
// ============================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRepoMetadata, saveRepoMetadata, REPO_METADATA_FILENAME, RepoMetadataError } from './repoMetadata.js';

describe('loadRepoMetadata', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-meta-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when openswarm.json does not exist', async () => {
    await expect(loadRepoMetadata(dir)).resolves.toBeNull();
  });

  it('parses a valid metadata file', async () => {
    writeFileSync(
      join(dir, REPO_METADATA_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        projectName: 'VEGA',
        linear: {
          teamId: 'ea78d38d-e835-4c58-a17c-5c4eb8d1fb45',
          teamKey: 'RES',
          projectId: 'c49a99e6-e420-463d-9c9a-ca5ee1fa51c2',
          projectName: 'VEGA Agent',
        },
      }),
    );

    const meta = await loadRepoMetadata(dir);
    expect(meta).not.toBeNull();
    expect(meta?.projectName).toBe('VEGA');
    expect(meta?.linear?.projectId).toBe('c49a99e6-e420-463d-9c9a-ca5ee1fa51c2');
    expect(meta?.linear?.teamKey).toBe('RES');
  });

  it('parses the checks map (INT-2303)', async () => {
    writeFileSync(
      join(dir, REPO_METADATA_FILENAME),
      JSON.stringify({ schemaVersion: 1, checks: { lint: 'ruff check .', test: 'pytest -x' } }),
    );
    const meta = await loadRepoMetadata(dir);
    expect(meta?.checks).toEqual({ lint: 'ruff check .', test: 'pytest -x' });
  });

  it('parses and defaults repository automation admission policy', async () => {
    writeFileSync(
      join(dir, REPO_METADATA_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        automation: { maxConcurrent: 2, maxCostUsdPerDay: 5 },
      }),
    );
    const meta = await loadRepoMetadata(dir);
    expect(meta?.automation).toEqual({
      enabled: true,
      maxConcurrent: 2,
      maxAttemptsPerHour: 12,
      maxFailuresPerHour: 6,
      maxCostUsdPerDay: 5,
      circuitCooldownMinutes: 60,
    });
  });

  it('throws RepoMetadataError on invalid JSON', async () => {
    writeFileSync(join(dir, REPO_METADATA_FILENAME), '{ not json');
    await expect(loadRepoMetadata(dir)).rejects.toBeInstanceOf(RepoMetadataError);
  });

  it('throws RepoMetadataError when schemaVersion is wrong', async () => {
    writeFileSync(
      join(dir, REPO_METADATA_FILENAME),
      JSON.stringify({ schemaVersion: 2 }),
    );
    await expect(loadRepoMetadata(dir)).rejects.toBeInstanceOf(RepoMetadataError);
  });

  it('throws RepoMetadataError when linear.projectId is not a UUID', async () => {
    writeFileSync(
      join(dir, REPO_METADATA_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        linear: { projectId: 'not-a-uuid' },
      }),
    );
    await expect(loadRepoMetadata(dir)).rejects.toBeInstanceOf(RepoMetadataError);
  });
});

describe('saveRepoMetadata', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-meta-save-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a Linear mapping through loadRepoMetadata', async () => {
    const meta = {
      schemaVersion: 1 as const,
      projectName: 'OpenSwarm',
      linear: {
        teamId: '49b7af95-3cac-4a56-adc7-f19d77dfbe9b',
        teamKey: 'INT',
        projectId: '74a9d092-7b3c-4d4d-a998-a2c9a8f08e83',
        projectName: 'OpenSwarm',
      },
    };
    const filePath = await saveRepoMetadata(dir, meta);
    expect(filePath).toBe(join(dir, REPO_METADATA_FILENAME));
    await expect(loadRepoMetadata(dir)).resolves.toEqual(meta);
  });

  it('rejects an invalid mapping (non-uuid projectId) without writing', async () => {
    await expect(
      // projectId is a string at the type level; the uuid check is runtime (zod).
      saveRepoMetadata(dir, { schemaVersion: 1, linear: { projectId: 'not-a-uuid' } }),
    ).rejects.toThrow();
    await expect(loadRepoMetadata(dir)).resolves.toBeNull();
  });

  // openswarm.json has many concurrent readers (projectMapper, worktreeManager's
  // linkSharedPaths, the daemon's repo resolution). Rewriting it in place lets a
  // reader observe a truncated file and fail with RepoMetadataError. An atomic
  // write is observable here as inode replacement: a plain writeFile truncates
  // the existing file and keeps its inode, whereas write-temp + rename installs
  // a new one.
  it('replaces openswarm.json atomically rather than rewriting it in place', async () => {
    const filePath = await saveRepoMetadata(dir, { schemaVersion: 1, projectName: 'A' });
    const inodeBefore = statSync(filePath).ino;

    const longer = {
      schemaVersion: 1 as const,
      linear: {
        teamId: '49b7af95-3cac-4a56-adc7-f19d77dfbe9b',
        teamKey: 'INTRECT-WITH-A-MUCH-LONGER-KEY',
        projectId: '74a9d092-7b3c-4d4d-a998-a2c9a8f08e83',
        projectName: 'OpenSwarm',
      },
    };
    await saveRepoMetadata(dir, longer);

    expect(statSync(filePath).ino).not.toBe(inodeBefore);
    await expect(loadRepoMetadata(dir)).resolves.toEqual(longer);
  });

  // atomicWriteFile defaults to 0o600. This file is tracked in the repo and is
  // meant to be readable like any other checked-in config, so the call has to
  // opt out of that default — otherwise adopting the atomic helper would
  // quietly turn openswarm.json owner-only.
  it('keeps openswarm.json readable beyond its owner', async () => {
    const filePath = await saveRepoMetadata(dir, { schemaVersion: 1, projectName: 'A' });
    expect(statSync(filePath).mode & 0o044).not.toBe(0);
  });
});
