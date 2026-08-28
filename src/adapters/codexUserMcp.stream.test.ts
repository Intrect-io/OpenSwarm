import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { runCodexMcpListJson } from './codexUserMcp.js';

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

describe('Codex MCP list stream decoding (AGT-3990)', () => {
  it('preserves a Unicode server name split inside one UTF-8 code point', async () => {
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout,
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    spawnMock.mockReturnValueOnce(proc);
    const expected = JSON.stringify([{ name: '리니어-서버', enabled: true }]);
    const bytes = Buffer.from(expected, 'utf8');
    const splitAt = bytes.indexOf(Buffer.from('리', 'utf8')) + 1;

    const pending = runCodexMcpListJson('/repo', {});
    stdout.write(bytes.subarray(0, splitAt));
    stdout.write(bytes.subarray(splitAt));
    proc.emit('close', 0);

    const output = await pending;
    expect(output).toBe(expected);
    expect(JSON.parse(output)[0].name).toBe('리니어-서버');
  });
});
