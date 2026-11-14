import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  definitionOfReadyHooks,
  definitionOfReadyMarker,
  definitionOfReadyProposal,
  isDaemonAuthoredBody,
  missingDefinitionOfReadySections,
  partitionByDefinitionOfReady,
  resetDefinitionOfReadyMemo,
  type DefinitionOfReadyTask,
} from './definitionOfReady.js';
import { isDaemonComment } from './dispatchFingerprint.js';

const READY_BODY = [
  '## Why', 'Because.', '',
  '## Acceptance criteria', '- the thing works', '',
  '## Out of scope', '- billing', '',
  '## Verification', '`npx vitest run src/x.test.ts`',
].join('\n');

const task = (over: Partial<DefinitionOfReadyTask> = {}): DefinitionOfReadyTask => ({
  issueId: 'uuid-1', issueIdentifier: 'AX-1', linearState: 'Todo', labels: [], title: 'Fix it',
  description: READY_BODY, projectPath: '/p/a', ...over,
});

describe('missingDefinitionOfReadySections (AGT-4805)', () => {
  it('accepts a body with all three headed sections', () => {
    expect(missingDefinitionOfReadySections(READY_BODY)).toEqual([]);
  });

  it('reports every section for an empty or missing body', () => {
    const all = ['acceptance_criteria', 'out_of_scope', 'verification'];
    expect(missingDefinitionOfReadySections(undefined)).toEqual(all);
    expect(missingDefinitionOfReadySections('결함 15건. 고쳐 주세요.')).toEqual(all);
  });

  it('does not count a heading with no content under it', () => {
    const body = '## Acceptance criteria\n\n## Out of scope\nnone\n## Verification\nnpm test';
    expect(missingDefinitionOfReadySections(body)).toEqual(['acceptance_criteria']);
  });

  it('accepts bold labels, inline labels and Korean headings', () => {
    const bold = '**Acceptance criteria:**\n- works\n\n**Out of scope:** billing\n\nVerify: `npm test`';
    expect(missingDefinitionOfReadySections(bold)).toEqual([]);
    const ko = '## 완료 조건\n- 동작\n## 범위 제외\n- 결제\n## 검증\nnpx vitest run';
    expect(missingDefinitionOfReadySections(ko)).toEqual([]);
  });

  it('reads the issue template shape of AGT-4805 itself as missing out-of-scope and verification', () => {
    const body = '## Why\n\nx\n\n## Scope\n\n* a\n\n## Acceptance\n\n* Replaying the snapshot parks them.';
    expect(missingDefinitionOfReadySections(body)).toEqual(['out_of_scope', 'verification']);
  });

  it('does not treat prose mentioning a section name as the section', () => {
    expect(missingDefinitionOfReadySections('We should add acceptance criteria and tests later.'))
      .toEqual(['acceptance_criteria', 'out_of_scope', 'verification']);
  });
});

describe('definitionOfReadyProposal', () => {
  it('starts with [OpenSwarm] and names only the missing sections', () => {
    const body = definitionOfReadyProposal(['out_of_scope']);
    expect(body.startsWith('[OpenSwarm]')).toBe(true);
    expect(isDaemonComment(body)).toBe(true);
    expect(body).toContain('Out of scope');
    expect(body).not.toContain('Acceptance criteria');
    expect(body).not.toContain('## Verification');
  });
});

