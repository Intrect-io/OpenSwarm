// ============================================
// OpenSwarm - Legacy dot-lock writer evidence (AGT-4024)
// ============================================
//
// Since 0.25.0 every task-state writer takes the SQLite mutex before the
// dot-lock, and removes its dot-lock before releasing the mutex. So while this
// process holds the mutex, no current writer can release or replace the
// dot-lock. A dot-lock that disappears or changes token between two of our
// acquisition attempts, without our own reclaim in between, can only come from
// a live writer that never takes the mutex: a <=0.24.4 CLI. A crashed current
// writer leaves its dot-lock behind and it never moves by itself, so it is not
// evidence (only our reclaim removes it). Absence of evidence proves nothing.
// Caveat: this assumes the SQLite mutex really excludes other writers. On a
// filesystem that does not honour fcntl locks across the boundary (NFS, some
// host+container virtiofs mounts) two current writers can both "hold" it, and
// one releasing its dot-lock looks the same: lock payloads are identical
// across 0.24.x and 0.25.x, so the probe cannot tell those cases apart.

import { readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../support/atomicFile.js';

export type LegacyWriterEvidence = { firstSeenAt: string; lastSeenAt: string; pid: number | null; ns: string | null };
type ObservedOwner = { token: string; pid?: number; ns?: string | null };

let warnedThisProcess = false;

export function legacyWriterEvidencePath(storePath: string): string {
  return `${storePath}.legacy-writer.json`;
}

/** The recorded evidence, or null when there is none or it cannot be read. */
export function readLegacyWriterEvidence(storePath: string): LegacyWriterEvidence | null {
  try {
    const raw = JSON.parse(readFileSync(legacyWriterEvidencePath(storePath), 'utf8')) as Partial<LegacyWriterEvidence>;
    if (typeof raw.lastSeenAt !== 'string') return null;
    return {
      firstSeenAt: typeof raw.firstSeenAt === 'string' ? raw.firstSeenAt : raw.lastSeenAt,
      lastSeenAt: raw.lastSeenAt,
      pid: Number.isInteger(raw.pid) ? raw.pid! : null,
      ns: typeof raw.ns === 'string' ? raw.ns : null,
    };
  } catch {
    return null;
  }
}

function recordEvidence(storePath: string, owner: ObservedOwner): void {
  const path = legacyWriterEvidencePath(storePath);
  try {
    const now = new Date().toISOString();
    const evidence: LegacyWriterEvidence = {
      firstSeenAt: readLegacyWriterEvidence(storePath)?.firstSeenAt ?? now,
      lastSeenAt: now,
      pid: owner.pid ?? null,
      ns: owner.ns ?? null,
    };
    atomicWriteFileSync(path, JSON.stringify(evidence), 0o600);
    if (!warnedThisProcess) {
      warnedThisProcess = true;
      console.warn(`[TaskState] A dot-lock-only (<=0.24.4) writer released the task-state lock (pid ${evidence.pid ?? 'unknown'}); evidence in ${path}`);
    }
  } catch {
    // Best effort: evidence must never fail lock acquisition or the store write.
    // atomicWriteFileSync removes its own temporary file on failure.
  }
}

/**
 * Tracks the dot-lock this process saw while holding the SQLite mutex. Every
 * method swallows its own failures. A null observation (unreadable or half
 * written lock) carries no identity and is ignored rather than compared.
 */
export function createLegacyWriterProbe(storePath: string) {
  let seen: ObservedOwner | undefined;
  let reclaimed = false;
  let recorded = false;
  const released = (): void => {
    try {
      if (seen && !reclaimed && !recorded) { recorded = true; recordEvidence(storePath, seen); }
    } catch { /* best effort */ }
  };
  return {
    observe(owner: ObservedOwner | null): void {
      if (!owner) return;
      if (seen && seen.token !== owner.token) released();
      seen = { token: owner.token, pid: owner.pid, ns: owner.ns };
      reclaimed = false;
    },
    reclaimedByUs(): void { reclaimed = true; },
    vanished(): void {
      released();
      seen = undefined;
      reclaimed = false;
    },
  };
}
