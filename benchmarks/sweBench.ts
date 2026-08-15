#!/usr/bin/env tsx
// ============================================
// OpenSwarm - SWE-bench Lite: solve with OpenSwarm, grade with official harness
// Created: 2026-06-09
// Purpose: OpenSwarm worker(runAgenticLoop)가 실제 SWE-bench 버그를 풀고, 채점은 공식
//          swebench 하니스에 위임. 채점을 손으로 재현하다 함정(테스트 수집/gold/base 상태)에
//          반복해 걸려서 — 해결은 OpenSwarm, 평가는 표준 도구로 분리.
//
// 흐름:
//   1. SWE-bench 이미지에서 /testbed(=base+test_patch) 호스트 추출
//   2. OpenSwarm worker가 호스트 소스를 read/edit로 수정 (Codex CLI 아님 — 진짜 하네스)
//      자가검증: bash run_tests.sh → 컨테이너 conda env에서 FAIL_TO_PASS 실행
//   3. git diff로 model_patch 추출 → prediction JSON 작성
//   → 채점은 별도: python -m swebench.harness.run_evaluation -p preds.json ...
//
// 실행: npx tsx benchmarks/sweBench.ts <instances.json> [outPreds.json]
//       (OPENROUTER_API_KEY required — auto-loaded from the repo .env)
// ============================================

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runWorker } from '../src/agents/worker.js';
import { setDefaultAdapter } from '../src/adapters/index.js';
import { initLocale } from '../src/locale/index.js';
import { loadEnvFile } from '../src/core/envFile.js';
import { safeConsole as console } from '../src/support/safeLog.js';

const exec = promisify(execFile);

interface SweInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  FAIL_TO_PASS: string;
  // The gold test diff. SWE-bench images ship base_commit only; the official
  // grader applies this at eval time. We pre-apply it so local verification
  // runs the REAL FAIL_TO_PASS test (defect #8) — see solveOne.
  test_patch?: string;
}

function imageFor(id: string): string {
  return `swebench/sweb.eval.x86_64.${id.replace('__', '_1776_')}:latest`;
}

/**
 * Extract the file paths a SWE-bench test_patch touches (the `+++ b/<path>`
 * targets). These feed protectedFiles so the implementer cannot edit the test
 * oracle once it has been pre-applied.
 */
function testFilesFromPatch(testPatch: string): string[] {
  const files = new Set<string>();
  for (const m of testPatch.matchAll(/^\+\+\+ b\/(\S+)/gm)) {
    if (m[1] !== '/dev/null') files.add(m[1]);
  }
  return [...files];
}

/**
 * Diagnosis section for hybrid stage 2 (implementer). Includes mechanical
 * finishing instructions — in the first hybrid run the implementer had the
 * diagnosis (correct location) yet failed on a missing import and `self` use
 * inside a @staticmethod; this prevents that recurrence.
 * Trust boundary: the diagnosis pseudocode itself may be buggy (measured on
 * 7993 — a missing Formatter.parse literal re-escape propagated verbatim to
 * the implementer twice). Stating that test results outrank the fix plan
 * blocks blind copying.
 */
function buildDiagnosisSection(diagText: string): string {
  return (
    `\n\n## Root-cause diagnosis (from a senior engineer — trust this analysis)\n` +
    `${diagText}\n\n` +
    `Apply the FIX PLAN above. Your job is the implementation and verification, not re-diagnosis.\n` +
    `The ROOT CAUSE analysis is reliable, but the FIX PLAN pseudocode may contain mechanical bugs ` +
    `of its own. THE TEST RESULT OUTRANKS THE PLAN: if you applied the plan faithfully and the ` +
    `tests still fail, the pseudocode itself is buggy — debug from the actual test output and fix ` +
    `the implementation (keeping the root-cause approach), do NOT re-apply the same code again.\n` +
    `Implementation mechanics matter: if you call a function not imported in that file, ADD the ` +
    `import. If you reference \`self\` inside a @staticmethod, convert it to an instance method ` +
    `(add \`self\` param, remove the decorator) or pass the values in. If edit_file fails with ` +
    `"old_string not found", re-read the exact lines and retry with the verbatim text — do NOT give up. ` +
    `If the test output shows NameError / ImportError / AttributeError / TypeError, that is YOUR ` +
    `mechanical bug — read the traceback and fix it, do not abandon the approach.\n`
  );
}

