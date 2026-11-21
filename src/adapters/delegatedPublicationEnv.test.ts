// Created: 2026-11-21
// Purpose: Prove a publication-fenced delegated CLI child gets no gh credentials (AGT-4414).
// Dependencies: vitest, node:child_process (real spawn), ./base.ts, ./delegatedPublicationEnv.ts
// Test Status: passing

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from './types.js';
import { applyEnvOverlay, spawnCli } from './base.js';
import {
  EMPTY_GH_CONFIG_DIR_PREFIX,
  PUBLICATION_TOKEN_ENV_KEYS,
  withoutPublicationCredentials,
} from './delegatedPublicationEnv.js';

describe('withoutPublicationCredentials', () => {
  it('drops every gh token and points GH_CONFIG_DIR at the given directory', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      GH_TOKEN: 'a',
      GITHUB_TOKEN: 'b',
      GH_ENTERPRISE_TOKEN: 'c',
      GITHUB_ENTERPRISE_TOKEN: 'd',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'e',
      GITHUB_PAT: 'f',
      GH_CONFIG_DIR: '/home/op/.config/gh',
    };
    const out = withoutPublicationCredentials(env, '/tmp/osw-gh-empty-x');
    for (const key of PUBLICATION_TOKEN_ENV_KEYS) expect(out).not.toHaveProperty(key);
    expect(out.GH_CONFIG_DIR).toBe('/tmp/osw-gh-empty-x');
    expect(out.PATH).toBe('/usr/bin');
  });

  it('does not mutate its input', () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: 'a' };
    withoutPublicationCredentials(env, '/tmp/empty');
    expect(env).toEqual({ GH_TOKEN: 'a' });
  });

  it('strips a token that an adapter overlay tries to set', () => {
    const overlaid = applyEnvOverlay({ PATH: '/usr/bin' }, { GH_TOKEN: 'from-overlay', GITHUB_TOKEN: 'x' });
    const out = withoutPublicationCredentials(overlaid, '/tmp/empty');
    expect(out).not.toHaveProperty('GH_TOKEN');
    expect(out).not.toHaveProperty('GITHUB_TOKEN');
    expect(out.GH_CONFIG_DIR).toBe('/tmp/empty');
  });
});

describe('delegated CLI spawn under forbidPublication', () => {
  let scriptDir: string;
  const savedSessionLog = process.env.OPENSWARM_SESSION_LOG;

  beforeEach(() => {
    process.env.OPENSWARM_SESSION_LOG = '0';
    scriptDir = mkdtempSync(join(tmpdir(), 'osw-fake-cli-'));
  });
  afterEach(() => {
    rmSync(scriptDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    if (savedSessionLog === undefined) delete process.env.OPENSWARM_SESSION_LOG;
    else process.env.OPENSWARM_SESSION_LOG = savedSessionLog;
  });

  /** A delegated adapter whose CLI prints the gh-relevant parts of its env as JSON. */
  const fakeCli = (overlay?: Record<string, string | undefined>): CliAdapter => {
    const script = join(scriptDir, 'print-env.cjs');
    writeFileSync(script, [
      "const fs = require('node:fs');",
      'const dir = process.env.GH_CONFIG_DIR;',
      'let entries = null;',
      'try { entries = dir ? fs.readdirSync(dir).length : null; } catch { entries = -1; }',
      'process.stdout.write(JSON.stringify({',
      '  GH_TOKEN: process.env.GH_TOKEN ?? null,',
      '  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,',
      '  GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN ?? null,',
      '  GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN ?? null,',
      '  GH_CONFIG_DIR: dir ?? null,',
      '  ghConfigEntries: entries,',
      '}));',
    ].join('\n'));
    return {
      name: 'fixture-cli',
      capabilities: {
        supportsStreaming: false,
        supportsJsonOutput: false,
        supportsModelSelection: false,
        managedGit: false,
        supportedSkills: [],
      },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: () => ({ command: process.execPath, args: [script], ...(overlay ? { env: overlay } : {}) }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
    };
  };

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GH_TOKEN: 'gh-secret',
    GITHUB_TOKEN: 'github-secret',
    GH_ENTERPRISE_TOKEN: 'ghe-secret',
  };

  it('a publication-fenced delegated adapter runs gh without credentials', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await spawnCli(fakeCli({ GH_TOKEN: 'overlay-secret' }), {
      prompt: 'p', cwd: scriptDir, baseEnv, forbidPublication: true,
    });
    const seen = JSON.parse(result.stdout) as Record<string, string | number | null>;
    expect(seen.GH_TOKEN).toBeNull();
    expect(seen.GITHUB_TOKEN).toBeNull();
    expect(seen.GH_ENTERPRISE_TOKEN).toBeNull();
    expect(seen.GITHUB_ENTERPRISE_TOKEN).toBeNull();
    expect(typeof seen.GH_CONFIG_DIR).toBe('string');
    const ghDir = String(seen.GH_CONFIG_DIR);
    expect(ghDir.startsWith(join(tmpdir(), EMPTY_GH_CONFIG_DIR_PREFIX))).toBe(true);
    // Existed and was empty inside the child; removed once the run settled.
    expect(seen.ghConfigEntries).toBe(0);
    expect(existsSync(ghDir)).toBe(false);
  });

  it('passes gh tokens through unchanged when the publication fence is off', async () => {
    const result = await spawnCli(fakeCli(), { prompt: 'p', cwd: scriptDir, baseEnv: { ...baseEnv, GH_CONFIG_DIR: '/op/gh' } });
    const seen = JSON.parse(result.stdout) as Record<string, string | number | null>;
    expect(seen.GH_TOKEN).toBe('gh-secret');
    expect(seen.GITHUB_TOKEN).toBe('github-secret');
    expect(seen.GH_ENTERPRISE_TOKEN).toBe('ghe-secret');
    expect(seen.GH_CONFIG_DIR).toBe('/op/gh');
  });
});
