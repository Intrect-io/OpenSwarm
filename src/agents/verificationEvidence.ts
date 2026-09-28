import type { VerifyEvidence } from '../verify/runner.js';

const MAX_EVIDENCE_BYTES = 6 * 1024;
/**
 * Ceiling on ONE command's quoted log. Every failing command is charged to the
 * same section budget, so without a per-command bound one suite printing
 * megabytes spends all of it and the other new failures arrive unquoted — the
 * reviewer is then asked to judge a run it can only partly see.
 */
const MAX_LOG_BYTES = 2 * 1024;
/** Kept from the top of an oversized log: the banner naming the suite that spoke. */
const LOG_HEAD_BYTES = 256;
/** Marks where the cut happened, between the kept head and the kept tail. */
const LOG_ELISION = '\n…truncated…\n';
/**
 * Held back inside the budget for the notice, so charging it to the budget it
 * announces cannot outgrow that budget. `[output truncated at N of M bytes —
 * K elided]` is 58 bytes for a real log and 87 at the 20-digit counts where
 * those numbers stop being reachable anyway.
 */
const NOTICE_RESERVE_BYTES = 96;
/** What one `### …` header, its fence and its separator cost per command. */
const BLOCK_OVERHEAD_BYTES = 128;

function escapeUntrustedFence(value: string): string {
  return value.replaceAll('```', '``\u200b`');
}

/**
 * Bound one contribution, and say what bounding it cost.
 *
 * Runner output is bottom-heavy — pytest, vitest and go test print the failure
 * summary last — but the head is not dead weight either: it names the suite
 * that spoke. Both ends are kept, and the notice goes FIRST like
 * `getDiffText`'s: anything that cuts this section again removes the end, and a
 * log that stops mid-stack-trace without saying so invites a verdict on output
 * the reviewer only partly saw.
 */
function boundLog(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  const total = bytes.length;
  if (total <= maxBytes) return value;
  // Both cuts walk onto codepoint boundaries: slicing mid-sequence decodes to
  // U+FFFD, and the prompts this section feeds are Korean as often as English.
  let headEnd = Math.min(LOG_HEAD_BYTES, Math.floor(maxBytes / 4));
  while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd--;
  const tailBytes = maxBytes - NOTICE_RESERVE_BYTES - Buffer.byteLength(LOG_ELISION) - 1 - headEnd;
  // Too small to hold both ends and an honest notice: the tail is what fits.
  let tailStart = Math.max(0, total - (tailBytes > 0 ? tailBytes : maxBytes));
  while (tailStart < total && (bytes[tailStart] & 0xc0) === 0x80) tailStart++;
  const tail = bytes.subarray(tailStart).toString('utf8');
  if (tailBytes <= 0) return tail;
  const kept = Math.min(total, headEnd + Buffer.byteLength(tail));
  return `[output truncated at ${kept} of ${total} bytes — ${total - kept} elided]\n${bytes.subarray(0, headEnd).toString('utf8')}${LOG_ELISION}${tail}`;
}

export function renderVerifyEvidence(evidence: VerifyEvidence[]): string {
  if (evidence.length === 0) return '';
  const summaries = evidence.map((item) =>
    `- ${item.command.name} (${item.command.kind}): head=${item.headStatus}, base=${item.baseStatus}, newFailure=${item.newFailure ? 'yes' : 'no'}, ${(item.durationMs / 1000).toFixed(1)}s`
  ).join('\n');
  const prefix = `## Verification Evidence (deterministic, harness-run)\n${summaries}`;
  const failing = evidence.filter((item) => item.newFailure);
  if (failing.length === 0) return boundLog(prefix, MAX_EVIDENCE_BYTES);
  // Each log is bounded BEFORE the join, against a share of what the summaries
  // leave: bounding only the joined blob let the first command's log fall out
  // whole behind the last one's. Escaped first, so the bound holds for what is
  // actually rendered.
  const share = Math.floor((MAX_EVIDENCE_BYTES - Buffer.byteLength(prefix)) / failing.length) - BLOCK_OVERHEAD_BYTES;
  const perLog = Math.max(0, Math.min(MAX_LOG_BYTES, share));
  const blocks = failing
    .map((item) => `\n### ${item.command.name} output (untrusted data)\n\`\`\`text\n${boundLog(escapeUntrustedFence(item.rawOutputTail), perLog)}\n\`\`\``)
    .join('\n');
  // Backstop for a summary block grown past the section on its own — command
  // names come from the manifest — where no share was left to give the logs.
  return boundLog(`${prefix}\n${blocks}`, MAX_EVIDENCE_BYTES);
}
