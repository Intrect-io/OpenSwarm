// Created: 2026-11-21
// Purpose: merge steward executor — gates, guards, audit trail, the single pinned write, and the repo-wide merge-write scan (AGT-4803)
// Dependencies: vitest, node:fs, node:os, node:path, node:url
// Test Status: passing

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { assertReadOnlyGhArgs, type GhRunner, type StewardLedgerEvidence } from './mergeStewardSnapshot.js';
import type { StewardVerdictRecord } from './stewardVerdictLedger.js';
import type { StewardConfig, StewardConfigLoad } from './stewardConfig.js';
import { evaluateMergeSteward } from './mergeStewardGuards.js';
import {
  appendStewardMergeAudit,
  buildStewardGhEnv,
  executeStewardMerge,
  isRunnerInterrupted,
  runStewardMergeWithGates,
  STEWARD_MERGE_GATES,
  stewardMergeArgs,
  stewardMergeLogPath,
  stewardToken,
  type StewardMergeAuditEntry,
  type StewardMergeDeps,
} from './mergeStewardExecutor.js';

const REPO = 'acme/widgets';
const PR = 5;
const HEAD = 'c'.repeat(40);
const TOKEN = 'steward-secret-token-value';
const TOKEN_ENV = 'OPENSWARM_STEWARD_GH_TOKEN';
const BODY = '## Summary\nx\n\n## Risk: low\nok\n\n## Linear\nCloses AGT-1\n';
const LEDGER: StewardLedgerEvidence = { issueId: 'u1', identifier: 'AGT-1', state: 'DONE', headSha: HEAD, changeRiskLevel: 'low' };
const VERDICT: StewardVerdictRecord = { prUrl: `https://github.com/${REPO}/pull/${PR}`, reviewedSha: HEAD, verdict: 'approve', coverage: null, recordedAt: '2026-11-21T00:00:00.000Z' };

