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
    super(`security-audit-infra: ${result?.detail ?? detail ?? result?.status ?? 'no result'}`);
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
  if (result.status === 'failed' || result.status === 'unavailable') throw new SecurityAuditInfrastructureError(result);
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
