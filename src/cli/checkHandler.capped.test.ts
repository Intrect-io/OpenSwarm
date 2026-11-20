// AGT-3470 review: `check --deprecated/--untested/--high-risk` listings are
// capped by HELPER_QUERY_MAX_LIMIT; a capped heading must show the real total.
// Split from checkHandler.test.ts (size limit); same mocking approach.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeEntity, RegistryStats } from '../registry/schema.js';

process.env.NO_COLOR = '1';

const store = vi.hoisted(() => ({
  getStats: vi.fn(),
  deprecatedEntities: vi.fn(),
  untestedEntities: vi.fn(),
  highRiskEntities: vi.fn(),
}));

vi.mock('../registry/sqliteStore.js', () => ({
  LIST_ENTITIES_MAX_LIMIT: 2,
  // Small helper-query cap so the capped-listing heading is cheap to exercise.
  HELPER_QUERY_MAX_LIMIT: 3,
  getRegistryStore: () => store,
  closeRegistryStore: vi.fn(),
}));
vi.mock('../registry/entityScanner.js', () => ({ scanRepository: vi.fn() }));
vi.mock('../registry/bsDetector.js', () => ({ scanRepository: vi.fn() }));

const emptyStats = (): RegistryStats => ({
  total: 0, byKind: [], byStatus: [], deprecated: 0, untested: 0, highRisk: 0, withWarnings: 0,
});

const entity = (over: Partial<CodeEntity> = {}): CodeEntity => ({
  id: 'e1', projectId: 'proj', kind: 'function', name: 'doThing', qualifiedName: 'src/x.ts::doThing',
  filePath: 'src/x.ts', lineStart: 10, lineEnd: 20, status: 'active', hasTests: true, riskLevel: 'low',
  description: '', notes: '', tags: [], warnings: [], linkedIssueIds: [], linkedMemoryIds: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
});

let logs: string[];
const out = () => logs.join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('capped helper listings show the real total (AGT-3470 review)', () => {
  const three = () => [entity({ id: '1' }), entity({ id: '2' }), entity({ id: '3' })];

  it.each([
    ['deprecated', 'deprecatedEntities', 'Deprecated Entities'],
    ['untested', 'untestedEntities', 'Untested Active Entities'],
    ['highRisk', 'highRiskEntities', 'High Risk Entities'],
  ] as const)('--%s prints "showing N of TOTAL" when the listing hits the cap', async (flag, method, title) => {
    store[method].mockReturnValue(three());
    const stats: RegistryStats = emptyStats();
    stats[flag] = 742;
    store.getStats.mockReturnValue(stats);

    const { handleCheck } = await import('./checkHandler.js');
    const opts: { deprecated?: boolean; untested?: boolean; highRisk?: boolean; project: string } = { project: 'proj' };
    opts[flag] = true;
    await handleCheck(undefined, opts);

    expect(out()).toContain(`${title} (showing 3 of 742, capped at 3)`);
    expect(store.getStats).toHaveBeenCalledWith('proj');
  });

  it('keeps the plain count and skips the stats query below the cap', async () => {
    store.deprecatedEntities.mockReturnValue([entity()]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { deprecated: true, project: 'proj' });

    expect(out()).toContain('Deprecated Entities (1)');
    expect(store.getStats).not.toHaveBeenCalled();
  });
});
