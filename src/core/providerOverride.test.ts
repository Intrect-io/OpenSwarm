import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync('/tmp/openswarm-home-');

vi.mock('node:os', () => ({ homedir: () => process.env.OPENSWARM_TEST_HOME! }));
process.env.OPENSWARM_TEST_HOME = TEST_HOME;

describe('providerOverride', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads and writes a valid override', async () => {
    const fs = await import('node:fs');
    fs.rmSync(TEST_HOME, { recursive: true, force: true });

    const { writeProviderOverride, readProviderOverride } = await import('./providerOverride.js');
    writeProviderOverride('codex');

    expect(readProviderOverride()).toBe('codex');
    expect(fs.readFileSync(join(TEST_HOME, '.config', 'openswarm', 'provider-override.json'), 'utf8')).toContain('"provider": "codex"');
  });

  it('returns undefined for missing or invalid files', async () => {
    const fs = await import('node:fs');
    fs.rmSync(TEST_HOME, { recursive: true, force: true });

    const { readProviderOverride } = await import('./providerOverride.js');
    expect(readProviderOverride()).toBeUndefined();

    fs.mkdirSync(join(TEST_HOME, '.config', 'openswarm'), { recursive: true });
    fs.writeFileSync(join(TEST_HOME, '.config', 'openswarm', 'provider-override.json'), '{not json', 'utf8');
    expect(readProviderOverride()).toBeUndefined();

    fs.writeFileSync(join(TEST_HOME, '.config', 'openswarm', 'provider-override.json'), JSON.stringify({ provider: 'unknown' }), 'utf8');
    expect(readProviderOverride()).toBeUndefined();
  });

  it('persists and reads back a claude override — an explicit operator switch must not silently no-op', async () => {
    const fs = await import('node:fs');
    fs.rmSync(TEST_HOME, { recursive: true, force: true });

    const { writeProviderOverride, readProviderOverride } = await import('./providerOverride.js');
    writeProviderOverride('claude');

    expect(readProviderOverride()).toBe('claude');
  });

  it('formats a loud mismatch warning naming both providers and the override file (INT-2408)', async () => {
    const { formatProviderOverrideMismatchWarning } = await import('./providerOverride.js');
    const msg = formatProviderOverrideMismatchWarning('codex', 'codex-responses');

    // Both values must appear so the divergence is obvious.
    expect(msg).toContain('"codex"');
    expect(msg).toContain('"codex-responses"');
    // Points at the actual file to delete, and reads as a warning.
    expect(msg).toContain('provider-override.json');
    expect(msg).toContain('overriding config.yaml');
    expect(msg).toContain('⚠️');
  });
});
