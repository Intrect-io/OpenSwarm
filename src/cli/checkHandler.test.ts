import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeEntity, RegistryStats, FileBrief } from '../registry/schema.js';
import type { ScanResult } from '../registry/entityScanner.js';
import type { BsScanResult } from '../registry/bsDetector.js';

// Force colors.ts to render plain (uncolored) text regardless of TTY state so
// badge/format assertions are deterministic across environments.
process.env.NO_COLOR = '1';

// Wrap readFileSync so individual tests can force it to throw a non-Error
// value (checkHandler.ts's catch branches special-case `err instanceof Error`
// vs. not — real fs/JSON errors are always Error instances, but the code
// still guards the non-Error case, so we simulate it here).
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const store = vi.hoisted(() => ({
  getStats: vi.fn(),
  listEntities: vi.fn(),
  deprecatedEntities: vi.fn(),
  untestedEntities: vi.fn(),
  highRiskEntities: vi.fn(),
  entitiesByTag: vi.fn(),
  searchEntities: vi.fn(),
  fileBrief: vi.fn(),
  getEntityByName: vi.fn(),
  getEntity: vi.fn(),
  deprecateEntity: vi.fn(),
  changeEntityStatus: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  addEvent: vi.fn(),
  updateEntity: vi.fn(),
  addWarning: vi.fn(),
}));

const closeRegistryStore = vi.hoisted(() => vi.fn());
const scanRepositoryMock = vi.hoisted(() => vi.fn());
const bsScanRepositoryMock = vi.hoisted(() => vi.fn());

vi.mock('../registry/sqliteStore.js', () => ({
  // Keep in sync with production page cap used by handleCheck --tree pagination.
  LIST_ENTITIES_MAX_LIMIT: 2,
  getRegistryStore: () => store,
  closeRegistryStore,
}));

vi.mock('../registry/entityScanner.js', () => ({
  scanRepository: scanRepositoryMock,
}));

vi.mock('../registry/bsDetector.js', () => ({
  scanRepository: bsScanRepositoryMock,
}));

// ---------- fixtures ----------

const emptyStats = (): RegistryStats => ({
  total: 0,
  byKind: [],
  byStatus: [],
  deprecated: 0,
  untested: 0,
  highRisk: 0,
  withWarnings: 0,
});

const entity = (over: Partial<CodeEntity> = {}): CodeEntity => ({
  id: 'e1',
  projectId: 'proj',
  kind: 'function',
  name: 'doThing',
  qualifiedName: 'src/x.ts::doThing',
  filePath: 'src/x.ts',
  lineStart: 10,
  lineEnd: 20,
  status: 'active',
  hasTests: true,
  riskLevel: 'low',
  description: '',
  notes: '',
  tags: [],
  warnings: [],
  linkedIssueIds: [],
  linkedMemoryIds: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

const bsResult = (over: Partial<BsScanResult> = {}): BsScanResult => ({
  issues: [],
  filesScanned: 3,
  critical: 0,
  warning: 0,
  minor: 0,
  bsScore: 0,
  ...over,
});

const scanResult = (over: Partial<ScanResult> = {}): ScanResult => ({
  scanned: 5,
  extracted: 8,
  registered: 2,
  updated: 1,
  removed: 0,
  testsMapped: 3,
  errors: [],
  durationMs: 42,
  languageBreakdown: {},
  ...over,
});

let logs: string[];
let errors: string[];
let exitCalls: number[];

beforeEach(() => {
  logs = [];
  errors = [];
  exitCalls = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    errors.push(args.join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`process.exit(${code})`);
  }) as never);

  store.getStats.mockReset().mockReturnValue(emptyStats());
  store.listEntities.mockReset().mockReturnValue({ entities: [], total: 0 });
  store.deprecatedEntities.mockReset().mockReturnValue([]);
  store.untestedEntities.mockReset().mockReturnValue([]);
  store.highRiskEntities.mockReset().mockReturnValue([]);
  store.entitiesByTag.mockReset().mockReturnValue([]);
  store.searchEntities.mockReset().mockReturnValue([]);
  store.fileBrief.mockReset().mockReturnValue({ filePath: '', summary: '', entities: [] } as FileBrief);
  store.getEntityByName.mockReset().mockReturnValue(null);
  store.getEntity.mockReset().mockReturnValue(null);
  store.deprecateEntity.mockReset();
  store.changeEntityStatus.mockReset();
  store.addTag.mockReset();
  store.removeTag.mockReset();
  store.addEvent.mockReset();
  store.updateEntity.mockReset();
  store.addWarning.mockReset();
  closeRegistryStore.mockReset();
  scanRepositoryMock.mockReset().mockResolvedValue(scanResult());
  bsScanRepositoryMock.mockReset().mockResolvedValue(bsResult());
});

