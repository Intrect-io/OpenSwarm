// ============================================
// OpenSwarm - Knowledge Graph
// In-memory graph with adjacency list + traversal
// ============================================

import type { GraphNode, GraphEdge, EdgeType, NodeType, ProjectSummary, SerializedGraph } from './types.js';

// ============================================
// KnowledgeGraph Class
// ============================================

export class KnowledgeGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];

  // 인접 리스트: nodeId → outgoing edges
  private adjacency = new Map<string, GraphEdge[]>();
  // 역방향 인접 리스트: nodeId → incoming edges
  private reverseAdjacency = new Map<string, GraphEdge[]>();

  readonly projectSlug: string;
  readonly projectPath: string;
  scannedAt: number = 0;

  constructor(projectSlug: string, projectPath: string) {
    this.projectSlug = projectSlug;
    this.projectPath = projectPath;
  }

  // ============================================
  // Node Operations
  // ============================================

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.adjacency.has(node.id)) {
      this.adjacency.set(node.id, []);
    }
    if (!this.reverseAdjacency.has(node.id)) {
      this.reverseAdjacency.set(node.id, []);
    }
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  removeNode(id: string): void {
    this.nodes.delete(id);
    // 관련 엣지 제거
    this.edges = this.edges.filter(e => e.source !== id && e.target !== id);
    this.adjacency.delete(id);
    this.reverseAdjacency.delete(id);
    // 다른 노드의 인접 리스트에서도 제거 (역순 반복으로 전체 제거)
    for (const [key, edges] of this.adjacency) {
      const filtered = edges.filter(e => e.target !== id);
      if (filtered.length !== edges.length) this.adjacency.set(key, filtered);
    }
    for (const [key, edges] of this.reverseAdjacency) {
      const filtered = edges.filter(e => e.source !== id);
      if (filtered.length !== edges.length) this.reverseAdjacency.set(key, filtered);
    }
  }

  getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  getNodesByType(type: NodeType): GraphNode[] {
    return this.getAllNodes().filter(n => n.type === type);
  }

  // ============================================
  // Edge Operations
  // ============================================

  addEdge(edge: GraphEdge): void {
    // 중복 방지
    const exists = this.edges.some(
      e => e.source === edge.source && e.target === edge.target && e.type === edge.type
    );
    if (exists) return;

    this.edges.push(edge);

    const outEdges = this.adjacency.get(edge.source);
    if (outEdges) outEdges.push(edge);
    else this.adjacency.set(edge.source, [edge]);

    const inEdges = this.reverseAdjacency.get(edge.target);
    if (inEdges) inEdges.push(edge);
    else this.reverseAdjacency.set(edge.target, [edge]);
  }

  getAllEdges(): GraphEdge[] {
    return this.edges;
  }

  /** 특정 노드의 outgoing 엣지 중 지정 타입만 제거 (adjacency 동기화 포함) */
  removeOutgoingEdges(nodeId: string, types: EdgeType[]): void {
    const typeSet = new Set<string>(types);

    // 제거 대상 수집
    const toRemove = this.edges.filter(e => e.source === nodeId && typeSet.has(e.type));
    if (toRemove.length === 0) return;

    // 메인 엣지 배열에서 제거
    this.edges = this.edges.filter(e => !(e.source === nodeId && typeSet.has(e.type)));

    // adjacency 맵 동기화
    const outEdges = this.adjacency.get(nodeId);
    if (outEdges) {
      this.adjacency.set(nodeId, outEdges.filter(e => !typeSet.has(e.type)));
    }

    // reverseAdjacency 맵 동기화: 제거된 엣지의 타겟에서 incoming 엣지 제거
    for (const edge of toRemove) {
      const inEdges = this.reverseAdjacency.get(edge.target);
      if (inEdges) {
        this.reverseAdjacency.set(
          edge.target,
          inEdges.filter(e => !(e.source === nodeId && typeSet.has(e.type))),
        );
      }
    }
  }

  // ============================================
  // Traversal Queries
  // ============================================

  /** 특정 노드가 포함하는 자식 노드들 (contains 엣지) */
  getChildren(nodeId: string): GraphNode[] {
    const outEdges = this.adjacency.get(nodeId) ?? [];
    return outEdges
      .filter(e => e.type === 'contains')
      .map(e => this.nodes.get(e.target))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** 특정 모듈이 import하는 모듈들 */
  getImports(nodeId: string): GraphNode[] {
    const outEdges = this.adjacency.get(nodeId) ?? [];
    return outEdges
      .filter(e => e.type === 'imports')
      .map(e => this.nodes.get(e.target))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** 특정 모듈을 import하는 모듈들 (역방향) */
  getDependents(nodeId: string): GraphNode[] {
    const inEdges = this.reverseAdjacency.get(nodeId) ?? [];
    return inEdges
      .filter(e => e.type === 'imports')
      .map(e => this.nodes.get(e.source))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** 특정 모듈의 테스트 파일들 */
  getTests(nodeId: string): GraphNode[] {
    const inEdges = this.reverseAdjacency.get(nodeId) ?? [];
    return inEdges
      .filter(e => e.type === 'tests')
      .map(e => this.nodes.get(e.source))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** 특정 테스트 파일이 테스트하는 모듈 */
  getTestedModules(testNodeId: string): GraphNode[] {
    const outEdges = this.adjacency.get(testNodeId) ?? [];
    return outEdges
      .filter(e => e.type === 'tests')
      .map(e => this.nodes.get(e.target))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** 특정 엣지 타입으로 연결된 노드들 */
  getConnected(nodeId: string, edgeType: EdgeType, direction: 'outgoing' | 'incoming' = 'outgoing'): GraphNode[] {
    const edgeList = direction === 'outgoing'
      ? (this.adjacency.get(nodeId) ?? [])
      : (this.reverseAdjacency.get(nodeId) ?? []);

    return edgeList
      .filter(e => e.type === edgeType)
      .map(e => this.nodes.get(direction === 'outgoing' ? e.target : e.source))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** 전이적 의존성 탐색 (BFS) */
  getTransitiveDependents(nodeId: string, maxDepth: number = 5): GraphNode[] {
    const visited = new Set<string>();
    const result: GraphNode[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const dependents = this.getDependents(id);
      for (const dep of dependents) {
        if (!visited.has(dep.id)) {
          result.push(dep);
          queue.push({ id: dep.id, depth: depth + 1 });
        }
      }
    }

    return result;
  }

  // ============================================
  // Analysis Queries
  // ============================================

  /** 모듈 이름 또는 경로 부분으로 검색 */
  findModules(query: string): GraphNode[] {
    const lower = query.toLowerCase();
    return this.getAllNodes().filter(n =>
      (n.type === 'module' || n.type === 'test_file') &&
      (n.id.toLowerCase().includes(lower) || n.name.toLowerCase().includes(lower))
    );
  }

  /** 프로젝트 요약 생성 */
  buildSummary(): ProjectSummary {
    const modules = this.getNodesByType('module');
    const testFiles = this.getNodesByType('test_file');

    // Hot modules: churn score 기준 상위 5개
    const hotModules = modules
      .filter(m => m.gitInfo?.churnScore !== undefined)
      .sort((a, b) => (b.gitInfo?.churnScore ?? 0) - (a.gitInfo?.churnScore ?? 0))
      .slice(0, 5)
      .map(m => m.id);

    // Untested modules: 테스트 엣지가 없는 모듈
    const testedModuleIds = new Set(
      this.edges
        .filter(e => e.type === 'tests')
        .map(e => e.target)
    );
    const untestedModules = modules
      .filter(m => !testedModuleIds.has(m.id))
      .map(m => m.id);

    // 평균 churn score
    const churnScores = modules
      .map(m => m.gitInfo?.churnScore ?? 0)
      .filter(s => s > 0);
    const avgChurnScore = churnScores.length > 0
      ? churnScores.reduce((a, b) => a + b, 0) / churnScores.length
      : 0;

    return {
      totalModules: modules.length,
      totalTestFiles: testFiles.length,
      hotModules,
      untestedModules,
      avgChurnScore: Math.round(avgChurnScore * 1000) / 1000,
    };
  }

  // ============================================
  // Serialization
  // ============================================

  serialize(): SerializedGraph {
    return {
      version: 1,
      projectSlug: this.projectSlug,
      projectPath: this.projectPath,
      scannedAt: this.scannedAt,
      nodes: this.getAllNodes(),
      edges: this.getAllEdges(),
      summary: this.buildSummary(),
    };
  }

  static deserialize(data: SerializedGraph): KnowledgeGraph {
    const graph = new KnowledgeGraph(data.projectSlug, data.projectPath);
    graph.scannedAt = data.scannedAt;
    for (const node of data.nodes) {
      graph.addNode(node);
    }
    for (const edge of data.edges) {
      graph.addEdge(edge);
    }
    return graph;
  }

  // ============================================
  // Utilities
  // ============================================

  clear(): void {
    this.nodes.clear();
    this.edges = [];
    this.adjacency.clear();
    this.reverseAdjacency.clear();
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.length;
  }
}
