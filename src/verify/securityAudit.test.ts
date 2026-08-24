import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => {
  const fn = vi.fn();
  (fn as typeof fn & { [key: symbol]: unknown })[Symbol.for('nodejs.util.promisify.custom')] = (...args: unknown[]) => fn(...args);
  return fn;
});
const fsMock = vi.hoisted(() => ({
  access: vi.fn(),
  cp: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  ...fsMock,
}));

import {
  DEFAULT_SECURITY_AUDIT_CONFIG,
  detectCodeqlLanguages,
  listTrackedSecurityFiles,
  newSecurityFindings,
  runSecurityAudit,
  securityFindingFingerprint,
  selectSecuritySourceFiles,
} from './securityAudit.js';

beforeEach(() => {
  vi.stubEnv('PATH', '/tools');
  vi.clearAllMocks();
  fsMock.access.mockResolvedValue(undefined);
  fsMock.cp.mockResolvedValue(undefined);
  fsMock.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false });
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.mkdtemp.mockResolvedValue('/snapshot');
  fsMock.rm.mockResolvedValue(undefined);
  execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('security audit primitives', () => {
  it('maps only supported tracked source languages', () => {
    expect(detectCodeqlLanguages(['src/a.ts', 'lib/b.py', 'tool/c.rs', 'README.md'])).toEqual([
      'javascript', 'python', 'rust',
    ]);
  });

  it('includes nonignored new source files and deduplicates Git path entries', () => {
    expect(selectSecuritySourceFiles([
      'src/existing.ts',
      'src/newly-created.ts',
      'src/existing.ts',
      'README.md',
      '',
    ])).toEqual(['src/existing.ts', 'src/newly-created.ts']);
  });

  it('treats shifted existing findings as a baseline match', () => {
    const baseline = [{ ruleId: 'codeql/js/x', level: 'error' as const, message: 'issue', filePath: 'src/a.ts', line: 2 }];
    const current = [{ ...baseline[0], line: 20 }, { ruleId: 'codeql/js/y', level: 'error' as const, message: 'new', filePath: 'src/b.ts' }];
    expect(securityFindingFingerprint(baseline[0]!)).not.toContain(':2');
    expect(newSecurityFindings(baseline, current)).toEqual([current[1]]);
  });

  it('keeps an additional result with the same stable fingerprint as new', () => {
    const baseline = [{ ruleId: 'codeql/js/x', level: 'error' as const, message: 'issue', filePath: 'src/a.ts', line: 2 }];
    const existingMoved = { ...baseline[0], line: 20 };
    const newlyIntroducedDuplicate = { ...baseline[0], line: 40 };

    expect(newSecurityFindings(baseline, [existingMoved, newlyIntroducedDuplicate]))
      .toEqual([newlyIntroducedDuplicate]);
  });
});