afterEach(() => {
  vi.restoreAllMocks();
});

const out = () => logs.join('\n');

// ---------- resolveProjectId (indirectly, via --stats project scoping) ----------

describe('resolveProjectId (via handleCheck --stats)', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'openswarm-check-'));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  it('reads the name from package.json and strips a scope prefix', async () => {
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: '@intrect/project-a' }), 'utf-8');
    process.chdir(tmp);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(store.getStats).toHaveBeenCalledWith('project-a');
  });

  it('uses an unscoped package.json name as-is', async () => {
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'plain-name' }), 'utf-8');
    process.chdir(tmp);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(store.getStats).toHaveBeenCalledWith('plain-name');
  });

  it('falls back to Cargo.toml when package.json parsing fails', async () => {
    await writeFile(join(tmp, 'package.json'), '{ not valid json', 'utf-8');
    await writeFile(join(tmp, 'Cargo.toml'), '[package]\nname = "rust-crate"\nversion = "0.1.0"', 'utf-8');
    process.chdir(tmp);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(store.getStats).toHaveBeenCalledWith('rust-crate');
    expect(errors.join('\n') + logs.join('\n')).toMatch(/package\.json 파싱 실패/);
  });

  it('reads module name from go.mod when no package.json/Cargo.toml name matches', async () => {
    await writeFile(join(tmp, 'go.mod'), 'module github.com/example/mypkg\n\ngo 1.21\n', 'utf-8');
    process.chdir(tmp);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(store.getStats).toHaveBeenCalledWith('mypkg');
  });

  it('falls back to the folder name when the go.mod module path has no trailing segment', async () => {
    // "module foo/" → split('/').pop() is '' (falsy) → the `if (lastSegment)` guard fails.
    await writeFile(join(tmp, 'go.mod'), 'module foo/\n', 'utf-8');
    process.chdir(tmp);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(store.getStats).toHaveBeenCalledWith(tmp.split('/').pop());
  });

  it('falls back to Cargo.toml when package.json throws a non-Error value', async () => {
    await writeFile(join(tmp, 'package.json'), '{}', 'utf-8');
    await writeFile(join(tmp, 'Cargo.toml'), 'name = "rust-crate"', 'utf-8');
    process.chdir(tmp);

    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw 'boom'; // eslint-disable-line no-throw-literal -- simulate a non-Error throw
    });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(store.getStats).toHaveBeenCalledWith('rust-crate');
    expect(errors.join('\n')).toContain('package.json 파싱 실패: boom');
  });

  it('falls back to go.mod when Cargo.toml throws a non-Error value', async () => {
    await writeFile(join(tmp, 'Cargo.toml'), 'name = "rust-crate"', 'utf-8');
    await writeFile(join(tmp, 'go.mod'), 'module example.com/foo/gomodpkg\n', 'utf-8');
    process.chdir(tmp);

    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw 'boom'; // eslint-disable-line no-throw-literal -- simulate a non-Error throw
    });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(store.getStats).toHaveBeenCalledWith('gomodpkg');
    expect(errors.join('\n')).toContain('Cargo.toml 파싱 실패: boom');
  });

  it('falls back to the folder name when go.mod throws a non-Error value', async () => {
    await writeFile(join(tmp, 'go.mod'), 'module example.com/foo/gomodpkg\n', 'utf-8');
    process.chdir(tmp);

    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw 'boom'; // eslint-disable-line no-throw-literal -- simulate a non-Error throw
    });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(store.getStats).toHaveBeenCalledWith(tmp.split('/').pop());
    expect(errors.join('\n')).toContain('go.mod 파싱 실패: boom');
  });

  it('falls back to Cargo.toml being unreadable (a directory) then to go.mod', async () => {
    await mkdir(join(tmp, 'Cargo.toml')); // a directory named Cargo.toml → readFileSync throws EISDIR
    await writeFile(join(tmp, 'go.mod'), 'module example.com/foo/bar\n', 'utf-8');
    process.chdir(tmp);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(store.getStats).toHaveBeenCalledWith('bar');
  });

  it('falls back to folder name when go.mod is unreadable (a directory)', async () => {
    await mkdir(join(tmp, 'go.mod'));
    process.chdir(tmp);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(store.getStats).toHaveBeenCalledWith(tmp.split('/').pop());
  });

  it('falls back to the folder name when no manifest file exists', async () => {
    process.chdir(tmp);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(store.getStats).toHaveBeenCalledWith(tmp.split('/').pop());
  });
});

