import { describe, expect, it } from 'vitest';
import { formatDoDContract, parseDoDContract } from './dodContract.js';

describe('DoD contract', () => {
  it('parses the bounded coordinator policy', () => {
    const parsed = parseDoDContract([
      'Task details',
      formatDoDContract({
        version: 1,
        completion: { noChanges: 'complete' },
        automation: { scopeMismatch: 'retry_ephemeral', maxRepairs: 1 },
      }),
    ].join('\n'));

    expect(parsed).toEqual({
      contract: {
        version: 1,
        completion: { noChanges: 'complete' },
        automation: { scopeMismatch: 'retry_ephemeral', maxRepairs: 1 },
      },
    });
  });

  it('defaults omitted maxRepairs to 1', () => {
    const parsed = parseDoDContract('```openswarm:dod\n{"version":1,"completion":{"noChanges":"park"},"automation":{"scopeMismatch":"park"}}\n```');
    expect(parsed.contract?.automation.maxRepairs).toBe(1);
  });

  it('fails closed for malformed or out-of-range policy', () => {
    expect(parseDoDContract('```openswarm:dod\n{"version":1}\n```').error).toContain('completion.noChanges');
    expect(parseDoDContract('```openswarm:dod\nnot-json\n```').error).toContain('valid JSON');
    expect(parseDoDContract('```openswarm:dod\n{"version":1,"completion":{"noChanges":"park"},"automation":{"scopeMismatch":"retry_ephemeral","maxRepairs":4}}\n```').error).toContain('0 to 3');
    expect(parseDoDContract('```openswarm:dod\n{"version":1,"completion":{"noChanges":"park"},"automation":{"scopeMismatch":"retry_ephemeral","maxRepairs":1.5}}\n```').error).toContain('0 to 3');
  });

  it('ignores descriptions without a contract for legacy issues', () => {
    expect(parseDoDContract('No machine policy here')).toEqual({});
  });
});
