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
import { ReasonCommentError, transitionWithReason } from '../automation/trackerTransition.js';
import { LinearTaskSource } from '../automation/taskSource.js';

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
  // no other state change in between. src/automation and web.ts go through transitionWithReason
  // instead (scanned below), so only the issue bridge is checked line by line here. (#853 review)
  const STATE_CHANGE = /\b(?:updateIssueState|updateState|linearClient\.updateIssue)\(/;
  const COMMENT = /\b(?:addComment|logPairComplete)\(/;
  const ALLOWED: string[] = [];
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

  it.each(['src/issues/linearBridge.ts'])(
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

describe('daemon state changes outside src/linear go through transitionWithReason (AGT-4800)', () => {
  const source = () => {
    const calls: string[] = [];
    return {
      calls,
      addComment: vi.fn(async (issueId: string, body: string) => { calls.push(`comment:${issueId}:${body}`); }),
      updateState: vi.fn(async (issueId: string, state: string) => { calls.push(`state:${issueId}:${state}`); return true; }),
    };
  };

  it('transitionWithReason posts the [OpenSwarm] comment before the state change', async () => {
    // Through the real Linear task source, so the lead is the one that actually reaches Linear.
    const calls: string[] = [];
    const client = {
      createComment: vi.fn(async (input: { issueId: string; body: string }) => { calls.push(`comment:${input.issueId}:${input.body}`); return { success: true }; }),
      issue: vi.fn(async () => ({ team: Promise.resolve({ id: 'team-1' }) })),
      team: vi.fn(async () => ({ states: async () => ({ nodes: [{ id: 'state-backlog', name: 'Backlog' }] }) })),
      updateIssue: vi.fn(async (issueId: string, input: { stateId: string }) => { calls.push(`state:${issueId}:${input.stateId}`); return { success: true }; }),
    };
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) { return client as never; } as never);
    initLinear('fake-key', 'team-1');
    const linearSource = new LinearTaskSource(async () => []);
    await expect(transitionWithReason(linearSource, 'issue-1', 'Backlog', 'Parked: retries exhausted.')).resolves.toBe(true);
    expect(calls).toEqual([`comment:issue-1:${DAEMON_COMMENT_LEAD} Parked: retries exhausted.`, 'state:issue-1:state-backlog']);
    expect(calls[0].slice('comment:issue-1:'.length)).toMatch(STARTS_WITH_OPENSWARM);

    // A failed comment still parks by default (the move is the safety action) ...
    const failing = source();
    failing.addComment.mockRejectedValueOnce(new Error('tracker down'));
    await expect(transitionWithReason(failing, 'issue-2', 'Backlog', 'Parked.')).resolves.toBe(true);
    expect(failing.updateState).toHaveBeenCalledWith('issue-2', 'Backlog');
    // ... 'rethrow' still moves, then surfaces the error so an outbox retries the comment ...
    failing.addComment.mockRejectedValueOnce(new Error('tracker down'));
    await expect(transitionWithReason(failing, 'issue-3', 'Backlog', 'Parked.', { commentFailure: 'rethrow' })).rejects.toThrow('tracker down');
    expect(failing.updateState).toHaveBeenCalledWith('issue-3', 'Backlog');
    // ... and 'abort' leaves the state alone.
    failing.addComment.mockRejectedValueOnce(new Error('tracker down'));
    await expect(transitionWithReason(failing, 'issue-4', 'Done', 'Groomed.', { commentFailure: 'abort' })).rejects.toBeInstanceOf(ReasonCommentError);
    expect(failing.updateState).not.toHaveBeenCalledWith('issue-4', 'Done');
  });

  it('no file under src/automation or src/support/web.ts calls updateState directly', () => {
    const root = join(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(path);
      }
    };
    walk(join(root, 'src', 'automation'));
    files.push(join(root, 'src', 'support', 'web.ts'));
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((path) => {
      const rel = path.slice(root.length + 1);
      if (rel === 'src/automation/trackerTransition.ts') return [];
      return readFileSync(path, 'utf8').split('\n').flatMap((line, at) => {
        if (!/\bupdateState\(/.test(line) || /^\s*(?:\/\/|\*)/.test(line)) return [];
        // The method itself: interface members and implementations (`updateState(issueId: string, ...)`).
        if (/^\s*(?:async\s+)?updateState\(\w+: string/.test(line)) return [];
        // An ITaskSource implementation calling its own method (each one comments first; taskSource.ts).
        if (rel === 'src/automation/taskSource.ts' && /\bthis\.updateState\(/.test(line)) return [];
        return [`${rel}:${at + 1}: ${line.trim()}`];
      });
    });
    expect(offenders).toEqual([]);
  });
});
