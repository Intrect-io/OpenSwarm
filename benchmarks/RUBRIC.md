# OpenSwarm Coding Benchmark Rubric (L0–L6)

A rubric for measuring the coding capability of the OpenSwarm harness
(worker = `runAgenticLoop`, openrouter adapter) per difficulty level, and for
routing each level to the most **cost-efficient model** based on data.

> The unit under measurement is the **harness + model combination**. The codex
> adapter (delegates to the Codex CLI) bypasses the OpenSwarm harness and is
> excluded — always run measurements through the openrouter adapter.

## Difficulty ladder

| Lv | Name | Capability verified | Grading | Infra |
|----|------|--------------------|---------|-------|
| **L0** | Single edit | One-line to one-function bugfix | Regex (`check()`) | Instant |
| **L1** | Locate + edit | Add a guard, simple feature | Regex | Instant |
| **L2** | Multi-file | Rename/signature cascade (3–4 files) | Regex | Instant |
| **L3** | Make tests pass | Implement a stub until existing tests are green | **Test run** (`tsx`) | Instant |
| **L4** | Hard | Deep dependency chains, edge-case completeness, hidden-bug tracing, type changes | Test run + **tsc** | Instant |
| **L5** | Very hard | Algorithmic correctness (merge-intervals/LRU), state machines (tokenizer), generic types | Test run | Instant |
| **L6** | **Real-world** | **Real GitHub issues** (SWE-bench Lite) — large-repo exploration + root cause + exact patch | **Official swebench harness** (Docker) | OrbStack, minutes |

- **L0–L5**: `benchmarks/tasks/codingTasks.ts` (synthetic, self-contained). Fast
  regression suite. `npx tsx benchmarks/modelSelect.ts --repeat N`. Grading is
  deterministic — no LLM judge.
- **L6**: `benchmarks/sweBench.ts`. The OpenSwarm worker solves SWE-bench Lite
  instances; the official `swebench.harness.run_evaluation` grades them via
  FAIL_TO_PASS + PASS_TO_PASS.

## Recommended models per level (measured)

Derived from benchmark data (`benchmarks/results/`). Score = pass_rate → $/pass → tool calls.

| Lv | Recommended worker model | Rationale |
|----|--------------------------|-----------|
| L0–L3 | **z-ai/glm-4.7-flash** or deepseek-v4-flash | 100% pass, $0.002–0.004/pass. glm is fastest at 2759 tok/s (DeepInfra). Lightweight is enough |
| L4 | Lightweight + escalate | Lightweight models mostly pass (100%); frontier escalation absorbs failures |
| L5 | **moonshotai/kimi-k2.5** | 100% L0–L5 sweep (24/24, repeat 2), $0.0095/pass — 57% cheaper than gemini-2.5-flash at higher quality (2026-06-11 round) |
| **L6** | **Frontier diagnosis + lightweight implementation** | Solo lightweight lacks diagnostic depth. Diagnosis role: gpt-5 or **kimi-k2.6** (first-shot RESOLVED); glm-5.1 works but needed the re-diagnosis escalate loop. Implementation role: kimi-k2.5 / deepseek-v4-flash / glm-5.1 |

### L6 measurements (pylint-dev__pylint-7080, 2026-06)

| Model | Patch | Result | Notes |
|-------|-------|--------|-------|
| **openai/gpt-5** | ✅ | **RESOLVED** | Correct location in `expand_modules.py` (`os.path.relpath`) |
| gemini-2.5-flash | ✅ | unresolved | Only `pylinter.py` — missed the correct location |
| glm-4.7-flash | ✅ | unresolved | Touched the right file but inaccurate |
| qwen3-coder-30b | ✅ | unresolved | Inaccurate |
| deepseek-v4-flash | ❌ | (empty patch) | Never reached an edit |
| gpt-5-mini | ❌ | (empty patch) | Never reached an edit |

→ **Only the frontier model (gpt-5) solved this instance (1/6).** After the
compaction-threshold fix (24k→60k), lightweight models do produce patches, but
**their answer accuracy falls short of frontier**. SWE-bench Lite sits at
30–50% difficulty even for frontier models, so L6 needs frontier routing plus
generous maxTurns (80).

### "Can mandatory verification push a lightweight model through?" (v2, ceiling test)

