// ============================================
// OpenSwarm - Hermes advisor bridge
// ============================================
//
// A clearly non-human, automated second opinion for `clarification` questions
// an agent would otherwise escalate to the operator. Thin on purpose: one
// bounded Hermes one-shot per question, through Hermes' documented CLI
// (`hermes chat --oneshot --format stream-json`), with no configuration or
// profile of Hermes' own touched.
//
// Every failure mode — Hermes missing, a timeout, a non-zero exit, output that
// is not the strict verdict shape, low confidence — resolves to "no answer",
// and the caller then pages the human exactly as before. The advisor can only
// ever remove an escalation, never approve anything: the class gate in
// `answerHumanQuestion` refuses it on anything but `clarification`.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Board identity of the advisor. Not on the human-surface allowlist. */
export const HERMES_ADVISOR_ACTOR = 'advisor:hermes';

/** Answers below this self-reported confidence are treated as a decline. */
export const ADVISOR_MIN_CONFIDENCE = 70;

const DEFAULT_RUN_BUDGET_SECONDS = 120;
/** Hard kill after Hermes' own budget, so a hung process cannot hold the ask. */
const KILL_GRACE_MS = 15_000;
const MAX_STDOUT_BYTES = 2_000_000;

export interface HermesRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type HermesRunner = (
  args: string[],
  options: { timeoutMs: number; bin: string },
) => Promise<HermesRunResult>;

export interface AdvisorQuestion {
  repository: string;
  taskLabel?: string;
  question: string;
}

export interface AdvisorProvenance {
  model?: string;
  sessionId?: string;
  totalTokens?: number;
  durationMs?: number;
}

export interface AdvisorVerdict {
  status: 'answered' | 'declined' | 'unavailable';
  answer?: string;
  confidence?: number;
  reason?: string;
  provenance?: AdvisorProvenance;
}

/** Opt-in only. Anything but exactly `1` leaves the advisor off. */
export function isHermesAdvisorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENSWARM_HERMES_ADVISOR === '1';
}

export function buildHermesArgs(input: { queryFile: string; workDir: string; runBudgetSeconds: number }): string[] {
  return [
    'chat',
    '--query-file', input.queryFile,
    '--oneshot',
    '--format', 'stream-json',
    // Keeps advisor sessions out of the operator's own session lists.
    '--source', 'tool',
    // A harmless in-memory toolset: the advisor answers from knowledge, it does
    // not act. One-shot mode bypasses approvals, so no acting toolset is given.
    '-t', 'todo',
    '--max-turns', '4',
    '--run-budget', String(input.runBudgetSeconds),
    // No AGENTS.md / SOUL.md / memory injection from wherever Hermes starts.
    '--ignore-rules',
    '--in', input.workDir,
  ];
}

export function buildAdvisorPrompt(input: AdvisorQuestion): string {
  return [
    'You are an automated technical advisor (not a human) answering a question from an',
    'autonomous coding agent working on a software repository. Your answer is returned',
    'to the agent labelled as automated advice.',
    '',
    'Answer ONLY factual or technical questions (how an API, tool, language or common',
    'convention works). You MUST decline if answering would require or imply: a permission',
    'or approval, credentials or secrets, spending money, production or deployment access,',
    'a destructive or irreversible action, or the operator\'s own preference or policy.',
    'Also decline if you are not confident.',
    '',
    `Repository: ${input.repository}`,
    ...(input.taskLabel ? [`Task: ${input.taskLabel}`] : []),
    'Question:',
    input.question,
    '',
    'Reply with ONLY one JSON object and nothing else:',
    '{"decision":"answer"|"decline","answer":"<answer, or the reason you decline>","confidence":<0-100>}',
  ].join('\n');
}

export interface ParsedHermesStream extends AdvisorProvenance {
  text?: string;
  exitCode?: number;
}

/** Read Hermes' JSONL event stream: final text plus runtime provenance. */
export function parseHermesStream(stdout: string): ParsedHermesStream {
  const parsed: ParsedHermesStream = {};
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch { // cxt-ignore: error_swallow — a partial or foreign line is not an event
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.model === 'string') parsed.model = event.model;
      if (typeof event.session_id === 'string') parsed.sessionId = event.session_id;
    } else if (event.type === 'result') {
      if (typeof event.text === 'string') parsed.text = event.text;
      if (typeof event.session_id === 'string') parsed.sessionId = event.session_id;
      if (typeof event.exit_code === 'number') parsed.exitCode = event.exit_code;
      if (typeof event.duration_ms === 'number') parsed.durationMs = event.duration_ms;
      const tokens = event.tokens as { total?: unknown } | undefined;
      if (typeof tokens?.total === 'number') parsed.totalTokens = tokens.total;
    }
  }
  return parsed;
}

