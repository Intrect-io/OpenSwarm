// Coverage companion for projectHandler.ts — targets handleProjectAdd,
// mapRepoToLinear (interactive Linear picker), handleProjectList, and
// handleProjectRm, none of which the base projectHandler.test.ts exercises
// (it only covers the pure addProject/removeProject/loadRepos helpers).
//
// Every fs call and dynamic Linear import is mocked so the tests never touch
// the real ~/.claude/openswarm-repos.json or make a network call.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const statSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const renameSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  statSync: statSyncMock,
  mkdirSync: mkdirSyncMock,
  renameSync: renameSyncMock,
}));
vi.mock('../support/atomicFile.js', () => ({
  atomicWriteFileSync: (path: string, contents: string) => writeFileSyncMock(path, contents),
}));

const loadRepoMetadataMock = vi.fn();
vi.mock('../support/repoMetadata.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../support/repoMetadata.js')>();
  return { ...actual, loadRepoMetadata: loadRepoMetadataMock };
});

const resolveLinearCredentialMock = vi.fn();
const pickAndSaveLinearMappingMock = vi.fn();
vi.mock('./linearMapping.js', () => ({
  resolveLinearCredential: resolveLinearCredentialMock,
  pickAndSaveLinearMapping: pickAndSaveLinearMappingMock,
}));

// Imported AFTER the mocks above so the module picks up the mocked `node:fs`.
const {
  handleProjectAdd,
  handleProjectList,
  handleProjectRm,
} = await import('./projectHandler.js');
const { RepoMetadataError } = await import('../support/repoMetadata.js');

const REPO_PATH = '/repo/under/test';

/** Configure the fs mock for a repo directory that exists and has (or lacks) a .git dir. */
function setupFs(opts: { isDir?: boolean; hasGit?: boolean; reposFileContent?: string } = {}) {
  const { isDir = true, hasGit = true, reposFileContent } = opts;
  existsSyncMock.mockImplementation((p: string) => {
    if (p === REPO_PATH) return isDir;
    if (p === `${REPO_PATH}/.git`) return hasGit;
    if (typeof p === 'string' && p.endsWith('openswarm-repos.json')) return reposFileContent !== undefined;
    return false;
  });
  statSyncMock.mockImplementation(() => ({ isDirectory: () => isDir }));
  readFileSyncMock.mockImplementation(() => reposFileContent ?? '{}');
}

let logs: string[] = [];
let errors: string[] = [];
let exitSpy: ReturnType<typeof vi.spyOn>;
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((l: string) => {
    logs.push(l);
  });
  vi.spyOn(console, 'error').mockImplementation((l: string) => {
    errors.push(l);
  });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  originalIsTTY = process.stdin.isTTY;
  setupFs();
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
});

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

