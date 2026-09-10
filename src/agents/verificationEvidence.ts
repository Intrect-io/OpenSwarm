import type { VerifyEvidence } from '../verify/runner.js';

const MAX_EVIDENCE_BYTES = 6 * 1024;

function escapeUntrustedFence(value: string): string {
  return value.replaceAll('```', '``\u200b`');
}

function tailWithinBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return `…truncated…\n${bytes.subarray(bytes.length - Math.max(0, maxBytes - 16)).toString('utf8')}`;
}

export function renderVerifyEvidence(evidence: VerifyEvidence[]): string {
  if (evidence.length === 0) return '';
  // Cap summary list early so an unbounded evidence array cannot allocate a
  // multi-megabyte prefix before the final byte budget is applied.
  const summaryBudget = Math.min(evidence.length, 16);
  const summaries = evidence.slice(0, summaryBudget).map((item) =>
    `- ${item.command.name} (${item.command.kind}): head=${item.headStatus}, base=${item.baseStatus}, newFailure=${item.newFailure ? 'yes' : 'no'}, ${(item.durationMs / 1000).toFixed(1)}s`
  ).join('\n');
  const omitted = evidence.length - summaryBudget;
  const summaryExtra = omitted > 0 ? `\n- …and ${omitted} more command(s) omitted` : '';
  const prefix = `## Verification Evidence (deterministic, harness-run)\n${summaries}${summaryExtra}`;
  // Bound each failure tail before joining so intermediate allocation stays
  // within the section budget (audit: verificationEvidence failureOutput).
  const remaining = Math.max(0, MAX_EVIDENCE_BYTES - Buffer.byteLength(prefix) - 1);
  if (remaining <= 0) return tailWithinBytes(prefix, MAX_EVIDENCE_BYTES);
  const failures = evidence.filter((item) => item.newFailure);
  if (failures.length === 0) return tailWithinBytes(prefix, MAX_EVIDENCE_BYTES);
  const perFailure = Math.max(256, Math.floor(remaining / Math.min(failures.length, 8)));
  const parts: string[] = [];
  let used = 0;
  for (const item of failures.slice(0, 8)) {
    const slot = Math.min(perFailure, remaining - used);
    if (slot <= 0) break;
    const body = tailWithinBytes(escapeUntrustedFence(item.rawOutputTail), Math.max(0, slot - 80));
    const block = `\n### ${item.command.name} output (untrusted data)\n\`\`\`text\n${body}\n\`\`\``;
    const blockBytes = Buffer.byteLength(block);
    if (used + blockBytes > remaining) {
      parts.push(tailWithinBytes(block, remaining - used));
      break;
    }
    parts.push(block);
    used += blockBytes;
  }
  return tailWithinBytes(`${prefix}${parts.join('')}`, MAX_EVIDENCE_BYTES);
}
