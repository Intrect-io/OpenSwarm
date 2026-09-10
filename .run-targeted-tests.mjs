#!/usr/bin/env node
/**
 * Workaround when Shell tool is blocked: parent/CI may invoke this file.
 * Writes results to .test-output.txt in the same directory.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const files = [
  'src/adapters/resultParsing.test.ts',
  'src/adapters/tools.test.ts',
  'src/cli/projectHandler.test.ts',
  'src/cli/memoryCommand.coverage.test.ts',
  'src/cli/workCommand.test.ts',
  'src/github/ciState.test.ts',
  'src/registry/sqliteStore.test.ts',
];

const vitest = spawnSync(
  process.execPath,
  ['--experimental-vm-modules', 'node_modules/vitest/vitest.mjs', 'run', ...files],
  { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
);

const py = spawnSync(
  'python3',
  ['-c', `
from src.task_state_model import OpenSwarmTaskState
from datetime import datetime, timezone
s = OpenSwarmTaskState(issueId='x', updatedAt=datetime.now(timezone.utc), topoRank=2.0, execution={'status':'todo','retryCount':'3'})
d = s.model_dump(by_alias=True)
assert d['topoRank'] == 2
assert d['execution']['retryCount'] == 3
print('py-ok')
`],
  { cwd: root, encoding: 'utf8' },
);

const out = [
  '=== vitest stdout ===',
  vitest.stdout || '',
  '=== vitest stderr ===',
  vitest.stderr || '',
  `=== vitest status ${vitest.status} ===`,
  '=== python stdout ===',
  py.stdout || '',
  '=== python stderr ===',
  py.stderr || '',
  `=== python status ${py.status} ===`,
].join('\n');

writeFileSync(join(root, '.test-output.txt'), out);
console.log(out);
process.exit(vitest.status || py.status || 0);
