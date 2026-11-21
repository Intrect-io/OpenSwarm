// A PR closes its issue only when the approving verdict said the change covers
// all of it (AGT-4786). cgf-portal #1329 was +3/-0 against a multi-defect issue
// and still said `Closes AX-2024`.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAndCreatePRWithHead } from './worktreeManager.js';
import { approvedCoverage, publicationTitle, withIssueLinkLine, type PublicationCoverage } from './publicationCoverage.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

describe('commitAndCreatePRWithHead issue link and title (AGT-4786)', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /**
   * Publish one change against a real bare origin with a fake `gh` that
   * records its arguments. `existingPr` makes `pr list --head` report an open
   * PR with that title/body, so the reuse path runs instead of `pr create`.
   */
  async function publish(coverage: PublicationCoverage | undefined, existingPr?: { title: string; body: string }): Promise<string[][]> {
    root = mkdtempSync(join(tmpdir(), 'openswarm-pub-coverage-'));
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    writeFileSync(join(repo, 'a.ts'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'initial');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    const branchName = 'swarm/AX-2024-fund-recon';
    git(repo, 'checkout', '-qb', branchName);
    writeFileSync(join(repo, 'a.ts'), 'changed\n');

    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const log = join(root, 'gh-calls.log');
    const view = join(root, 'pr-view.json');
    if (existingPr) writeFileSync(view, JSON.stringify(existingPr));
    // Each call is written as its NUL-separated argv followed by a newline-terminated record marker.
    writeFileSync(join(bin, 'gh'), [
      '#!/bin/sh',
      `for a in "$@"; do printf '%s\\0' "$a" >> '${log}'; done; printf '\\036' >> '${log}'`,
      'case "$*" in',
      existingPr
        ? `  *"pr list --head"*) echo "https://example.test/pr/7";;\n  *"pr view"*"title,body"*) cat '${view}';;`
        : '  *"pr list --head"*) echo "";;',
      '  *"pr create"*) echo "https://example.test/pr/8";;',
      '  *) ;;',
      'esac',
      '',
    ].join('\n'));
    chmodSync(join(bin, 'gh'), 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      await commitAndCreatePRWithHead(
        { worktreePath: repo, originalPath: repo, branchName, issueId: 'AX-2024' },
        'UAT12a2 fund reconciliation gaps', 'AX-2024', 'Fills the MMF column.', { coverage },
      );
    } finally {
      process.env.PATH = prevPath;
    }
    return readFileSync(log, 'utf8').split('\u001e').filter(Boolean).map((call) => call.split('\0').filter(Boolean));
  }

  const createCall = (calls: string[][]) => calls.find((c) => c[0] === 'pr' && c[1] === 'create')!;
  const argAfter = (call: string[], flag: string) => call[call.indexOf(flag) + 1];

  it('a partial verdict gets a [partial] title and Refs instead of Closes', async () => {
    const create = createCall(await publish('partial'));
    expect(argAfter(create, '--title')).toBe('[partial] UAT12a2 fund reconciliation gaps');
    const body = argAfter(create, '--body');
    expect(body).toMatch(/^Refs AX-2024$/m);
    expect(body).not.toContain('Closes AX-2024');
  });

  it('unknown coverage uses Refs', async () => {
    const create = createCall(await publish(undefined));
    expect(argAfter(create, '--title')).toBe('[partial] UAT12a2 fund reconciliation gaps');
    expect(argAfter(create, '--body')).toMatch(/^Refs AX-2024$/m);
    expect(argAfter(create, '--body')).not.toContain('Closes');
  });

  it('a complete verdict keeps the bare title and Closes', async () => {
    const create = createCall(await publish('complete'));
    expect(argAfter(create, '--title')).toBe('UAT12a2 fund reconciliation gaps');
    expect(argAfter(create, '--body')).toMatch(/^Closes AX-2024$/m);
  });

  it('a complete run reusing a parked [partial]/Refs PR rewrites it to the bare title and Closes', async () => {
    const calls = await publish('complete', { title: '[partial] UAT12a2 fund reconciliation gaps', body: '## Summary\nx\n\n## Linear\nRefs AX-2024\n' });
    expect(calls.some((c) => c[1] === 'create')).toBe(false);
    const edit = calls.find((c) => c[1] === 'edit' && c.includes('--title'))!;
    expect(argAfter(edit, '--title')).toBe('UAT12a2 fund reconciliation gaps');
    expect(argAfter(edit, '--body')).toMatch(/^Closes AX-2024$/m);
  });

  it('a partial run reusing a PR that says Closes downgrades it to Refs', async () => {
    const calls = await publish('partial', { title: 'UAT12a2 fund reconciliation gaps', body: '## Linear\nCloses AX-2024\n' });
    const edit = calls.find((c) => c[1] === 'edit' && c.includes('--title'))!;
    expect(argAfter(edit, '--title')).toBe('[partial] UAT12a2 fund reconciliation gaps');
    expect(argAfter(edit, '--body')).toBe('## Linear\nRefs AX-2024\n');
  });
});

describe('publication coverage helpers (AGT-4786)', () => {
  it('honours coverage only on an approving verdict', () => {
    expect(approvedCoverage({ decision: 'approve', coverage: 'complete' })).toBe('complete');
    expect(approvedCoverage({ decision: 'revise', coverage: 'complete' })).toBe('unknown');
    expect(approvedCoverage({ decision: 'approve' })).toBe('unknown');
    expect(approvedCoverage(undefined)).toBe('unknown');
  });

  it('never stacks the [partial] prefix', () => {
    expect(publicationTitle('[partial] [partial] Fix', 'partial')).toBe('[partial] Fix');
    expect(publicationTitle('[partial] Fix', 'complete')).toBe('Fix');
  });

  it('rewrites only the exact issue line', () => {
    expect(withIssueLinkLine('Closes AX-20240\nCloses AX-2024', 'AX-2024', 'partial')).toBe('Closes AX-20240\nRefs AX-2024');
  });
});