// ---------- statusBadge / riskBadge / severityBadge / formatEntity (via --deprecated / --highRisk) ----------

describe('statusBadge + riskBadge + severityBadge (via handleCheck --deprecated / --high-risk)', () => {
  it('renders each known status value in the deprecated listing', async () => {
    store.deprecatedEntities.mockReturnValue([
      entity({ id: '1', name: 'a', status: 'active' }),
      entity({ id: '2', name: 'b', status: 'deprecated' }),
      entity({ id: '3', name: 'c', status: 'experimental' }),
      entity({ id: '4', name: 'd', status: 'planned' }),
      entity({ id: '5', name: 'e', status: 'broken' }),
    ]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { deprecated: true });

    expect(out()).toContain('● active');
    expect(out()).toContain('✗ deprecated');
    expect(out()).toContain('◎ experimental');
    expect(out()).toContain('○ planned');
    expect(out()).toContain('⚠ broken');
  });

  it('falls through to the raw value for an unknown status', async () => {
    store.deprecatedEntities.mockReturnValue([entity({ status: 'mystery' as CodeEntity['status'] })]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { deprecated: true });

    expect(out()).toContain('mystery');
  });

  it('renders each known risk level in the high-risk listing', async () => {
    store.highRiskEntities.mockReturnValue([
      entity({ id: '1', name: 'a', riskLevel: 'high' }),
      entity({ id: '2', name: 'b', riskLevel: 'medium' }),
      entity({ id: '3', name: 'c', riskLevel: 'low' }),
    ]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { highRisk: true });

    expect(out()).toContain('risk:HIGH');
    expect(out()).toContain('risk:MED');
    expect(out()).toContain('risk:LOW');
  });

  it('falls through to the raw value for an unknown risk level', async () => {
    store.highRiskEntities.mockReturnValue([entity({ riskLevel: 'catastrophic' as CodeEntity['riskLevel'] })]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { highRisk: true });

    expect(out()).toContain('risk:catastrophic');
  });

  it('renders every severity level for unresolved warnings, filtering out resolved ones', async () => {
    store.highRiskEntities.mockReturnValue([
      entity({
        warnings: [
          { id: 'w1', entityId: '1', severity: 'critical', category: 'security', message: 'crit msg', resolved: false, createdAt: '2026-01-01' },
          { id: 'w2', entityId: '1', severity: 'error', category: 'correctness', message: 'err msg', resolved: false, createdAt: '2026-01-01' },
          { id: 'w3', entityId: '1', severity: 'warning', category: 'style', message: 'warn msg', resolved: false, createdAt: '2026-01-01' },
          { id: 'w4', entityId: '1', severity: 'info', category: 'performance', message: 'info msg', resolved: false, createdAt: '2026-01-01' },
          { id: 'w5', entityId: '1', severity: 'critical', category: 'security', message: 'already fixed', resolved: true, createdAt: '2026-01-01' },
        ],
      }),
    ]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { highRisk: true });

    expect(out()).toContain('CRITICAL [security] crit msg');
    expect(out()).toContain('ERROR [correctness] err msg');
    expect(out()).toContain('WARNING [style] warn msg');
    expect(out()).toContain('INFO [performance] info msg');
    expect(out()).not.toContain('already fixed');
  });

  it('falls through to the raw value for an unknown severity', async () => {
    store.highRiskEntities.mockReturnValue([
      entity({
        warnings: [
          { id: 'w1', entityId: '1', severity: 'mystery' as CodeEntity['warnings'][number]['severity'], category: 'style', message: 'weird', resolved: false, createdAt: '2026-01-01' },
        ],
      }),
    ]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { highRisk: true });

    expect(out()).toContain('mystery [style] weird');
  });
});