async function sh(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  return exec(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 1024 * 1024 * 64 });
}

/**
 * model_name_or_path recorded in predictions. Includes the evaluated model so
 * a preds file identifies what produced it without relying on its filename
 * (PR #354 review). Slashes sanitized — the official harness uses this value
 * in report/log paths.
 */
function predsModelName(model: string): string {
  return `openswarm+${model.replaceAll('/', '__')}`;
}

async function solveOne(inst: SweInstance, model: string): Promise<{ pred: Record<string, unknown>; resolvedHint: string }> {
  const image = imageFor(inst.instance_id);
  const container = `swe-${inst.instance_id.replace(/[^a-z0-9]/gi, '-')}`;
  const hostDir = await mkdtemp(join(tmpdir(), 'swe-'));
  const log = (s: string) => console.log(s);
  const failToPass: string[] = JSON.parse(inst.FAIL_TO_PASS);

  await sh('docker', ['rm', '-f', container], { timeoutMs: 30_000 }).catch(() => {});
  try {
    log(`\n=== ${inst.instance_id} (${inst.repo}) ===`);
    await sh('docker', ['run', '-d', '--name', container, '--platform', 'linux/amd64', image, 'sleep', 'infinity'], { timeoutMs: 60_000 });
    log('  extracting /testbed...');
    await sh('docker', ['cp', `${container}:/testbed/.`, hostDir], { timeoutMs: 120_000 });

    // Pre-apply the gold test_patch BEFORE baselining (defect #8). The extracted
    // /testbed is at base_commit without the FAIL_TO_PASS test, so the implementer
    // would otherwise invent its own test — which can validate a WRONG fix (seen on
    // 7080). Baking the real test into the baseline (a) makes local verification use
    // the true oracle and (b) keeps it out of the extracted model_patch automatically
    // (git diff baseSha excludes it), so model_patch stays source-only as the grader
    // requires. The official harness applies test_patch itself at eval time.
    let protectedTestFiles: string[] = [];
    if (inst.test_patch && inst.test_patch.trim()) {
      const tpPath = join(hostDir, '.openswarm-gold-test.patch');
      await writeFile(tpPath, inst.test_patch);
      try {
        await sh('git', ['apply', '--whitespace=nowarn', tpPath], { cwd: hostDir, timeoutMs: 30_000 });
        protectedTestFiles = testFilesFromPatch(inst.test_patch);
        log(`  applied gold test_patch — protecting ${protectedTestFiles.length} test file(s): ${protectedTestFiles.join(', ')}`);
      } catch (err) {
        log(`  WARNING: gold test_patch did not apply (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — falling back to implementer-authored test (defect #8 risk)`);
      }
      await rm(tpPath, { force: true }).catch(() => {});
    } else {
      log('  WARNING: instance has no test_patch — local verification relies on an implementer-authored test (defect #8 risk)');
    }

    // git baseline 고정 (patch 추출 기준). 추출된 /testbed는 이미 git repo.
    await sh('git', ['add', '-A'], { cwd: hostDir, timeoutMs: 30_000 }).catch(() => {});
    await sh('git', ['-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-qm', 'baseline', '--allow-empty'], { cwd: hostDir, timeoutMs: 30_000 }).catch(() => {});
    const baseSha = (await sh('git', ['rev-parse', 'HEAD'], { cwd: hostDir, timeoutMs: 10_000 })).stdout.trim();

    // worker 자가검증 래퍼 — 변경분을 컨테이너에 sync 후 conda env에서 테스트.
    const runTests = [
      '#!/usr/bin/env bash',
      `docker cp . ${container}:/testbed >/dev/null 2>&1`,
      `docker exec ${container} bash -lc "source /opt/miniconda3/bin/activate testbed && cd /testbed && python -m pytest ${failToPass.map((t) => `'${t}'`).join(' ')} -q --no-header -p no:warnings --tb=short 2>&1 | tail -25"`,
    ].join('\n');
    await writeFile(join(hostDir, 'run_tests.sh'), runTests, { mode: 0o755 });

    // ---- 하이브리드 모드 (SWE_DIAG_MODEL 설정 시) ----
    // Stage 1: frontier가 read-only 진단 → root cause + 수정 계획 텍스트.
    // Stage 2: 경량 모델이 진단서를 받아 구현 + 검증 루프.
    // 가설: 경량의 천장은 "진단 깊이"이므로, 그 부분만 frontier가 메우면
    // 긴 edit-test 루프(토큰 대부분)는 싼 모델로 충분할 것.
    const diagModel = process.env.SWE_DIAG_MODEL;
    const diagFile = process.env.SWE_DIAG_FILE; // 저장된 진단 재사용 (stage 2만 재시도)
    let diagnosisSection = '';
    if (diagFile) {
      const diagText = (await readFile(diagFile, 'utf-8')).trim();
      log(`  stage 1 skipped — reusing diagnosis from ${diagFile} (${diagText.length} chars)`);
      diagnosisSection = buildDiagnosisSection(diagText);
    } else if (diagModel) {
      log(`  stage 1: diagnosing with ${diagModel} (read-only)...`);
      const diag = await runWorker({
        taskTitle: `Diagnose ${inst.instance_id}`,
        taskDescription:
          `${inst.problem_statement}\n\n` +
          `You are a DIAGNOSTICIAN, not an implementer. Explore the ${inst.repo} source ` +
          `(search_files + read_file) and produce a precise root-cause diagnosis. ` +
          `Do NOT edit any files. Do NOT run run_tests.sh. Read-only.\n\n` +
          `Your final message MUST contain:\n` +
          `1. ROOT CAUSE: the exact mechanism of the bug (which function, what goes wrong, why).\n` +
          `2. FIX PLAN: the exact file + function to change, and precisely what the change should be ` +
          `(describe the code to add/modify — concrete enough that a junior developer could apply it ` +
          `without re-deriving the analysis).\n` +
          `Failing tests (for context):\n` + failToPass.map((t) => `  - ${t}`).join('\n'),
        projectPath: hostDir,
        adapterName: 'openrouter',
        model: diagModel,
        timeoutMs: 900_000,
        maxTurns: 50,
        // Benchmark integrity — no web tools, or the model could just search up
        // the instance's GitHub issue / gold patch instead of diagnosing.
        webTools: false,
        onLog: process.env.SWE_VERBOSE ? (l) => console.log(`    [diag] ${l}`) : () => {},
      });
      // 진단자가 실수로 수정했어도 구현 단계는 깨끗한 베이스에서 시작
      await sh('git', ['checkout', '--', '.'], { cwd: hostDir, timeoutMs: 30_000 }).catch(() => {});
      const diagText = (diag.output || diag.summary || '').trim();
      log(`  stage 1 done — diagnosis ${diagText.length} chars`);
      await writeFile(join(hostDir, 'openswarm-diagnosis.txt'), diagText).catch(() => {});
      diagnosisSection = buildDiagnosisSection(diagText);
    }

    log(`  ${diagnosisSection ? 'stage 2: implementing' : 'worker solving'} (OpenSwarm harness)...`);
    const result = await runWorker({
      taskTitle: `Fix ${inst.instance_id}`,
      taskDescription:
        `${inst.problem_statement}${diagnosisSection}\n\n` +
        `This is a real bug in ${inst.repo}. Your job: locate the root cause in the SOURCE files ` +
        `(search_files + read_file) and FIX it with edit_file. Do NOT edit test files.\n\n` +
        `Do NOT try to set up a Python environment (no pip install, no venv) — the test environment ` +
        `is already managed inside a container.\n\n` +
        `MANDATORY verification loop: after EVERY edit, run \`bash run_tests.sh\` — it executes the ` +
        `failing tests in the correct environment and prints pass/fail. If tests still fail, read the ` +
        `failure output, refine your diagnosis, and edit again. Repeat edit→test until the tests pass. ` +
        `Do NOT finish while the tests are failing — an unverified patch is worthless. A plausible-looking ` +
        `fix in the wrong place is the most common failure mode; only the test output proves correctness.\n\n` +
        `Failing tests:\n` + failToPass.map((t) => `  - ${t}`).join('\n'),
      projectPath: hostDir,
      adapterName: 'openrouter',
      model,
      timeoutMs: 1_200_000,
      maxTurns: 80,
      // SWE 작업은 수정이 필수 — 모델이 분석만 하고 끝내려 하면 2회까지 되민다.
      nudgeMaxOnNoEdit: 2,
      // Verification-harness protection — on 7993 the implementer blamed test
      // failures on run_tests.sh and edited it 5 times, dismantling verification.
      // The pre-applied gold test files join the protected set (defect #8) so the
      // implementer can't rewrite the oracle to make a wrong fix pass.
      protectedFiles: ['run_tests.sh', ...protectedTestFiles],
      // run_tests.sh = docker cp + in-container pytest — the 30s default times
      // out into a silent no-output failure the model reads as a broken env.
      bashTimeoutMs: 240_000,
      // Benchmark integrity — no web search of the gold patch / GitHub issue.
      webTools: false,
      onLog: process.env.SWE_VERBOSE ? (l) => console.log(`    ${l}`) : () => {},
    });

    // model_patch 추출 — run_tests.sh는 제외(평가 노이즈 방지)
    await sh('git', ['rm', '--cached', '-q', 'run_tests.sh'], { cwd: hostDir, timeoutMs: 10_000 }).catch(() => {});
    const diff = (await sh('git', ['diff', baseSha, '--', '.', ':(exclude)run_tests.sh'], { cwd: hostDir, timeoutMs: 30_000 })).stdout;

    log(`  worker done — ${result.filesChanged?.length ?? 0} files, patch ${diff.split('\n').length} lines`);
    return {
      pred: { instance_id: inst.instance_id, model_name_or_path: predsModelName(model), model_patch: diff },
      resolvedHint: `${result.filesChanged?.length ?? 0} files`,
    };
  } finally {
    await sh('docker', ['rm', '-f', container], { timeoutMs: 30_000 }).catch(() => {});
    await rm(hostDir, { recursive: true, force: true });
  }
}

