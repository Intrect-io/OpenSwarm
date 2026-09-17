import { describe, expect, it } from 'vitest';
import { ownerProcessId, ownerVerdict } from './ownerLiveness.js';

const base = {
  ourInstanceId: '7-current',
  ourPidSpace: 'pidns:boot:ns',
  ourPid: 7,
  processIsAlive: () => true,
};

describe('ownerProcessId', () => {
  it('reads the leading pid and rejects ids without one', () => {
    expect(ownerProcessId('7-uuid')).toBe(7);
    expect(ownerProcessId('uuid-only')).toBeNull();
    expect(ownerProcessId('0-uuid')).toBeNull();
  });
});

describe('ownerVerdict (AGT-4072)', () => {
  it('our pid under another instance id in our proven space is a dead prior generation', () => {
    expect(ownerVerdict({ ...base, ownerInstanceId: '7-prior', ownerPidSpace: 'pidns:boot:ns' })).toBe('gone');
  });

  it('our own row is alive', () => {
    expect(ownerVerdict({ ...base, ownerInstanceId: '7-current', ownerPidSpace: 'pidns:boot:ns' })).toBe('alive');
  });

  it('the same pid in a foreign space is a live peer container, not a prior generation', () => {
    expect(ownerVerdict({ ...base, ownerInstanceId: '7-peer', ownerPidSpace: 'pidns:other:ns' })).toBe('unknown');
    expect(ownerVerdict({ ...base, ownerInstanceId: '7-peer', ownerPidSpace: 'pidns:other:ns', processIsAlive: () => false })).toBe('unknown');
  });

  it('a row without a recorded space cannot be judged, whatever the probe says', () => {
    expect(ownerVerdict({ ...base, ownerInstanceId: '7-prior', ownerPidSpace: undefined })).toBe('unknown');
    expect(ownerVerdict({ ...base, ownerInstanceId: '99-x', ownerPidSpace: undefined, processIsAlive: () => false })).toBe('unknown');
  });

  it('a judge that cannot name its own space judges nothing', () => {
    expect(ownerVerdict({ ...base, ourPidSpace: undefined, ownerInstanceId: '7-prior', ownerPidSpace: 'pidns:boot:ns' })).toBe('unknown');
    expect(ownerVerdict({ ...base, ourPidSpace: undefined, ownerInstanceId: '7-prior', ownerPidSpace: undefined })).toBe('unknown');
  });

  it('probes a sibling pid inside our own space', () => {
    expect(ownerVerdict({ ...base, ownerInstanceId: '31337-sibling', ownerPidSpace: 'pidns:boot:ns', processIsAlive: (pid) => pid === 31337 })).toBe('alive');
    expect(ownerVerdict({ ...base, ownerInstanceId: '31337-sibling', ownerPidSpace: 'pidns:boot:ns', processIsAlive: () => false })).toBe('gone');
  });

  it('a matching host hint restores the local probe but a differing one withholds it', () => {
    const hinted = { ...base, ourPidSpace: 'host:macstudio' };
    expect(ownerVerdict({ ...hinted, ownerInstanceId: '7-prior', ownerPidSpace: 'host:macstudio' })).toBe('gone');
    expect(ownerVerdict({ ...hinted, ownerInstanceId: '31337-x', ownerPidSpace: 'host:macstudio', processIsAlive: () => false })).toBe('gone');
    expect(ownerVerdict({ ...hinted, ownerInstanceId: '7-prior', ownerPidSpace: 'host:other-mac' })).toBe('unknown');
  });

  it('an owner id without a pid cannot be judged', () => {
    expect(ownerVerdict({ ...base, ownerInstanceId: 'no-pid', ownerPidSpace: 'pidns:boot:ns' })).toBe('unknown');
  });
});