describe('formatEntity verbose fields (via handleCheck --search)', () => {
  it('prints signature, author, description, deprecation reason and tags', async () => {
    store.searchEntities.mockReturnValue([
      entity({
        signature: 'function doThing(x: number): void',
        author: 'heewon',
        description: 'does the thing',
        deprecatedReason: 'superseded by doOtherThing',
        tags: [{ tag: 'owner', value: 'team-a' }, { tag: 'legacy' }],
      }),
    ]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { search: 'doThing' });

    expect(out()).toContain('sig: function doThing(x: number): void');
    expect(out()).toContain('author: heewon');
    expect(out()).toContain('does the thing');
    expect(out()).toContain('reason: superseded by doOtherThing');
    expect(out()).toContain('tags: owner=team-a, legacy');
  });

  it('renders the untested test icon and omits verbose lines that have no data', async () => {
    store.searchEntities.mockReturnValue([entity({ hasTests: false, signature: undefined, author: undefined, description: '', tags: [] })]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { search: 'x' });

    expect(out()).toContain('test:✗');
    expect(out()).not.toContain('sig:');
    expect(out()).not.toContain('author:');
  });

  it('renders a location range when lineStart+lineEnd are set, and no location when unset', async () => {
    store.searchEntities.mockReturnValue([
      entity({ id: '1', name: 'ranged', lineStart: 5, lineEnd: 9 }),
      entity({ id: '2', name: 'lineless', lineStart: undefined, lineEnd: undefined }),
    ]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { search: 'x' });

    expect(out()).toContain('ranged:5-9');
    expect(out()).toContain('lineless  '); // no ":N" suffix appended
    expect(out()).not.toContain('lineless:');
  });

  it('renders a single line number when lineStart is set but lineEnd is not', async () => {
    store.searchEntities.mockReturnValue([entity({ id: '1', name: 'singleline', lineStart: 7, lineEnd: undefined })]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { search: 'x' });

    expect(out()).toContain('singleline:7 '); // no "-N" range suffix
    expect(out()).not.toContain('singleline:7-');
  });

  it('reports no matches when the search returns nothing', async () => {
    store.searchEntities.mockReturnValue([]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { search: 'nothing' });

    expect(out()).toContain('No matches');
  });
});

describe('formatEntityCompact (via handleCheck --untested / --tag)', () => {
  it('renders a padded single-line summary', async () => {
    store.untestedEntities.mockReturnValue([
      entity({ kind: 'class', name: 'Widget', filePath: 'src/widget.ts', lineStart: 3, status: 'experimental', hasTests: false, riskLevel: 'medium' }),
    ]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { untested: true });

    expect(out()).toContain('class     Widget                         src/widget.ts:3  experimental test:✗  risk:medium');
  });

  it('omits the line suffix when lineStart is unset', async () => {
    store.untestedEntities.mockReturnValue([
      entity({ kind: 'function', name: 'noLine', filePath: 'src/nl.ts', lineStart: undefined, hasTests: false }),
    ]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { untested: true });

    expect(out()).toContain('src/nl.ts ');
    expect(out()).not.toContain('src/nl.ts:');
  });

  it('reports "All tested" when the untested list is empty', async () => {
    store.untestedEntities.mockReturnValue([]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { untested: true });

    expect(out()).toContain('All tested');
  });

  it('filters by tag and reports an empty result', async () => {
    store.entitiesByTag.mockReturnValue([]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { tag: 'wip' });

    expect(store.entitiesByTag).toHaveBeenCalledWith('wip', undefined, 'openswarm');
    expect(out()).toContain('No entities with tag "wip"');
  });

  it('filters by tag and lists matches compactly', async () => {
    store.entitiesByTag.mockReturnValue([entity({ name: 'tagged' })]);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { tag: 'wip' });

    expect(out()).toContain('tagged');
  });
});

// ---------- handleCheck: remaining branches ----------

describe('handleCheck --stats', () => {
  it('prints full stats including byKind/byStatus breakdowns', async () => {
    store.getStats.mockReturnValue({
      total: 10,
      byKind: [{ kind: 'function', count: 7 }],
      byStatus: [{ status: 'active', count: 8 }],
      deprecated: 1,
      untested: 2,
      highRisk: 3,
      withWarnings: 4,
    });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true, project: 'proj-x' });

    expect(store.getStats).toHaveBeenCalledWith('proj-x');
    expect(out()).toContain('Total entities:  10');
    expect(out()).toContain('function     7');
    expect(out()).toContain('active         8');
  });
});

describe('handleCheck --deprecated / --high-risk empty states', () => {
  it('reports None for an empty deprecated list', async () => {
    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { deprecated: true });
    expect(out()).toContain('None');
  });

  it('reports None for an empty high-risk list', async () => {
    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { highRisk: true });
    expect(out()).toContain('None');
  });
});

