// ============================================
// OpenSwarm - Model selection benchmark scoring (AGT-4186)
// Created: 2026-11-22
// Purpose: The pure half of benchmarks/modelSelect.ts: run records, the
//          infrastructure-failure classifier, aggregation, the level table, the
//          ranking report, the escalation verdict against --primary, and the
//          sweep loop that aborts on the first infrastructure failure.
// Dependencies: none (no process, git or network access)
// Test Status: tests/modelSelect.scoring.test.ts
// ============================================

export interface RunResult {
  model: string;
  taskId: string;
  rep: number;
  passed: boolean;
  reason: string;
  toolCalls: number;
  apiCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  durationMs: number;
  /**
   * Set when the run failed for an infrastructure reason (auth, billing, quota,
   * an adapter fallback). Such a run says nothing about the model: it is left
   * out of every pass rate and aborts the sweep.
   */
  infraError?: string;
}

export interface ModelAgg {
  model: string;
  /** Scored runs only (infrastructure failures are excluded). */
  runs: number;
  passes: number;
  passRate: number;
  avgCostUsd: number;
  /** Cost per successful run, the main efficiency metric. */
  costPerPass: number;
  avgToolCalls: number;
  avgDurationMs: number;
  /** Runs left out of the score because of an infrastructure failure. */
  infraErrors: number;
}

/** What a single worker run left behind, as seen by the classifier. */
export interface InfraEvidence {
  /**
   * The message of an error runWorker threw. Only the adapter or the worker
   * writes it, so the broad auth/billing/quota rules apply.
   */
  error?: string;
  /**
   * WorkerResult.error. Trusted only when runWorker took its catch path (see
   * isWorkerCatchPath); otherwise it can come from the model's own completion
   * block or name model-chosen file paths, so only the narrow rules apply.
   */
  workerError?: string;
  /** WorkerResult.summary (may contain model-authored text). */
  summary?: string;
  /** onLog lines (tool output and model text appear here too). */
  logs?: readonly string[];
}

// Text only the adapter or the worker writes (a thrown error, or
// WorkerResult.error from runWorker's catch path). The broad forms are safe
// only here.
const ADAPTER_TEXT_RULES: ReadonlyArray<{ re: RegExp; label: string }> = [
  {
    re: /\b401\b|user not found/i,
    label: '401 / User not found: the OpenRouter key was rejected (auth), not a model failure',
  },
  {
    re: /\b402\b|insufficient[\s_-]+(?:balance|credits)|out of credits/i,
    label: '402 insufficient balance: the provider pool is dry (billing), not a model failure',
  },
  {
    re: /insufficient[_-]?quota|\bquota\b|usage limit reached|rate limit reached/i,
    label: 'quota exhausted at the provider, not a model failure',
  },
];

// Text a model can influence (summary, onLog lines, WorkerResult.error outside
// the catch path). Only forms an adapter or the worker itself emits are trusted
// here, so a task that mentions "401" or "quota" is still scored as a model
// result.
const FALLBACK_LINE = /\[Worker\] (?:quota|infra) on \S+, fallback to \S+/;
// OpenRouterAdapter re-runs a failed DEFAULT_MODEL run on another model and
// logs this line; the result then belongs to a different model.
const MODEL_ESCALATION_LINE = /^\[OpenRouter\] \S+ failed; escalating to \S+/;
const WRAPPED_API_ERROR = /API error \((40[12])\)/i;
// runWorker's catch path sets this summary (with an adapter prefix on a
// fallback attempt); only then is WorkerResult.error the adapter's own message.
const WORKER_CATCH_SUMMARY = /^(\[\S+\] )?Worker execution failed$/;

/** True when a WorkerResult came from runWorker's catch path, not from the model. */
export function isWorkerCatchPath(summary: string | undefined): boolean {
  return summary !== undefined && WORKER_CATCH_SUMMARY.test(summary);
}

function classifyAdapterText(text: string): string | null {
  for (const rule of ADAPTER_TEXT_RULES) {
    if (rule.re.test(text)) return rule.label;
  }
  return null;
}

/**
 * Decide whether a run failed for an infrastructure reason. Returns a
 * human-readable reason, or null when the run is a genuine model result.
 */
export function classifyInfraFailure(evidence: InfraEvidence): string | null {
  const catchPath = isWorkerCatchPath(evidence.summary);
  const trusted = [evidence.error, catchPath ? evidence.workerError : undefined];
  for (const text of trusted) {
    if (!text) continue;
    const hit = classifyAdapterText(text);
    if (hit) return hit;
  }
  const untrusted = [
    evidence.summary ?? '',
    ...(catchPath || !evidence.workerError ? [] : [evidence.workerError]),
    ...(evidence.logs ?? []),
  ];
  for (const line of untrusted) {
    const fallback = line.match(FALLBACK_LINE);
    if (fallback) {
      return `worker infra fallback ("${fallback[0]}"): another adapter ran under this model's name`;
    }
    const escalation = line.match(MODEL_ESCALATION_LINE);
    if (escalation) {
      return `adapter model escalation ("${escalation[0]}"): another model ran under this model's name`;
    }
    // A FATAL line is written by runOne itself from a thrown error.
    if (line.startsWith('FATAL:')) {
      const hit = classifyAdapterText(line);
      if (hit) return hit;
    }
    const wrapped = line.match(WRAPPED_API_ERROR);
    if (wrapped) {
      const hit = classifyAdapterText(wrapped[0]);
      if (hit) return hit;
    }
  }
  return null;
}

