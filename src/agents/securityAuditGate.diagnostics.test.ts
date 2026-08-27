import { describe, expect, it } from 'vitest';
import { SecurityAuditInfrastructureError } from './securityAuditGate.js';
import type { SecurityAuditResult } from '../verify/securityAudit.js';

function result(over: Partial<SecurityAuditResult> = {}): SecurityAuditResult {
  return {
    status: 'failed',
    codeqlLanguages: ['javascript-typescript'],
    skippedCodeqlLanguages: [],
    findings: [],
    ...over,
  } as SecurityAuditResult;
}

describe('SecurityAuditInfrastructureError', () => {
  it('prefers an explicit detail', () => {
    expect(new SecurityAuditInfrastructureError(result({ detail: 'pack download refused' })).message)
      .toBe('security-audit-infra: pack download refused');
  });

  it('falls back to the recorded error finding rather than the bare status', () => {
    // Without this the operator saw "security-audit-infra: failed" and had no
    // way to tell a missing extractor from an unreadable source file.
    const error = new SecurityAuditInfrastructureError(result({
      findings: [{ ruleId: 'openswarm/security-codeql-runtime', level: 'error', message: 'CodeQL security audit failed: EACCES /work' }],
    }));
    expect(error.message).toBe('security-audit-infra: CodeQL security audit failed: EACCES /work');
  });

  it('ignores non-error findings when choosing a cause', () => {
    const error = new SecurityAuditInfrastructureError(result({
      status: 'unavailable',
      findings: [{ ruleId: 'note', level: 'warning', message: 'informational' }],
    }));
    expect(error.message).toBe('security-audit-infra: unavailable');
  });

  it('still reports something when there is no result at all', () => {
    expect(new SecurityAuditInfrastructureError(undefined).message).toBe('security-audit-infra: no result');
  });
});