We made the verification loop MANDATORY ("run run_tests.sh after every edit;
iterate while failing") and re-measured:

| Model | v1 (optional verification) | v2 (mandatory verification + all harness fixes) |
|-------|---------------------------|------------------------------------------------|
| gemini-2.5-flash | 1 edit, 0 verifications → wrong patch | **9 edits + 13 test runs** → still unresolved (FAIL_TO_PASS 0/1, PASS_TO_PASS 120/120 intact) |
| deepseek-v4-flash | 0 edits (pre-compaction-fix) | **Still 0 edits** — 80 turns of exploration, never committed to a change |

**Conclusion: for diagnosis-type bugs at this difficulty, it is effectively a
model ceiling.** Mandatory verification changed behavior dramatically (blind
submission → iterate loop), but the insight the answer required ("absolute vs
relative path representation mismatch in recursive discovery") never emerged
even after 13 rounds of feedback. The harness can provide opportunity (loops,
context) — it cannot provide diagnostic depth.

### Hybrid experiment: frontier diagnosis + lightweight implementation — ✅ all 3 attempted instances RESOLVED (3/3)

We measured the planner/worker split hypothesis directly: **gpt-5 performs a
read-only diagnosis** (root cause + concrete fix plan) → **a lightweight model
implements with the verification loop** → official swebench grading.
**4 cumulative passes** — reproducible across instances (5859, 7993) and
across implementers (deepseek).

| Configuration | Instance | Result |
|---------------|----------|--------|
| gemini solo (mandatory verification, 9 edits + 13 tests) | 7080 | unresolved — diagnosis failure |
| **gpt-5 diagnosis (52 read-only turns) + gemini implementation (3 edits + 2 tests)** | 7080 | **RESOLVED** ✅ |
| **gpt-5 diagnosis + deepseek-v4-flash implementation** (a model that made 0 edits solo) | 7080 | **RESOLVED** ✅ |
| **gpt-5 diagnosis + gemini implementation** (full pipeline on a new instance) | 5859 | **RESOLVED** ✅ |
| gpt-5 diagnosis + glm-4.7-flash | 7080 | Empty patch — **unfit as implementer** (ignored the no-edit guard, 0 edits) |
| gpt-5 diagnosis + gemini (v1–v5) | 7993 | unresolved — the implementer faithfully copied a bug in the first diagnosis's pseudocode |
| **gpt-5 re-diagnosis (fed the failing patch + test output) + deepseek implementation** | 7993 | **RESOLVED** ✅ |

→ **A lightweight model's L6 ceiling is "diagnostic depth"; fill just that gap
with a frontier model and it passes.** Implementer fitness varies by model:
deepseek ✅✅ (reliable mechanical finishing) / gemini ✅ (volatile finishing —
e.g. missed imports) / glm ✗.

**The re-diagnosis escalate loop (proven by 7993)**: when the first diagnosis's
fix plan contains a bug, the lightweight implementer copies it faithfully
("trust this analysis" — even an explicit trust-boundary instruction failed to
break through, 4 consecutive runs). The remedy is not persuading the
implementer but **re-diagnosing with the frontier model, feeding it the
failing patch + test output** — given that feedback, gpt-5 pinpointed the bug
in its own pseudocode (a missing Formatter.parse literal re-escape), and
deepseek finished the job with the revised diagnosis. Structurally identical
to the OpenSwarm worker escalate loop.
Run with SWE_DIAG_MODEL=openai/gpt-5 + SWE_MODEL=<lightweight>. Diagnoses are
reusable (SWE_DIAG_FILE) — retrying stage 2 on the same instance costs zero
frontier tokens.

Operational implication: even L6-grade work can use the "frontier planner
analyzes → lightweight worker implements" split, reducing frontier usage from
a full solve (82 turns) to a read-only diagnosis (52 turns). Lightweight
implementers are volatile (they can give up early even with the same
diagnosis) — the no-edit guard (`nudgeMaxOnNoEdit`) and a rich diagnosis
(including concrete pseudocode) are the success factors. Best-of-N has low
expected value (all 9 undiagnosed gemini attempts were wrong).

### Kimi K2.5/K2.6 round (2026-06-11) — both roles validated

Tested MoonshotAI Kimi K2.5 ($0.40/$1.90 per M) and K2.6 ($0.68/$3.41 per M)
in both OpenSwarm roles, same harness, official grading.

**L0–L5 ladder** (12 tasks × repeat 2 vs baseline gemini-2.5-flash):

| Model | L0–L5 pass | $/pass | avg tools | avg dur |
|-------|-----------|--------|-----------|---------|
| **moonshotai/kimi-k2.5** | **100%** (24/24) | $0.0095 | 7.9 | 34s |
| moonshotai/kimi-k2.6 | **100%** (24/24) | $0.0122 | 6.8 | 41s |
| google/gemini-2.5-flash (baseline) | 88% | $0.0220 | 10.8 | 27s |

k2.5 strictly dominates k2.6 as a worker (same quality, cheaper, faster);
k2.6's higher reasoning latency (~2× on trivial tasks) buys nothing at L0–L5.

**L6 worker role** — kimi-k2.5 as hybrid implementer (saved gpt-5 diagnoses):

| Configuration | Instance | Result |
|---------------|----------|--------|
| gpt-5 diagnosis + **kimi-k2.5** implementation | 5859 | **RESOLVED** ✅ |
| gpt-5 re-diagnosis + **kimi-k2.5** implementation | 7993 | **RESOLVED** ✅ (first attempt, clean single-file patch) |

**L6 planner role** — kimi-k2.6 as the diagnostician (replacing gpt-5):

| Configuration | Instance | Result |
|---------------|----------|--------|
| **kimi-k2.6 diagnosis** + deepseek-v4-flash implementation | 7080 | **RESOLVED** ✅ |

→ **The hybrid pattern no longer requires gpt-5.** kimi-k2.6 produced a
RESOLVED-grade diagnosis on the instance where 5 of 6 solo models failed
(its fix differs from gpt-5's — `_is_in_ignore_list_re` path normalization
vs `os.path.relpath` — both pass the official grader). Caveat: the k2.6
diagnosis is verbose (58k chars vs gpt-5's 5.5k), so implementer context
pressure is higher; it worked, but diagnosis-length budgeting is a future
lever. Implementer fitness update: **kimi-k2.5 ✅✅ (2/2, joins deepseek as
a reliable finisher)**.

One contamination case (5859): the implementer re-created the missing
FAIL_TO_PASS test in the test file to self-verify; test-file hunks were
stripped from model_patch before grading (standard SWE-bench practice).
Harness improvement candidate: auto-exclude `tests/**` from patch
extraction.

Evidence: `results/kimi_ladder_260611.json`,
`results/swe_{5859,7993}_kimi_worker_RESOLVED_report.json`,
`results/swe_7080_kimi_planner_RESOLVED_report.json`,
`results/swe_7080_kimi_k26_diagnosis.txt`.

### GLM-5.1 round (2026-06-11) — worker ✅, planner needs the escalate loop

Tested `z-ai/glm-5.1` ($0.98/$3.08 per M, 202k ctx — kimi-k2.6's class) on the
same instances:

| Role | Configuration | Instance | Result |
|------|---------------|----------|--------|
| Worker | gpt-5 diagnosis + **glm-5.1** implementation | 5859 | **RESOLVED** ✅ (identical source fix to kimi-k2.5's) |
| Planner (1st shot) | **glm-5.1** diagnosis + deepseek implementation | 7080 | unresolved — wrong mechanism (directory pruning instead of the `./` prefix mismatch); FAIL_TO_PASS 0/1, PASS_TO_PASS 120/120 intact |
| Planner (escalate) | **glm-5.1 re-diagnosis** (fed the failed patch + official test output) + deepseek | 7080 | **RESOLVED** ✅ (`os.path.normpath(root)` + `norm_root + os.sep` — converged on the real mechanism) |

Planner-role comparison on 7080: gpt-5 ✅ first shot / kimi-k2.6 ✅ first shot /
**glm-5.1 ✅ but only via the re-diagnosis escalate loop**. Its first diagnosis
reads precise (compact 4k chars, detailed mechanism walkthrough) yet targeted
the wrong layer — articulate-but-wrong is exactly the failure mode the escalate
loop exists for, and glm-5.1 self-corrected when fed the failing evidence
(same protocol that rescued gpt-5 on 7993).

**Harness defect #8 — self-authored test masking (FIXED 2026-06-18, INT-1462)**:
the FAIL_TO_PASS test is absent from the extracted /testbed, so the implementer
wrote its own guess of the gold test, which validated the wrong fix — local
verification "passed" while official grading failed. When the test oracle
itself is model-authored, the verification loop cannot catch a wrong diagnosis.
→ Fix: `sweBench.ts` now pre-applies the instance's `test_patch` to the sandbox
**before** baselining, so local verification runs the real oracle; the touched
test files join `protectedFiles` so the implementer can't rewrite them. Because
the gold test is baked into the baseline, `git diff baseSha` excludes it and
model_patch stays source-only automatically (no manual test-hunk stripping).
Verified on 5859: worker created zero test files, model_patch was source-only
(`pylint/checkers/misc.py`), official grading still RESOLVED
(`results/swe_5859_fix8_{sourceonly_preds,RESOLVED_report}.json`).

Evidence: `results/swe_5859_glm51_worker_{report,preds}.json`,
`results/swe_7080_glm51_{diagnosis,rediagnosis}.txt`,
`results/swe_7080_glm51_planner_v1_failed_preds.json`,
`results/swe_7080_glm51_rediag_{RESOLVED_report,preds}.json`.

Additional hybrid failure modes (discovered on 7993):

- **Diagnosis error propagation**: if the diagnosis pseudocode itself is buggy
  (the missing Formatter.parse literal re-escape), the implementer copies the
  bug faithfully because of the "trust this analysis" instruction (3
  consecutive identical patches). → Added the "THE TEST RESULT OUTRANKS THE
  PLAN" trust boundary to the stage-2 instructions.
- **Verification-harness self-dismantling** (defect #6): the implementer
  misattributed test failures to the verification script and edited
  run_tests.sh five times. → `protectedFiles` option (rejects edit/write).
- **Silent bash timeout** (defect #7): the fixed 30s timeout died without
  output on docker-based test runs, leading models to conclude "the
  environment is broken". → `bashTimeoutMs` option + explicit TIMEOUT message.

## Routing principles (tiering)

- **Judgment-heavy roles** (Planner/decomposition, Reviewer): pinned to
  frontier-grade models. A wrong judgment poisons everything downstream, so
  these are never downgraded. Measured options: gpt-5, **kimi-k2.6**
  (RESOLVED-grade L6 diagnosis at ~1/3 of gpt-5 pricing — 2026-06-11 round).
- **Execution roles** (Worker/Tester/Documenter/Auditor): lightweight by
  default + frontier escalation after 2 failures.
  - But **L6-grade real-world work should use a frontier worker too** —
    lightweight answer accuracy is too low.

## L6 grading procedure

```bash
# 1. Use OrbStack (stable amd64 emulation on Apple Silicon). Docker Desktop corrupts.
export DOCKER_HOST="unix:///Users/<you>/.orbstack/run/docker.sock"

# 2. The OpenSwarm worker solves the instance and produces predictions
SWE_MODEL=openai/gpt-5 \
  npx tsx benchmarks/sweBench.ts <instances.json> <preds.json>

# 3. Grade with the official swebench harness (per-model, max_workers 1 — concurrency overloads the VM)
/path/swebench-env/bin/python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Lite --predictions_path <preds.json> \
  --run_id <run> --instance_ids <id> --cache_level instance --max_workers 1
```

### L6 pitfalls (all confirmed by measurement)

- **OrbStack is required.** Docker Desktop corrupts with "unable to start" 503
  on every amd64 SWE-bench workload (reboot needed). OrbStack completes
  reliably.
- Old instances need period-correct Python (3.6–3.9) → use the conda env
  "testbed" inside the official Docker image. A naive venv won't work
  (`cgi` / `collections.Mapping` were removed from modern Python).
- Old `requests` instances depend on external httpbin (503s) → unsuitable.
  Prefer **pure-logic repos** (pylint/sympy/sphinx).
- Putting the same instance_id under multiple models in one prediction file
  grades only the last one → **grade per model separately**.
- Image tag: `swebench/sweb.eval.x86_64.<instance_id with __ replaced by _1776_>`.

### Verified N=30 cohort (AGT-3185)

`benchmarks/sweBenchVerifiedSet.ts` generates a fixed N=30 cohort: ten each
from pylint, Sphinx, and SymPy. These pure-logic repositories avoid the known
external-http dependency in old `requests` cases, while fixing the denominator
before comparing models.

```bash
# Writes the complete official records needed by sweBench.ts.
npx tsx benchmarks/sweBenchVerifiedSet.ts --out /tmp/swebench-verified-n30.json

# Low-disk preflight: prove all 30 tags resolve without storing image layers.
npx tsx benchmarks/sweBenchVerifiedSet.ts --check-manifests --out /tmp/swebench-verified-n30.json

# Only after confirming Docker storage headroom: sequentially pull all amd64 images.
npx tsx benchmarks/sweBenchVerifiedSet.ts --pull --out /tmp/swebench-verified-n30.json
```

The final command is intentionally opt-in: 30 evaluation images can exceed a
developer machine's free Docker storage. A successful manifest check is a tag
availability preflight, not a substitute for the ticket's required pull proof.

## Harness defects — found and fixed at L6 (invisible on synthetic L0–L5)

L6 exposed defects that only manifest in large repos:

1. **cwd unawareness**: agenticLoop never told the model its working
   directory, so it guessed absolute paths → exploration fully blocked.
   → Inject `Working directory: <cwd>` into the user prompt.
2. **bash exit-1 misread**: grep "no match" (exit 1) was treated as a fatal
   error with no stdout returned → infinite retries.
   → Return stdout/stderr + exit code even on errors; exit 1 with no output
   is benign.
3. **Compaction loop** (the critical one): on long runs (60+ turns),
   compaction truncated freshly-read files, causing endless re-reads — edits
   were never reached. → Thresholds 24k→60k tokens, compactAfterMessages
   24→60, keepRecent 8→16.

(Defects #4–#8 — final-answer turn, no-edit guard, protected files, bash
timeout, and self-authored test masking — were found later during the hybrid
experiments; see the hybrid section above. #8 is fixed in INT-1462.)