/** Fake read-only gh: one open PR, green `ci`, no siblings. Throws on anything unexpected. */
function fakeGh(opts: { failingCheck?: boolean } = {}): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push([...args]);
    assertReadOnlyGhArgs(args);
    const cmd = args.join(' ');
    const json = (v: unknown) => JSON.stringify(v);
    if (cmd.startsWith('pr view')) {
      return json({
        number: PR, url: `https://github.com/${REPO}/pull/${PR}`, headRefOid: HEAD, headRefName: 'swarm/AGT-1-x', baseRefName: 'main',
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

function config(over: Partial<StewardConfig> = {}): StewardConfigLoad {
  return {
    config: { mergeEnabled: true, automationAccounts: ['openswarm-bot'], tokenEnv: TOKEN_ENV, mergeMethod: 'squash', ...over },
    source: 'file', reason: 'test config', path: '/fake/config.json',
  };
}

interface HarnessOptions {
  config?: Partial<StewardConfig>;
  env?: NodeJS.ProcessEnv;
  granted?: boolean;
  failingCheck?: boolean;
  writeResult?: string | Error;
  appendFails?: (entry: StewardMergeAuditEntry) => boolean;
}

function harness(opts: HarnessOptions = {}) {
  const fake = fakeGh({ failingCheck: opts.failingCheck });
  const audit: StewardMergeAuditEntry[] = [];
  const writes: Array<{ args: readonly string[]; token: string }> = [];
  const deps: StewardMergeDeps = {
    loadConfig: () => config(opts.config),
    env: opts.env ?? { [TOKEN_ENV]: TOKEN },
    readGrant: (repo) => ({ granted: opts.granted ?? true, reason: `${repo} test grant`, path: '/fake/grants.json' }),
    gh: fake.gh,
    ledger: () => LEDGER,
    verdictLookup: () => VERDICT,
    writeRunner: async (args, token) => {
      writes.push({ args: [...args], token });
      const r = opts.writeResult ?? JSON.stringify({ merged: true, sha: 'd'.repeat(40), message: 'Pull Request successfully merged' });
      if (r instanceof Error) throw r;
      return r;
    },
    appendAudit: (entry) => {
      if (opts.appendFails?.(entry)) throw new Error('EROFS: read-only file system');
      audit.push(entry);
    },
    now: () => new Date('2026-11-21T00:00:00Z'),
  };
  return { deps, audit, writes, calls: fake.calls };
}

describe('merge steward executor gates', () => {
  it('refuses to merge when mergeEnabled is not true', async () => {
    const h = harness({ config: { mergeEnabled: false } });
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps });
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/mergeEnabled is not true/);
    expect(h.writes).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ event: 'refused', repo: REPO, prNumber: PR });
    expect(h.audit[0].audit).toBe(`[steward audit] repo=${REPO} pr=#${PR} head=unknown ci=fail review=fail grant=fail`);
  });

  it('refuses to merge when the steward token env is unset, with no ambient fallback', async () => {
    const h = harness({ env: { GH_TOKEN: 'ambient-gh', GITHUB_TOKEN: 'ambient-github', PATH: '/usr/bin' } });
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps });
    expect(result.status).toBe('refused');
    expect(result.reason).toContain(TOKEN_ENV);
    expect(result.reason).toMatch(/no ambient fallback/);
    expect(h.writes).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.audit.map((e) => e.event)).toEqual(['refused']);
    expect(JSON.stringify(h.audit)).not.toMatch(/ambient-gh|ambient-github/);
  });

  it.each([
    'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_PAT',
  ])('refuses a config whose tokenEnv names the ambient %s, even when it is set', async (name) => {
    const h = harness({ config: { tokenEnv: name }, env: { [name]: 'ambient-secret' } });
    expect(stewardToken(config({ tokenEnv: name }).config, { [name]: 'ambient-secret' })).toBeNull();
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps });
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/ambient GitHub token variable/);
    expect(h.writes).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(JSON.stringify(h.audit)).not.toContain('ambient-secret');
  });

  it('the token reader refuses an ambient tokenEnv even without the steward-token gate', async () => {
    const h = harness({ config: { tokenEnv: 'GH_TOKEN' }, env: { GH_TOKEN: 'ambient-secret' } });
    const without = STEWARD_MERGE_GATES.filter((gate) => gate.name !== 'steward-token');
    const result = await runStewardMergeWithGates({ repo: REPO, prNumber: PR, deps: h.deps }, without);
    expect(result.status).toBe('refused');
    expect(h.writes).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('a config loader that throws is an audited refusal', async () => {
    const h = harness();
    const deps: StewardMergeDeps = { ...h.deps, loadConfig: () => { throw new Error('EACCES: permission denied'); } };
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps });
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/steward config could not be loaded: EACCES/);
    expect(h.writes).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.audit.map((e) => e.event)).toEqual(['refused']);
  });

  it('treats a blank steward token as unset', async () => {
    const h = harness({ env: { [TOKEN_ENV]: '   ' } });
    expect((await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps })).status).toBe('refused');
    expect(h.writes).toEqual([]);
  });

  it('refuses to merge without the operator merge grant', async () => {
    const h = harness({ granted: false });
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps });
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/no operator merge grant/);
    expect(h.writes).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.audit).toHaveLength(1);
  });

  it('refuses an invalid repository or PR number before reading anything', async () => {
    const h = harness();
    expect((await executeStewardMerge({ repo: 'not a repo', prNumber: PR, deps: h.deps })).status).toBe('refused');
    expect((await executeStewardMerge({ repo: REPO, prNumber: 0, deps: h.deps })).status).toBe('refused');
    expect(h.writes).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('the mergeEnabled gate is what refuses: the same PR merges once that gate is removed', async () => {
    const off = harness({ config: { mergeEnabled: false } });
    const refused = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: off.deps });
    expect(refused.status).toBe('refused');
    expect(off.writes).toEqual([]);

    const without = STEWARD_MERGE_GATES.filter((gate) => gate.name !== 'merge-enabled');
    expect(without).toHaveLength(STEWARD_MERGE_GATES.length - 1);
    const same = harness({ config: { mergeEnabled: false } });
    const merged = await runStewardMergeWithGates({ repo: REPO, prNumber: PR, deps: same.deps }, without);
    expect(merged.status).toBe('merged');
    expect(same.writes).toHaveLength(1);
  });
});