describe('handleCheck file brief', () => {
  it('prints the summary and entities for a known file', async () => {
    store.fileBrief.mockReturnValue({
      filePath: 'src/x.ts',
      summary: '2 entities, 1 untested',
      entities: [entity()],
    });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck('src/x.ts', {});

    expect(store.fileBrief).toHaveBeenCalledWith('src/x.ts', 'openswarm');
    expect(out()).toContain('File Brief: src/x.ts');
    expect(out()).toContain('2 entities, 1 untested');
  });

  it('prompts to register entities when the file has none', async () => {
    store.fileBrief.mockReturnValue({ filePath: 'src/empty.ts', summary: 'no entities', entities: [] });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck('src/empty.ts', {});

    expect(out()).toContain('No registered entities for this file.');
  });
});

describe('handleCheck default summary (no filePath, no flags)', () => {
  it('shows the empty-registry message when total is 0', async () => {
    store.getStats.mockReturnValue(emptyStats());

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, {});

    expect(out()).toContain('Code Registry: empty');
  });

  it('shows the summary + usage lines when entities exist', async () => {
    store.getStats.mockReturnValue({
      total: 5,
      byKind: [],
      byStatus: [],
      deprecated: 1,
      untested: 2,
      highRisk: 0,
      withWarnings: 1,
    });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, {});

    expect(out()).toContain('Code Registry: 5 entities');
    expect(out()).toContain('1 deprecated, 2 untested, 0 high-risk, 1 with warnings');
    expect(out()).toContain('Usage:');
  });
});

describe('handleCheck --scan', () => {
  it('reports the scan result and post-scan stats', async () => {
    scanRepositoryMock.mockResolvedValue(scanResult({
      languageBreakdown: { ts: 5, py: 2 },
      errors: Array.from({ length: 12 }, (_, i) => `err-${i}`),
    }));
    store.getStats.mockReturnValue({ ...emptyStats(), total: 8 });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { scan: true, project: 'proj-x' });

    expect(scanRepositoryMock).toHaveBeenCalledWith(process.cwd(), 'proj-x', { verbose: undefined });
    expect(out()).toContain('Scan Complete');
    expect(out()).toContain('ts           5 files');
    expect(out()).toContain('py           2 files');
    expect(out()).toContain('Errors (12):');
    expect(out()).toContain('...and 2 more');
    expect(out()).toContain('Total: 8');
  });

  it('omits the language breakdown and errors sections when there are none', async () => {
    scanRepositoryMock.mockResolvedValue(scanResult());

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { scan: true });

    expect(out()).not.toContain('By language:');
    expect(out()).not.toContain('Errors (');
  });

  it('lists errors in full (no truncation) when there are 10 or fewer', async () => {
    scanRepositoryMock.mockResolvedValue(scanResult({ errors: ['e1', 'e2', 'e3'] }));

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { scan: true });

    expect(out()).toContain('Errors (3):');
    expect(out()).not.toContain('more');
  });

  it('marks removed entities in red when the scan removes at least one', async () => {
    scanRepositoryMock.mockResolvedValue(scanResult({ removed: 4 }));

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { scan: true });

    expect(out()).toContain('Marked broken:  4');
  });
});

