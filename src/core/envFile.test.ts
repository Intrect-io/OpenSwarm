import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, platform, homedir as realHomedir } from 'node:os';
import { join } from 'node:path';
import { formatShadowWarning, writeEnvVars } from './envFile.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockedHome };
});

// Reassigned per-test by loadEnvFileWith(); the node:os mock above reads it
// live, so tests never touch the real home directory.
let mockedHome = '';

const { loadEnvFile } = await import('./envFile.js');

let dir: string | null = null;
function freshEnvPath(): string {
  dir = mkdtempSync(join(tmpdir(), 'env-write-'));
  return join(dir, '.env');
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('writeEnvVars', () => {
  it('creates a new file with the given keys', () => {
    const p = freshEnvPath();
    writeEnvVars(p, { LINEAR_API_KEY: 'abc', LINEAR_TEAM_ID: 'TEAM' });
    const txt = readFileSync(p, 'utf8');
    expect(txt).toContain('LINEAR_API_KEY=abc');
    expect(txt).toContain('LINEAR_TEAM_ID=TEAM');
  });

  it('upserts existing keys in place and preserves other lines + comments', () => {
    const p = freshEnvPath();
    writeFileSync(p, '# my env\nLINEAR_API_KEY=old\nKEEP_ME=yes\n');
    writeEnvVars(p, { LINEAR_API_KEY: 'new' });
    const txt = readFileSync(p, 'utf8');
    expect(txt).toContain('# my env');
    expect(txt).toContain('KEEP_ME=yes');
    expect(txt).toContain('LINEAR_API_KEY=new');
    expect(txt).not.toContain('LINEAR_API_KEY=old');
  });

  it('quotes values that contain spaces or special characters', () => {
    const p = freshEnvPath();
    writeEnvVars(p, { TOKEN: 'a b#c' });
    expect(readFileSync(p, 'utf8')).toContain('TOKEN="a b#c"');
  });

  it('round-trips a quoted value through loadEnvFile parsing', () => {
    const p = freshEnvPath();
    writeEnvVars(p, { WEBHOOK: 'https://x.example/y?z=1 2' });
    const txt = readFileSync(p, 'utf8');
    // value is quoted; the embedded space is retained inside the quotes
    expect(txt).toMatch(/WEBHOOK="https:\/\/x\.example\/y\?z=1 2"/);
  });

  it('writes the file as owner-only (0600) on POSIX', () => {
    if (platform() === 'win32') return;
    const p = freshEnvPath();
    writeEnvVars(p, { SECRET: 'x' });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('refuses to write through a symlinked .env instead of reading it and severing the link (AGT-3424)', () => {
    if (platform() === 'win32') return; // symlinkSync requires elevated perms on Windows CI
    const p = freshEnvPath();
    const outsideDir = mkdtempSync(join(tmpdir(), 'env-outside-'));
    const outside = join(outsideDir, 'not-an-env-file.txt');
    writeFileSync(outside, 'sensitive-content\n');
    try {
      symlinkSync(outside, p);
      expect(() => writeEnvVars(p, { SECRET: 'x' })).toThrow(/symlink/);
      // Neither the symlink itself nor the file it points to changed.
      expect(readFileSync(outside, 'utf8')).toBe('sensitive-content\n');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

// Regression for INT-3247: a project with its own (older) .env silently hid
// every key that only lived in the global ~/.config/openswarm/.env, because
// loadEnvFile returned after the FIRST file it found instead of layering
// all of them. `openswarm review --max` from such a project failed every
// subagent instantly — ATLASCLOUD_API_KEY was global-only.
describe('loadEnvFile', () => {
  let projectDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function stashEnv(...keys: string[]) {
    for (const k of keys) savedEnv[k] = process.env[k];
  }

  afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    if (mockedHome && mockedHome !== realHomedir()) rmSync(mockedHome, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it('falls back to a global .env key the project-local .env does not define', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'env-project-'));
    mockedHome = mkdtempSync(join(tmpdir(), 'env-home-'));
    const configDir = join(mockedHome, '.config', 'openswarm');
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(projectDir, '.env'), 'PROJECT_ONLY=local\n');
    writeFileSync(join(configDir, '.env'), 'GLOBAL_ONLY=global\nPROJECT_ONLY=should-not-win\n');

    stashEnv('PROJECT_ONLY', 'GLOBAL_ONLY', 'OPENSWARM_ENV', 'OPENSWARM_CONFIG');
    delete process.env.OPENSWARM_ENV;
    delete process.env.OPENSWARM_CONFIG;
    delete process.env.PROJECT_ONLY;
    delete process.env.GLOBAL_ONLY;
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    const result = loadEnvFile();

    expect(process.env.PROJECT_ONLY).toBe('local'); // local file wins the shared key
    expect(process.env.GLOBAL_ONLY).toBe('global'); // global-only key still gets picked up
    expect(result.paths).toEqual([join(projectDir, '.env'), join(configDir, '.env')]);
  });

  it('a pre-existing process.env value beats every file', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'env-project-'));
    mockedHome = mkdtempSync(join(tmpdir(), 'env-home-'));
    writeFileSync(join(projectDir, '.env'), 'SHELL_WINS=from-file\n');

    stashEnv('SHELL_WINS', 'OPENSWARM_ENV', 'OPENSWARM_CONFIG');
    delete process.env.OPENSWARM_ENV;
    delete process.env.OPENSWARM_CONFIG;
    process.env.SHELL_WINS = 'from-shell';
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    loadEnvFile();

    expect(process.env.SHELL_WINS).toBe('from-shell');
  });

  it('reports a shadowed key when the ambient value differs from the file (AGT-4154)', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'env-project-'));
    mockedHome = mkdtempSync(join(tmpdir(), 'env-home-'));
    const envPath = join(projectDir, '.env');
    writeFileSync(envPath, 'DIVERGES=file-value\n');

    stashEnv('DIVERGES', 'OPENSWARM_ENV', 'OPENSWARM_CONFIG');
    delete process.env.OPENSWARM_ENV;
    delete process.env.OPENSWARM_CONFIG;
    process.env.DIVERGES = 'ambient-value';
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    const result = loadEnvFile();

    expect(result.shadowedKeys).toHaveLength(1);
    expect(result.shadowedKeys[0]).toMatchObject({ key: 'DIVERGES', sourcePath: envPath });
    expect(result.shadowedKeys[0].fileFingerprint).not.toBe(result.shadowedKeys[0].ambientFingerprint);

    const warning = formatShadowWarning(result.shadowedKeys[0]);
    expect(warning).not.toContain('file-value');
    expect(warning).not.toContain('ambient-value');
    expect(warning).toContain('DIVERGES');
    expect(warning).toContain(envPath);
  });

  it('stays silent when the ambient value is identical to the file', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'env-project-'));
    mockedHome = mkdtempSync(join(tmpdir(), 'env-home-'));
    writeFileSync(join(projectDir, '.env'), 'SAME=matching\n');

    stashEnv('SAME', 'OPENSWARM_ENV', 'OPENSWARM_CONFIG');
    delete process.env.OPENSWARM_ENV;
    delete process.env.OPENSWARM_CONFIG;
    process.env.SAME = 'matching';
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    const result = loadEnvFile();

    expect(result.shadowedKeys).toEqual([]);
  });

  it('reports no shadow when the ambient value is unset (the key is simply loaded)', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'env-project-'));
    mockedHome = mkdtempSync(join(tmpdir(), 'env-home-'));
    writeFileSync(join(projectDir, '.env'), 'FRESH=from-file\n');

    stashEnv('FRESH', 'OPENSWARM_ENV', 'OPENSWARM_CONFIG');
    delete process.env.OPENSWARM_ENV;
    delete process.env.OPENSWARM_CONFIG;
    delete process.env.FRESH;
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    const result = loadEnvFile();

    expect(result.shadowedKeys).toEqual([]);
    expect(process.env.FRESH).toBe('from-file');
  });
});