describe('merge steward executor write', () => {
  it('merges with the head SHA pinned and writes one audit line', async () => {
    const h = harness();
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps });
    expect(result).toMatchObject({ status: 'merged', repo: REPO, prNumber: PR, headSha: HEAD });
    expect(result.auditError).toBeUndefined();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].args).toEqual(['api', '-X', 'PUT', `repos/${REPO}/pulls/${PR}/merge`, '-f', `sha=${HEAD}`, '-f', 'merge_method=squash']);
    expect(h.writes[0].token).toBe(TOKEN);
    for (const arg of h.writes[0].args) expect(arg).not.toMatch(/^--(?:admin|auto|force)$/);
    // The code defines exactly two lines for a write: one intent, one result.
    expect(h.audit.map((e) => e.event)).toEqual(['intent', 'result']);
    expect(h.audit[1]).toMatchObject({ outcome: 'merged', headSha: HEAD, mergeMethod: 'squash' });
    expect(h.audit[0].audit).toBe(`[steward audit] repo=${REPO} pr=#${PR} head=${HEAD} ci=pass review=pass grant=pass`);
    expect(JSON.stringify(h.audit)).not.toContain(TOKEN);
    expect(JSON.stringify(h.audit)).not.toMatch(/dryRun/);
    for (const call of h.calls) expect(() => assertReadOnlyGhArgs(call)).not.toThrow();
  });

  it('takes automation accounts only from the config and uses its merge method', async () => {
    const h = harness({ config: { mergeMethod: 'rebase', automationAccounts: ['factory-a', 'factory-b'] } });
    const seen: Array<readonly string[]> = [];
    const deps: StewardMergeDeps = {
      ...h.deps,
      buildSnapshot: async (req) => {
        seen.push(req.automationAccounts);
        const { buildStewardSnapshot } = await import('./mergeStewardSnapshot.js');
        return buildStewardSnapshot({ repo: req.repo, prNumber: req.prNumber, gh: fakeGh().gh, ledger: () => LEDGER, verdictLookup: () => VERDICT, automationAccounts: req.automationAccounts, readGrant: req.readGrant });
      },
    };
    expect((await executeStewardMerge({ repo: REPO, prNumber: PR, deps })).status).toBe('merged');
    expect(seen).toEqual([['factory-a', 'factory-b']]);
    expect(h.writes[0].args).toContain('merge_method=rebase');
  });

  it('a failing guard refuses without writing', async () => {
    const h = harness({ failingCheck: true });
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps });
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/required-checks/);
    expect(h.writes).toEqual([]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ event: 'refused', headSha: HEAD });
    expect(h.audit[0].blockedBy?.[0]).toMatch(/^required-checks/);
    expect(h.audit[0].audit).toContain('ci=fail');
  });

  it('a snapshot failure is infra and never writes', async () => {
    const h = harness();
    const deps: StewardMergeDeps = { ...h.deps, buildSnapshot: async () => { throw new Error('gh: HTTP 502'); } };
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps });
    expect(result.status).toBe('infra');
    expect(h.writes).toEqual([]);
    expect(h.audit.map((e) => e.event)).toEqual(['infra']);
  });

  it('an audit append failure refuses before the write', async () => {
    const h = harness({ appendFails: (entry) => entry.event === 'intent' });
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps });
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/no write without an audit trail/);
    expect(h.writes).toEqual([]);
  });

  it('a write failure returns infra/failed with no retry', async () => {
    const h = harness({ writeResult: new Error(`HTTP 405: Pull Request is not mergeable (token ${TOKEN})`) });
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps });
    expect(result.status).toBe('infra');
    expect(result.reason).toMatch(/merge write failed, not retried/);
    expect(result.reason).not.toContain(TOKEN);
    expect(h.writes).toHaveLength(1);
    expect(h.audit.map((e) => e.event)).toEqual(['intent', 'result']);
    expect(h.audit[1]).toMatchObject({ outcome: 'failed' });
    expect(JSON.stringify(h.audit)).not.toContain(TOKEN);
  });

  it.each([
    ['killed', Object.assign(new Error('Command failed: gh api'), { killed: true, signal: 'SIGTERM' })],
    ['signalled', Object.assign(new Error('Command failed: gh api'), { signal: 'SIGKILL' })],
    ['timed out', Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' })],
    ['wrapped kill', new Error('Command failed', { cause: Object.assign(new Error('x'), { killed: true }) })],
  ])('a %s runner records an unknown outcome, not failed, and is not retried', async (_label, error) => {
    const h = harness({ writeResult: error });
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps });
    expect(result.status).toBe('infra');
    expect(result.reason).toMatch(/state unknown, not retried/);
    expect(h.writes).toHaveLength(1);
    expect(h.audit.map((e) => e.event)).toEqual(['intent', 'result']);
    expect(h.audit[1]).toMatchObject({ outcome: 'unknown' });
  });

  it('isRunnerInterrupted ignores ordinary errors', () => {
    expect(isRunnerInterrupted(new Error('HTTP 405'))).toBe(false);
    expect(isRunnerInterrupted(Object.assign(new Error('exit 1'), { code: 1, killed: false, signal: null }))).toBe(false);
    expect(isRunnerInterrupted('ETIMEDOUT')).toBe(false);
    expect(isRunnerInterrupted(null)).toBe(false);
  });

  it('a response without merged: true is infra with an unknown state, not retried', async () => {
    const h = harness({ writeResult: '{"message":"odd"}' });
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps });
    expect(result.status).toBe('infra');
    expect(result.reason).toMatch(/state unknown/);
    expect(h.writes).toHaveLength(1);
    expect(h.audit[1]).toMatchObject({ outcome: 'unknown' });
  });

  it('a result line that cannot be appended still reports the merge', async () => {
    const h = harness({ appendFails: (entry) => entry.event === 'result' });
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps: h.deps });
    expect(result.status).toBe('merged');
    expect(result.auditError).toMatch(/result audit line/);
    expect(h.writes).toHaveLength(1);
  });

  it('evaluateMergeSteward still refuses dryRun: false', () => {
    expect(() => evaluateMergeSteward({} as never, { dryRun: false })).toThrow(/only --dry-run/);
  });

  it('builds the merge argv with the pinned SHA', () => {
    expect(stewardMergeArgs('a/b', 3, HEAD, 'merge')).toEqual(['api', '-X', 'PUT', 'repos/a/b/pulls/3/merge', '-f', `sha=${HEAD}`, '-f', 'merge_method=merge']);
  });
});

