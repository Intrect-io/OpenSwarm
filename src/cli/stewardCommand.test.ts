// Created: 2026-11-21
// Purpose: `openswarm steward --dry-run` — fake gh and ledger, temp log (AGT-4803)
// Dependencies: vitest
// Test Status: passing

import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { assertReadOnlyGhArgs, type GhRunner, type StewardLedgerEvidence } from '../automation/mergeStewardSnapshot.js';
import type { StewardVerdictRecord } from '../automation/stewardVerdictLedger.js';
import { parsePrRef, registerStewardCommand, runStewardCommand } from './stewardCommand.js';

const REPO = 'acme/widgets';
const HEAD = 'c'.repeat(40);
const BODY = '## Summary\nx\n\n## Risk: low\nok\n\n## Linear\nCloses AGT-1\n';
const LEDGER: StewardLedgerEvidence = { issueId: 'u1', identifier: 'AGT-1', state: 'DONE', headSha: HEAD, changeRiskLevel: 'low' };
const VERDICT: StewardVerdictRecord = { prUrl: `https://github.com/${REPO}/pull/5`, reviewedSha: HEAD, verdict: 'approve', coverage: null, recordedAt: '2026-11-21T00:00:00.000Z' };

function fakeGh(opts: { failView?: boolean; failingCheck?: boolean } = {}): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push([...args]);
    const cmd = args.join(' ');
    const json = (v: unknown) => JSON.stringify(v);
    if (cmd.startsWith('repo view')) return json({ nameWithOwner: REPO });
    if (cmd.startsWith('pr view')) {
      if (opts.failView) throw new Error('gh: HTTP 502');
      return json({
        number: 5, url: `https://github.com/${REPO}/pull/5`, headRefOid: HEAD, headRefName: 'swarm/AGT-1-x', baseRefName: 'main',
        title: 'feat: x', body: BODY, author: { login: 'bot' }, isDraft: false, state: 'OPEN', changedFiles: 1,
      });
    }
    if (cmd.includes('/check-runs')) {
      return json({ total_count: 1, check_runs: [{ name: 'ci', head_sha: HEAD, status: 'completed', conclusion: opts.failingCheck ? 'failure' : 'success' }] });
    }
    if (cmd.includes('/status?')) return json({ total_count: 0, statuses: [] });
    if (cmd.includes('/protection/')) return json({ contexts: ['ci'] });
    if (cmd.includes('/rules/')) return json([]);
    if (cmd.includes('/reviews')) return json([]);
    if (cmd.includes('/files')) return json(/[?&]page=1(?:&|$)/.test(args[1]) ? [{ filename: 'src/x.ts' }] : []);
    if (cmd.startsWith('pr list')) return json([]);
    throw new Error(`unexpected gh call: ${cmd}`);
  };
  return { gh, calls };
}