describe('runSecurityAudit', () => {
  it('does not require CodeQL for a disabled or source-free audit', async () => {
    await expect(runSecurityAudit('/repo', ['src/a.ts'], { enabled: false, maxThreads: 2 }))
      .resolves.toEqual({ status: 'disabled', codeqlLanguages: [], skippedCodeqlLanguages: [], findings: [] });
    await expect(runSecurityAudit('/repo', ['README.md'], DEFAULT_SECURITY_AUDIT_CONFIG))
      .resolves.toEqual({ status: 'passed', codeqlLanguages: [], skippedCodeqlLanguages: [], findings: [] });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('fails closed when CodeQL cannot be found on an absolute PATH entry', async () => {
    fsMock.access.mockRejectedValue(new Error('ENOENT'));

    const audit = await runSecurityAudit('/repo', ['src/a.ts']);

    expect(audit).toMatchObject({ status: 'unavailable', codeqlLanguages: ['javascript'] });
    expect(audit.findings[0]?.ruleId).toBe('openswarm/security-codeql-unavailable');
  });

  it('reports a query-pack preparation failure and cleans its isolated snapshot', async () => {
    execFileMock.mockRejectedValueOnce(Object.assign(new Error('pack failed'), { code: 1, stderr: 'network unavailable' }));

    const audit = await runSecurityAudit('/repo', ['src/a.ts']);

    expect(audit).toMatchObject({ status: 'failed', codeqlLanguages: ['javascript'] });
    expect(audit.findings[0]?.ruleId).toBe('openswarm/security-codeql-query-pack');
    expect(fsMock.rm).toHaveBeenCalledWith('/snapshot', { recursive: true, force: true });
  });

  it('parses SARIF findings from a no-build database run', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({
      version: '2.1.0',
      runs: [{ results: [{
        ruleId: 'js/file-access-to-http',
        message: { text: 'file content reaches an outbound request' },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: 'src/a.ts' }, region: { startLine: 12 },
        } }],
      }] }],
    }));

    const audit = await runSecurityAudit('/repo', ['src/a.ts']);

    expect(audit).toMatchObject({
      status: 'findings',
      codeqlLanguages: ['javascript'],
      findings: [{ ruleId: 'codeql/js/file-access-to-http', filePath: 'src/a.ts', line: 12 }],
    });
    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([
      ['pack', 'download', '--', 'codeql/javascript-queries'],
      expect.arrayContaining(['database', 'create']),
      expect.arrayContaining(['database', 'analyze']),
    ]));
  });

  it('preserves contained file URI locations and rejects locations outside the snapshot', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({
      version: '2.1.0',
      runs: [{ results: [
        {
          ruleId: 'js/xss-through-dom',
          message: { text: 'contained location' },
          locations: [{ physicalLocation: {
            artifactLocation: { uri: 'file:///snapshot/web/main.js' },
            region: { startLine: 85 },
          } }],
        },
        {
          ruleId: 'js/path-injection',
          message: { text: 'external location' },
          locations: [{ physicalLocation: {
            artifactLocation: { uri: 'file:///etc/passwd' },
            region: { startLine: 1 },
          } }],
        },
      ] }],
    }));

    const audit = await runSecurityAudit('/repo', ['web/main.js']);

    expect(audit.findings).toEqual([
      expect.objectContaining({ filePath: 'web/main.js', line: 85 }),
      expect.objectContaining({ filePath: undefined, line: 1 }),
    ]);
  });

  it('records an exact unsupported none-build response as an explicit coverage skip', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('unsupported build mode'), {
        code: 2,
        stderr: 'Swift does not support the none build mode. Please try using one of the following build modes instead: autobuild, manual.',
      }));

    const audit = await runSecurityAudit('/repo', ['host/App.swift']);

    expect(audit).toMatchObject({
      status: 'partial',
      codeqlLanguages: ['swift'],
      skippedCodeqlLanguages: ['swift'],
      findings: [],
    });
    expect(audit.detail).toContain('build-mode=none: swift');
  });

  it('keeps unrelated database creation failures fail-closed', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('database failed'), {
        code: 1,
        stderr: 'extractor crashed while importing source',
      }));

    const audit = await runSecurityAudit('/repo', ['host/App.swift']);

    expect(audit).toMatchObject({
      status: 'failed',
      skippedCodeqlLanguages: [],
      findings: [{ ruleId: 'openswarm/security-codeql-swift-database' }],
    });
  });

  it('keeps partial coverage visible when another language also has findings', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({
      version: '2.1.0',
      runs: [{ results: [{
        ruleId: 'js/xss-through-dom',
        message: { text: 'untrusted data reaches a DOM sink' },
      }] }],
    }));
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('unsupported build mode'), {
        code: 2,
        stderr: 'Swift does not support the none build mode. Please try using one of the following build modes instead: autobuild, manual.',
      }));

    const audit = await runSecurityAudit('/repo', ['web/main.js', 'host/App.swift']);

    expect(audit).toMatchObject({
      status: 'partial',
      codeqlLanguages: ['javascript', 'swift'],
      skippedCodeqlLanguages: ['swift'],
      findings: [{ ruleId: 'codeql/js/xss-through-dom' }],
    });
  });

  it('fails closed when SARIF cannot be parsed', async () => {
    fsMock.readFile.mockResolvedValue('{not json');

    const audit = await runSecurityAudit('/repo', ['src/a.ts']);

    expect(audit).toMatchObject({ status: 'failed' });
    expect(audit.findings[0]?.ruleId).toBe('openswarm/security-codeql-javascript-sarif');
  });

  it('refuses a symbolic-link source before CodeQL can inspect it', async () => {
    fsMock.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => true });

    const audit = await runSecurityAudit('/repo', ['src/a.ts']);

    expect(audit).toMatchObject({ status: 'failed' });
    expect(audit.findings[0]?.message).toContain('refuses non-regular source');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('listTrackedSecurityFiles', () => {
  it("uses Git's NUL-delimited tracked-and-untracked listing", async () => {
    execFileMock.mockResolvedValue({ stdout: 'src/a.ts\u0000new/b.py\u0000README.md\u0000', stderr: '' });

    await expect(listTrackedSecurityFiles('/repo')).resolves.toEqual(['new/b.py', 'src/a.ts']);
    expect(execFileMock).toHaveBeenCalledWith(
      '/tools/git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});
