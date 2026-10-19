/** 미리보기/규모 검증 전용. 프로덕션 응답의 대체값으로 사용하지 않는다. */
export function createProjectFixture(scenario = 'normal', now = Date.now()) {
  const projectCount = scenario === 'stress' ? 100 : 10;
  const projects = []; const tasks = []; const needs = []; const entries = new Map();
  const names = ['OpenSwarm', 'Sound library', 'NeuralSound', 'WAVE', '고객 포털 · Financial operations', 'StockAPI', 'Intrect platform', 'Research', 'Synthesizer', 'Archive'];
  for (let p = 0; p < projectCount; p++) {
    const repoKey = `demo:${String(p).padStart(3, '0')}`;
    const members = [];
    for (let a = 0; a < 10; a++) members.push({ id: JSON.stringify([repoKey, 'task-1', `agent-${a}`]), address: `agent-${a}`,
      name: ['Sable', 'Juniper', 'Sable', 'Kite', 'Cedar'][a % 5], role: a % 3 === 0 ? 'reviewer' : 'worker', recent: true, canReceive: a % 3 === 0 });
    const questions = scenario === 'questions' ? 3 : p === 0 ? 1 : 0;
    const projectNeeds = Array.from({ length: questions }, (_, q) => ({ id: `question-${p}-${q}`, repoKey, taskId: 'task-1', taskLabel: `DEMO-${p + 1}`,
      kind: 'question', actor: 'agent-0', correlationId: `corr-${p}-${q}`, question: ['Which release should keep the migration?', '기존 고객 데이터를 보존한 채 진행할까요?', 'هل نعتمد هذا القرار للمشروع؟'][q % 3] }));
    needs.push(...projectNeeds);
    projects.push({ repoKey, name: names[p % names.length] + (p >= 10 ? ` ${p + 1}` : ''), repository: `/demo/${p}`,
      configured: p !== 9, readSeq: 5, latestSeq: 12, unread: p === 0 ? 4 : p % 4,
      runningTasks: scenario === 'offline' ? null : p === 9 ? 0 : 2,
      recentParticipants: scenario === 'offline' ? null : 10, needsYou: questions,
      coordinatorAvailable: scenario !== 'offline' && p !== 9 });
    tasks.push({ repoKey, taskId: 'task-1', title: `DEMO-${p + 1} · Preserve existing discussion history`, status: 'running', stage: 'Review', participants: members, needs: projectNeeds },
      { repoKey, taskId: 'task-2', title: 'Verify the next release', status: 'queued', participants: [], needs: [] });
    const count = scenario === 'busy' ? 150 : 12;
    entries.set(repoKey, Array.from({ length: count }, (_, i) => ({ seq: i + 1, repoKey, sourceKind: i === 1 ? 'trace' : 'message',
      sourceId: `demo-${p}-${i}`, threadId: i === 1 ? undefined : `topic-${p}`, taskId: 'task-1', taskLabel: `DEMO-${p + 1}`,
      actor: i % 3 === 0 ? 'agent-0' : 'agent-1', actorName: i % 3 === 0 ? 'Sable' : 'Juniper', actorRole: i % 3 === 0 ? 'reviewer' : 'worker',
      body: i === 0 ? 'Keep the original discussion as the source of truth. Every project has its own coordinator queue.'
        : i === 1 ? 'Tool activity: inspected the durable message store.'
          : i === 2 ? '확인했습니다. 채널을 전환해도 질문과 수신자가 함께 이동하지 않도록 검증하고 있습니다.'
            : i === 3 ? 'قرار المشروع محفوظ في النقاش الأصلي.'
              : i === count - 1 ? 'The migration check is ready for your decision. Open the task to review the exact question.'
                : `The discussion remains linked to DEMO-${p + 1}. Validation step ${i + 1} is recorded.`,
      kind: i === 1 ? 'mcp-audit' : i === count - 1 && questions ? 'human-question' : 'discussion',
      status: i === count - 1 && questions ? 'waiting' : 'recorded', createdAt: now - (count - i) * 60_000,
      correlationId: i === count - 1 ? projectNeeds[0]?.correlationId : undefined,
    })));
  }
  return { projects, tasks, needs, entries,
    totals: { runningTasks: scenario === 'offline' ? null : 18 + (projectCount - 10) * 2,
      recentParticipants: scenario === 'offline' ? null : projectCount * 10, needsYou: needs.length },
    partial: scenario === 'offline', unavailable: scenario === 'offline' ? ['sessions', 'activity'] : [],
    activityScope: { participantsSince: now - 30 * 60_000 }, generatedAt: now };
}

export function demoProjectFetch(fixture) {
  const page = (items, url) => {
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const limit = 50;
    return { items: items.slice(start, start + limit), ...(items.length > start + limit ? { nextCursor: String(start + limit) } : {}),
      partial: fixture.partial, unavailable: fixture.unavailable, scope: { limit, throughSeq: 150 } };
  };
  return async (path, options = {}) => {
    const url = new URL(path, 'http://demo.local');
    let data;
    if (options.method && options.method !== 'GET') throw new Error('Demo data is read-only');
    if (url.pathname === '/api/coordination/projects') data = { ...page(fixture.projects, url), totals: fixture.totals, activityScope: fixture.activityScope };
    else if (url.pathname === '/api/coordination/needs-you') data = page(fixture.needs, url);
    else if (url.pathname.includes('/entries')) {
      const repoKey = decodeURIComponent(url.pathname.split('/')[4]);
      let all = fixture.entries.get(repoKey) ?? [];
      const corr = url.searchParams.get('correlationId');
      if (corr) all = all.filter((e) => e.correlationId === corr);
      data = { ...page([...all].reverse(), url), scope: { throughSeq: all.at(-1)?.seq ?? 0, limit: 50 } };
    } else if (url.pathname.includes('/tasks/')) {
      const repoKey = decodeURIComponent(url.pathname.split('/')[4]);
      const task = fixture.tasks.find((t) => t.repoKey === repoKey && t.taskId === decodeURIComponent(url.pathname.split('/')[6]));
      const nodes = task.participants.map((p) => ({ ...p }));
      const edges = nodes.slice(1).map((n) => ({ source: nodes[0].id, target: n.id, count: 2 }));
      data = { task, graph: { nodes, edges, omittedNodes: 0, omittedEdges: 0 }, participants: page(nodes, url), relationships: page(edges, url) };
    } else if (url.pathname.endsWith('/tasks')) {
      const repoKey = decodeURIComponent(url.pathname.split('/')[4]);
      data = page(fixture.tasks.filter((t) => t.repoKey === repoKey), url);
    } else if (url.pathname.includes('/threads/')) {
      const repoKey = url.searchParams.get('repository');
      const all = fixture.entries.get(repoKey) ?? [];
      data = { thread: { id: all[0]?.threadId, subject: 'Preserve the project discussion', status: 'open', relatedTaskIds: ['task-1', 'task-2'] },
        messages: { items: all.filter((e) => e.sourceKind === 'message').map((e) => ({ ...e, id: e.sourceId })) }, participants: [] };
    } else throw new Error(`Unsupported demo endpoint: ${url.pathname}`);
    return { ok: true, status: 200, json: async () => data };
  };
}
