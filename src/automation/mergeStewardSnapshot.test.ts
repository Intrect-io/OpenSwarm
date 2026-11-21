// Created: 2026-11-21
// Purpose: snapshot collector for the merge steward dry run — fake gh, no network (AGT-4803)
// Dependencies: vitest
// Test Status: passing

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateMergeSteward } from './mergeStewardGuards.js';
import {
  StewardSnapshotError,
  assertReadOnlyGhArgs,
  buildStewardSnapshot,
  createLedgerLookup,
  latestChangeRiskLevel,
  mapHeadCheckRuns,
  parseRiskSection,
  reviewEvidence,
  riskEvidence,
  type GhRunner,
  type StewardLedgerEvidence,
} from './mergeStewardSnapshot.js';

const REPO = 'acme/widgets';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const BODY = ['## Summary', 'did it', '', '## Risk: low', '1 file(s), 3 line(s); no high- or medium-risk path.', '', '## Linear', 'Closes AGT-1', ''].join('\n');

const LEDGER: StewardLedgerEvidence = { issueId: 'uuid-1', identifier: 'AGT-1', state: 'DONE', headSha: HEAD, changeRiskLevel: 'low' };

interface FakeOptions {
  view?: Record<string, unknown>;
  headAfter?: string;
  checkRuns?: unknown;
  statuses?: unknown;
  protection?: unknown;
  rules?: unknown;
  reviews?: unknown;
  files?: Record<number, unknown>;
  openPrs?: unknown;
  fail?: RegExp;
}

/** Fake gh keyed on the command; records every call. */
function fakeGh(o: FakeOptions = {}): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push([...args]);
    const cmd = args.join(' ');
    if (o.fail?.test(cmd)) throw new Error(`gh: simulated failure for ${cmd}`);
    const json = (value: unknown) => JSON.stringify(value);
    if (cmd.startsWith('pr view') && cmd.endsWith('headRefOid')) return json({ headRefOid: o.headAfter ?? HEAD });
    if (cmd.startsWith('pr view')) {
      return json({
        number: 7, url: `https://github.com/${REPO}/pull/7`, headRefOid: HEAD, headRefName: 'swarm/AGT-1-thing',
        baseRefName: 'main', title: 'feat: thing', body: BODY, author: { login: 'openswarm-bot' },
        isDraft: false, state: 'OPEN', changedFiles: 1, ...o.view,
      });
    }
    if (cmd.includes('/check-runs')) {
      return json(o.checkRuns ?? { total_count: 1, check_runs: [{ name: 'ci', head_sha: HEAD, status: 'completed', conclusion: 'success' }] });
    }
    if (cmd.includes('/status?')) return json(o.statuses ?? { total_count: 0, statuses: [] });
    if (cmd.includes('/protection/required_status_checks')) {
      if (o.protection === undefined) return json({ contexts: ['ci'], checks: [{ context: 'ci' }] });
      if (o.protection === null) throw new Error('gh: HTTP 404 Branch not protected');
      return json(o.protection);
    }
    if (cmd.includes('/rules/branches/')) return json(o.rules ?? []);
    if (cmd.includes('/reviews')) return json(o.reviews ?? []);
    const files = cmd.match(/pulls\/(\d+)\/files/);
    if (files) {
      const n = Number(files[1]);
      const page = Number(args[1].match(/[?&]page=(\d+)/)?.[1] ?? '1');
      if (page > 1) return json([]);
      return json(o.files?.[n] ?? (n === 7 ? [{ filename: 'src/a.ts' }] : [{ filename: 'src/other.ts' }]));
    }
    if (cmd.startsWith('pr list')) return json(o.openPrs ?? []);
    throw new Error(`unexpected gh call: ${cmd}`);
  };
  return { gh, calls };
}

const build = (o: FakeOptions = {}, ledger: StewardLedgerEvidence | null = LEDGER) => {
  const fake = fakeGh(o);
  return { fake, result: buildStewardSnapshot({ repo: REPO, prNumber: 7, gh: fake.gh, ledger: () => ledger }) };
};