describe('handleProjectAdd', () => {
  it('errors and exits when the path is not a directory', async () => {
    setupFs({ isDir: false });
    await expect(handleProjectAdd(REPO_PATH)).rejects.toThrow('process.exit(1)');
    expect(errors.join('\n')).toContain('Not a directory');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('warns (but proceeds) when the directory has no .git', async () => {
    setupFs({ hasGit: false });
    setTTY(false); // short-circuit mapRepoToLinear at the non-interactive branch
    loadRepoMetadataMock.mockResolvedValue(null);
    await handleProjectAdd(REPO_PATH);
    expect(errors.join('\n')).toMatch(/not a git repo/);
    expect(writeFileSyncMock).toHaveBeenCalled(); // repo still registered
  });

  it('saves the repo and skips the git warning when .git is present', async () => {
    setTTY(false);
    loadRepoMetadataMock.mockResolvedValue(null);
    await handleProjectAdd(REPO_PATH);
    expect(errors.join('\n')).not.toMatch(/not a git repo/);
    expect(logs.join('\n')).toContain(`Added work repo: ${REPO_PATH}`);
  });
});

describe('mapRepoToLinear branches (via handleProjectAdd)', () => {
  it('logs "already mapped" and returns early when openswarm.json has a Linear project', async () => {
    loadRepoMetadataMock.mockResolvedValue({ linear: { projectId: 'proj-1', projectName: 'Demo', teamKey: 'INT' } });
    await handleProjectAdd(REPO_PATH);
    expect(logs.join('\n')).toContain('already mapped → INT/Demo');
    expect(resolveLinearCredentialMock).not.toHaveBeenCalled();
  });

  it('falls back to the projectId when projectName is absent', async () => {
    loadRepoMetadataMock.mockResolvedValue({ linear: { projectId: 'proj-1' } });
    await handleProjectAdd(REPO_PATH);
    expect(logs.join('\n')).toContain('already mapped → ?/proj-1');
  });

  it('warns and re-maps when loadRepoMetadata throws RepoMetadataError', async () => {
    loadRepoMetadataMock.mockRejectedValue(new RepoMetadataError('bad json', `${REPO_PATH}/openswarm.json`));
    setTTY(false);
    await handleProjectAdd(REPO_PATH);
    expect(errors.join('\n')).toContain('bad json');
    expect(errors.join('\n')).toContain('re-mapping');
  });

  it('silently continues when loadRepoMetadata throws a non-RepoMetadataError', async () => {
    loadRepoMetadataMock.mockRejectedValue(new Error('unexpected'));
    setTTY(false);
    await handleProjectAdd(REPO_PATH);
    expect(errors.join('\n')).not.toContain('re-mapping');
    expect(logs.join('\n')).toContain('Linear mapping skipped (non-interactive)');
  });

  it('skips mapping (non-interactive) when stdin is not a TTY', async () => {
    loadRepoMetadataMock.mockResolvedValue(null);
    setTTY(false);
    await handleProjectAdd(REPO_PATH);
    expect(logs.join('\n')).toContain('Linear mapping skipped (non-interactive)');
  });

  it('reports Linear not configured when there is a TTY but no credential', async () => {
    loadRepoMetadataMock.mockResolvedValue(null);
    setTTY(true);
    resolveLinearCredentialMock.mockResolvedValue(null);
    await handleProjectAdd(REPO_PATH);
    expect(logs.join('\n')).toContain('Linear not configured');
  });

  it('reports no teams visible when the picker returns kind "no-teams"', async () => {
    loadRepoMetadataMock.mockResolvedValue(null);
    setTTY(true);
    resolveLinearCredentialMock.mockResolvedValue({ apiKey: 'x' });
    pickAndSaveLinearMappingMock.mockResolvedValue({ kind: 'no-teams' });
    await handleProjectAdd(REPO_PATH);
    expect(logs.join('\n')).toContain('No Linear teams visible');
  });

  it('reports a skip when the user skips the interactive picker', async () => {
    loadRepoMetadataMock.mockResolvedValue(null);
    setTTY(true);
    resolveLinearCredentialMock.mockResolvedValue({ apiKey: 'x' });
    pickAndSaveLinearMappingMock.mockResolvedValue({ kind: 'skipped' });
    await handleProjectAdd(REPO_PATH);
    expect(logs.join('\n')).toContain('Repo mapping skipped');
  });

  it('completes silently when the picker saves a new mapping', async () => {
    loadRepoMetadataMock.mockResolvedValue(null);
    setTTY(true);
    resolveLinearCredentialMock.mockResolvedValue({ apiKey: 'x' });
    pickAndSaveLinearMappingMock.mockResolvedValue({
      kind: 'saved',
      teamId: 'team-1',
      mapping: { teamId: 'team-1', projectId: 'proj-2' },
    });
    await expect(handleProjectAdd(REPO_PATH)).resolves.toBeUndefined();
    expect(logs.join('\n')).not.toContain('No Linear teams visible');
    expect(logs.join('\n')).not.toContain('Repo mapping skipped');
  });

  it('swallows an @inquirer ExitPromptError as a skip', async () => {
    loadRepoMetadataMock.mockResolvedValue(null);
    setTTY(true);
    resolveLinearCredentialMock.mockResolvedValue({ apiKey: 'x' });
    const exitPromptError = new Error('user pressed ctrl-c');
    exitPromptError.name = 'ExitPromptError';
    pickAndSaveLinearMappingMock.mockRejectedValue(exitPromptError);
    await handleProjectAdd(REPO_PATH);
    expect(logs.join('\n')).toContain('Linear mapping skipped.');
  });

  it('rethrows a non-ExitPromptError from the picker', async () => {
    loadRepoMetadataMock.mockResolvedValue(null);
    setTTY(true);
    resolveLinearCredentialMock.mockResolvedValue({ apiKey: 'x' });
    pickAndSaveLinearMappingMock.mockRejectedValue(new Error('network down'));
    await expect(handleProjectAdd(REPO_PATH)).rejects.toThrow('network down');
  });
});

describe('loadRepos malformed-JSON recovery (via handleProjectList)', () => {
  it('preserves the invalid registry and reports the corruption', () => {
    readFileSyncMock.mockReturnValue('{ not valid json ,, }');
    existsSyncMock.mockImplementation((p: string) => typeof p === 'string' && p.endsWith('openswarm-repos.json'));
    expect(() => handleProjectList()).toThrow(/preserved as/);
    expect(renameSyncMock).toHaveBeenCalledOnce();
  });

  it('reports quarantine failure accurately when renameSync fails', () => {
    readFileSyncMock.mockReturnValue('{ not valid json ,, }');
    existsSyncMock.mockImplementation((p: string) => typeof p === 'string' && p.endsWith('openswarm-repos.json'));
    renameSyncMock.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(() => handleProjectList()).toThrow(/quarantine .* failed — original left in place/);
  });
});

describe('loadRepos defaults missing fields (via handleProjectList)', () => {
  it('defaults every field to [] when the repos file only has a subset', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({})); // no pinned/enabled/basePaths/removedConfigPaths at all
    existsSyncMock.mockImplementation((p: string) => typeof p === 'string' && p.endsWith('openswarm-repos.json'));
    handleProjectList();
    expect(logs.join('\n')).toContain('(none)');
  });
});