describe('merge steward write env and audit log', () => {
  it('builds the gh env from scratch with only the steward token', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/opt/bin:/usr/bin', HOME: '/home/op', GH_TOKEN: 'ambient', GITHUB_TOKEN: 'ambient2', GH_HOST: 'evil.example',
      GH_ENTERPRISE_TOKEN: 'x', GITHUB_ENTERPRISE_TOKEN: 'y', GH_CONFIG_DIR: '/home/op/.config/gh', OPENSWARM_STEWARD_GH_TOKEN: TOKEN,
    };
    const env = buildStewardGhEnv(TOKEN, '/tmp/osw-steward-gh-x', base);
    expect(env).toEqual({ PATH: '/opt/bin:/usr/bin', HOME: '/home/op', GH_TOKEN: TOKEN, GH_CONFIG_DIR: '/tmp/osw-steward-gh-x', GH_PROMPT_DISABLED: '1' });
    expect(Object.keys(env).sort()).toEqual(['GH_CONFIG_DIR', 'GH_PROMPT_DISABLED', 'GH_TOKEN', 'HOME', 'PATH']);
  });

  it('defaults PATH and HOME when the base env lacks them', () => {
    const env = buildStewardGhEnv(TOKEN, '/tmp/d', {});
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBeTruthy();
    expect(Object.keys(env)).toHaveLength(5);
  });

  it('resolves the merge log path from OPENSWARM_STEWARD_MERGE_LOG', () => {
    expect(stewardMergeLogPath({ OPENSWARM_STEWARD_MERGE_LOG: '/x/merges.jsonl' })).toBe('/x/merges.jsonl');
    expect(stewardMergeLogPath({})).toMatch(/[/\\]\.openswarm[/\\]steward[/\\]merges\.jsonl$/);
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('appends JSONL to a tmp log through the default appender', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'steward-merge-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'merges.jsonl');
    const h = harness();
    const deps: StewardMergeDeps = { ...h.deps, appendAudit: (entry) => appendStewardMergeAudit(entry, path) };
    expect((await executeStewardMerge({ repo: REPO, prNumber: PR, deps })).status).toBe('merged');
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as StewardMergeAuditEntry);
    expect(lines.map((l) => l.event)).toEqual(['intent', 'result']);
    expect(readFileSync(path, 'utf8')).not.toContain(TOKEN);
  });

  it('a log path that cannot be written refuses before the write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'steward-merge-'));
    dirs.push(dir);
    const blocker = join(dir, 'file');
    writeFileSync(blocker, '');
    const h = harness();
    const deps: StewardMergeDeps = { ...h.deps, appendAudit: (entry) => appendStewardMergeAudit(entry, join(blocker, 'merges.jsonl')) };
    const result = await executeStewardMerge({ repo: REPO, prNumber: PR, deps });
    expect(result.status).toBe('refused');
    expect(h.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Repo-wide static scan: the executor is the only file holding a PR merge write.

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));
const Q = `['"\`]`;