async function main() {
  loadEnvFile();
  initLocale('en');
  setDefaultAdapter('openrouter');
  const file = process.argv[2];
  const outputDir = process.argv[3] ? undefined : await mkdtemp(join(tmpdir(), 'swe-preds-'));
  const outPreds = process.argv[3] ?? join(outputDir!, 'predictions.json');
  if (!file) { console.error('usage: sweBench.ts <instances.json> [outPreds.json]'); process.exit(1); }
  const instances: SweInstance[] = JSON.parse(await readFile(file, 'utf-8'));
  const model = process.env.SWE_MODEL ?? 'deepseek/deepseek-v4-flash';
  console.log(`[swe] ${instances.length} instances, model=${model} (OpenSwarm harness → official grading)`);

  const preds = [];
  for (const inst of instances) {
    const { pred } = await solveOne(inst, model);
    preds.push(pred);
  }
  await writeFile(outPreds, JSON.stringify(preds, null, 2));
  console.log(`\npredictions → ${outPreds}`);
  console.log(`\nGrade with official harness:`);
  console.log(`  /tmp/swebench-env/bin/python -m swebench.harness.run_evaluation \\`);
  console.log(`    --dataset_name SWE-bench/SWE-bench_Lite --predictions_path ${outPreds} \\`);
  console.log(`    --run_id openswarm-run --instance_ids ${instances.map((i) => i.instance_id).join(' ')} --cache_level instance`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