export function aggregate(results: readonly RunResult[]): ModelAgg[] {
  const byModel = new Map<string, RunResult[]>();
  for (const r of results) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model)!.push(r);
  }

  const aggs: ModelAgg[] = [];
  for (const [model, all] of byModel) {
    const rs = all.filter((r) => !r.infraError);
    const n = rs.length;
    const passes = rs.filter((r) => r.passed).length;
    const totalCost = rs.reduce((s, r) => s + r.costUsd, 0);
    aggs.push({
      model,
      runs: n,
      passes,
      passRate: n ? passes / n : 0,
      avgCostUsd: n ? totalCost / n : 0,
      costPerPass: passes > 0 ? totalCost / passes : Infinity,
      avgToolCalls: n ? rs.reduce((s, r) => s + r.toolCalls, 0) / n : 0,
      avgDurationMs: n ? rs.reduce((s, r) => s + r.durationMs, 0) / n : 0,
      infraErrors: all.length - n,
    });
  }

  // Ranking: pass rate desc, then $/pass asc, then tool calls asc.
  aggs.sort((a, b) =>
    b.passRate - a.passRate ||
    a.costPerPass - b.costPerPass ||
    a.avgToolCalls - b.avgToolCalls);
  return aggs;
}

export function fmtUsd(n: number): string {
  if (!isFinite(n)) return '∞';
  if (n < 0.001) return `$${(n * 1000).toFixed(3)}m`; // milli-dollar
  return `$${n.toFixed(4)}`;
}

/** taskId to level (the difficulty ladder in RUBRIC.md). */
export function levelOf(taskId: string): string {
  const m = taskId.match(/^(L\d)/);
  return m ? m[1] : '?';
}

/**
 * Model x level pass-rate table: the level at which models separate.
 * Infrastructure failures are left out of every cell.
 */
export function levelTable(results: readonly RunResult[]): string {
  const levels = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
  const models = [...new Set(results.map((r) => r.model))];
  const cell = new Map<string, { p: number; n: number }>();
  for (const r of results) {
    if (r.infraError) continue;
    const k = `${r.model}|${levelOf(r.taskId)}`;
    const c = cell.get(k) ?? { p: 0, n: 0 };
    c.n++; if (r.passed) c.p++;
    cell.set(k, c);
  }
  const lines: string[] = [];
  lines.push('\n========== LEVEL × MODEL pass-rate (RUBRIC discrimination) ==========');
  lines.push(`${'model'.padEnd(34)} ${levels.map((l) => l.padStart(5)).join(' ')}`);
  for (const model of models) {
    const cells = levels.map((l) => {
      const c = cell.get(`${model}|${l}`);
      return c && c.n ? `${Math.round((c.p / c.n) * 100)}%`.padStart(5) : '  -  ';
    });
    lines.push(`${model.padEnd(34)} ${cells.join(' ')}`);
  }
  lines.push('(L6 = real SWE-bench, graded separately: benchmarks/sweBench.ts + RUBRIC.md)');
  return lines.join('\n');
}

const pct = (r: number): string => `${(r * 100).toFixed(0)}%`;

/**
 * ESCALATION FINDING: which candidate is a real second opinion for --primary.
 * A candidate scoring below the primary on the same task set is weaker than the
 * primary and therefore not a second opinion. Eligible candidates (pass rate at
 * least the primary's) are ranked by pass rate, then $/pass. When the primary
 * passes everything, the task set cannot separate an escalate model from it.
 */
export function escalationVerdict(aggs: readonly ModelAgg[], primary: string): string {
  const lines: string[] = ['\n========== ESCALATION FINDING =========='];
  const prim = aggs.find((a) => a.model === primary);
  if (!prim || prim.runs === 0) {
    lines.push(`primary ${primary} has no scored runs on this task set; no escalation verdict.`);
    return lines.join('\n');
  }
  lines.push(`primary: ${primary} — pass ${pct(prim.passRate)}, $/pass ${fmtUsd(prim.costPerPass)}`);

  const candidates = aggs.filter((a) => a.model !== primary && a.runs > 0);
  const weaker = candidates.filter((a) => a.passRate < prim.passRate);
  const eligible = candidates
    .filter((a) => a.passRate >= prim.passRate)
    .sort((a, b) => b.passRate - a.passRate || a.costPerPass - b.costPerPass);

  for (const a of weaker) {
    lines.push(`✗ ${a.model} — pass ${pct(a.passRate)} < ${pct(prim.passRate)}: weaker than primary - not a second opinion`);
  }
  eligible.forEach((a, i) => {
    lines.push(`${i + 1}. ${a.model} — pass ${pct(a.passRate)}, $/pass ${fmtUsd(a.costPerPass)}: eligible escalate target`);
  });

  if (prim.passRate >= 1) {
    lines.push(`⚠️ primary passes 100%: task set does not discriminate - need a harder tier. Recommend no escalate change.`);
  } else if (eligible.length === 0) {
    lines.push(`⚠️ No candidate matched ${primary} on this task set. Recommend no escalate change.`);
  } else {
    lines.push(`→ best second opinion: ${eligible[0].model}`);
  }
  return lines.join('\n');
}

