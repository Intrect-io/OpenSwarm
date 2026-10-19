/** Live advisor transport proof on an execution-grounded fixture; not a worker-quality benchmark. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'openswarm-recovery-proof-'));
const repo = join(root, 'repo'); mkdirSync(repo);
process.env.OPENSWARM_USAGE_DIR = join(root, 'usage');
process.env.OPENSWARM_SESSION_LOG_DIR = join(root, 'sessions');
const fixture = 'export const add = (a, b) => a - b;\n';
writeFileSync(join(repo, 'add.mjs'), fixture);
writeFileSync(join(repo, 'add.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {add} from './add.mjs'; test('adds two numbers',()=>assert.equal(add(2,3),5));\n");
let failure = '';
try { execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'add.test.mjs'], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }); }
catch (error) { failure = String((error as { stdout?: string }).stdout ?? error); }
if (!failure.includes('not ok')) throw new Error('Fixture did not produce the intended independent failed assertion');
const { runRecoveryAdvisor } = await import('../src/agents/recoveryAdvisor.js');
const started = Date.now();
const model = process.argv[2] ?? 'gpt-5.6-terra';
const outcome = await runRecoveryAdvisor({ cwd: repo, adapter: 'codex-responses', model, failedModel: 'fixture-worker-model',
  stage: 'tester', cause: 'quality', allowedModels: [], remainingMs: 45_000,
  evidence: { failure, source: fixture, requirement: 'add(2, 3) must equal 5', check: 'node --test add.test.mjs' } });
const unchanged = readFileSync(join(repo, 'add.mjs'), 'utf8') === fixture;
const receipt = { at: new Date().toISOString(), kind: 'live-advisor-on-fixture', root, requestedModel: model,
  failedStage: 'synthetic fixture worker; not a live worker trial', actualFailedCheck: 'node --test --test-reporter=tap add.test.mjs',
  failureHash: createHash('sha256').update(failure).digest('hex'), toolPolicy: 'all tools denied', unchanged,
  wallMs: Date.now() - started, outcome };
writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
if (!outcome.decision || !unchanged || !outcome.costInfo?.servedModels?.length) process.exitCode = 1;
