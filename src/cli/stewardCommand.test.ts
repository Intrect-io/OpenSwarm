// Created: 2026-11-21
// Purpose: `openswarm steward --dry-run` — fake gh and ledger, temp log (AGT-4803)
// Dependencies: vitest
// Test Status: passing

import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { assertReadOnlyGhArgs, type GhRunner, type StewardLedgerEvidence } from '../automation/mergeStewardSnapshot.js';
import { parsePrRef, registerStewardCommand, runStewardCommand } from './stewardCommand.js';

const REPO = 'acme/widgets';
const HEAD = 'c'.repeat(40);
const BODY = '## Summary\nx\n\n## Risk: low\nok\n\n## Linear\nCloses AGT-1\n';
const LEDGER: StewardLedgerEvidence = { issueId: 'u1', identifier: 'AGT-1', state: 'DONE', headSha: HEAD, changeRiskLevel: 'low' };

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

function harness(opts: Parameters<typeof fakeGh>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'steward-'));
  const logPath = join(dir, 'decisions.jsonl');
  const out: string[] = [];
  const err: string[] = [];
  const fake = fakeGh(opts);
  const deps = {
    gh: fake.gh, ledger: () => LEDGER, logPath,
    out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => new Date('2026-11-21T00:00:00Z'),
  };
  const log = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { deps, out, err, calls: fake.calls, log };
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

  it('registers `steward` with --dry-run in its help', () => {
    const program = new Command();
    registerStewardCommand(program);
    const steward = program.commands.find((c) => c.name() === 'steward');
    expect(steward?.helpInformation()).toContain('--dry-run');
  });
});