describe('mergeStewardSnapshot: checks and required checks', () => {
  it('maps check runs on the head SHA into required-check inputs, ignoring older SHAs', async () => {
    const mapped = mapHeadCheckRuns([
      { name: 'ci', head_sha: OLD, status: 'completed', conclusion: 'failure' },
      { name: 'ci', head_sha: HEAD, status: 'completed', conclusion: 'success' },
      { name: 'lint', head_sha: HEAD, status: 'in_progress', conclusion: null },
      { name: 'e2e', head_sha: HEAD, status: 'completed', conclusion: 'timed_out' },
    ], HEAD);
    expect(mapped).toEqual([
      { name: 'ci', conclusion: 'success', headSha: HEAD },
      { name: 'lint', conclusion: 'pending', headSha: HEAD },
      { name: 'e2e', conclusion: 'failure', headSha: HEAD },
    ]);

    const { snapshot } = await build({
      checkRuns: { total_count: 2, check_runs: [
        { name: 'ci', head_sha: OLD, status: 'completed', conclusion: 'failure' },
        { name: 'ci', head_sha: HEAD, status: 'completed', conclusion: 'success' },
      ] },
    }).result;
    expect(snapshot.requiredChecks).toEqual(['ci']);
    expect(snapshot.checks).toEqual([{ name: 'ci', conclusion: 'success', headSha: HEAD }]);
    expect(evaluateMergeSteward(snapshot).results.find((r) => r.guard === 'required-checks')?.pass).toBe(true);
  });

  it('a truncated check-run list counts nothing as green', async () => {
    const { snapshot, notes } = await build({ checkRuns: { total_count: 150, check_runs: [{ name: 'ci', head_sha: HEAD, status: 'completed', conclusion: 'success' }] } }).result;
    expect(snapshot.checks).toEqual([]);
    expect(notes.join('\n')).toMatch(/truncated/);
    expect(evaluateMergeSteward(snapshot).mergeable).toBe(false);
  });

  it('unions branch protection with rulesets, and falls back to every head check when neither is readable', async () => {
    const union = await build({ rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }] }).result;
    expect(union.snapshot.requiredChecks.sort()).toEqual(['build', 'ci']);
    expect(evaluateMergeSteward(union.snapshot).results[0].reason).toMatch(/build: missing/);

    const fallback = await build({ protection: null, fail: /rules\/branches/ }).result;
    expect(fallback.snapshot.requiredChecks).toEqual(['ci']);
    expect(fallback.notes.join('\n')).toMatch(/treating all 1 check\(s\) as required/);
  });

  it('when one source is unreadable, every head check is required too (no subset)', async () => {
    const { snapshot } = await build({
      protection: null,
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }],
      checkRuns: { total_count: 2, check_runs: [
        { name: 'build', head_sha: HEAD, status: 'completed', conclusion: 'success' },
        { name: 'ci', head_sha: HEAD, status: 'completed', conclusion: 'failure' },
      ] },
    }).result;
    expect(snapshot.requiredChecks.sort()).toEqual(['build', 'ci']);
    expect(evaluateMergeSteward(snapshot).mergeable).toBe(false);
  });

  it('REST reads project their fields with --jq', async () => {
    const { fake, result } = build({ openPrs: [{ number: 8, headRefName: 'swarm/AGT-2-other', changedFiles: 1 }] });
    await result;
    const rest = fake.calls.filter((c) => c[0] === 'api' && /check-runs|\/status\?|\/reviews|\/files/.test(c[1]));
    expect(rest.length).toBeGreaterThanOrEqual(5);
    for (const call of rest) expect(call.slice(2, 3)).toEqual(['--jq']);
  });

  it('commit statuses on the head count as checks', async () => {
    const { snapshot } = await build({ statuses: { total_count: 1, statuses: [{ context: 'legacy/ci', state: 'error' }] }, protection: { contexts: ['legacy/ci'] } }).result;
    expect(snapshot.checks).toContainEqual({ name: 'legacy/ci', conclusion: 'failure', headSha: HEAD });
    expect(evaluateMergeSteward(snapshot).mergeable).toBe(false);
  });
});

