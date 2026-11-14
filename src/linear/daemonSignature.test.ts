// AGT-4800: the daemon writes to Linear with the operator's credential, so every comment it posts
// must start with [OpenSwarm], and every state change it makes must come with a comment that says why.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LinearClient } from '@linear/sdk';
import { addComment, initLinear } from './linear.js';
import { DAEMON_COMMENT_LEAD, formatAutomationComment, isSignedDaemonComment, signDaemonComment } from './format.js';
import { scopeDeclineComment } from '../automation/draftGrooming.js';
import { coordinatorResolutionComment } from '../automation/coordinatorResolution.js';
import { decideMergedPublication } from '../automation/mergedPublications.js';
import { isDaemonComment } from '../automation/dispatchFingerprint.js';

vi.mock('@linear/sdk', () => ({ LinearClient: vi.fn() }));

const STARTS_WITH_OPENSWARM = /^(?:🧭 )?\*\*\[OpenSwarm\]|^\[OpenSwarm\]/;

describe('signDaemonComment (AGT-4800)', () => {
  it('prefixes an unsigned body and leaves a signed one alone', () => {
    expect(signDaemonComment('Draft grooming did not start a worker.')).toBe(`${DAEMON_COMMENT_LEAD} Draft grooming did not start a worker.`);
    const signed = formatAutomationComment({ heading: 'Task complete' });
    expect(signDaemonComment(signed)).toBe(signed);
    expect(signDaemonComment('[OpenSwarm] proposal')).toBe('[OpenSwarm] proposal');
    expect(signDaemonComment(signDaemonComment('x'))).toBe(`${DAEMON_COMMENT_LEAD} x`);
  });

  it('every comment builder output, as posted, starts with [OpenSwarm] and reads as the daemon', () => {
    const merged = decideMergedPublication(
      { repo: 'o/r', number: 1, state: 'MERGED', mergedAt: '2026-11-15', mergeCommitOid: 'abcdef1234' } as never,
      'https://github.com/o/r/pull/1', undefined,
    );
    const outputs = [
      formatAutomationComment({ heading: 'Task complete', summary: 'Done.' }),
      scopeDeclineComment({ kind: 'decision_pending', reason: 'waiting', evidence: ['a'] }),
      coordinatorResolutionComment({ action: 'complete', reason: 'r' }),
      coordinatorResolutionComment({ action: 'retry', reason: 'r', retryAt: 0 }),
      coordinatorResolutionComment({ action: 'park', reason: 'r' }),
      'comment' in merged ? String(merged.comment) : '',
      'Backlog grooming result: ready\n\nReason: x\n\nAction: none',
      'Draft grooming deferred this task because an open pull request owns its planned files.',
    ].filter(Boolean);
    for (const output of outputs) {
      const posted = signDaemonComment(output);
      expect(posted).toMatch(STARTS_WITH_OPENSWARM);
      expect(isSignedDaemonComment(posted)).toBe(true);
      expect(isDaemonComment(posted)).toBe(true);
    }
  });
});

describe('addComment signs at the one place comments leave the process (AGT-4800)', () => {
  it('posts an unsigned body with the [OpenSwarm] lead', async () => {
    const createComment = vi.fn(async () => ({ success: true }));
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) { return { createComment } as never; } as never);
    initLinear('fake-key', 'team-1');
    await addComment('issue-1', 'Coordinator completed this run automatically.');
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: 'issue-1',
      body: `${DAEMON_COMMENT_LEAD} Coordinator completed this run automatically.`,
    }));
  });

  it('has no second write path: createComment is called only from linear.addComment', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
        const count = (readFileSync(path, 'utf8').match(/\.createComment\(/g) ?? []).length;
        if (count > 0) offenders.push(`${path.replace(/^.*?src\//, 'src/')}:${count}`);
      }
    };
    walk(join(__dirname, '..'));
    expect(offenders).toEqual(['src/linear/linear.ts:1']);
  });
});

describe('state changes in linear.ts come with a companion comment (AGT-4800)', () => {
  it('every function that calls updateIssueState posts a comment first', () => {
    const source = readFileSync(join(__dirname, 'linear.ts'), 'utf8');
    // Split into top-level function bodies.
    const chunks = source.split(/\n(?=export (?:async )?function |(?:async )?function )/);
    const callers = chunks.filter(chunk => /\bupdateIssueState\(/.test(chunk) && !/^export async function updateIssueState\(/.test(chunk));
    expect(callers.length).toBeGreaterThanOrEqual(9);
    const missing = callers
      .filter(chunk => {
        const state = chunk.search(/\bupdateIssueState\(/);
        const comment = chunk.search(/\baddComment\(/);
        return comment === -1 || comment > state;
      })
      .map(chunk => chunk.match(/function (\w+)/)?.[1] ?? '?');
    expect(missing).toEqual([]);
  });

  it('the check fails for a state change without its comment', () => {
    const chunk = 'export async function bad(issueId: string) {\n  await updateIssueState(issueId, \'Done\');\n}';
    const state = chunk.search(/\bupdateIssueState\(/);
    const comment = chunk.search(/\baddComment\(/);
    expect(comment === -1 || comment > state).toBe(true);
  });
});
