// Created: 2026-11-21
// Purpose: durable reviewer verdicts bound to the exact commit reviewed, for the merge steward (AGT-4803)
// Dependencies: better-sqlite3 (lazy), ./automationDbPath.js, ../support/sqliteWal.js
// Test Status: stewardVerdictLedger.test.ts

/**
 * One row per (PR, reviewed commit). The publication review hook writes it; the
 * merge steward only reads it. Unlike the review-reuse cache this table has no
 * TTL and nothing deletes a row: it is evidence, and a later verdict for the
 * same key replaces the earlier one in place.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { defaultAutomationDbPath } from './automationDbPath.js';
import { DEFAULT_BUSY_TIMEOUT_MS, enableWalWithRetry } from '../support/sqliteWal.js';

// Loaded at open time, not import time, like reviewVerdictStore.ts.
const require = createRequire(import.meta.url);

export type StewardReviewDecision = 'approve' | 'reject' | 'revise';
export type StewardVerdict = 'approve' | 'reject';
export type StewardCoverage = 'complete' | 'partial';

export interface StewardVerdictInput {
  prUrl: string;
  reviewedSha: string;
  decision: StewardReviewDecision;
  /** Only a review that was given the issue text may pass a coverage claim. */
  coverage?: StewardCoverage | null;
  /** Epoch ms; defaults to now. */
  now?: number;
}

export interface StewardVerdictRecord {
  prUrl: string;
  reviewedSha: string;
  verdict: StewardVerdict;
  coverage: StewardCoverage | null;
  /** ISO-8601 timestamp of the latest write for this key. */
  recordedAt: string;
}

/** Writer shape the publication hook takes, so tests can inject one. */
export type StewardVerdictWriter = (input: StewardVerdictInput) => void;

const FULL_SHA = /^[0-9a-f]{40}$/;

/** True for a full, lowercase 40-hex commit sha. */
export function isFullCommitSha(value: unknown): value is string {
  return typeof value === 'string' && FULL_SHA.test(value);
}

/** 'revise' is not a pass, so the steward sees it as a rejection. */
export function stewardVerdictFor(decision: StewardReviewDecision): StewardVerdict {
  return decision === 'approve' ? 'approve' : 'reject';
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS steward_verdicts (
    pr_url TEXT NOT NULL,
    reviewed_sha TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'reject')),
    coverage TEXT CHECK (coverage IS NULL OR coverage IN ('complete', 'partial')),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (pr_url, reviewed_sha)
  );
`;

interface Row {
  pr_url: string;
  reviewed_sha: string;
  verdict: StewardVerdict;
  coverage: StewardCoverage | null;
  recorded_at: string;
}

export class StewardVerdictLedger {
  private readonly db: Database.Database;
  readonly readOnly: boolean;
  private closed = false;

  private constructor(db: Database.Database, readOnly: boolean) {
    this.db = db;
    this.readOnly = readOnly;
  }

  /** Open for writing, creating the database and table when missing. */
  static open(dbPath: string = defaultAutomationDbPath()): StewardVerdictLedger {
    mkdirSync(dirname(dbPath), { recursive: true });
    const Sqlite = require('better-sqlite3') as typeof Database;
    const db = new Sqlite(dbPath);
    try {
      db.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
      enableWalWithRetry(db, DEFAULT_BUSY_TIMEOUT_MS);
      db.exec(SCHEMA);
    } catch (error) {
      db.close();
      throw error;
    }
    return new StewardVerdictLedger(db, false);
  }

  /**
   * Open for the steward: never creates anything. A missing database is no
   * evidence, so null; one that exists but cannot be opened throws.
   */
  static openReadOnly(dbPath: string = defaultAutomationDbPath()): StewardVerdictLedger | null {
    if (!existsSync(dbPath)) return null;
    const Sqlite = require('better-sqlite3') as typeof Database;
    const db = new Sqlite(dbPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    } catch (error) {
      db.close();
      throw error;
    }
    return new StewardVerdictLedger(db, true);
  }

  /** Insert or update the verdict for (prUrl, reviewedSha). Refuses a non-40-hex sha. */
  record(input: StewardVerdictInput): StewardVerdictRecord {
    if (this.readOnly) throw new Error('steward verdict ledger: opened read-only');
    if (!isFullCommitSha(input.reviewedSha)) {
      throw new Error(`steward verdict ledger: refusing reviewed sha ${JSON.stringify(input.reviewedSha)} (need 40 lowercase hex)`);
    }
    if (!input.prUrl.trim()) throw new Error('steward verdict ledger: refusing an empty PR URL');
    const record: StewardVerdictRecord = {
      prUrl: input.prUrl,
      reviewedSha: input.reviewedSha,
      verdict: stewardVerdictFor(input.decision),
      coverage: input.coverage ?? null,
      recordedAt: new Date(input.now ?? Date.now()).toISOString(),
    };
    this.db.prepare(`
      INSERT INTO steward_verdicts(pr_url, reviewed_sha, verdict, coverage, recorded_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pr_url, reviewed_sha) DO UPDATE SET
        verdict = excluded.verdict,
        coverage = excluded.coverage,
        recorded_at = excluded.recorded_at
    `).run(record.prUrl, record.reviewedSha, record.verdict, record.coverage, record.recordedAt);
    return record;
  }

  /** The verdict for exactly this commit of this PR, or null. */
  lookup(prUrl: string, reviewedSha: string): StewardVerdictRecord | null {
    if (!isFullCommitSha(reviewedSha)) return null;
    // A read-only handle on a database that never held a verdict has no table.
    const table = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steward_verdicts'",
    ).get();
    if (!table) return null;
    const row = this.db.prepare(
      'SELECT pr_url, reviewed_sha, verdict, coverage, recorded_at FROM steward_verdicts WHERE pr_url = ? AND reviewed_sha = ?',
    ).get(prUrl, reviewedSha) as Row | undefined;
    if (!row) return null;
    return {
      prUrl: row.pr_url,
      reviewedSha: row.reviewed_sha,
      verdict: row.verdict,
      coverage: row.coverage,
      recordedAt: row.recorded_at,
    };
  }

  /** The connection's busy_timeout in ms. */
  busyTimeoutMs(): number {
    return Number(this.db.pragma('busy_timeout', { simple: true }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** Open, write one verdict, close. Throws on an invalid sha or a database error. */
export function recordStewardVerdict(
  input: StewardVerdictInput,
  dbPath: string = defaultAutomationDbPath(),
): StewardVerdictRecord {
  const ledger = StewardVerdictLedger.open(dbPath);
  try {
    return ledger.record(input);
  } finally {
    ledger.close();
  }
}

/** Read-only lookup for the steward. A missing database or table is null. */
export function lookupStewardVerdict(
  prUrl: string,
  reviewedSha: string,
  dbPath: string = defaultAutomationDbPath(),
): StewardVerdictRecord | null {
  const ledger = StewardVerdictLedger.openReadOnly(dbPath);
  if (!ledger) return null;
  try {
    return ledger.lookup(prUrl, reviewedSha);
  } finally {
    ledger.close();
  }
}
