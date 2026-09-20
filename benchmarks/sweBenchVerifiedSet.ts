#!/usr/bin/env tsx
// Generate the fixed, pure-logic SWE-bench Verified N=30 cohort used for
// worker-model comparison. The official dataset is the source of the complete
// problem/test records; this file deliberately stores only the stable IDs.

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DATASET = 'SWE-bench/SWE-bench_Verified';
const PAGE_SIZE = 100;
const DATASET_URL = 'https://datasets-server.huggingface.co/rows';

export const COHORT_REPOS = ['pylint-dev/pylint', 'sphinx-doc/sphinx', 'sympy/sympy'] as const;

/**
 * Fixed rather than "first 30 returned" so a dataset-server page-order change
 * cannot silently change the denominator of a model comparison.
 */
export const COHORT_IDS = [
  'pylint-dev__pylint-4551',
  'pylint-dev__pylint-4604',
  'pylint-dev__pylint-4661',
  'pylint-dev__pylint-4970',
  'pylint-dev__pylint-6386',
  'pylint-dev__pylint-6528',
  'pylint-dev__pylint-6903',
  'pylint-dev__pylint-7080',
  'pylint-dev__pylint-7277',
  'pylint-dev__pylint-8898',
  'sphinx-doc__sphinx-10323',
  'sphinx-doc__sphinx-10435',
  'sphinx-doc__sphinx-10449',
  'sphinx-doc__sphinx-10466',
  'sphinx-doc__sphinx-10614',
  'sphinx-doc__sphinx-10673',
  'sphinx-doc__sphinx-11445',
  'sphinx-doc__sphinx-11510',
  'sphinx-doc__sphinx-7440',
  'sphinx-doc__sphinx-7454',
  'sympy__sympy-11618',
  'sympy__sympy-12096',
  'sympy__sympy-12419',
  'sympy__sympy-12481',
  'sympy__sympy-12489',
  'sympy__sympy-13031',
  'sympy__sympy-13091',
  'sympy__sympy-13372',
  'sympy__sympy-13480',
  'sympy__sympy-13551',
] as const;

export interface SweBenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  FAIL_TO_PASS: string;
  test_patch?: string;
  [key: string]: unknown;
}

interface DatasetPage {
  rows?: Array<{ row?: SweBenchInstance }>;
}

export function imageFor(instanceId: string): string {
  return `swebench/sweb.eval.x86_64.${instanceId.replace('__', '_1776_')}:latest`;
}

export function selectCohort(rows: SweBenchInstance[]): SweBenchInstance[] {
  const byId = new Map(rows.map((row) => [row.instance_id, row]));
  const cohort = COHORT_IDS.map((id) => byId.get(id));
  const missing = COHORT_IDS.filter((id, index) => !cohort[index]);
  if (missing.length) throw new Error(`Official dataset did not return ${missing.length} cohort record(s): ${missing.join(', ')}`);

  const selected = cohort as SweBenchInstance[];
  for (const row of selected) {
    if (!COHORT_REPOS.includes(row.repo as (typeof COHORT_REPOS)[number])) {
      throw new Error(`Cohort member ${row.instance_id} unexpectedly belongs to ${row.repo}`);
    }
    for (const field of ['base_commit', 'problem_statement', 'FAIL_TO_PASS'] as const) {
      if (!row[field]) throw new Error(`Cohort member ${row.instance_id} is missing required field ${field}`);
    }
  }
  return selected;
}

async function fetchPage(offset: number): Promise<SweBenchInstance[]> {
  const url = new URL(DATASET_URL);
  url.searchParams.set('dataset', DATASET);
  url.searchParams.set('config', 'default');
  url.searchParams.set('split', 'test');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('length', String(PAGE_SIZE));
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Dataset request failed at offset ${offset}: HTTP ${response.status}`);
  const body = await response.json() as DatasetPage;
  return (body.rows ?? []).flatMap(({ row }) => row ? [row] : []);
}

export async function fetchCohort(): Promise<SweBenchInstance[]> {
  const rows: SweBenchInstance[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchPage(offset);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return selectCohort(rows);
}

async function dockerImageCheck(image: string, pull: boolean): Promise<void> {
  const args = pull ? ['pull', '--platform', 'linux/amd64', image] : ['manifest', 'inspect', image];
  await execFileAsync('docker', args, { maxBuffer: 1024 * 1024 * 8 });
}

function parseArgs(argv: string[]): { output: string; checkManifests: boolean; pull: boolean } {
  let output = 'benchmarks/fixtures/swebench-verified-n30.json';
  let checkManifests = false;
  let pull = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      output = argv[++index] ?? '';
      if (!output) throw new Error('--out requires a path');
    } else if (arg === '--check-manifests') {
      checkManifests = true;
    } else if (arg === '--pull') {
      pull = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { output, checkManifests, pull };
}

async function main(): Promise<void> {
  const { output, checkManifests, pull } = parseArgs(process.argv.slice(2));
  const cohort = await fetchCohort();
  const destination = resolve(output);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(cohort, null, 2)}\n`);
  console.log(`Wrote ${cohort.length} official ${DATASET} records to ${destination}`);

  if (checkManifests || pull) {
    const mode = pull ? 'pull' : 'manifest';
    for (const row of cohort) {
      const image = imageFor(row.instance_id);
      process.stdout.write(`[${mode}] ${image}\n`);
      await dockerImageCheck(image, pull);
    }
    console.log(`${mode} check passed for ${cohort.length} images`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
