export const GRAPH_NODE_LIMIT = 20;
export const GRAPH_EDGE_LIMIT = 40;
export function boundedGraph(nodes, edges, selected) {
  const chosen = nodes.find((n) => n.id === selected);
  const visible = [...(chosen ? [chosen] : []), ...nodes.filter((n) => n.id !== chosen?.id)].slice(0, GRAPH_NODE_LIMIT);
  const ids = new Set(visible.map((n) => n.id));
  const links = edges.filter((e) => ids.has(e.source) && ids.has(e.target)).slice(0, GRAPH_EDGE_LIMIT);
  return { nodes: visible, edges: links, omittedNodes: nodes.length - visible.length, omittedEdges: edges.length - links.length };
}
export function mergeEntries(previous, incoming) {
  return [...new Map([...previous, ...incoming].map((e) => [`${e.repoKey}:${e.sourceKind}:${e.sourceId}`, e])).values()]
    .sort((a, b) => a.seq - b.seq);
}
export function draftKey(scope) {
  return JSON.stringify([scope.repoKey, scope.threadId ?? '', scope.taskId ?? '', scope.recipient ?? '', scope.correlationId ?? '']);
}
export class ProjectDrafts {
  #drafts = new Map();
  #storage;
  constructor(storage) { this.#storage = storage; }
  get(scope) {
    const key = draftKey(scope);
    if (!this.#drafts.has(key)) {
      let text = '';
      let keyForRetry; let submittedBody;
      try {
        const saved = JSON.parse(this.#storage?.getItem(`project-draft:${key}`) ?? 'null');
        text = saved?.text ?? ''; keyForRetry = saved?.idempotencyKey; submittedBody = saved?.submittedBody;
      } catch { /* 저장 제한/비공개 모드에서도 메모리 초안을 유지한다. */ }
      this.#drafts.set(key, { text, files: [], idempotencyKey: keyForRetry, submittedBody, sending: false, error: '' });
    }
    return this.#drafts.get(key);
  }
  save(scope, text) {
    const draft = this.get(scope);
    if (draft.text !== text) { draft.idempotencyKey = undefined; draft.submittedBody = undefined; }
    draft.text = text;
    this.persist(scope);
  }
  persist(scope) {
    const draft = this.get(scope);
    try { this.#storage?.setItem(`project-draft:${draftKey(scope)}`, JSON.stringify({ text: draft.text, idempotencyKey: draft.idempotencyKey, submittedBody: draft.submittedBody })); }
    catch { /* 파일과 초안은 이 탭의 메모리에서 계속 사용할 수 있다. */ }
  }
}
export const deliveryLabel = (entry, available = true) => {
  const status = entry?.delivery?.status ?? entry?.status;
  return ({ queued: available ? 'Saved · queued' : 'Queued — coordinator unavailable',
    processing: 'Processing · response pending', responded: 'Response complete',
    failed: 'Failed', interrupted: 'Interrupted · retry required' })[status] ?? '';
};