const harnessDirs: string[] = [];
afterEach(() => {
  for (const dir of harnessDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(opts: Parameters<typeof fakeGh>[0] = {}, grant: Record<string, unknown> | null = { [REPO]: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'steward-'));
  harnessDirs.push(dir);
  const logPath = join(dir, 'decisions.jsonl');
  const mergeGrantsPath = join(dir, 'merge-grants.json');
  if (grant !== null) writeFileSync(mergeGrantsPath, JSON.stringify(grant));
  const out: string[] = [];
  const err: string[] = [];
  const fake = fakeGh(opts);
  const deps = {
    gh: fake.gh, ledger: () => LEDGER, verdictLookup: () => VERDICT, logPath, mergeGrantsPath,
    out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => new Date('2026-11-21T00:00:00Z'),
  };
  const log = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { deps, out, err, calls: fake.calls, log, dir, mergeGrantsPath };
}

describe('openswarm steward', () => {
  it('dry-run prints the decision and never calls merge', async () => {
    const h = harness();
    const code = await runStewardCommand('5', { dryRun: true, repo: REPO }, h.deps);
    expect(code).toBe(0);
    expect(h.out[0]).toMatch(/^\[steward dry-run\] PR #5 @ cccccccccccc: would merge/);
    expect(h.log()).toEqual([expect.objectContaining({ prNumber: 5, headSha: HEAD, mergeable: true, dryRun: true, repo: REPO, at: '2026-11-21T00:00:00.000Z' })]);
    expect(h.calls.length).toBeGreaterThan(0);
    for (const call of h.calls) {
      expect(call.join(' ')).not.toMatch(/merge/i);
      expect(() => assertReadOnlyGhArgs(call)).not.toThrow();
    }
  });

  it('a refusal is still a successful dry run (exit 0) and is logged', async () => {
    const h = harness({ failingCheck: true });
    expect(await runStewardCommand(`https://github.com/${REPO}/pull/5`, { dryRun: true }, h.deps)).toBe(0);
    expect(h.out[0]).toContain('would NOT merge');
    expect(h.out[0]).toContain('required-checks');
    expect(h.log()[0]).toMatchObject({ mergeable: false });
  });

  it('a gh failure yields a refusal: printed and logged as REFUSE, exit non-zero', async () => {
    const h = harness({ failView: true });
    expect(await runStewardCommand('5', { dryRun: true, repo: REPO }, h.deps)).toBe(1);
    expect(h.out[0]).toMatch(/^\[steward dry-run\] PR #5: REFUSE — cannot read PR #5/);
    expect(h.log()[0]).toMatchObject({ prNumber: 5, mergeable: false, dryRun: true });
  });

  it('a decision that cannot be logged exits non-zero', async () => {
    const h = harness();
    const blocker = join(mkdtempSync(join(tmpdir(), 'steward-')), 'file');
    writeFileSync(blocker, '');
    expect(await runStewardCommand('5', { dryRun: true, repo: REPO }, { ...h.deps, logPath: join(blocker, 'decisions.jsonl') })).toBe(1);
    expect(h.out[0]).toContain('would merge');
    expect(h.err.join('\n')).toMatch(/could not append/);
  });

  it('without --dry-run it says only dry-run is supported and exits non-zero', async () => {
    const h = harness();
    expect(await runStewardCommand('5', { repo: REPO }, h.deps)).toBe(2);
    expect(h.err.join('\n')).toMatch(/only --dry-run is supported/);
    expect(h.calls).toEqual([]);
    expect(h.log()).toEqual([]);
  });

  it('usage errors exit non-zero without touching gh', async () => {
    const h = harness();
    expect(await runStewardCommand(undefined, { dryRun: true }, h.deps)).toBe(2);
    expect(await runStewardCommand('abc', { dryRun: true }, h.deps)).toBe(2);
    expect(await runStewardCommand(`https://github.com/${REPO}/pull/5`, { dryRun: true, repo: 'other/repo' }, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('resolves the repository read-only when only a number is given', async () => {
    const h = harness();
    expect(await runStewardCommand('#5', { dryRun: true }, h.deps)).toBe(0);
    expect(h.calls[0]).toEqual(['repo', 'view', '--json', 'nameWithOwner']);
  });

  it('parses PR references', () => {
    expect(parsePrRef('https://github.com/a/b/pull/12/files')).toEqual({ repo: 'a/b', prNumber: 12 });
    expect(parsePrRef('12', 'a/b')).toEqual({ repo: 'a/b', prNumber: 12 });
    expect(() => parsePrRef('0')).toThrow();
    expect(() => parsePrRef('1', 'not-a-repo')).toThrow(/owner\/name/);
  });

  it('PR opened -> no merge without the grant', async () => {
    // Open, non-draft PR with green checks and complete review evidence; no grants file.
    const denied = harness({}, null);
    try {
      expect(existsSync(denied.mergeGrantsPath)).toBe(false);
      expect(await runStewardCommand('5', { dryRun: true, repo: REPO }, denied.deps)).toBe(0);
      expect(denied.out[0]).toContain('would NOT merge');
      expect(denied.out[0]).toContain('merge-grant: no operator merge grant: no grants file at');
      expect(denied.out[1]).toBe(`[steward audit] repo=${REPO} pr=#5 head=${HEAD} ci=pass review=pass grant=fail`);
      expect(denied.log()[0]).toMatchObject({ mergeable: false, audit: denied.out[1] });
      expect(denied.log()[0].results.filter((r: { pass: boolean }) => !r.pass).map((r: { guard: string }) => r.guard)).toEqual(['merge-grant']);
    } finally {
      rmSync(denied.dir, { recursive: true, force: true });
    }

    // The same PR once the operator grants the repository (key case does not matter).
    const granted = harness({}, { 'ACME/Widgets': true });
    try {
      expect(await runStewardCommand('5', { dryRun: true, repo: REPO }, granted.deps)).toBe(0);
      expect(granted.out[0]).toContain('would merge');
      expect(granted.out[1]).toBe(`[steward audit] repo=${REPO} pr=#5 head=${HEAD} ci=pass review=pass grant=pass`);
      expect(granted.log()[0]).toMatchObject({ mergeable: true, audit: granted.out[1] });
    } finally {
      rmSync(granted.dir, { recursive: true, force: true });
    }
  });

  it('reads OPENSWARM_MERGE_GRANTS when no grants path is injected', async () => {
    const h = harness({}, { [REPO]: true });
    const deps = { ...h.deps, mergeGrantsPath: undefined };
    const previous = process.env.OPENSWARM_MERGE_GRANTS;
    process.env.OPENSWARM_MERGE_GRANTS = h.mergeGrantsPath;
    try {
      expect(await runStewardCommand('5', { dryRun: true, repo: REPO }, deps)).toBe(0);
      expect(h.out[1]).toContain('grant=pass');
    } finally {
      if (previous === undefined) delete process.env.OPENSWARM_MERGE_GRANTS;
      else process.env.OPENSWARM_MERGE_GRANTS = previous;
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('a REFUSE also prints and logs an audit line with every guard failing', async () => {
    const h = harness({ failView: true });
    expect(await runStewardCommand('5', { dryRun: true, repo: REPO }, h.deps)).toBe(1);
    expect(h.out[1]).toBe(`[steward audit] repo=${REPO} pr=#5 head=unknown ci=fail review=fail grant=fail`);
    expect(h.log()[0]).toMatchObject({ audit: h.out[1] });
  });

  it('registers `steward` with --dry-run in its help', () => {
    const program = new Command();
    registerStewardCommand(program);
    const steward = program.commands.find((c) => c.name() === 'steward');
    expect(steward?.helpInformation()).toContain('--dry-run');
  });
});
