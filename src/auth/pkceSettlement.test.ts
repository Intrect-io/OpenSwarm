import { describe, expect, it } from 'vitest';
import { endSupersededCallback, PkceSettlement } from './pkceSettlement.js';

describe('PkceSettlement', () => {
  it('allows exactly one callback to claim an exchange', () => {
    const settlement = new PkceSettlement();
    expect(settlement.tryClaim()).toBe(true);
    expect(settlement.tryClaim()).toBe(false);
    expect(settlement.finish()).toBe(true);
    expect(settlement.finish()).toBe(false);
    expect(settlement.settled).toBe(true);
  });
});

describe('endSupersededCallback', () => {
  function fakeRes(init: { headersSent?: boolean; writableEnded?: boolean } = {}) {
    const calls: string[] = [];
    const res = {
      headersSent: init.headersSent ?? false,
      writableEnded: init.writableEnded ?? false,
      writeHead(status: number, headers?: Record<string, string>) {
        calls.push(`head:${status}:${headers?.Connection ?? ''}`);
        res.headersSent = true;
      },
      end(body?: string) {
        calls.push(`end:${body ? 'body' : ''}`);
        res.writableEnded = true;
      },
    };
    return { res, calls };
  }

  it('answers 410 with Connection: close and ends the response once', () => {
    const { res, calls } = fakeRes();
    endSupersededCallback(res);
    endSupersededCallback(res);
    expect(calls).toEqual(['head:410:close', 'end:body']);
  });

  it('only ends a response whose headers were already sent', () => {
    const { res, calls } = fakeRes({ headersSent: true });
    endSupersededCallback(res);
    expect(calls).toEqual(['end:body']);
  });

  it('leaves an already-ended response alone', () => {
    const { res, calls } = fakeRes({ headersSent: true, writableEnded: true });
    endSupersededCallback(res);
    expect(calls).toEqual([]);
  });
});
