import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';
import { tryHandleAppRoutes } from './webAppRoutes.js';

describe('durable run read surface (inside the existing web authentication gate)', () => {
  it.each(['GET', 'POST'])('serves status only for GET; %s', async (method) => {
    const getRunStatus = vi.fn(() => ({ issueId: 'task id', state: 'RETRY_AT', recovery: { advice: { status: 'unavailable' } } }));
    const runner = { getRunStatus } as unknown as AutonomousRunner;
    const writeHead = vi.fn(), end = vi.fn();
    const url = '/api/automation/runs/task%20id';
    expect(await tryHandleAppRoutes({ method } as IncomingMessage, { writeHead, end } as unknown as ServerResponse, url, new URL(url, 'http://localhost'), runner, vi.fn())).toBe(true);
    expect(writeHead.mock.calls[0][0]).toBe(method === 'GET' ? 200 : 405);
    if (method === 'GET') { expect(getRunStatus).toHaveBeenCalledWith('task id'); expect(JSON.parse(end.mock.calls[0][0]).recovery.advice.status).toBe('unavailable'); }
    else expect(getRunStatus).not.toHaveBeenCalled();
  });
  it.each(['missing', 'failure', 'bad-uri'])('preserves %s as an explicit read failure', async (kind) => {
    const getRunStatus = vi.fn(() => { if (kind === 'failure') throw new Error('DB unavailable'); return undefined; });
    const writeHead = vi.fn(), end = vi.fn(); const url = '/api/automation/runs/' + (kind === 'bad-uri' ? '%ZZ' : 'task');
    await tryHandleAppRoutes({ method: 'GET' } as IncomingMessage, { writeHead, end } as unknown as ServerResponse, url, new URL(url, 'http://localhost'), { getRunStatus } as unknown as AutonomousRunner, vi.fn());
    expect(writeHead.mock.calls[0][0]).toBe(kind === 'missing' ? 404 : kind === 'bad-uri' ? 400 : 503);
    if (kind === 'bad-uri') expect(getRunStatus).not.toHaveBeenCalled();
  });
});
