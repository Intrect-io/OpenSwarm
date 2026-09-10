import { mkdtempSync, rmSync, symlinkSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeGraph } from './graph.js';
import { exportRepoGraph } from './graphqlExporter.js';

describe('exportRepoGraph symlink refusal', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('refuses to export when .openswarm is a symlink', () => {
    root = mkdtempSync(join(tmpdir(), 'gql-export-'));
    const project = join(root, 'project');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(project);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(project, '.openswarm'));

    const graph = new KnowledgeGraph('p', project);
    graph.scannedAt = Date.now();

    expect(() => exportRepoGraph(graph, project)).toThrow(/refusing to export/);
    expect(existsSync(join(elsewhere, 'repo.graphql'))).toBe(false);
  });

  it('exports into a real .openswarm directory', () => {
    root = mkdtempSync(join(tmpdir(), 'gql-export-ok-'));
    const project = join(root, 'project');
    mkdirSync(project);
    const graph = new KnowledgeGraph('p', project);
    graph.scannedAt = Date.now();

    const result = exportRepoGraph(graph, project);
    expect(existsSync(result.schemaPath)).toBe(true);
    expect(existsSync(result.snapshotPath)).toBe(true);
  });
});