/** Executable PR-merge write forms. Detection regexes and prose do not match. */
const MERGE_WRITE_FORMS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  // A string or template literal naming the pulls/<n>/merge endpoint (REST PUT, octokit request).
  { pattern: new RegExp(`${Q}[^'"\`\\n]*\\bpulls/[^'"\`\\s]+/merge(?:${Q}|\\?)`), what: 'pulls/<n>/merge endpoint literal' },
  // A gh argv with 'pr' followed by 'merge'.
  { pattern: new RegExp(`${Q}pr${Q}\\s*,(?:\\s*[^,\\n\\])]+\\s*,)*?\\s*${Q}merge${Q}`), what: "argv 'pr', ..., 'merge'" },
  // A command string that starts with `pr merge` / `gh pr merge`.
  { pattern: new RegExp(`${Q}(?:gh\\s+)?pr\\s+(?:-\\S+\\s+\\S+\\s+)*merge\\b`), what: "'pr merge' command string" },
  // GraphQL mutation call with arguments.
  { pattern: /\b(?:mergePullRequest|enablePullRequestAutoMerge)\s*\(/, what: 'GraphQL merge mutation call' },
  // Octokit merge call.
  { pattern: /\.pulls\.merge\s*\(/, what: 'octokit pulls.merge call' },
];

interface ScannedSource {
  /** The source with comment text blanked out; strings, regexes and code intact. */
  code: string;
  /** The contents of every string and template literal (template `${}` kept raw). */
  literals: string[];
}

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * A small lexer: drops `//` and `/* *\/` comment text only (code before or after a
 * comment on the same line stays), and collects string literals. Regex literals
 * are skipped as code so a quote inside one cannot open a phantom string.
 */
function scanSource(source: string): ScannedSource {
  let code = '';
  const literals: string[] = [];
  let lastSignificant = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      // Keep the newlines so line-sensitive patterns do not join across a block.
      code += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n && source[j] !== ch) {
        if (source[j] === '\\') j += 1;
        else if (ch !== '`' && source[j] === '\n') break;
        j += 1;
      }
      literals.push(source.slice(i + 1, j));
      code += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = ch;
      continue;
    }
    if (ch === '/' && (REGEX_PRECEDERS.has(lastSignificant) || /\b(?:return|typeof|case|in|of)\s*$/.test(code))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        const c = source[j];
        if (c === '\\') j += 1;
        else if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j += 1;
      }
      code += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = '/';
      continue;
    }
    code += ch;
    if (!/\s/.test(ch)) lastSignificant = /[\w$]/.test(ch) ? 'w' : ch;
    i += 1;
  }
  return { code, literals };
}

/**
 * The merge endpoint assembled from pieces ('repos/' + r + '/pulls/' + n + '/merge',
 * a verb held in a variable): one literal names a pulls/ path, another ends the
 * path in merge, and a PUT literal is present. File-level on purpose.
 */
function hasConcatenatedMergeEndpoint(literals: readonly string[]): boolean {
  const pulls = literals.some((l) => /(?:^|\/)pulls(?:\/|$)/.test(l));
  const merge = literals.some((l) => /(?:^|\/)merge\/?$/.test(l.trim()));
  const put = literals.some((l) => /^(?:-X\s*|--method[=\s]+)?PUT\b/i.test(l.trim()));
  return pulls && merge && put;
}

function mergeWriteFormsIn(source: string): string[] {
  const { code, literals } = scanSource(source);
  const found = MERGE_WRITE_FORMS.filter(({ pattern }) => pattern.test(code)).map(({ what }) => what);
  if (hasConcatenatedMergeEndpoint(literals)) found.push('concatenated pulls/<n>/merge endpoint with PUT');
  return found;
}

/** Files that mention a merge form only to refuse it. Each entry must actually be flagged. */
const REFUSE_ONLY_ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || /fixtures?/i.test(entry)) continue;
      sourceFiles(path, out);
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