describe('handleCheck --bs', () => {
  it('reports CLEAN status with no issues', async () => {
    bsScanRepositoryMock.mockResolvedValue(bsResult({ filesScanned: 4, bsScore: 0 }));

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { bs: true });

    expect(out()).toContain('Status:        CLEAN');
  });

  it('reports WARN status and lists warning issues, truncating past 30', async () => {
    const warnings = Array.from({ length: 32 }, (_, i) => ({
      severity: 'warning' as const, category: 'style', message: `w${i}`, filePath: `f${i}.ts`, line: i, matchedText: `code${i}`,
    }));
    bsScanRepositoryMock.mockResolvedValue(bsResult({ warning: 32, issues: warnings, bsScore: 1.2 }));

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { bs: true });

    expect(out()).toContain('Status:        WARN');
    expect(out()).toContain('WARNING (권장 수정)');
    expect(out()).toContain('...and 2 more');
  });

  it('lists warning issues in full when there are 30 or fewer (no truncation)', async () => {
    const warnings = Array.from({ length: 5 }, (_, i) => ({
      severity: 'warning' as const, category: 'style', message: `w${i}`, filePath: `f${i}.ts`, line: i, matchedText: `code${i}`,
    }));
    bsScanRepositoryMock.mockResolvedValue(bsResult({ warning: 5, issues: warnings, bsScore: 0.5 }));

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { bs: true });

    expect(out()).toContain('WARNING (권장 수정)');
    expect(out()).not.toContain('more');
  });

  it('reports FAIL status and lists critical + minor issues, truncating minors past 10', async () => {
    const criticals = [{ severity: 'critical' as const, category: 'security', message: 'sql injection', filePath: 'a.ts', line: 1, matchedText: 'exec(sql)' }];
    const minors = Array.from({ length: 11 }, (_, i) => ({
      severity: 'minor' as const, category: 'style', message: `m${i}`, filePath: `m${i}.ts`, line: i, matchedText: `x${i}`,
    }));
    bsScanRepositoryMock.mockResolvedValue(bsResult({ critical: 1, minor: 11, issues: [...criticals, ...minors] }));

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { bs: true });

    expect(out()).toContain('Status:        FAIL');
    expect(out()).toContain('CRITICAL (즉시 수정 필요)');
    expect(out()).toContain('sql injection');
    expect(out()).toContain('MINOR (11건)');
    expect(out()).toContain('...and 1 more');
  });

  it('lists minor issues in full when there are 10 or fewer (no truncation)', async () => {
    const minors = Array.from({ length: 3 }, (_, i) => ({
      severity: 'minor' as const, category: 'style', message: `m${i}`, filePath: `m${i}.ts`, line: i, matchedText: `x${i}`,
    }));
    bsScanRepositoryMock.mockResolvedValue(bsResult({ minor: 3, issues: minors }));

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { bs: true });

    expect(out()).toContain('MINOR (3건)');
    expect(out()).not.toContain('more');
  });
});

describe('handleCheck --ci', () => {
  it('emits pass:true JSON and does not set an exit code when clean', async () => {
    bsScanRepositoryMock.mockResolvedValue(bsResult({ critical: 0 }));
    store.getStats.mockReturnValue({ ...emptyStats(), total: 3 });
    process.exitCode = undefined;

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { ci: true, project: 'proj-x' });

    const parsed = JSON.parse(out());
    expect(parsed.pass).toBe(true);
    expect(parsed.project).toBe('proj-x');
    expect(parsed.registry.total).toBe(3);
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exit code 1 and pass:false when critical BS issues exist', async () => {
    bsScanRepositoryMock.mockResolvedValue(bsResult({ critical: 2 }));
    process.exitCode = undefined;

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { ci: true });

    const parsed = JSON.parse(out());
    expect(parsed.pass).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});

describe('handleCheck --tree', () => {
  it('groups entities by directory/file, flags high-risk/deprecated, and computes tested %', async () => {
    store.listEntities.mockReturnValue({
      entities: [
        // src/a has two files so the per-directory file sort comparator actually runs.
        entity({ id: '1', filePath: 'src/a/x.ts', kind: 'function', hasTests: true, riskLevel: 'low', status: 'active' }),
        entity({ id: '2', filePath: 'src/a/x.ts', kind: 'class', hasTests: false, riskLevel: 'high', status: 'active' }),
        entity({ id: '4', filePath: 'src/a/z.ts', kind: 'function', hasTests: true, riskLevel: 'low', status: 'active' }),
        entity({ id: '5', filePath: 'src/a/z.ts', kind: 'function', hasTests: true, riskLevel: 'low', status: 'active' }),
        entity({ id: '6', filePath: 'src/a/z.ts', kind: 'function', hasTests: false, riskLevel: 'low', status: 'active' }),
        entity({ id: '3', filePath: 'src/b/y.ts', kind: 'function', hasTests: false, riskLevel: 'low', status: 'deprecated' }),
      ],
      total: 6,
    });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { tree: true, project: 'proj-x' });

    expect(out()).toContain('Code Tree');
    expect(out()).toContain('src/a/');
    expect(out()).toContain('1 high-risk');
    expect(out()).toContain('src/b/');
    expect(out()).toContain('1 deprecated');
    expect(out()).toContain('50% tested'); // x.ts: 1 of 2 tested
    expect(out()).toContain('0% tested'); // y.ts: 0 of 1 tested
    expect(out()).toContain('67% tested'); // z.ts: 2 of 3 tested -> mid-range (>50, <100) color branch
  });

  it('scopes the tree to a path prefix when filePath is given', async () => {
    store.listEntities.mockReturnValue({
      entities: [
        entity({ id: '1', filePath: 'src/a/x.ts' }),
        entity({ id: '2', filePath: 'src/b/y.ts' }),
      ],
      total: 2,
    });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck('src/a', { tree: true });

    expect(out()).toContain('src/a/');
    expect(out()).not.toContain('src/b/');
  });

  it('shows a full test percentage as green-path (100% tested, no flags)', async () => {
    store.listEntities.mockReturnValue({
      entities: [entity({ id: '1', filePath: 'root.ts', hasTests: true, riskLevel: 'low', status: 'active' })],
      total: 1,
    });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { tree: true });

    expect(out()).toContain('100% tested');
  });

  it('paginates --tree listEntities using the store page cap across every page', async () => {
    // LIST_ENTITIES_MAX_LIMIT is mocked to 2 above — five entities require 3 pages.
    const all = [
      entity({ id: '1', filePath: 'src/p1.ts', hasTests: true }),
      entity({ id: '2', filePath: 'src/p2.ts', hasTests: true }),
      entity({ id: '3', filePath: 'src/p3.ts', hasTests: true }),
      entity({ id: '4', filePath: 'src/p4.ts', hasTests: true }),
      entity({ id: '5', filePath: 'src/p5.ts', hasTests: true }),
    ];
    store.listEntities.mockImplementation((filter?: { limit?: number; offset?: number }) => {
      const limit = filter?.limit ?? all.length;
      const offset = filter?.offset ?? 0;
      return { entities: all.slice(offset, offset + limit), total: all.length };
    });

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { tree: true, project: 'proj-x' });

    expect(store.listEntities.mock.calls.length).toBeGreaterThan(1);
    expect(store.listEntities.mock.calls[0][0]).toMatchObject({ limit: 2, offset: 0 });
    expect(store.listEntities.mock.calls[1][0]).toMatchObject({ limit: 2, offset: 2 });
    expect(out()).toContain('src/');
    expect(out()).toContain('p1.ts');
    expect(out()).toContain('p5.ts');
  });
});

