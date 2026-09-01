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
  const summaries = evidence.map((item) =>
    `- ${item.command.name} (${item.command.kind}): head=${item.headStatus}, base=${item.baseStatus}, newFailure=${item.newFailure ? 'yes' : 'no'}, ${(item.durationMs / 1000).toFixed(1)}s`
  ).join('\n');
  const prefix = `## Verification Evidence (deterministic, harness-run)\n${summaries}`;
  const failureOutput = evidence
    .filter((item) => item.newFailure)
    .map((item) => {
      // Bound untrusted raw output before UTF-8 conversion, escaping, and interpolation
      const taskId = tailWithinBytes(item.taskId, 1024);
      const stage = tailWithinBytes(item.stage, 1024);
      const identity = tailWithinBytes(item.identity, 1024);
      const bounded = tailWithinBytes(item.rawOutputTail, 4 * 1024);
      return `\n### ${item.command.name} output (untrusted data)\n\`\`\`text\n${escapeUntrustedFence(bounded)}\n\`\`\``;
    })
    .join('\n');
  if (!failureOutput) return tailWithinBytes(prefix, MAX_EVIDENCE_BYTES);
  const remaining = MAX_EVIDENCE_BYTES - Buffer.byteLength(prefix) - 1;
  return `${prefix}\n${tailWithinBytes(failureOutput, remaining)}`;
}
