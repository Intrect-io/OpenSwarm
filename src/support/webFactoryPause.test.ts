import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RunnerPauseControl } from '../automation/factoryPause.js';
import { handleFactoryPause } from './webFactoryPause.js';

// AGT-4808: the dashboard's pause button writes the same durable row as the CLI.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function request(method: string, body?: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function response() {
  const captured: { status?: number; body?: any } = {};
  const res = {
    writeHead(status: number) { captured.status = status; return res; },
    end(text: string) { captured.body = JSON.parse(text); },
  } as unknown as ServerResponse;
  return { res, captured };
}

function control(): RunnerPauseControl {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-web-pause-'));
  roots.push(root);
  return new RunnerPauseControl(() => join(root, 'automation.db'));
}

describe('dashboard kill-switch routes', () => {
  it('pauses, reports and resumes the factory', async () => {
    const pauses = control();
    const logs: string[] = [];
    let r = response();
    expect(await handleFactoryPause('/api/factory/pause', request('POST', { mode: 'now', reason: 'stop' }), r.res, pauses, (l) => logs.push(l))).toBe(true);
    expect(r.captured.status).toBe(200);
    expect(r.captured.body.pauses).toEqual([expect.objectContaining({ scope: '*', mode: 'now', reason: 'stop', actor: 'dashboard' })]);

    r = response();
    await handleFactoryPause('/api/factory/pause', request('GET'), r.res, pauses);
    expect(r.captured.body.pauses).toHaveLength(1);

    r = response();
    await handleFactoryPause('/api/factory/resume', request('POST', {}), r.res, pauses, (l) => logs.push(l));
    expect(r.captured.body.pauses).toEqual([]);
    expect(logs).toHaveLength(2);
    pauses.close();
  });

  it('rejects an unknown mode and answers 503 without a runner', async () => {
    let r = response();
    const pauses = control();
    await handleFactoryPause('/api/factory/pause', request('POST', { mode: 'later' }), r.res, pauses);
    expect(r.captured.status).toBe(400);
    expect(pauses.list().pauses).toEqual([]);
    r = response();
    await handleFactoryPause('/api/factory/pause', request('POST', {}), r.res, undefined);
    expect(r.captured.status).toBe(503);
    pauses.close();
  });

  it('leaves other routes to the caller', async () => {
    const r = response();
    expect(await handleFactoryPause('/api/factory/other', request('GET'), r.res, control())).toBe(false);
    expect(await handleFactoryPause('/api/factory/resume', request('GET'), r.res, control())).toBe(false);
  });
});
