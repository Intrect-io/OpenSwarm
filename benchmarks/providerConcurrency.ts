#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Provider concurrency sweep
// Created: 2026-07-31
// Purpose: Does the serving provider hold up at the fan-out levels OpenSwarm
//          actually uses? `openswarm review --max` runs up to 16 reviewers at
//          once, and a provider that serializes behind the scenes turns that
//          fan-out into a queue while looking healthy (200s all the way).
//
//          Fires N identical requests simultaneously and reports per-request
//          latency against N. Flat latency = real parallelism. Latency growing
//          in proportion to N = the provider is serializing.
//
// 실행:
//   OPENROUTER_PROVIDER_ONLY=atlas-cloud npx tsx benchmarks/providerConcurrency.ts
//   npx tsx benchmarks/providerConcurrency.ts --model z-ai/glm-5.2 --levels 1,4,8,16
// ============================================

import { loadEnvFile } from '../src/core/envFile.js';

const API = 'https://openrouter.ai/api/v1/chat/completions';
const PROMPT =
  'Write a TypeScript function clamp(n, lo, hi) with a JSDoc comment. Code only, no prose.';

interface Sample {
  ms: number;
  status: number;
  provider?: string;
  completionTokens?: number;
  error?: string;
}

async function one(apiKey: string, model: string, maxTokens: number, pin?: string): Promise<Sample> {
  const t0 = Date.now();
  try {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: PROMPT }],
      max_tokens: maxTokens,
    };
    if (pin) body.provider = { only: pin.split(',').map((s) => s.trim()) };

    const res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as any;
    const ms = Date.now() - t0;
    if (j.error) return { ms, status: res.status, error: String(j.error.message ?? j.error).slice(0, 120) };
    return {
      ms,
      status: res.status,
      provider: j.provider,
      completionTokens: j.usage?.completion_tokens,
    };
  } catch (err) {
    return { ms: Date.now() - t0, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

async function sweep(apiKey: string, model: string, levels: number[], maxTokens: number, pin?: string) {
  console.log(`\nmodel=${model}  pin=${pin ?? '(none)'}  max_tokens=${maxTokens}`);
  console.log('  N   median    p95     max   agg tok/s  wall   errors  provider');

  // A single warm request first: the very first call to a cold model would
  // otherwise land inside N=1 and look like a concurrency effect.
  await one(apiKey, model, maxTokens, pin);

  for (const n of levels) {
    const wall0 = Date.now();
    const samples = await Promise.all(Array.from({ length: n }, () => one(apiKey, model, maxTokens, pin)));
    const wallSec = (Date.now() - wall0) / 1000;

    const ok = samples.filter((s) => !s.error);
    const lat = ok.map((s) => s.ms).sort((a, b) => a - b);
    const tokens = ok.reduce((sum, s) => sum + (s.completionTokens ?? 0), 0);
    const providers = [...new Set(ok.map((s) => s.provider).filter(Boolean))].join(',') || '—';
    const errors = samples.length - ok.length;

    console.log(
      `${String(n).padStart(3)}  ${String(quantile(lat, 0.5)).padStart(6)}ms ` +
      `${String(quantile(lat, 0.95)).padStart(6)}ms ${String(lat[lat.length - 1] ?? 0).padStart(6)}ms ` +
      `${(tokens / wallSec).toFixed(1).padStart(9)}  ${wallSec.toFixed(1).padStart(5)}s ` +
      `${String(errors).padStart(6)}  ${providers}`,
    );
    if (errors > 0) {
      const first = samples.find((s) => s.error);
      console.log(`      first error: ${first?.status} ${first?.error}`);
    }
  }
}

function parseArgs(argv: string[]) {
  const models: string[] = [];
  let levels = [1, 4, 8, 16];
  let maxTokens = 400;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') models.push(argv[++i]);
    else if (argv[i] === '--levels') levels = argv[++i].split(',').map(Number);
    else if (argv[i] === '--max-tokens') maxTokens = Number(argv[++i]);
  }
  return {
    models: models.length ? models : ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.2'],
    levels,
    maxTokens,
  };
}

async function main(): Promise<void> {
  loadEnvFile();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY required');
    process.exit(1);
  }
  const { models, levels, maxTokens } = parseArgs(process.argv.slice(2));
  const pin = process.env.OPENROUTER_PROVIDER_ONLY;

  console.log('=== Provider concurrency sweep ===');
  console.log('Flat median across N => real parallelism. Median growing with N => serialization.');
  for (const model of models) {
    await sweep(apiKey, model, levels, maxTokens, pin);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
