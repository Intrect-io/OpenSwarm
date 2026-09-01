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

describe('runConfiguredSecurityAudit partial status', () => {
  it('passes a partial audit through — skipped languages are a known limitation, not a fault', async () => {
    const runModule = await import('./securityAuditGate.js');
    const { vi } = await import('vitest');
    const verify = await import('../verify/securityAudit.js');
    const partial = result({
      status: 'partial',
      codeqlLanguages: ['go'],
      skippedCodeqlLanguages: ['go'],
      detail: 'Skipped languages whose installed CodeQL extractor does not support build-mode=none: go.',
    });
    const spyList = vi.spyOn(verify, 'listTrackedSecurityFiles').mockResolvedValue(['main.go']);
    const spyRun = vi.spyOn(verify, 'runSecurityAudit').mockResolvedValue(partial);
    try {
      await expect(runModule.captureSecurityAuditBaseline('/repo', { enabled: true, maxThreads: 2 }))
        .resolves.toBe(partial);
    } finally {
      spyList.mockRestore();
      spyRun.mockRestore();
    }
  });
});
