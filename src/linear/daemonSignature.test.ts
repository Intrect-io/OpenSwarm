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

const STARTS_WITH_OPENSWARM = /^🧭 \*\*\[OpenSwarm\]/;

describe('signDaemonComment (AGT-4800)', () => {
  it('prefixes an unsigned body and leaves a signed one alone', () => {
    expect(signDaemonComment('Draft grooming did not start a worker.')).toBe(`${DAEMON_COMMENT_LEAD} Draft grooming did not start a worker.`);
    const signed = formatAutomationComment({ heading: 'Task complete' });
    expect(signDaemonComment(signed)).toBe(signed);
    // A bare tag is not the daemon's signature: it is replaced by the lead, not doubled. (#853 review)
    expect(signDaemonComment('[OpenSwarm] proposal')).toBe(`${DAEMON_COMMENT_LEAD} proposal`);
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

describe('signDaemonComment keeps a leading Markdown block intact (#853 review)', () => {
  it.each(['# Heading', '- item', '* item', '| a | b |', '```ts\ncode\n```', '> quote', '<details>', '1. first', '12. twelfth'])(
    'puts a blank line between the lead and a body opening with %j',
    (body) => {
      expect(signDaemonComment(body)).toBe(`${DAEMON_COMMENT_LEAD}\n\n${body}`);
    },
  );

  it('keeps an inline body on the lead line', () => {
    expect(signDaemonComment('Draft grooming did not start a worker.')).toBe(`${DAEMON_COMMENT_LEAD} Draft grooming did not start a worker.`);
    expect(signDaemonComment('2026 plan is ready')).toBe(`${DAEMON_COMMENT_LEAD} 2026 plan is ready`);
  });
});

describe('only the full lead marks a comment as the daemon\'s (#853 review)', () => {
  it('counts a human comment that starts with [OpenSwarm] as human', () => {
    expect(isDaemonComment('[OpenSwarm] please retry')).toBe(false);
    expect(isSignedDaemonComment('[OpenSwarm] please retry')).toBe(false);
    expect(isDaemonComment(signDaemonComment('please retry'))).toBe(true);
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

  // Tracker state changes outside linear.ts: each call needs a comment call shortly before it with
  // no other state change in between. autonomousRunner.ts is not scanned yet: its stale In Progress
  // repair (reconcileStalledInProgress) moves state with no comment, and the merge reconciliation
  // comments after the move; that file is owned by another change. (#853 review)
  const STATE_CHANGE = /\b(?:updateIssueState|updateState|linearClient\.updateIssue)\(/;
  const COMMENT = /\b(?:addComment|logPairComplete)\(/;
  /** A completion retry whose effect comment already landed reapplies the state only (by design). */
  const ALLOWED = ['src/automation/trackerEffects.ts: const accepted = await source.updateState(issueId, target);'];
  const uncommented = (file: string, source: string): string[] => {
    const lines = source.split('\n');
    return lines.flatMap((line, at) => {
      if (!STATE_CHANGE.test(line) || /^\s*(?:\/\/|\*)/.test(line) || /^\s*(?:export )?(?:async )?\w+\(.*\): Promise/.test(line)) return [];
      for (let back = at - 1; back >= Math.max(0, at - 30); back--) {
        if (COMMENT.test(lines[back])) return [];
        if (STATE_CHANGE.test(lines[back])) break;
      }
      const site = `${file}: ${line.trim()}`;
      return ALLOWED.includes(site) ? [] : [site];
    });
  };

  it.each(['src/automation/trackerEffects.ts', 'src/issues/linearBridge.ts', 'src/support/web.ts'])(
    'every tracker state change in %s comes after a companion comment',
    (file) => {
      const source = readFileSync(join(__dirname, '..', '..', file), 'utf8');
      expect(STATE_CHANGE.test(source)).toBe(true);
      expect(uncommented(file, source)).toEqual([]);
    },
  );

  it('the widened check fails for a state change without its comment', () => {
    expect(uncommented('x.ts', "  await addComment(id, 'a');\n  await source.updateState(id, 'Todo');\n  await source.updateState(id, 'Done');"))
      .toEqual(["x.ts: await source.updateState(id, 'Done');"]);
  });

  it('the check fails for a state change without its comment', () => {
    const chunk = 'export async function bad(issueId: string) {\n  await updateIssueState(issueId, \'Done\');\n}';
    const state = chunk.search(/\bupdateIssueState\(/);
    const comment = chunk.search(/\baddComment\(/);
    expect(comment === -1 || comment > state).toBe(true);
  });
});
