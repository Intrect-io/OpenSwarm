import { afterEach, describe, expect, it } from 'vitest';
import {
  configureSandboxExecutor,
  getSandboxExecutorConfig,
  resetSandboxExecutorForTests,
} from './runtime.js';

const config = {
  socketPath: '/run/openswarm-sandbox/executor.sock',
  allowedRoots: ['/work'],
  connectTimeoutMs: 1_000,
  maxRequestBytes: 64 * 1024,
  maxOutputBytes: 512 * 1024,
  maxTimeoutMs: 900_000,
  maxConcurrent: 8,
};

afterEach(() => resetSandboxExecutorForTests());

describe('sandbox executor process capability', () => {
  it('can be added once but cannot be redirected or weakened during the process lifetime', () => {
    configureSandboxExecutor(config);
    configureSandboxExecutor({ ...config, allowedRoots: ['/work'] });

    expect(getSandboxExecutorConfig()).toEqual(config);
    expect(() => configureSandboxExecutor({ ...config, socketPath: '/run/openswarm-sandbox/other.sock' }))
      .toThrow('cannot change during the process lifetime');
    expect(getSandboxExecutorConfig()).toEqual(config);
  });

  it('defensively copies allowed roots so callers cannot mutate the attested target', () => {
    const roots = ['/work'];
    configureSandboxExecutor({ ...config, allowedRoots: roots });
    roots.push('/work/other');

    expect(getSandboxExecutorConfig()?.allowedRoots).toEqual(['/work']);
    expect(() => getSandboxExecutorConfig()!.allowedRoots.push('/work/attacker')).toThrow();
    expect(getSandboxExecutorConfig()?.allowedRoots).toEqual(['/work']);
  });
});
