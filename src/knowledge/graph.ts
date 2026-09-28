// ============================================
// OpenSwarm - Knowledge Graph
// In-memory graph with adjacency list + traversal
// ============================================

import type { GraphNode, GraphEdge, EdgeType, NodeType, ProjectSummary, SerializedGraph } from './types.js';

// KnowledgeGraph Class

export class KnowledgeGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];

  // Adjacency list: nodeId → outgoing edges
  private adjacency = new Map<string, GraphEdge[]>();
  // Reverse adjacency list: nodeId → incoming edges
  private reverseAdjacency = new Map<string, GraphEdge[]>();

  readonly projectSlug: string;
  readonly projectPath: string;
  scannedAt: number = 0;
  /** True when a scan/update limit truncated this graph (see incompleteReasons). */
  incomplete: boolean = false;
  incompleteReasons: string[] = [];

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
    // Remove related edges
    this.edges = this.edges.filter(e => e.source !== id && e.target !== id);
    this.adjacency.delete(id);
    this.reverseAdjacency.delete(id);
    // Also remove from other nodes' adjacency lists
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
    // Prevent duplicates
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

  /** Remove only specified edge types from a node's outgoing edges (with adjacency sync) */
  removeOutgoingEdges(nodeId: string, types: EdgeType[]): void {
    const typeSet = new Set<string>(types);

    // Collect removal targets
    const toRemove = this.edges.filter(e => e.source === nodeId && typeSet.has(e.type));
    if (toRemove.length === 0) return;

    // Remove from main edge array
    this.edges = this.edges.filter(e => !(e.source === nodeId && typeSet.has(e.type)));

    // Sync adjacency map
    const outEdges = this.adjacency.get(nodeId);
    if (outEdges) {
      this.adjacency.set(nodeId, outEdges.filter(e => !typeSet.has(e.type)));
    }

    // Sync reverseAdjacency map: remove incoming edges from removed edges' targets
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

  /** Child nodes contained by a specific node (contains edges) */
  getChildren(nodeId: string): GraphNode[] {
    const outEdges = this.adjacency.get(nodeId) ?? [];
    return outEdges
      .filter(e => e.type === 'contains')
      .map(e => this.nodes.get(e.target))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** Modules imported by a specific module */
  getImports(nodeId: string): GraphNode[] {
    const outEdges = this.adjacency.get(nodeId) ?? [];
    return outEdges
      .filter(e => e.type === 'imports')
      .map(e => this.nodes.get(e.target))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** Modules that import a specific module (reverse direction) */
  getDependents(nodeId: string): GraphNode[] {
    const inEdges = this.reverseAdjacency.get(nodeId) ?? [];
    return inEdges
      .filter(e => e.type === 'imports')
      .map(e => this.nodes.get(e.source))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** Test files for a specific module */
  getTests(nodeId: string): GraphNode[] {
    const inEdges = this.reverseAdjacency.get(nodeId) ?? [];
    return inEdges
      .filter(e => e.type === 'tests')
      .map(e => this.nodes.get(e.source))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** Modules tested by a specific test file */
  getTestedModules(testNodeId: string): GraphNode[] {
    const outEdges = this.adjacency.get(testNodeId) ?? [];
    return outEdges
      .filter(e => e.type === 'tests')
      .map(e => this.nodes.get(e.target))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** Nodes connected by a specific edge type */
  getConnected(nodeId: string, edgeType: EdgeType, direction: 'outgoing' | 'incoming' = 'outgoing'): GraphNode[] {
    const edgeList = direction === 'outgoing'
      ? (this.adjacency.get(nodeId) ?? [])
      : (this.reverseAdjacency.get(nodeId) ?? []);

    return edgeList
      .filter(e => e.type === edgeType)
      .map(e => this.nodes.get(direction === 'outgoing' ? e.target : e.source))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** Transitive dependency traversal (BFS) */
  getTransitiveDependents(nodeId: string, maxDepth: number = 5): GraphNode[] {
    const discovered = new Set<string>([nodeId]);
    const result: GraphNode[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth > maxDepth) continue;

      const dependents = this.getDependents(id);
      for (const dep of dependents) {
        if (!discovered.has(dep.id)) {
          discovered.add(dep.id);
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

  /** Search by module name or path segment */
  findModules(query: string): GraphNode[] {
    const lower = query.toLowerCase();
    return this.getAllNodes().filter(n =>
      (n.type === 'module' || n.type === 'test_file') &&
      (n.id.toLowerCase().includes(lower) || n.name.toLowerCase().includes(lower))
    );
  }

  /** Build project summary */
  buildSummary(): ProjectSummary {
    const modules = this.getNodesByType('module');
    const testFiles = this.getNodesByType('test_file');

    // Hot modules: top 5 by churn score
    const hotModules = modules
      .filter(m => m.gitInfo?.churnScore !== undefined)
      .sort((a, b) => (b.gitInfo?.churnScore ?? 0) - (a.gitInfo?.churnScore ?? 0))
      .slice(0, 5)
      .map(m => m.id);

    // Untested modules: modules with no test edges
    const testedModuleIds = new Set(
      this.edges
        .filter(e => e.type === 'tests')
        .map(e => e.target)
    );
    const untestedModules = modules
      .filter(m => !testedModuleIds.has(m.id))
      .map(m => m.id);

    // Average churn score
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
      incomplete: this.incomplete,
      incompleteReasons: this.incompleteReasons,
      nodes: this.getAllNodes(),
      edges: this.getAllEdges(),
      summary: this.buildSummary(),
    };
  }

  static deserialize(data: SerializedGraph): KnowledgeGraph {
    const graph = new KnowledgeGraph(data.projectSlug, data.projectPath);
    graph.scannedAt = data.scannedAt;
    graph.incomplete = data.incomplete ?? false;
    graph.incompleteReasons = data.incompleteReasons ?? [];
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
