#!/usr/bin/env node
/**
 * Local test runner for AGT-3420 when `npm test` / vitest CLI path is awkward.
 * Resolves vitest from this worktree or the main OpenSwarm checkout.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(root, 'node_modules', 'vitest', 'vitest.mjs'),
  join(root, 'node_modules', 'vitest', 'dist', 'cli.js'),
  join('/work/OpenSwarm', 'node_modules', 'vitest', 'vitest.mjs'),
  join('/work/OpenSwarm', 'node_modules', 'vitest', 'dist', 'cli.js'),
];

const vitestEntry = candidates.find((p) => existsSync(p));
if (!vitestEntry) {
  console.error('vitest not found in worktree or /work/OpenSwarm/node_modules');
  process.exit(2);
}

const files = [
  'src/orchestration/decisionEngine.admission.test.ts',
  'src/orchestration/decisionEngine.gating.test.ts',
  'src/orchestration/decisionEngine.coverage.test.ts',
  'src/orchestration/taskParser.coverage.test.ts',
  'src/knowledge/gitInfo.test.ts',
  'src/memory/reembed.test.ts',
];

const child = spawn(process.execPath, [vitestEntry, 'run', ...files, '--reporter=dot'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 1));
