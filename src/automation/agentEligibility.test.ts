import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_SKIP,
  formatSkipSummary,
  humanOwnedReason,
  partitionHumanOwned,
} from './agentEligibility.js';

// 2026-10-04: moving stale human-owned cards to Backlog made the daemon queue them at once,
// including epics and a card that waits on an external decision (AGT-4682).

const task = (over: Partial<Parameters<typeof humanOwnedReason>[0]> = {}) => ({
  title: '[B1] 월별 정산 화면 수정',
  labels: [] as string[],
  ...over,
});

describe('humanOwnedReason', () => {
  it('lets an ordinary issue through', () => {
    expect(humanOwnedReason(task())).toBeNull();
    expect(humanOwnedReason(task({ labels: ['Bug', 'quality'] }))).toBeNull();
  });

  it('skips an issue carrying a skip label, ignoring case and spacing', () => {
    expect(humanOwnedReason(task({ labels: ['SWARM:Skip '] }))).toBe('label:swarm:skip');
    const config = { ...DEFAULT_AGENT_SKIP, labels: ['swarm:skip', '외부 검증·결정 대기'] };
    expect(humanOwnedReason(task({ labels: ['외부 검증·결정 대기'] }), config)).toBe('label:외부 검증·결정 대기');
  });

  it('skips an epic, an issue that has sub-issues, even without a tag in the title', () => {
    expect(humanOwnedReason(task({ title: '[UI/UX] CGF Portal 전체 화면 개선', hasChildren: true }))).toBe('epic');
    expect(humanOwnedReason(task({ hasChildren: true }), { ...DEFAULT_AGENT_SKIP, epics: false })).toBeNull();
  });

  it('skips by title tag when the tag opens a bracket group', () => {
    expect(humanOwnedReason(task({ title: '[인수][PLATFORM] CGF 인수 점검' }))).toBe('tag:인수');
    expect(humanOwnedReason(task({ title: '[인수] CGF 2주 무개입 운영 실증' }))).toBe('tag:인수');
    expect(humanOwnedReason(task({ title: '[확인 원장] CGF 외부 입력·결정' }))).toBe('tag:확인 원장');
    expect(humanOwnedReason(task({ title: '[docs] 시나리오별 사용 가이드' }))).toBe('tag:Docs');
    expect(humanOwnedReason(task({ title: '[Portal][Docs] 가이드' }))).toBe('tag:Docs');
    expect(humanOwnedReason(task({ title: '[Portal][EPIC] 묶음' }), { ...DEFAULT_AGENT_SKIP, titleTags: ['EPIC'] })).toBe('tag:EPIC');
  });

  it('does not match a tag that only appears inside other words or text', () => {
    expect(humanOwnedReason(task({ title: '[DocsBot] 봇 응답 수정' }))).toBeNull();
    expect(humanOwnedReason(task({ title: 'Docs 폴더 정리' }))).toBeNull();
    expect(humanOwnedReason(task({ title: '[B1] 인수 상태 표시 버그' }))).toBeNull();
  });

  it('does not skip [UAT] defect reports by default', () => {
    expect(humanOwnedReason(task({ title: '[C2][UAT] 사입 의심 탭이 발주 자료 없이 표시됨' }))).toBeNull();
    expect(humanOwnedReason(task({ title: '[UAT][P2] 고객 표에 내부 상태 코드가 노출됨' }))).toBeNull();
    expect(humanOwnedReason(task({ title: '[UAT] 10/2 배포 readback' }), { ...DEFAULT_AGENT_SKIP, titleTags: ['UAT'] })).toBe('tag:UAT');
  });

  it('never skips a task the operator dispatched by hand', () => {
    expect(humanOwnedReason(task({ labels: ['swarm:skip'], hasChildren: true, title: '[Docs] x', explicitDispatch: true }))).toBeNull();
  });
});

describe('partitionHumanOwned', () => {
  const issues = [
    { id: '1', issueIdentifier: 'AX-1', title: '[B1] 수정', labels: [] as string[] },
    { id: '2', issueIdentifier: 'AX-2', title: '[Docs] 가이드', labels: [] as string[] },
    { id: '3', issueIdentifier: 'AX-3', title: '[A2] 확인', labels: ['swarm:skip'] },
    { id: '4', title: '[인수] 운영 실증', labels: [] as string[] },
    { id: '5', issueIdentifier: 'AX-5', title: '[C2] 수정', labels: [] as string[], hasChildren: true },
  ];

  it('keeps only the work the swarm may take and groups the rest by reason', () => {
    const { eligible, skipped } = partitionHumanOwned(issues);
    expect(eligible.map((t) => t.id)).toEqual(['1']);
    expect([...skipped.entries()]).toEqual([
      ['tag:Docs', ['AX-2']],
      ['label:swarm:skip', ['AX-3']],
      ['tag:인수', ['4']],
      ['epic', ['AX-5']],
    ]);
  });

  it('formats one aggregated line per reason and caps the listed keys', () => {
    const lines = formatSkipSummary(new Map([
      ['epic', ['AX-1', 'AX-2']],
      ['label:swarm:skip', Array.from({ length: 10 }, (_, i) => `AX-${i}`)],
    ]), 3);
    expect(lines).toEqual([
      '  ⏭ not agent work (epic) 2: AX-1, AX-2',
      '  ⏭ not agent work (label:swarm:skip) 10: AX-0, AX-1, AX-2 +7 more',
    ]);
  });
});
