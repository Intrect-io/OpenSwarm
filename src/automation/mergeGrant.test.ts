// Created: 2026-11-21
// Purpose: operator merge grants are fail-closed and read only from the operator path (AGT-4414)
// Dependencies: vitest
// Test Status: passing

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultMergeGrantsPath, parseMergeGrants, readMergeGrant } from './mergeGrant.js';

const REPO = 'intrect/openswarm';

describe('merge grants', () => {
  let dir: string;
  const write = (name: string, content: string): string => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'merge-grants-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a missing or unreadable grants file grants nothing', () => {
    const missing = readMergeGrant(REPO, { path: join(dir, 'none.json') });
    expect(missing).toMatchObject({ granted: false, path: join(dir, 'none.json') });
    expect(missing.reason).toContain('no grants file at');

    const asDir = join(dir, 'a-directory');
    mkdirSync(asDir);
    const unreadable = readMergeGrant(REPO, { path: asDir });
    expect(unreadable.granted).toBe(false);
    expect(unreadable.reason).toMatch(/unreadable/);

    const denied = readMergeGrant(REPO, { path: join(dir, 'x.json'), readFile: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); } });
    expect(denied).toMatchObject({ granted: false });
    expect(denied.reason).toContain('unreadable (EACCES)');

    for (const raw of ['{not json', '[]', 'null', 'true', '"intrect/openswarm"', '']) {
      const result = readMergeGrant(REPO, { path: write('bad.json', raw) });
      expect(result.granted, raw).toBe(false);
      expect(result.reason, raw).toMatch(/malformed/);
    }

    // Wildcards and malformed keys never grant, including the repo they resemble.
    for (const grants of [{ '*': true }, { 'intrect/*': true }, { '*/openswarm': true }, { 'intrect/openswarm*': true },
      { intrect: true }, { 'intrect/openswarm/extra': true }, { ' intrect/openswarm': true }]) {
      const result = readMergeGrant(REPO, { path: write('wild.json', JSON.stringify(grants)) });
      expect(result.granted, JSON.stringify(grants)).toBe(false);
      expect(result.reason).toContain(`no entry for ${REPO}`);
    }
    expect(parseMergeGrants(JSON.stringify({ 'intrect/*': true })).rejected).toEqual(['intrect/*']);

    // Only the literal boolean true grants.
    for (const value of ['true', 1, 'yes', {}, [true], null, false]) {
      const result = readMergeGrant(REPO, { path: write('value.json', JSON.stringify({ [REPO]: value })) });
      expect(result.granted, JSON.stringify(value)).toBe(false);
      expect(result.reason).toContain('is not true');
    }

    // Keys match case-insensitively; another repo's grant does not carry over.
    const path = write('grants.json', JSON.stringify({ 'Intrect/OpenSwarm': true, 'acme/widgets': false }));
    expect(readMergeGrant(REPO, { path })).toEqual({ granted: true, reason: `${REPO} granted by ${path}`, path });
    expect(readMergeGrant('INTRECT/openswarm', { path }).granted).toBe(true);
    expect(readMergeGrant('acme/widgets', { path }).granted).toBe(false);
    expect(readMergeGrant('acme/other', { path }).reason).toContain('no entry for acme/other');

    // Disagreeing duplicates fail closed.
    const dup = write('dup.json', '{"intrect/openswarm": true, "INTRECT/OPENSWARM": false}');
    expect(readMergeGrant(REPO, { path: dup }).granted).toBe(false);
    const dupBad = write('dup2.json', '{"intrect/openswarm": true, "Intrect/openswarm": "true"}');
    expect(readMergeGrant(REPO, { path: dupBad }).granted).toBe(false);

    // An invalid repository name or a relative path grants nothing.
    expect(readMergeGrant('*', { path }).granted).toBe(false);
    expect(readMergeGrant(REPO, { path: 'merge-grants.json' }).granted).toBe(false);

    // OPENSWARM_MERGE_GRANTS overrides the home path.
    const previous = process.env.OPENSWARM_MERGE_GRANTS;
    try {
      process.env.OPENSWARM_MERGE_GRANTS = path;
      expect(defaultMergeGrantsPath()).toBe(path);
      expect(readMergeGrant(REPO)).toMatchObject({ granted: true, path });
      process.env.OPENSWARM_MERGE_GRANTS = join(dir, 'gone.json');
      expect(readMergeGrant(REPO).granted).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENSWARM_MERGE_GRANTS;
      else process.env.OPENSWARM_MERGE_GRANTS = previous;
    }
  });

  it('defaults to the operator home path, never the cwd', () => {
    expect(defaultMergeGrantsPath({})).toBe(join(homedir(), '.openswarm', 'steward', 'merge-grants.json'));
    expect(defaultMergeGrantsPath({ OPENSWARM_MERGE_GRANTS: '' })).toBe(join(homedir(), '.openswarm', 'steward', 'merge-grants.json'));
  });
});
