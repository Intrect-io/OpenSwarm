#!/usr/bin/env node
// Temporary harness runner — executes vitest from npm cache when local install lacks vitest.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  join(root, 'node_modules', 'vitest', 'vitest.mjs'),
  join(root, 'node_modules', 'vitest', 'dist', 'cli.js'),
  '/work/.npm-cache/_npx/5aa325d8ffb78db0/node_modules/vitest/vitest.mjs',
  '/work/.npm-cache/_npx/69c381f8ad94b576/node_modules/vitest/vitest.mjs',
];
const vitestEntry = candidates.find((p) => existsSync(p));
if (!vitestEntry) {
  console.error('vitest not found in node_modules or npx cache');
  process.exit(127);
}
const args = [
  vitestEntry,
  'run',
  'src/verify/qualityHarness.test.ts',
  'src/cli/reviewAudit.test.ts',
  'src/cli/reviewMaxHarness.smoke.test.ts',
  '--reporter=verbose',
];
const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: process.env });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