export interface AdvisorVerdictShape {
  decision: 'answer' | 'decline';
  answer: string;
  confidence: number;
}

/** Strict: anything but the exact verdict shape is no verdict at all. */
export function parseAdvisorVerdict(text: string): AdvisorVerdictShape | undefined {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch { // cxt-ignore: error_swallow — prose instead of the contract is a malformed verdict
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const { decision, answer, confidence } = value as Record<string, unknown>;
  if (decision !== 'answer' && decision !== 'decline') return undefined;
  if (typeof answer !== 'string') return undefined;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return undefined;
  if (decision === 'answer' && !answer.trim()) return undefined;
  return { decision, answer: answer.trim(), confidence };
}

const defaultRunner: HermesRunner = (args, { timeoutMs, bin }) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 64_000) stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ exitCode: code, stdout, stderr, timedOut });
  });
});

export interface ConsultOptions {
  runner?: HermesRunner;
  bin?: string;
  runBudgetSeconds?: number;
}

export async function consultHermesAdvisor(
  input: AdvisorQuestion,
  options: ConsultOptions = {},
): Promise<AdvisorVerdict> {
  const runner = options.runner ?? defaultRunner;
  const bin = options.bin ?? process.env.OPENSWARM_HERMES_BIN ?? 'hermes';
  const runBudgetSeconds = options.runBudgetSeconds ?? DEFAULT_RUN_BUDGET_SECONDS;
  let workDir: string | undefined;
  try {
    workDir = await mkdtemp(join(tmpdir(), 'openswarm-hermes-advisor-'));
    const queryFile = join(workDir, 'question.txt');
    await writeFile(queryFile, buildAdvisorPrompt(input), 'utf8');
    const run = await runner(buildHermesArgs({ queryFile, workDir, runBudgetSeconds }), {
      timeoutMs: runBudgetSeconds * 1000 + KILL_GRACE_MS,
      bin,
    });
    const stream = parseHermesStream(run.stdout);
    const provenance: AdvisorProvenance = {
      model: stream.model,
      sessionId: stream.sessionId,
      totalTokens: stream.totalTokens,
      durationMs: stream.durationMs,
    };
    if (run.timedOut) return { status: 'unavailable', reason: 'Hermes timed out', provenance };
    if (run.exitCode !== 0 || (stream.exitCode !== undefined && stream.exitCode !== 0)) {
      return { status: 'unavailable', reason: `Hermes exited ${run.exitCode ?? 'null'}`, provenance };
    }
    if (stream.text === undefined) return { status: 'unavailable', reason: 'Hermes produced no result event', provenance };
    const verdict = parseAdvisorVerdict(stream.text);
    if (!verdict) return { status: 'unavailable', reason: 'Hermes reply did not match the verdict contract', provenance };
    if (verdict.decision === 'decline') {
      return { status: 'declined', reason: verdict.answer || 'declined', confidence: verdict.confidence, provenance };
    }
    if (verdict.confidence < ADVISOR_MIN_CONFIDENCE) {
      return {
        status: 'declined',
        reason: `confidence ${verdict.confidence} below ${ADVISOR_MIN_CONFIDENCE}`,
        confidence: verdict.confidence,
        provenance,
      };
    }
    return { status: 'answered', answer: verdict.answer, confidence: verdict.confidence, provenance };
  } catch (error) { // cxt-ignore: error_swallow,exception_hiding — any failure means "no advice"; the caller pages the human
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The text that reaches the asking agent and the board. States plainly that it
 * is automated advice, names the runtime model, and is never phrased as an
 * operator decision.
 */
export function formatAdvisorAnswer(verdict: AdvisorVerdict): string {
  const p = verdict.provenance ?? {};
  const origin = [
    'Hermes advisor (automated, not a human)',
    p.model ? `model ${p.model}` : undefined,
    p.sessionId ? `session ${p.sessionId}` : undefined,
    verdict.confidence !== undefined ? `confidence ${verdict.confidence}` : undefined,
  ].filter(Boolean).join(', ');
  return `[${origin}]\n${verdict.answer ?? ''}\n\n`
    + 'This is technical advice, not an operator decision. Verify it against the repository before relying on it.';
}