// ---------- handleAnnotate ----------

describe('handleAnnotate', () => {
  it('exits 1 when the entity cannot be found by name or search', async () => {
    store.getEntityByName.mockReturnValue(null);
    store.searchEntities.mockReturnValue([]);

    const { handleAnnotate } = await import('./checkHandler.js');
    await expect(handleAnnotate('unknown::thing', {})).rejects.toThrow('process.exit(1)');

    expect(exitCalls).toEqual([1]);
    expect(errors.join('\n')).toContain('Entity not found: "unknown::thing"');
  });

  it('lists multiple matches and returns without annotating', async () => {
    store.getEntityByName.mockReturnValue(null);
    store.searchEntities.mockReturnValue([
      entity({ id: '1', qualifiedName: 'a::x', status: 'active' }),
      entity({ id: '2', qualifiedName: 'b::x', status: 'deprecated' }),
    ]);

    const { handleAnnotate } = await import('./checkHandler.js');
    await handleAnnotate('x', {});

    expect(out()).toContain('Multiple matches for "x"');
    expect(out()).toContain('a::x');
    expect(out()).toContain('b::x');
    expect(store.deprecateEntity).not.toHaveBeenCalled();
  });

  it('resolves a single search match and proceeds to annotate it', async () => {
    store.getEntityByName.mockReturnValue(null);
    store.searchEntities.mockReturnValue([entity({ id: '1', qualifiedName: 'only::match' })]);
    store.getEntity.mockReturnValue(entity({ id: '1', qualifiedName: 'only::match', status: 'deprecated' }));

    const { handleAnnotate } = await import('./checkHandler.js');
    await handleAnnotate('match', { deprecate: true });

    expect(store.deprecateEntity).toHaveBeenCalledWith('1', undefined);
  });

  it('deprecates with and without a reason', async () => {
    store.getEntityByName.mockReturnValue(entity({ id: 'e1' }));

    const { handleAnnotate } = await import('./checkHandler.js');
    await handleAnnotate('q', { deprecate: 'no longer used' });
    expect(store.deprecateEntity).toHaveBeenCalledWith('e1', 'no longer used');
    expect(out()).toContain('Deprecated: no longer used');

    logs.length = 0;
    await handleAnnotate('q', { deprecate: true });
    expect(store.deprecateEntity).toHaveBeenCalledWith('e1', undefined);
    expect(out()).toContain('Deprecated');
  });

  it('changes status when valid, rejects when invalid', async () => {
    store.getEntityByName.mockReturnValue(entity({ id: 'e1' }));

    const { handleAnnotate } = await import('./checkHandler.js');
    await handleAnnotate('q', { status: 'broken' });
    expect(store.changeEntityStatus).toHaveBeenCalledWith('e1', 'broken');
    expect(out()).toContain('Status changed');

    store.changeEntityStatus.mockClear();
    await handleAnnotate('q', { status: 'not-a-status' });
    expect(store.changeEntityStatus).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('Invalid status: not-a-status');
  });

  it('adds a tag with and without a value', async () => {
    store.getEntityByName.mockReturnValue(entity({ id: 'e1' }));

    const { handleAnnotate } = await import('./checkHandler.js');
    await handleAnnotate('q', { tag: 'owner=team-a' });
    expect(store.addTag).toHaveBeenCalledWith('e1', 'owner', 'team-a');

    await handleAnnotate('q', { tag: 'legacy' });
    expect(store.addTag).toHaveBeenCalledWith('e1', 'legacy', undefined);
  });

  it('removes a tag', async () => {
    store.getEntityByName.mockReturnValue(entity({ id: 'e1' }));

    const { handleAnnotate } = await import('./checkHandler.js');
    await handleAnnotate('q', { untag: 'legacy' });
    expect(store.removeTag).toHaveBeenCalledWith('e1', 'legacy');
    expect(out()).toContain('Removed tag: legacy');
  });

  it('adds a note as a cli-authored event', async () => {
    store.getEntityByName.mockReturnValue(entity({ id: 'e1' }));

    const { handleAnnotate } = await import('./checkHandler.js');
    await handleAnnotate('q', { note: 'looks fine' });
    expect(store.addEvent).toHaveBeenCalledWith('e1', 'note_added', { content: 'looks fine', actor: 'cli' });
    expect(out()).toContain('Note added');
  });

  it('updates risk when valid, rejects when invalid', async () => {
    store.getEntityByName.mockReturnValue(entity({ id: 'e1' }));

    const { handleAnnotate } = await import('./checkHandler.js');
    await handleAnnotate('q', { risk: 'high' });
    expect(store.updateEntity).toHaveBeenCalledWith('e1', { riskLevel: 'high' }, 'cli');
    expect(out()).toContain('Risk: HIGH');

    store.updateEntity.mockClear();
    await handleAnnotate('q', { risk: 'extreme' });
    expect(store.updateEntity).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('Invalid risk: extreme');
  });

  it('adds a warning when the format matches, rejects malformed input', async () => {
    store.getEntityByName.mockReturnValue(entity({ id: 'e1' }));

    const { handleAnnotate } = await import('./checkHandler.js');
    await handleAnnotate('q', { warn: 'error/security: SQL injection risk' });
    expect(store.addWarning).toHaveBeenCalledWith('e1', 'error', 'security', 'SQL injection risk');
    expect(out()).toContain('ERROR [security] SQL injection risk');

    store.addWarning.mockClear();
    await handleAnnotate('q', { warn: 'not a valid warning' });
    expect(store.addWarning).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('Invalid warning format');
  });

  it('reports no changes when no annotation flags are passed', async () => {
    store.getEntityByName.mockReturnValue(entity({ id: 'e1' }));

    const { handleAnnotate } = await import('./checkHandler.js');
    await handleAnnotate('q', {});

    expect(out()).toContain('No changes. Use --deprecate, --status, --tag, --note, --risk, or --warn');
  });

  it('prints the updated entity state after a successful change', async () => {
    store.getEntityByName.mockReturnValue(entity({ id: 'e1', qualifiedName: 'src/x.ts::doThing' }));
    store.getEntity.mockReturnValue(entity({ id: 'e1', qualifiedName: 'src/x.ts::doThing', status: 'deprecated' }));

    const { handleAnnotate } = await import('./checkHandler.js');
    await handleAnnotate('q', { deprecate: true });

    expect(store.getEntity).toHaveBeenCalledWith('e1');
    expect(out()).toContain('Updated state:');
    expect(out()).toContain('doThing');
  });

  it('closes the registry store even when annotation throws', async () => {
    store.getEntityByName.mockReturnValue(null);
    store.searchEntities.mockReturnValue([]);

    const { handleAnnotate } = await import('./checkHandler.js');
    await expect(handleAnnotate('missing', {})).rejects.toThrow();

    expect(closeRegistryStore).toHaveBeenCalled();
  });
});

describe('handleCheck closes the registry store in all cases', () => {
  it('calls closeRegistryStore after a normal run', async () => {
    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, {});
    expect(closeRegistryStore).toHaveBeenCalled();
  });
});