describe('merge write matcher self-test', () => {
  it.each([
    "['api', '-X', 'PUT', `repos/${repo}/pulls/${prNumber}/merge`, '-f', `sha=${headSha}`]",
    "gh(['api', '-X', 'PUT', 'repos/o/r/pulls/7/merge'])",
    "octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {})",
    "execFile('gh', ['pr', 'merge', '7', '--squash'])",
    "gh(cwd, 'pr', 'merge', String(n))",
    "gh(cwd, 'pr', '-R', repo, 'merge', String(n))",
    "run('gh pr merge 7 --auto')",
    "run('pr merge 7')",
    'const q = `mutation { mergePullRequest(input: { pullRequestId: $id }) { clientMutationId } }`;',
    'enablePullRequestAutoMerge(input: $input)',
    'await octokit.pulls.merge({ owner, repo, pull_number: 7 })',
    'await octokit.rest.pulls.merge({ owner, repo, pull_number: 7 })',
    // Concatenated endpoint.
    "gh(['api', '-X', 'PUT', 'repos/' + repo + '/pulls/' + n + '/merge'])",
    "const path = `repos/${repo}/pulls/${n}` + '/merge'; await gh(['api', '--method', 'PUT', path]);",
    // Verb held in a variable, endpoint assembled from pieces.
    "const verb = 'PUT';\nconst base = 'repos/' + repo + '/pulls/';\nawait gh(['api', '-X', verb, base + n + '/merge']);",
    // Verb in a variable, endpoint in one literal.
    "const method = 'PUT'; await gh(['api', '-X', method, `repos/${repo}/pulls/${n}/merge`]);",
    // Code after a block comment on the same line is still code.
    "/* harmless */ gh(['api', '-X', 'PUT', 'repos/o/r/pulls/7/merge'])",
    // A '//' inside a string is not a comment.
    "gh(['api', '-X', 'PUT', 'https://api.github.com/repos/o/r/pulls/7/merge'])",
  ])('flags %s', (snippet) => {
    expect(mergeWriteFormsIn(snippet)).not.toEqual([]);
  });

  it.each([
    // publicationFence.ts detection sources.
    "  { pattern: /\\bgh\\s+api\\b[^|;&\\n]*\\/merge(?:s|-upstream)?(?![\\w-])/, what: 'gh api …/merges' },",
    '    pattern: /^(?=[\\s\\S]*\\bgh\\s+api\\b)(?=[\\s\\S]*\\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\\b)/,',
    // assertReadOnlyGhArgs deny-list.
    '    if (/^merge$/i.test(arg) || /\\/merge(?:s)?(?:$|[/?])/i.test(arg)) {',
    " * `pull_request` CI trigger tests `refs/pull/N/merge` (this branch merged into",
    '// never call gh pr merge here',
    "await git(worktreePath, 'merge', '--abort');",
    "gh(worktreePath, 'pr', 'list', '--state', 'merged', '--json', 'number,mergeCommit')",
    "gh(['pr', 'view', '7', '--json', 'mergeable,state'])",
    "export type StewardMergeMethod = 'squash' | 'merge' | 'rebase';",
    "'repos/o/r/pulls/7/files'",
    // Pieces without PUT (a read of the merged state).
    "gh(['api', 'repos/' + repo + '/pulls/' + n + '/merge'])",
    // A block comment spanning lines is prose.
    "/*\n gh(['api', '-X', 'PUT', 'repos/o/r/pulls/7/merge'])\n*/",
    "const x = 1; // gh(['api', '-X', 'PUT', 'repos/o/r/pulls/7/merge'])",
  ])('allows %s', (snippet) => {
    expect(mergeWriteFormsIn(snippet)).toEqual([]);
  });
});

describe('repo-wide merge write scan', () => {
  it('only mergeStewardExecutor.ts holds a pull request merge write', () => {
    const allowed = new Set(REFUSE_ONLY_ALLOWLIST.map((a) => a.file));
    const flagged: string[] = [];
    const rawFlagged = new Set<string>();
    for (const path of sourceFiles(SRC_ROOT)) {
      const rel = `src/${relative(SRC_ROOT, path).split('\\').join('/')}`;
      if (mergeWriteFormsIn(readFileSync(path, 'utf8')).length === 0) continue;
      rawFlagged.add(rel);
      if (!allowed.has(rel)) flagged.push(rel);
    }
    expect(flagged).toEqual(['src/automation/mergeStewardExecutor.ts']);
    // A stale allowlist entry fails.
    for (const entry of REFUSE_ONLY_ALLOWLIST) expect(rawFlagged.has(entry.file), entry.why).toBe(true);
  });

  it('stewardCommand.ts imports neither the executor nor a write runner', () => {
    const source = readFileSync(join(SRC_ROOT, 'cli', 'stewardCommand.ts'), 'utf8');
    expect(source).not.toMatch(/mergeStewardExecutor|stewardMergeCommand/);
    expect(source).not.toMatch(/writeRunner|runStewardGhWrite|StewardWriteRunner|executeStewardMerge/);
    expect(source).not.toMatch(/node:child_process|\bexecFile\b|\bspawn\b/);
    expect(mergeWriteFormsIn(source)).toEqual([]);
  });
});
