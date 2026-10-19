import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { RunClaim } from './runLedgerTypes.js';
import type { AdviceRecord, ExecutionContract, ProgressSnapshot, RecoveryCheckpoint, RecoveryHooks, RecoveryStatus } from './loopRecoveryTypes.js';

const DAY = 24 * 60 * 60_000;
export const recoveryHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 기존 원장에 추가하는 테이블. JSON task-state나 관측 요청으로 실행 권한을 만들지 않는다. */
export class RunRecoveryStore {
  constructor(private readonly db: Database.Database) {
    db.transaction(() => db.exec(`CREATE TABLE IF NOT EXISTS automation_recovery (
      issue_id TEXT PRIMARY KEY REFERENCES automation_runs(issue_id) ON DELETE CASCADE,
      contract_json TEXT, progress_json TEXT, resume_stage TEXT, environment_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS automation_stage_checkpoints (
      issue_id TEXT NOT NULL REFERENCES automation_runs(issue_id) ON DELETE CASCADE,
      stage TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(issue_id,stage)
    );
    CREATE TABLE IF NOT EXISTS automation_progress_failures (
      issue_id TEXT NOT NULL REFERENCES automation_runs(issue_id) ON DELETE CASCADE,
      stage TEXT NOT NULL, progress_json TEXT NOT NULL, PRIMARY KEY(issue_id,stage)
    );
    CREATE TABLE IF NOT EXISTS automation_advice (
      id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES automation_runs(issue_id) ON DELETE CASCADE,
      evidence_key TEXT NOT NULL, lease_epoch INTEGER NOT NULL, owner_id TEXT NOT NULL, lease_token TEXT NOT NULL,
      created_at INTEGER NOT NULL, data_json TEXT NOT NULL, UNIQUE(issue_id,evidence_key)
    );
    CREATE INDEX IF NOT EXISTS idx_automation_advice_budget ON automation_advice(issue_id,created_at);`)).immediate();
  }

