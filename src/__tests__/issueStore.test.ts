// ============================================
// Issue Tracker - SQLite Store Unit Tests
// ============================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteIssueStore } from '../issues/sqliteStore.js';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';

describe('SqliteIssueStore', () => {
  let store: SqliteIssueStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = resolve(tmpdir(), `openswarm-test-${Date.now()}.db`);
    store = new SqliteIssueStore(dbPath);
  });

  afterEach(() => {
    store.close();
    // WAL 관련 파일도 정리
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  describe('createIssue', () => {
    it('이슈 생성 및 필수 필드 확인', () => {
      const issue = store.createIssue({
        projectId: 'test-project',
        title: '버그 수정',
        description: '로그인 실패 버그',
        priority: 'high',
      });

      expect(issue.id).toBeDefined();
      expect(issue.title).toBe('버그 수정');
      expect(issue.description).toBe('로그인 실패 버그');
      expect(issue.projectId).toBe('test-project');
      expect(issue.priority).toBe('high');
      expect(issue.status).toBe('backlog');
      expect(issue.source).toBe('local');
      expect(issue.createdAt).toBeDefined();
    });

    it('라벨, 파일, 수용기준 저장', () => {
      const label = store.createLabel('bug', '#ff0000');

      const issue = store.createIssue({
        projectId: 'p1',
        title: 'test',
        labels: [label.id],
        relevantFiles: ['src/foo.ts', 'src/bar.ts'],
        acceptanceCriteria: ['단위 테스트 통과', 'E2E 통과'],
      });

      expect(issue.labels).toEqual([label.name]);
      expect(issue.relevantFiles).toEqual(expect.arrayContaining(['src/foo.ts', 'src/bar.ts']));
      expect(issue.acceptanceCriteria).toEqual(['단위 테스트 통과', 'E2E 통과']);
    });

    it('의존성 설정', () => {
      const dep = store.createIssue({ projectId: 'p1', title: '선행 작업' });
      const issue = store.createIssue({
        projectId: 'p1',
        title: '후속 작업',
        dependencies: [dep.id],
      });

      expect(issue.dependencies).toEqual([dep.id]);
    });

    it('서브태스크 (parentId, childIds)', () => {
      const parent = store.createIssue({ projectId: 'p1', title: '상위 이슈' });
      const child = store.createIssue({
        projectId: 'p1',
        title: '하위 이슈',
        parentId: parent.id,
      });

      expect(child.parentId).toBe(parent.id);

      const refreshed = store.getIssue(parent.id);
      expect(refreshed?.childIds).toEqual([child.id]);
    });
  });

  describe('updateIssue', () => {
    it('제목/설명 업데이트', () => {
      const issue = store.createIssue({ projectId: 'p1', title: 'old' });
      const updated = store.updateIssue(issue.id, {
        title: 'new title',
        description: 'new desc',
      });

      expect(updated?.title).toBe('new title');
      expect(updated?.description).toBe('new desc');
    });

    it('라벨 교체', () => {
      const l1 = store.createLabel('bug');
      const l2 = store.createLabel('feature');
      const issue = store.createIssue({ projectId: 'p1', title: 't', labels: [l1.id] });

      const updated = store.updateIssue(issue.id, { labels: [l2.id] });
      expect(updated?.labels).toEqual([l2.name]);
    });
  });

  describe('changeStatus', () => {
    it('상태 전이 + 이벤트 기록', () => {
      const issue = store.createIssue({ projectId: 'p1', title: 'task' });
      const updated = store.changeStatus(issue.id, 'in_progress', 'user1');

      expect(updated?.status).toBe('in_progress');

      const events = store.getEvents(issue.id);
      const statusEvent = events.find((e) => e.type === 'status_changed');
      expect(statusEvent).toBeDefined();
      expect(statusEvent?.oldValue).toBe('backlog');
      expect(statusEvent?.newValue).toBe('in_progress');
    });

    it('done → closedAt 자동 설정', () => {
      const issue = store.createIssue({ projectId: 'p1', title: 'task' });
      const done = store.changeStatus(issue.id, 'done');

      expect(done?.closedAt).toBeDefined();
    });

    it('event oldValue reflects the status read inside the write transaction', () => {
      const issue = store.createIssue({ projectId: 'p1', title: 'task' });
      store.changeStatus(issue.id, 'todo');
      store.changeStatus(issue.id, 'in_progress');

      // getEvents returns newest-first (created_at DESC, rowid DESC).
      const events = store.getEvents(issue.id).filter((e) => e.type === 'status_changed');
      expect(events.map((e) => [e.oldValue, e.newValue])).toEqual([
        ['todo', 'in_progress'],
        ['backlog', 'todo'],
      ]);
    });
  });

  describe('listIssues', () => {
    it('필터: projectId, priority', () => {
      store.createIssue({ projectId: 'a', title: 't1', priority: 'high' });
      store.createIssue({ projectId: 'b', title: 't2', priority: 'low' });
      store.createIssue({ projectId: 'a', title: 't3', priority: 'low' });

      const { issues, total } = store.listIssues({ projectId: 'a', limit: 50, offset: 0 });
      expect(total).toBe(2);
      expect(issues.every((i) => i.projectId === 'a')).toBe(true);

      const { total: t2 } = store.listIssues({ priority: ['high'], limit: 50, offset: 0 });
      expect(t2).toBe(1);
    });

    it('FTS 전문검색', () => {
      store.createIssue({ projectId: 'p1', title: 'API 엔드포인트 추가' });
      store.createIssue({ projectId: 'p1', title: '로그인 버그 수정' });

      const { issues } = store.listIssues({ search: 'API', limit: 50, offset: 0 });
      expect(issues.length).toBe(1);
      expect(issues[0].title).toContain('API');
    });

    it('FTS OR 검색', () => {
      store.createIssue({ projectId: 'p1', title: 'API endpoint failure' });
      store.createIssue({ projectId: 'p1', title: 'login regression' });
      store.createIssue({ projectId: 'p1', title: 'billing cleanup' });

      const { issues } = store.listIssues({ search: 'API OR login', limit: 50, offset: 0 });
      expect(issues.map((i) => i.title)).toEqual(expect.arrayContaining([
        'API endpoint failure',
        'login regression',
      ]));
      expect(issues).toHaveLength(2);
    });

    it('FTS 정규화된 quoted AND 검색', () => {
      store.createIssue({ projectId: 'p1', title: 'API login failure' });
      store.createIssue({ projectId: 'p1', title: 'API billing failure' });
      store.createIssue({ projectId: 'p1', title: 'login page copy' });

      const { issues } = store.listIssues({ search: '"API" AND "login"', limit: 50, offset: 0 });
      expect(issues).toHaveLength(1);
      expect(issues[0].title).toBe('API login failure');
    });

    it('우선순위 정렬 (urgent > high > medium > low)', () => {
      store.createIssue({ projectId: 'p1', title: 'low', priority: 'low' });
      store.createIssue({ projectId: 'p1', title: 'urgent', priority: 'urgent' });
      store.createIssue({ projectId: 'p1', title: 'medium', priority: 'medium' });

      const { issues } = store.listIssues({ limit: 50, offset: 0 });
      expect(issues[0].priority).toBe('urgent');
      expect(issues[issues.length - 1].priority).toBe('low');
    });
  });

  describe('events', () => {
    it('코멘트 이벤트 추가 + 최근 이벤트 조회', () => {
      const issue = store.createIssue({ projectId: 'p1', title: 'task' });
      store.addEvent(issue.id, 'commented', { content: '작업 시작합니다', actor: 'dev1' });

      const events = store.getEvents(issue.id);
      expect(events.length).toBe(2); // created + commented
      expect(events[0].type).toBe('commented');
      expect(events[0].content).toBe('작업 시작합니다');

      const recent = store.getRecentEvents(10);
      expect(recent.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('memory links', () => {
    it('메모리 연결 + 조회', () => {
      const issue = store.createIssue({ projectId: 'p1', title: 'task' });
      store.linkMemory(issue.id, 'mem-123');
      store.linkMemory(issue.id, 'mem-456');

      const mems = store.getLinkedMemories(issue.id);
      expect(mems).toEqual(['mem-123', 'mem-456']);

      // 이슈 조회 시에도 반영
      const refreshed = store.getIssue(issue.id);
      expect(refreshed?.memoryIds).toEqual(['mem-123', 'mem-456']);
    });
  });

  describe('labels & milestones', () => {
    it('라벨 CRUD', () => {
      const label = store.createLabel('bug', '#ff0000', '버그');
      expect(label.name).toBe('bug');

      const all = store.listLabels();
      expect(all.length).toBe(1);

      store.deleteLabel(label.id);
      expect(store.listLabels().length).toBe(0);
    });

    it('중복 라벨 생성 시 기존 행을 반환', () => {
      const first = store.createLabel('bug', '#ff0000', '버그');
      const second = store.createLabel('bug', '#00ff00', '중복');

      expect(second.id).toBe(first.id);
      expect(second.color).toBe(first.color);
      expect(store.listLabels()).toHaveLength(1);
      expect(store.deleteLabel(second.id)).toBe(true);
    });

    it('마일스톤 생성', () => {
      const ms = store.createMilestone('v1.0', 'First release', '2026-05-01');
      expect(ms.name).toBe('v1.0');
      expect(ms.dueDate).toBe('2026-05-01');

      const all = store.listMilestones();
      expect(all.length).toBe(1);
    });
  });

  describe('stats', () => {
    it('통계 집계', () => {
      store.createIssue({ projectId: 'p1', title: 't1', priority: 'high' });
      store.createIssue({ projectId: 'p1', title: 't2', priority: 'low' });
      store.createIssue({ projectId: 'p2', title: 't3' });

      const stats = store.getStats();
      expect(stats.total).toBe(3);
      expect(stats.byProject['p1']).toBe(2);
      expect(stats.byProject['p2']).toBe(1);

      const p1Stats = store.getStats('p1');
      expect(p1Stats.total).toBe(2);
    });
  });

  describe('deleteIssue', () => {
    it('이슈 삭제', () => {
      const issue = store.createIssue({ projectId: 'p1', title: 'to delete' });
      expect(store.deleteIssue(issue.id)).toBe(true);
      expect(store.getIssue(issue.id)).toBeNull();
    });

    it('존재하지 않는 이슈 삭제 시 false', () => {
      expect(store.deleteIssue('nonexistent')).toBe(false);
    });
  });
});
