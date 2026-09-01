import type { SecurityAuditConfig } from '../core/types.js';
import {
  listTrackedSecurityFiles,
  newSecurityFindings,
  runSecurityAudit,
  type SecurityAuditResult,
  type SecurityFinding,
} from '../verify/securityAudit.js';
import type { PipelineContext } from './pairPipelineTypes.js';

export class SecurityAuditInfrastructureError extends Error {
  constructor(result: SecurityAuditResult | undefined, detail?: string) {
    // Fall through to the findings before giving up on a cause: a failing audit
    // records why it failed as a finding, and reporting only `status` told the
    // operator "failed" with nothing to act on.
    const fromFindings = result?.findings?.find((finding) => finding.level === 'error')?.message;
    super(`security-audit-infra: ${result?.detail ?? detail ?? fromFindings ?? result?.status ?? 'no result'}`);
    this.name = 'SecurityAuditInfrastructureError';
  }
}

export function formatSecurityFinding(finding: SecurityFinding): string {
  const location = finding.filePath ? `${finding.filePath}${finding.line ? `:${finding.line}` : ''}` : 'repository';
  return `CodeQL ${finding.ruleId} (${location}): ${finding.message}`;
}

async function runConfiguredSecurityAudit(projectPath: string, config: SecurityAuditConfig): Promise<SecurityAuditResult> {
  let result: SecurityAuditResult;
  try {
    result = await runSecurityAudit(projectPath, await listTrackedSecurityFiles(projectPath), config);
  } catch (error) {
    throw new SecurityAuditInfrastructureError(undefined, error instanceof Error ? error.message : String(error));
  }
  if (result.status === 'failed' || result.status === 'unavailable') {
    throw new SecurityAuditInfrastructureError(result);
  }
  // 'partial' (some languages skipped because their extractor rejects
  // build-mode=none — e.g. Go) is a permanent environmental limitation, not a
  // transient fault: baseline and current skip the same languages, so the
  // introduced-findings comparison stays sound for everything scanned. Failing
  // closed here burned every pipeline on Go repositories against a wall no
  // retry can move. The coverage gap is visible on the result's
  // `skippedCodeqlLanguages`/`detail`.
  return result;
}

export async function captureSecurityAuditBaseline(projectPath: string, config: SecurityAuditConfig): Promise<SecurityAuditResult> {
  return runConfiguredSecurityAudit(projectPath, config);
}

export async function collectIntroducedSecurityFindings(context: PipelineContext): Promise<SecurityFinding[]> {
  if (!context.config.securityAudit?.enabled) return [];
  if (!context.securityBaseline) throw new SecurityAuditInfrastructureError(undefined, 'baseline was not captured');
  const current = await runConfiguredSecurityAudit(context.projectPath, context.config.securityAudit);
  const introduced = newSecurityFindings(context.securityBaseline.findings, current.findings);
  context.newSecurityFindings = introduced;
  return introduced;
}