describe('partitionByDefinitionOfReady', () => {
  beforeEach(() => resetDefinitionOfReadyMemo());

  it('without hooks behaves exactly like partitionByReadiness', async () => {
    const { ready } = await partitionByDefinitionOfReady([task({ description: '' })], {});
    expect(ready).toHaveLength(1);
  });

  it('holds a Todo issue missing a section and posts one proposal, never twice', async () => {
    const comment = vi.fn().mockResolvedValue(undefined);
    const hooks = { enabled: () => true, comment };
    const t = task({ description: '결함 15건' });
    const first = await partitionByDefinitionOfReady([t], { definitionOfReady: hooks });
    const second = await partitionByDefinitionOfReady([t], { definitionOfReady: hooks });
    expect(first.ready).toEqual([]);
    expect(second.ready).toEqual([]);
    expect([...first.held.keys()]).toEqual(['definition_of_ready:acceptance_criteria,out_of_scope,verification']);
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment).toHaveBeenCalledWith('uuid-1', expect.stringMatching(/^\[OpenSwarm\]/), definitionOfReadyMarker('uuid-1'));
  });

  it('retries the comment on the next heartbeat when posting failed', async () => {
    const comment = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const hooks = { enabled: () => true, comment };
    const t = task({ description: '' });
    await partitionByDefinitionOfReady([t], { definitionOfReady: hooks });
    await partitionByDefinitionOfReady([t], { definitionOfReady: hooks });
    expect(comment).toHaveBeenCalledTimes(2);
  });

  it('claims a ready issue, and leaves In Progress, In Review and explicit dispatch alone', async () => {
    const comment = vi.fn();
    const hooks = { enabled: () => true, comment };
    const tasks = [
      task(),
      task({ issueId: 'u2', linearState: 'In Progress', description: '' }),
      task({ issueId: 'u3', linearState: 'In Review', description: '' }),
      task({ issueId: 'u4', explicitDispatch: true, description: '' }),
    ];
    const { ready } = await partitionByDefinitionOfReady(tasks, { definitionOfReady: hooks });
    expect(ready).toHaveLength(4);
    expect(comment).not.toHaveBeenCalled();
  });

  it('keeps earlier readiness rules first: a Backlog issue is held by state, not commented on', async () => {
    const comment = vi.fn();
    const { ready, held } = await partitionByDefinitionOfReady(
      [task({ linearState: 'Backlog', description: '' })],
      { definitionOfReady: { enabled: () => true, comment } },
    );
    expect(ready).toEqual([]);
    expect([...held.keys()]).toEqual(['state:Backlog']);
    expect(comment).not.toHaveBeenCalled();
  });

  it('replays an AX-style snapshot: issues without criteria are parked with one comment each and claimed 0 times', async () => {
    const comment = vi.fn().mockResolvedValue(undefined);
    const hooks = { enabled: () => true, comment };
    const snapshot = [
      task({ issueId: 'a1', issueIdentifier: 'AX-1', description: '결함 15건 — 전부 고쳐 주세요' }),
      task({ issueId: 'a2', issueIdentifier: 'AX-2', description: 'Dashboard is slow.' }),
      task({ issueId: 'a3', issueIdentifier: 'AX-3' }),
    ];
    for (let heartbeat = 0; heartbeat < 5; heartbeat++) {
      const { ready } = await partitionByDefinitionOfReady(snapshot, { definitionOfReady: hooks });
      expect(ready.map(t => t.issueIdentifier)).toEqual(['AX-3']);
    }
    expect(comment).toHaveBeenCalledTimes(2);
  });
});

describe('daemon-authored bodies', () => {
  beforeEach(() => resetDefinitionOfReadyMemo());

  it('recognises planner splits and reviewer follow-ups, not human prose', () => {
    expect(isDaemonAuthoredBody('Do x.\n\n_Split out from "Parent" during planning._')).toBe(true);
    expect(isDaemonAuthoredBody('Follow-up from reviewer.\n\nLocation: a.ts:1')).toBe(true);
    expect(isDaemonAuthoredBody('Follow-up recommended by the reviewer.')).toBe(true);
    expect(isDaemonAuthoredBody('결함 15건')).toBe(false);
  });

  it('never parks the daemon\'s own decomposition children', async () => {
    const comment = vi.fn();
    const { ready } = await partitionByDefinitionOfReady(
      [task({ description: 'Do x.\n\n_Split out from "Parent" during planning._' })],
      { definitionOfReady: { enabled: () => true, comment } },
    );
    expect(ready).toHaveLength(1);
    expect(comment).not.toHaveBeenCalled();
  });
});

describe('definitionOfReadyHooks', () => {
  const linear = { kind: 'linear', addComment: vi.fn().mockResolvedValue(undefined) };
  const agents = [
    { projectPath: '/p/a' },
    { projectPath: '/p/b', requireDefinitionOfReady: false },
    { projectPath: '/p/c', linearProjectId: 'lp-c', requireDefinitionOfReady: false },
  ];

  it('is on when the project has no setting, off when it opts out', async () => {
    const hooks = definitionOfReadyHooks(agents, linear);
    expect(await hooks.enabled(task({ projectPath: '/p/a' }))).toBe(true);
    expect(await hooks.enabled(task({ projectPath: '/p/b' }))).toBe(false);
    expect(await hooks.enabled(task({ projectPath: '/p/b/worktrees/x' }))).toBe(false);
    expect(await hooks.enabled(task({ projectPath: '/elsewhere' }))).toBe(true);
  });

  it('finds the owning project of a fetched Linear task, which has no projectPath', async () => {
    const resolve = vi.fn(async () => '/p/b');
    const hooks = definitionOfReadyHooks(agents, linear, resolve);
    expect(await hooks.enabled(task({ projectPath: undefined, linearProject: { id: 'lp-c' } }))).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(await hooks.enabled(task({ projectPath: undefined, linearProject: { id: 'lp-x' } }))).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    const unresolved = definitionOfReadyHooks(agents, linear, vi.fn(async () => null));
    expect(await unresolved.enabled(task({ projectPath: undefined }))).toBe(true);
  });

  it('does not gate a local task source', async () => {
    const hooks = definitionOfReadyHooks(agents, { kind: 'local', addComment: vi.fn() });
    expect(await hooks.enabled(task({ projectPath: '/p/a' }))).toBe(false);
  });

  it('comments only through a Linear source', async () => {
    expect(definitionOfReadyHooks([], { kind: 'local', addComment: vi.fn() }).comment).toBeUndefined();
    expect(definitionOfReadyHooks([], null).comment).toBeUndefined();
    await definitionOfReadyHooks([], linear).comment!('i', 'b', 'm');
    expect(linear.addComment).toHaveBeenCalledWith('i', 'b', 'm');
  });
});