export function report(
  aggs: readonly ModelAgg[],
  baseline: string,
  results: readonly RunResult[],
  primary?: string,
): string {
  const lines: string[] = [];
  lines.push(levelTable(results));
  lines.push('\n========== MODEL RANKING (pass_rate → $/pass → tool calls) ==========');
  lines.push('rank  model                       pass    $/pass     avg$     tools  dur');
  aggs.forEach((a, i) => {
    const tag = a.model === baseline ? ' (baseline)' : a.model === primary ? ' (primary)' : '';
    lines.push(
      `${String(i + 1).padEnd(4)}  ${a.model.padEnd(26)}  ` +
      `${(a.passRate * 100).toFixed(0).padStart(3)}%  ` +
      `${fmtUsd(a.costPerPass).padStart(8)}  ` +
      `${fmtUsd(a.avgCostUsd).padStart(8)}  ` +
      `${a.avgToolCalls.toFixed(1).padStart(5)}  ` +
      `${(a.avgDurationMs / 1000).toFixed(0)}s${tag}`,
    );
  });

  // Pareto frontier: the cheapest model that keeps the baseline's pass rate.
  const base = aggs.find((a) => a.model === baseline);
  if (base) {
    const asGoodCheaper = aggs.filter(
      (a) => a.model !== baseline && a.passRate >= base.passRate && a.costPerPass < base.costPerPass,
    );
    lines.push('\n========== PARETO FINDING ==========');
    lines.push(`baseline: ${baseline} — pass ${pct(base.passRate)}, $/pass ${fmtUsd(base.costPerPass)}`);
    if (asGoodCheaper.length > 0) {
      const best = asGoodCheaper[0];
      const savings = ((1 - best.costPerPass / base.costPerPass) * 100).toFixed(0);
      lines.push(`✅ ${best.model} matches quality (${pct(best.passRate)}) at ${savings}% lower $/pass`);
      lines.push(`   → safe to route here; keep ${baseline} as escalate target.`);
    } else {
      lines.push(`⚠️ No cheaper model matched ${baseline}'s pass rate. Keep frontier or add more repeats.`);
    }
  }

  if (primary) lines.push(escalationVerdict(aggs, primary));
  return lines.join('\n');
}

/** The message printed instead of a ranking when a run hit infrastructure. */
export function infraAbortMessage(failed: RunResult): string {
  return [
    `[bench] ABORTED: infrastructure failure on ${failed.model} / ${failed.taskId} rep${failed.rep}.`,
    `[bench] ${failed.infraError}`,
    '[bench] No ranking was produced: an infrastructure failure is not a model score.',
    '[bench] A 402 means the sponsor pool behind the provider pin is dry; dropping the pin bills the real OpenRouter account.',
  ].join('\n');
}

export type RunSummary =
  | { ok: true; aggs: ModelAgg[]; text: string }
  | { ok: false; failed: RunResult; text: string };

/** Turn finished runs into the printed outcome: a ranking, or an abort with no ranking. */
export function summarizeRun(
  results: readonly RunResult[],
  baseline: string,
  primary?: string,
): RunSummary {
  const failed = results.find((r) => r.infraError);
  if (failed) return { ok: false, failed, text: infraAbortMessage(failed) };
  const aggs = aggregate(results);
  return { ok: true, aggs, text: report(aggs, baseline, results, primary) };
}

/**
 * Run every model x task x repeat. Models run in parallel, each model's runs in
 * series. The first infrastructure failure stops every model from starting
 * another run, so a dry pool or a dead key does not keep spending calls.
 */
export async function runSweep<T extends { id: string }>(
  models: readonly string[],
  tasks: readonly T[],
  repeat: number,
  runOne: (task: T, model: string, rep: number) => Promise<RunResult>,
  onResult?: (r: RunResult) => void,
): Promise<RunResult[]> {
  let aborted = false;
  const perModel = await Promise.all(
    models.map(async (model) => {
      const out: RunResult[] = [];
      for (const task of tasks) {
        for (let rep = 1; rep <= repeat; rep++) {
          if (aborted) return out;
          const r = await runOne(task, model, rep);
          out.push(r);
          onResult?.(r);
          if (r.infraError) aborted = true;
        }
      }
      return out;
    }),
  );
  return perModel.flat();
}
