// Created: 2026-11-21
// Purpose: unit tests for the steward verdict ledger (AGT-4803)
// Dependencies: vitest, better-sqlite3
// Test Status: passing

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  StewardVerdictLedger,
  isFullCommitSha,
  lookupStewardVerdict,
  recordStewardVerdict,
} from './stewardVerdictLedger.js';
import { DEFAULT_BUSY_TIMEOUT_MS } from '../support/sqliteWal.js';

const PR = 'https://github.com/acme/repo/pull/7';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const roots: string[] = [];

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-steward-verdicts-'));
  roots.push(root);
  return join(root, 'automation.db');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('steward verdict ledger', () => {
  it('round-trips a verdict bound to the reviewed sha', () => {
    const path = dbPath();
    const written = recordStewardVerdict({ prUrl: PR, reviewedSha: SHA, decision: 'approve', coverage: 'complete', now: 1_000 }, path);
    expect(lookupStewardVerdict(PR, SHA, path)).toEqual(written);
    expect(written).toEqual({
      prUrl: PR, reviewedSha: SHA, verdict: 'approve', coverage: 'complete', recordedAt: new Date(1_000).toISOString(),
    });
    expect(lookupStewardVerdict(PR, 'f'.repeat(40), path)).toBeNull();
    expect(lookupStewardVerdict('https://github.com/acme/repo/pull/8', SHA, path)).toBeNull();
  });

  it('stores revise as reject and a missing coverage as null', () => {
    const path = dbPath();
    recordStewardVerdict({ prUrl: PR, reviewedSha: SHA, decision: 'revise' }, path);
    expect(lookupStewardVerdict(PR, SHA, path)).toMatchObject({ verdict: 'reject', coverage: null });
  });

  it('refuses a reviewed sha that is not 40 lowercase hex', () => {
    const path = dbPath();
    for (const bad of ['abc1234', SHA.toUpperCase(), `${SHA}0`, '', 'g'.repeat(40)]) {
      expect(() => recordStewardVerdict({ prUrl: PR, reviewedSha: bad, decision: 'approve' }, path)).toThrow(/refusing reviewed sha/);
    }
    expect(isFullCommitSha(SHA)).toBe(true);
    expect(isFullCommitSha(undefined)).toBe(false);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM steward_verdicts').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('updates a later write for the same key in place and never deletes', () => {
    const path = dbPath();
    recordStewardVerdict({ prUrl: PR, reviewedSha: SHA, decision: 'approve', now: 1_000 }, path);
    recordStewardVerdict({ prUrl: PR, reviewedSha: 'a'.repeat(40), decision: 'approve', now: 1_500 }, path);
    recordStewardVerdict({ prUrl: PR, reviewedSha: SHA, decision: 'reject', now: 2_000 }, path);
    expect(lookupStewardVerdict(PR, SHA, path)).toMatchObject({ verdict: 'reject', recordedAt: new Date(2_000).toISOString() });
    expect(lookupStewardVerdict(PR, 'a'.repeat(40), path)).toMatchObject({ verdict: 'approve' });
    const db = new Database(path, { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM steward_verdicts').get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  it('reads a missing database as no evidence without creating it', () => {
    const path = dbPath();
    expect(lookupStewardVerdict(PR, SHA, path)).toBeNull();
    expect(StewardVerdictLedger.openReadOnly(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('reads a database without the table as no evidence', () => {
    const path = dbPath();
    new Database(path).close();
    expect(lookupStewardVerdict(PR, SHA, path)).toBeNull();
  });

  it('refuses to write through a read-only handle', () => {
    const path = dbPath();
    recordStewardVerdict({ prUrl: PR, reviewedSha: SHA, decision: 'approve' }, path);
    const ledger = StewardVerdictLedger.openReadOnly(path)!;
    try {
      expect(() => ledger.record({ prUrl: PR, reviewedSha: SHA, decision: 'reject' })).toThrow(/read-only/);
      expect(ledger.lookup(PR, SHA)).toMatchObject({ verdict: 'approve' });
    } finally {
      ledger.close();
    }
  });

  it('sets busy_timeout on both the writer and the read-only handle', () => {
    const path = dbPath();
    const writer = StewardVerdictLedger.open(path);
    try {
      expect(writer.busyTimeoutMs()).toBe(DEFAULT_BUSY_TIMEOUT_MS);
    } finally {
      writer.close();
    }
    const reader = StewardVerdictLedger.openReadOnly(path)!;
    try {
      expect(reader.busyTimeoutMs()).toBe(DEFAULT_BUSY_TIMEOUT_MS);
    } finally {
      reader.close();
    }
  });
});
