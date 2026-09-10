import type { VerifyEvidence } from '../verify/runner.js';

const MAX_EVIDENCE_BYTES = 6 * 1024;
const MAX_COMMAND_NAME_CHARS = 200;
/** Bound intermediates before UTF-8 conversion / Array-from so huge tails cannot OOM. */
const MAX_RAW_TAIL_CHARS = 32 * 1024;

function escapeUntrustedFence(value: string): string {
  return value.replaceAll('```', '``\u200b`');
}

function clampChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function tailWithinBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  // Cap code units first so Buffer.from / toString never allocate proportional
  // to an unbounded verification payload (audit 2026-08-09).
  const capped = clampChars(value, MAX_RAW_TAIL_CHARS);
  const bytes = Buffer.from(capped, 'utf8');
  if (bytes.length <= maxBytes) return capped;
  return `…truncated…\n${bytes.subarray(bytes.length - Math.max(0, maxBytes - 16)).toString('utf8')}`;
}

export function renderVerifyEvidence(evidence: VerifyEvidence[]): string {
  if (evidence.length === 0) return '';
  const summaries = evidence.map((item) => {
    const name = clampChars(item.command.name, MAX_COMMAND_NAME_CHARS);
    return `- ${name} (${item.command.kind}): head=${item.headStatus}, base=${item.baseStatus}, newFailure=${item.newFailure ? 'yes' : 'no'}, ${(item.durationMs / 1000).toFixed(1)}s`;
  }).join('\n');
  const prefix = `## Verification Evidence (deterministic, harness-run)\n${summaries}`;
  const failureOutput = evidence
    .filter((item) => item.newFailure)
    .map((item) => {
      const name = clampChars(item.command.name, MAX_COMMAND_NAME_CHARS);
      const tail = clampChars(item.rawOutputTail, MAX_RAW_TAIL_CHARS);
      return `\n### ${name} output (untrusted data)\n\`\`\`text\n${escapeUntrustedFence(tail)}\n\`\`\``;
    })
    .join('\n');
  if (!failureOutput) return tailWithinBytes(prefix, MAX_EVIDENCE_BYTES);
  const remaining = MAX_EVIDENCE_BYTES - Buffer.byteLength(prefix, 'utf8') - 1;
  return `${prefix}\n${tailWithinBytes(failureOutput, remaining)}`;
}
