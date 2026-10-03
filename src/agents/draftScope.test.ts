import { describe, expect, it } from 'vitest';
import {
  SCOPE_GATE_MIN_CONFIDENCE,
  SCOPE_GATE_MIN_EVIDENCE,
  isScopeDeclined,
  parseScopeVerdict,
  scopePromptParts,
} from './draftScope.js';

const decline = {
  applicable: false, kind: 'wrong_repository', confidence: 0.95,
  reason: 'The files named by the task belong to kyte-portal.',
  evidence: ['search for bin/kyte-chat-daemon: 0 matches', 'search for KYTE_PYTHON: 0 matches'],
};

describe('parseScopeVerdict (AGT-4662)', () => {
  it('reads a well-formed decline', () => {
    expect(parseScopeVerdict(decline)).toEqual(decline);
  });

  it('is undefined for anything that is not a decline, so it can never block a task', () => {
    expect(parseScopeVerdict(undefined)).toBeUndefined();
    expect(parseScopeVerdict('wrong_repository')).toBeUndefined();
    expect(parseScopeVerdict({ ...decline, applicable: true })).toBeUndefined();
    expect(parseScopeVerdict({ ...decline, applicable: 'false' })).toBeUndefined();
    expect(parseScopeVerdict({ ...decline, kind: 'too_hard' })).toBeUndefined();
    expect(parseScopeVerdict({ ...decline, reason: '   ' })).toBeUndefined();
  });

  it('clamps confidence, defaults a missing one to 0, and drops non-string evidence', () => {
    expect(parseScopeVerdict({ ...decline, confidence: 7 })?.confidence).toBe(1);
    expect(parseScopeVerdict({ ...decline, confidence: -1 })?.confidence).toBe(0);
    expect(parseScopeVerdict({ ...decline, confidence: 'high' })?.confidence).toBe(0);
    expect(parseScopeVerdict({ ...decline, evidence: ['a', 3, '', '  b  ', null] })?.evidence).toEqual(['a', 'b']);
    expect(parseScopeVerdict({ ...decline, evidence: 'a' })?.evidence).toEqual([]);
  });
});

describe('isScopeDeclined (AGT-4662)', () => {
  const verdict = parseScopeVerdict(decline);

  it('needs the same bar as duplicate grooming: confidence and two pieces of evidence', () => {
    expect(SCOPE_GATE_MIN_CONFIDENCE).toBe(0.9);
    expect(SCOPE_GATE_MIN_EVIDENCE).toBe(2);
    expect(isScopeDeclined(verdict)).toBe(true);
    expect(isScopeDeclined(parseScopeVerdict({ ...decline, confidence: 0.89 }))).toBe(false);
    expect(isScopeDeclined(parseScopeVerdict({ ...decline, evidence: ['only one'] }))).toBe(false);
    expect(isScopeDeclined(undefined)).toBe(false);
  });
});

describe('scopePromptParts (AGT-4662)', () => {
  it('is empty without a goal, so a project that sets none gets the prompt it always had', () => {
    expect(scopePromptParts(undefined)).toEqual({ field: '', rules: '' });
    expect(scopePromptParts('  ')).toEqual({ field: '', rules: '' });
  });

  it('asks for the verdict, names every kind, and says hard tasks stay in scope', () => {
    const { field, rules } = scopePromptParts('Ship usable work.');
    expect(field).toContain('"scope"');
    for (const kind of ['wrong_repository', 'human_action_only', 'blocked_by_dependency', 'out_of_goal']) {
      expect(field).toContain(kind);
      expect(rules).toContain(kind);
    }
    expect(rules).toContain('Hard tasks, large tasks');
    expect(rules).toContain('>= 0.90');
  });
});