describe('mergeStewardSnapshot: siblings, files and reviews', () => {
  it('marks a sibling overlap when an open swarm PR touches the same file', async () => {
    const { snapshot } = await build({
      openPrs: [
        { number: 7, headRefName: 'swarm/AGT-1-thing', changedFiles: 1 },
        { number: 8, headRefName: 'swarm/AGT-2-other', changedFiles: 2 },
        { number: 9, headRefName: 'feature/human', changedFiles: 1 },
      ],
      files: { 8: [{ filename: 'src/b.ts' }, { filename: 'src/a2.ts', previous_filename: 'src/a.ts' }], 9: [{ filename: 'src/a.ts' }] },
    }).result;
    // Only swarm/* siblings, never the PR itself; the rename's old path counts.
    expect(snapshot.siblings?.map((s) => s.number)).toEqual([8]);
    expect(snapshot.siblings?.[0]).toMatchObject({ complete: true });
    const decision = evaluateMergeSteward(snapshot);
    const overlap = decision.results.find((r) => r.guard === 'sibling-overlap');
    expect(overlap?.pass).toBe(false);
    expect(overlap?.reason).toContain('#8 (swarm/AGT-2-other) also touches src/a.ts');
    expect(decision.mergeable).toBe(false);
  });

  it('no overlap with an unrelated sibling: every guard passes', async () => {
    const { snapshot } = await build({ openPrs: [{ number: 8, headRefName: 'swarm/AGT-2-other', changedFiles: 1 }] }).result;
    expect(evaluateMergeSteward(snapshot).mergeable).toBe(true);
  });

  it('a sibling whose files cannot be read is kept as unknown, and a failed list is null', async () => {
    const partial = await build({ openPrs: [{ number: 8, headRefName: 'swarm/AGT-2-other', changedFiles: 1 }], fail: /pulls\/8\/files/ }).result;
    expect(partial.snapshot.siblings).toEqual([{ number: 8, headRefName: 'swarm/AGT-2-other', files: null, complete: false }]);
    expect(evaluateMergeSteward(partial.snapshot).mergeable).toBe(false);
    const failed = await build({ fail: /^pr list/ }).result;
    expect(failed.snapshot.siblings).toBeNull();
    expect(evaluateMergeSteward(failed.snapshot).mergeable).toBe(false);
  });

  it('a file count that does not match changedFiles is incomplete', async () => {
    const { snapshot } = await build({ view: { changedFiles: 3 } }).result;
    expect(snapshot.complete).toBe(false);
    expect(evaluateMergeSteward(snapshot).mergeable).toBe(false);
  });

  it('maps REST reviews with user type and commit id', async () => {
    const { snapshot } = await build({ reviews: [{ user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-11-21T00:00:00Z' }] }).result;
    expect(snapshot.prReviews).toEqual([{ login: 'alice', userType: 'User', state: 'APPROVED', commitId: HEAD, submittedAt: '2026-11-21T00:00:00Z' }]);
  });
});

describe('mergeStewardSnapshot: gh failures refuse', () => {
  it('a gh failure yields a refusal', async () => {
    for (const fail of [/check-runs/, /\/reviews/, /pulls\/7\/files/, /^pr list/]) {
      const { snapshot } = await build({ fail, view: { body: BODY.replace('## Risk: low', '## Risk: medium') } }, { ...LEDGER, changeRiskLevel: null }).result;
      expect(evaluateMergeSteward(snapshot).mergeable, String(fail)).toBe(false);
    }
  });

  it('an unreadable PR, a closed PR or a head that moved throws StewardSnapshotError', async () => {
    await expect(build({ fail: /^pr view 7 -R acme\/widgets --json number/ }).result).rejects.toBeInstanceOf(StewardSnapshotError);
    await expect(build({ view: { state: 'MERGED' } }).result).rejects.toThrow(/not open/);
    await expect(build({ view: { headRefOid: '' } }).result).rejects.toThrow(/no readable head/);
    await expect(build({ headAfter: OLD }).result).rejects.toThrow(/head moved/);
  });

  it('the injected runner is only ever called with read-only commands', async () => {
    const { fake, result } = build({ openPrs: [{ number: 8, headRefName: 'swarm/AGT-2-other', changedFiles: 1 }] });
    await result;
    for (const call of fake.calls) expect(() => assertReadOnlyGhArgs(call)).not.toThrow();
  });
});

describe('mergeStewardSnapshot: risk and reviewer fallbacks', () => {
  it('risk comes from the ledger, then the body, bound to the published head; unknown is medium', () => {
    expect(riskEvidence(LEDGER, BODY, HEAD).risk).toEqual({ level: 'low', headSha: HEAD });
    expect(riskEvidence({ ...LEDGER, changeRiskLevel: null }, BODY.replace('low', 'high'), HEAD).risk).toEqual({ level: 'high', headSha: HEAD });
    expect(riskEvidence({ ...LEDGER, changeRiskLevel: 'bogus' }, 'no section', HEAD).risk).toEqual({ level: 'medium', headSha: HEAD });
    // Published on OLD, PR now at HEAD: the engine sees a stale class.
    expect(riskEvidence({ ...LEDGER, headSha: OLD }, BODY, HEAD).risk.headSha).toBe(OLD);
  });

  it('takes the stricter of the stored class and the body (a later attempt may not have recorded one)', () => {
    expect(riskEvidence({ ...LEDGER, changeRiskLevel: 'low' }, BODY.replace('## Risk: low', '## Risk: high'), HEAD).risk.level).toBe('high');
    expect(riskEvidence({ ...LEDGER, changeRiskLevel: 'medium' }, BODY, HEAD).risk.level).toBe('medium');
  });

  it('without a ledger row the risk is never low', () => {
    expect(riskEvidence(null, BODY, HEAD).risk).toEqual({ level: 'medium', headSha: HEAD });
    expect(riskEvidence(null, BODY.replace('low', 'high'), HEAD).risk.level).toBe('high');
    expect(riskEvidence(null, '', HEAD).risk.level).toBe('medium');
  });

  it('parses the risk heading across CRLF bodies and reads the newest stored class', () => {
    expect(parseRiskSection('## Summary\r\nx\r\n## Risk: high\r\n- ci')).toBe('high');
    expect(parseRiskSection('Risk: low')).toBeNull();
    expect(latestChangeRiskLevel([null, '{"changeRisk":{"level":"high"}}', '{"changeRisk":{"level":"low"}}'])).toBe('high');
    expect(latestChangeRiskLevel(['not json', '{}'])).toBeNull();
  });

  it('reviewer verdict: Closes on a non-partial, non-draft PR bound to the ledger head; otherwise missing or unknown', () => {
    const pr = { body: BODY, title: 'feat: thing', isDraft: false };
    expect(reviewEvidence(LEDGER, pr)).toMatchObject({ review: { verdict: 'approve', headSha: HEAD }, completeness: { verdict: 'complete', headSha: HEAD } });
    expect(reviewEvidence(null, pr)).toMatchObject({ review: null, completeness: null });
    expect(reviewEvidence(LEDGER, { ...pr, isDraft: true }).review?.verdict).toBe('unknown');
    expect(reviewEvidence(LEDGER, { ...pr, title: '[partial] feat: thing' }).completeness?.verdict).toBe('partial');
    expect(reviewEvidence(LEDGER, { ...pr, body: BODY.replace('Closes AGT-1', 'Refs AGT-1') })).toMatchObject({ review: { verdict: 'unknown' }, completeness: { verdict: 'partial' } });
    expect(reviewEvidence(LEDGER, { ...pr, body: BODY.replace('Closes AGT-1', 'Closes AGT-99') }).review?.verdict).toBe('unknown');
  });

  it('a run that was not cleanly published (e.g. a review rollback) proves no approval, whatever the body says', () => {
    const pr = { body: BODY, title: 'feat: thing', isDraft: false };
    for (const state of ['NEEDS_RECONCILE', 'NEEDS_HUMAN', 'PUBLISHING', 'RETRY_AT']) {
      expect(reviewEvidence({ ...LEDGER, state }, pr).review?.verdict, state).toBe('unknown');
    }
    expect(reviewEvidence({ ...LEDGER, state: 'SYNC_PENDING' }, pr).review?.verdict).toBe('approve');
  });

  it('a PR with no ledger row is refused for want of a reviewer verdict', async () => {
    const { snapshot } = await build({}, null).result;
    const decision = evaluateMergeSteward(snapshot);
    expect(decision.mergeable).toBe(false);
    expect(decision.blockedBy.join('\n')).toMatch(/no reviewer verdict recorded/);
    expect(decision.blockedBy.join('\n')).toMatch(/risk is medium/);
  });
});

describe('ledger lookup (read-only SQLite)', () => {
  const makeDb = async () => {
    const { default: Database } = await import('better-sqlite3');
    const path = join(mkdtempSync(join(tmpdir(), 'steward-ledger-')), 'automation.db');
    const db = new Database(path);
    db.exec(`CREATE TABLE automation_runs (issue_id TEXT PRIMARY KEY, identifier TEXT, state TEXT NOT NULL, pr_url TEXT, head_sha TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE automation_attempts (issue_id TEXT NOT NULL, attempt_no INTEGER NOT NULL, result_json TEXT);`);
    db.prepare('INSERT INTO automation_runs VALUES (?, ?, ?, ?, ?, ?)').run('u1', 'AGT-1', 'DONE', 'https://github.com/acme/widgets/pull/7', HEAD, 1);
    db.prepare('INSERT INTO automation_attempts VALUES (?, ?, ?)').run('u1', 1, JSON.stringify({ changeRisk: { level: 'high' } }));
    db.prepare('INSERT INTO automation_attempts VALUES (?, ?, ?)').run('u1', 2, JSON.stringify({ thrown: true }));
    db.close();
    return path;
  };

  it('reads the run bound to the PR URL and the newest stored risk class', async () => {
    const lookup = createLedgerLookup(await makeDb());
    expect(await lookup('https://github.com/acme/widgets/pull/7')).toEqual({
      issueId: 'u1', identifier: 'AGT-1', state: 'DONE', headSha: HEAD, changeRiskLevel: 'high',
    });
    expect(await lookup('https://github.com/acme/widgets/pull/8')).toBeNull();
  });

  it('a missing database is no evidence; a broken one is reported as unreadable', async () => {
    expect(await createLedgerLookup(join(tmpdir(), 'steward-no-such-dir', 'x.db'))('u')).toBeNull();
    const broken = join(mkdtempSync(join(tmpdir(), 'steward-broken-')), 'automation.db');
    writeFileSync(broken, 'not a database');
    await expect(createLedgerLookup(broken)('u')).rejects.toThrow();
    const fake = fakeGh();
    const { notes, snapshot } = await buildStewardSnapshot({ repo: REPO, prNumber: 7, gh: fake.gh, ledger: createLedgerLookup(broken) });
    expect(notes.join('\n')).toMatch(/ledger unreadable/);
    expect(snapshot.review).toBeNull();
  });
});

describe('read-only gh allowlist', () => {
  it('refuses merge, writes and unknown subcommands', () => {
    for (const args of [
      ['pr', 'merge', '7'], ['pr', 'edit', '7'], ['pr', 'review', '7', '--approve'],
      ['api', '-X', 'PUT', 'repos/a/b/pulls/7/merge'], ['api', '--method=PUT', 'repos/a/b/x'], ['api', '-XPOST', 'x'],
      ['api', 'repos/a/b/pulls/7/merge'], ['api', 'repos/a/b/merges'], ['api', '-f', 'x=1', 'repos/a/b/x'], ['api', '--input', 'f', 'x'],
    ]) {
      expect(() => assertReadOnlyGhArgs(args), args.join(' ')).toThrow();
    }
    expect(() => assertReadOnlyGhArgs(['api', `repos/a/b/commits/${HEAD}/check-runs?per_page=100`])).not.toThrow();
    expect(() => assertReadOnlyGhArgs(['pr', 'list', '-R', 'a/b', '--state', 'open'])).not.toThrow();
  });
});

describe('no code path that could merge', () => {
  it('has no code path that could merge: the collector and the steward command import nothing that can', () => {
    for (const rel of ['./mergeStewardSnapshot.ts', '../cli/stewardCommand.ts']) {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      const imports = source.match(/(?:^\s*import\s[^;]*?from\s+'[^']+'|import\('[^']+'\))/gm) ?? [];
      const allowed = [
        "'./mergeStewardGuards.js'", "'../support/branchNaming.js'", "'better-sqlite3'",
        "'commander'", "'node:fs'", "'node:os'", "'node:path'",
        "'../automation/mergeStewardSnapshot.js'", "'../automation/mergeStewardGuards.js'",
        "'../automation/automationDbPath.js'", "'../support/ghPullRequests.js'",
      ];
      for (const line of imports) expect(allowed.some((mod) => line.includes(mod)), `${rel}: ${line}`).toBe(true);
      expect(source, rel).not.toMatch(/child_process|execFile|spawn\(|fetch\(|octokit|github\/github|gh pr merge|'merge'|\bmergePullRequest|\bmergePR\b/i);
    }
    // The one process-spawning dependency (the default runner, behind the allowlist) has no merge verb either.
    const ghModule = readFileSync(fileURLToPath(new URL('../support/ghPullRequests.ts', import.meta.url)), 'utf8');
    expect(ghModule).not.toMatch(/'merge'|"merge"|pr merge|\/merges?\b'/);
  });
});