  forClaim(getClaim: () => RunClaim, now: () => number = Date.now): RecoveryHooks {
    const current = (): boolean => {
      if (!this.db.open) return false;
      const c = getClaim();
      return !!this.db.prepare(`SELECT 1 FROM automation_runs WHERE issue_id=? AND owner_instance_id=?
        AND lease_token=? AND lease_epoch=? AND attempt_no=? AND lease_expires_at>?
        AND state IN ('CLAIMED','EXECUTING','VERIFYING','PUBLISHING')`)
        .get(c.issueId, c.ownerInstanceId, c.leaseToken, c.leaseEpoch, c.attemptNo, now());
    };
    const write = <T>(fn: (claim: RunClaim) => T): T => this.db.transaction(() => {
      if (!current()) throw new Error('Recovery lease fence rejected');
      return fn(getClaim());
    }).immediate();
    const ensure = (id: string): void => { this.db.prepare('INSERT OR IGNORE INTO automation_recovery(issue_id) VALUES (?)').run(id); };
    const held = (): boolean => !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_exec_runs'").get()
      && !!this.db.prepare('SELECT 1 FROM automation_exec_runs WHERE issue_id=? AND updated_at>?').get(getClaim().issueId, now() - DAY);
    const row = (): { contract_json: string | null; progress_json: string | null; resume_stage: string | null } | undefined =>
      this.db.prepare('SELECT * FROM automation_recovery WHERE issue_id=?').get(getClaim().issueId) as ReturnType<typeof row>;
    return {
      isCurrent: current,
      canAdvise: () => current() && !held(),
      contract: (contract: ExecutionContract) => write((claim) => {
        if (contract.issueId !== claim.issueId) throw new Error('Recovery contract scope conflict');
        ensure(claim.issueId);
        const previous = row();
        if (previous?.contract_json && recoveryHash(JSON.parse(previous.contract_json)) !== recoveryHash(contract)) {
          this.db.prepare('DELETE FROM automation_stage_checkpoints WHERE issue_id=?').run(claim.issueId);
          this.db.prepare('DELETE FROM automation_progress_failures WHERE issue_id=?').run(claim.issueId);
          this.db.prepare('UPDATE automation_recovery SET progress_json=NULL,resume_stage=NULL WHERE issue_id=?').run(claim.issueId);
        }
        this.db.prepare('UPDATE automation_recovery SET contract_json=? WHERE issue_id=?').run(JSON.stringify(contract), claim.issueId);
        const interrupted = this.db.prepare('SELECT id,data_json FROM automation_advice WHERE issue_id=? AND lease_epoch!=?')
          .all(claim.issueId, claim.leaseEpoch) as Array<{ id: string; data_json: string }>;
        for (const row of interrupted) {
          const advice = JSON.parse(row.data_json) as AdviceRecord;
          if (advice.status === 'processing') this.db.prepare('UPDATE automation_advice SET data_json=? WHERE id=?')
            .run(JSON.stringify({ ...advice, status: 'interrupted', reason: 'Previous advisor owner exited; outcome unknown' }), row.id);
        }
      }),
      observe: (value) => write((claim) => {
        ensure(claim.issueId);
        const raw = (this.db.prepare('SELECT progress_json FROM automation_progress_failures WHERE issue_id=? AND stage=?')
          .get(claim.issueId, value.stage) as { progress_json: string } | undefined)?.progress_json;
        const previous = raw ? JSON.parse(raw) as ProgressSnapshot : undefined;
        const sameFailure = !!value.failureFingerprint && previous?.failureFingerprint === value.failureFingerprint;
        const sameEvidence = previous?.artifactDigest === value.artifactDigest
          && previous?.environmentDigest === value.environmentDigest
          && recoveryHash(previous?.checks ?? []) === recoveryHash(value.checks);
        const progress: ProgressSnapshot = { ...value, consecutiveNoProgress: value.failureFingerprint
          ? sameFailure && sameEvidence ? previous!.consecutiveNoProgress + 1 : 1 : 0 };
        this.db.prepare('UPDATE automation_recovery SET progress_json=? WHERE issue_id=?').run(JSON.stringify(progress), claim.issueId);
        if (value.failureFingerprint) this.db.prepare(`INSERT INTO automation_progress_failures VALUES (?,?,?)
          ON CONFLICT(issue_id,stage) DO UPDATE SET progress_json=excluded.progress_json`)
          .run(claim.issueId, value.stage, JSON.stringify(progress));
        else this.db.prepare('DELETE FROM automation_progress_failures WHERE issue_id=? AND stage=?').run(claim.issueId, value.stage);
        return progress;
      }),
      checkpoint: (checkpoint) => write((claim) => {
        if (!checkpoint.result.success || !checkpoint.artifactDigest) throw new Error('Only proven successful stages may be checkpointed');
        this.db.prepare(`INSERT INTO automation_stage_checkpoints VALUES (?,?,?)
          ON CONFLICT(issue_id,stage) DO UPDATE SET data_json=excluded.data_json`)
          .run(claim.issueId, checkpoint.stage, JSON.stringify(checkpoint));
      }),
      resume: (contractHash, artifactDigest, environmentHash) => {
        if (!current()) throw new Error('Recovery lease fence rejected');
        const boundary = row()?.resume_stage;
        if (!['reviewer', 'tester'].includes(boundary ?? '')) return [];
        const checkpoints = this.db.prepare('SELECT data_json FROM automation_stage_checkpoints WHERE issue_id=?')
          .all(getClaim().issueId) as Array<{ data_json: string }>;
        return checkpoints.map((r) => JSON.parse(r.data_json) as RecoveryCheckpoint)
          .filter((c) => c.contractHash === contractHash && c.artifactDigest === artifactDigest && c.environmentHash === environmentHash
            && c.stage !== boundary);
      },
      resumable: (stage) => write((claim) => {
        if (stage !== undefined && !['reviewer', 'tester'].includes(stage)) throw new Error('Unsafe recovery boundary');
        ensure(claim.issueId);
        this.db.prepare('UPDATE automation_recovery SET resume_stage=? WHERE issue_id=?').run(stage ?? null, claim.issueId);
      }),
      settle: (success) => write((claim) => {
        this.db.prepare('UPDATE automation_recovery SET resume_stage=NULL WHERE issue_id=?').run(claim.issueId);
        this.db.prepare('DELETE FROM automation_stage_checkpoints WHERE issue_id=?').run(claim.issueId);
        if (success) this.db.prepare('DELETE FROM automation_progress_failures WHERE issue_id=?').run(claim.issueId);
      }),
      reserveAdvice: (evidenceKey, mode, maxCalls) => write((claim) => {
        if (held()) return undefined;
        if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 2) throw new Error('Invalid advisor call cap');
        if (this.db.prepare('SELECT 1 FROM automation_advice WHERE issue_id=? AND evidence_key=?').get(claim.issueId, evidenceKey)) return undefined;
        const count = (this.db.prepare('SELECT COUNT(*) n FROM automation_advice WHERE issue_id=? AND created_at>?')
          .get(claim.issueId, now() - DAY) as { n: number }).n;
        if (count >= maxCalls) return undefined;
        const advice: AdviceRecord = { id: randomUUID(), evidenceKey, mode, status: 'processing', applied: false, createdAt: now() };
        this.db.prepare('INSERT INTO automation_advice VALUES (?,?,?,?,?,?,?,?)')
          .run(advice.id, claim.issueId, evidenceKey, claim.leaseEpoch, claim.ownerInstanceId, claim.leaseToken, now(), JSON.stringify(advice));
        return advice;
      }),
      finishAdvice: (id, update) => {
        if (!current() || held()) return false;
        return write((claim) => {
          const raw = this.db.prepare(`SELECT data_json FROM automation_advice WHERE id=? AND issue_id=?
            AND lease_epoch=? AND owner_id=? AND lease_token=?`)
            .get(id, claim.issueId, claim.leaseEpoch, claim.ownerInstanceId, claim.leaseToken) as { data_json: string } | undefined;
          if (!raw) return false;
          const previous = JSON.parse(raw.data_json) as AdviceRecord;
          if (previous.status !== 'processing') return false;
          this.db.prepare('UPDATE automation_advice SET data_json=? WHERE id=?').run(JSON.stringify({ ...previous, ...update }), id);
          return true;
        });
      },
      status: () => this.status(getClaim().issueId, now()),
      advice: (key) => {
        if (!current()) return undefined;
        const raw = this.db.prepare('SELECT data_json FROM automation_advice WHERE issue_id=? AND evidence_key=?')
          .get(getClaim().issueId, key) as { data_json: string } | undefined;
        return raw ? JSON.parse(raw.data_json) as AdviceRecord : undefined;
      },
    };
  }

  status(issueId: string, now = Date.now()): RecoveryStatus {
    const row = this.db.prepare('SELECT contract_json,progress_json FROM automation_recovery WHERE issue_id=?')
      .get(issueId) as { contract_json: string | null; progress_json: string | null } | undefined;
    const raw = this.db.prepare(`SELECT a.data_json, a.lease_epoch=a2.lease_epoch AND a.owner_id=a2.owner_instance_id
      AND a.lease_token=a2.lease_token AND a2.lease_expires_at>? AND a2.state IN ('CLAIMED','EXECUTING','VERIFYING','PUBLISHING') live
      FROM automation_advice a JOIN automation_runs a2 USING(issue_id) WHERE issue_id=? ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1`)
      .get(now, issueId) as { data_json: string; live: number } | undefined;
    const advice = raw ? JSON.parse(raw.data_json) as AdviceRecord : undefined;
    if (advice?.status === 'processing' && !raw?.live) {
      advice.status = 'interrupted'; advice.reason = 'Advisor owner is no longer current; outcome unknown';
    }
    return { contract: row?.contract_json ? JSON.parse(row.contract_json) : undefined,
      progress: row?.progress_json ? JSON.parse(row.progress_json) : undefined, advice,
      nextAction: advice?.decision?.action, reason: advice?.reason ?? advice?.decision?.diagnosis };
  }

  /** 운영자의 재개 전환과 같은 트랜잭션에서만 terminal 권고의 적용을 해제한다. */
  operatorResumed(issueId: string): void {
    if (!this.db.inTransaction) throw new Error('Operator recovery must share the run transition transaction');
    const rows = this.db.prepare('SELECT id,data_json FROM automation_advice WHERE issue_id=?').all(issueId) as Array<{ id: string; data_json: string }>;
    for (const row of rows) {
      const advice = JSON.parse(row.data_json) as AdviceRecord;
      if (advice.applied && ['stop', 'ask_operator'].includes(advice.decision?.action ?? '')) {
        this.db.prepare('UPDATE automation_advice SET data_json=? WHERE id=?')
          .run(JSON.stringify({ ...advice, applied: false, reason: 'Operator explicitly resumed this run' }), row.id);
      }
    }
  }

  summary(inScope?: (projectPath: string) => boolean, now = Date.now()) {
    const rows = this.db.prepare(`SELECT r.project_path,p.progress_json,
      r.lease_expires_at>? AND r.state IN ('CLAIMED','EXECUTING','VERIFYING','PUBLISHING')
        AND a.lease_epoch=r.lease_epoch AND a.owner_id=r.owner_instance_id AND a.lease_token=r.lease_token live,
      a.data_json advice FROM automation_runs r JOIN automation_recovery p ON p.issue_id=r.issue_id
      LEFT JOIN automation_advice a ON a.id=(SELECT id FROM automation_advice WHERE issue_id=r.issue_id ORDER BY created_at DESC,rowid DESC LIMIT 1)`)
      .all(now) as Array<{ project_path: string; progress_json: string | null; advice: string | null; live: number }>;
    const result = { tracked: 0, noProgress: 0, advising: 0, adviceCompleted: 0, adviceUnavailable: 0 };
    for (const row of rows) {
      if (inScope && !inScope(row.project_path)) continue;
      result.tracked++;
      const progress = row.progress_json ? JSON.parse(row.progress_json) as ProgressSnapshot : undefined;
      const advice = row.advice ? JSON.parse(row.advice) as AdviceRecord : undefined;
      if ((progress?.consecutiveNoProgress ?? 0) >= 2) result.noProgress++;
      if (advice?.status === 'processing' && row.live) result.advising++;
      if (advice?.status === 'completed') result.adviceCompleted++;
      if (advice && (['unavailable', 'interrupted'].includes(advice.status) || advice.status === 'processing' && !row.live)) result.adviceUnavailable++;
    }
    return result;
  }
}
