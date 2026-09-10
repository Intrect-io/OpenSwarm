import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildWizardConfig } from './initWizard.js';
import { loadConfig } from '../core/config.js';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('buildWizardConfig', () => {
  it('injects the chosen adapter', () => {
    const cfg = buildWizardConfig('codex-responses', 'none');
    expect(cfg).toMatch(/^adapter: codex-responses$/m);
    expect(cfg).not.toMatch(/^adapter: codex$/m);
  });

  it('sets the notification channel', () => {
    expect(buildWizardConfig('openrouter', 'slack')).toMatch(/^ {2}channel: slack$/m);
    expect(buildWizardConfig('openrouter', 'none')).toMatch(/^ {2}channel: none$/m);
  });

  it('uncomments the slack credential line when slack is chosen', () => {
    const cfg = buildWizardConfig('gpt', 'slack');
    expect(cfg).toMatch(/^ {2}slackWebhookUrl:/m);
    expect(cfg).not.toMatch(/^ {2}# slackWebhookUrl:/m);
  });

  it('uncomments both telegram credential lines when telegram is chosen', () => {
    const cfg = buildWizardConfig('gpt', 'telegram');
    expect(cfg).toMatch(/^ {2}telegramBotToken:/m);
    expect(cfg).toMatch(/^ {2}telegramChatId:/m);
  });

  it('leaves slack/telegram lines commented for an unrelated channel', () => {
    const cfg = buildWizardConfig('gpt', 'discord');
    expect(cfg).toMatch(/^ {2}# slackWebhookUrl:/m);
    expect(cfg).toMatch(/^ {2}# telegramBotToken:/m);
  });

  it('replaces placeholder agents with a single agent for this repo', () => {
    const cfg = buildWizardConfig('codex', 'none', { name: 'WAVE', projectPath: '/Users/x/dev/WAVE' });
    expect(cfg).toMatch(/^ {2}- name: WAVE$/m);
    expect(cfg).toMatch(/^ {4}projectPath: \/Users\/x\/dev\/WAVE$/m);
    // sample placeholders are gone
    expect(cfg).not.toContain('~/dev/my-project');
    expect(cfg).not.toContain('- name: backend');
    // defaultHeartbeatInterval still follows the agents block
    expect(cfg).toMatch(/defaultHeartbeatInterval:/);
  });

  it('keeps the sample agents when no agent is given (back-compat)', () => {
    const cfg = buildWizardConfig('codex', 'none');
    expect(cfg).toContain('~/dev/my-project');
  });
});

// AdapterNameSchema (src/core/config.ts) accepts exactly these.
const VALID_ADAPTERS = ['codex', 'codex-responses', 'gpt', 'local', 'lmstudio', 'openrouter', 'atlascloud', 'claude'];
const PROVIDERS = ['codex-responses', 'openrouter', 'atlascloud', 'gpt', 'lmstudio', 'local', 'codex', 'claude'] as const;
const adapterOf = (cfg: string) =>
  cfg.split('\n').find((l) => l.startsWith('adapter:'))?.replace('adapter:', '').trim();

describe('buildWizardConfig adapter validity (INT-1844)', () => {
  for (const p of PROVIDERS) {
    it(`writes a schema-valid adapter for provider '${p}'`, () => {
      expect(VALID_ADAPTERS).toContain(adapterOf(buildWizardConfig(p, 'none')));
    });
  }

  // Regression: `openswarm init` once wrote `adapter: claude` while the schema
  // allowed only 6 adapters, so `openswarm validate` failed. claude is now a
  // first-class adapter (schema + registry); the generated config must load.
  it('produces a config that loadConfig accepts when claude is chosen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'initwiz-'));
    try {
      const p = join(dir, 'config.yaml');
      writeFileSync(p, buildWizardConfig('claude', 'none', { name: 'x', projectPath: dir }));
      expect(loadConfig(p).adapter).toBe('claude');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runInitWizard symlink guards (AGT-3424)', () => {
  let dir: string | null = null;
  let outsideDir: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
    dir = null;
    outsideDir = null;
  });

  function mockExitAndErrors(): { errorSpy: ReturnType<typeof vi.spyOn> } {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { errorSpy };
  }

  it('refuses a config.yaml symlinked to an arbitrary (non-daemon) target', async () => {
    dir = mkdtempSync(join(tmpdir(), 'initwiz-symlink-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'initwiz-outside-'));
    const outsideFile = join(outsideDir, 'other-config.yaml');
    writeFileSync(outsideFile, 'adapter: codex\n');
    symlinkSync(outsideFile, join(dir, 'config.yaml'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const { errorSpy } = mockExitAndErrors();

    const { runInitWizard } = await import('./initWizard.js');
    await expect(runInitWizard()).rejects.toThrow('process.exit(1)');

    expect(errorSpy.mock.calls.flat().join(' ')).toContain('symlink to');
    expect(readFileSync(outsideFile, 'utf8')).toBe('adapter: codex\n');
  });

  it('refuses a symlinked .env even when config.yaml is a plain file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'initwiz-symlink-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'initwiz-outside-'));
    const outsideFile = join(outsideDir, 'other.env');
    writeFileSync(outsideFile, 'SECRET=leak\n');
    symlinkSync(outsideFile, join(dir, '.env'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const { errorSpy } = mockExitAndErrors();

    const { runInitWizard } = await import('./initWizard.js');
    await expect(runInitWizard()).rejects.toThrow('process.exit(1)');

    expect(errorSpy.mock.calls.flat().join(' ')).toContain('.env is a symlink');
    expect(readFileSync(outsideFile, 'utf8')).toBe('SECRET=leak\n');
  });
});