describe('handleProjectList', () => {
  it('prints "(none)" when there are no enabled repos', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ pinned: [], enabled: [], basePaths: [], removedConfigPaths: [] }));
    existsSyncMock.mockImplementation((p: string) => typeof p === 'string' && p.endsWith('openswarm-repos.json'));
    handleProjectList();
    expect(logs.join('\n')).toContain('(none)');
  });

  it('lists enabled repos and marks pinned ones, plus the denylist section', () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        pinned: ['/a'],
        enabled: ['/a', '/b'],
        basePaths: [],
        removedConfigPaths: ['/c'],
      }),
    );
    existsSyncMock.mockImplementation((p: string) => typeof p === 'string' && p.endsWith('openswarm-repos.json'));
    handleProjectList();
    const out = logs.join('\n');
    expect(out).toContain('/a');
    expect(out).toContain('(pinned)');
    expect(out).toContain('/b');
    expect(out).toContain('Excluded (denylist):');
    expect(out).toContain('/c');
  });
});

describe('handleProjectRm', () => {
  it('warns when removing a path that was not registered, but still denylists it', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ pinned: [], enabled: [], basePaths: [], removedConfigPaths: [] }));
    existsSyncMock.mockImplementation((p: string) => typeof p === 'string' && p.endsWith('openswarm-repos.json'));
    handleProjectRm('/never/added');
    expect(errors.join('\n')).toContain('Not a registered work repo');
    expect(writeFileSyncMock).toHaveBeenCalled();
    const written = JSON.parse(writeFileSyncMock.mock.calls[0][1] as string);
    expect(written.removedConfigPaths).toContain('/never/added');
  });

  it('removes a registered repo without the warning', () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ pinned: ['/x'], enabled: ['/x'], basePaths: [], removedConfigPaths: [] }),
    );
    existsSyncMock.mockImplementation((p: string) => typeof p === 'string' && p.endsWith('openswarm-repos.json'));
    handleProjectRm('/x');
    expect(errors.join('\n')).not.toContain('Not a registered work repo');
    expect(logs.join('\n')).toContain('Removed work repo: /x');
  });
});
