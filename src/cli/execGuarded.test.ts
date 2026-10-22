import { describe, expect, it } from 'vitest';
import { runExecGuarded } from './execCommand.js';

// Split out of execCommand.test.ts, which is at its line cap. These need none of its ledger or spawn fixtures.

describe('runExecGuarded', () => {
  it('passes the command\'s own exit code through', async () => {
    expect(await runExecGuarded(true, async () => 0)).toBe(0);
    expect(await runExecGuarded(false, async () => 1)).toBe(1);
  });

  it('turns a throw into exit 2 with the message, instead of an unhandled rejection', async () => {
    const logs: string[] = [];
    const code = await runExecGuarded(false, async () => { throw new Error('Refusing to send OPENSWARM_DAEMON_TOKEN over plaintext http'); }, { log: (line) => logs.push(line) });
    expect(code).toBe(2);
    expect(logs).toEqual(['Refusing to send OPENSWARM_DAEMON_TOKEN over plaintext http']);
  });

  it('keeps stdout a JSON document under --json, so the orchestrator can parse the failure', async () => {
    const outs: string[] = [];
    const code = await runExecGuarded(true, async () => { throw new Error('ledger busy'); }, { out: (line) => outs.push(line) });
    expect(code).toBe(2);
    expect(JSON.parse(outs.join('\n'))).toEqual({ error: 'ledger busy' });
  });

  it('copes with a non-Error throw', async () => {
    const logs: string[] = [];
    expect(await runExecGuarded(false, async () => { throw 'plain string'; }, { log: (line) => logs.push(line) })).toBe(2);
    expect(logs).toEqual(['plain string']);
  });
});
