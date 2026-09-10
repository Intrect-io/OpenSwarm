#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { writeFileSync } = require('fs');
const wt = '/work/OpenSwarm/worktree/cf4a7989-826c-4d4c-b049-d79b150566c5';
const parts = [];
function run(cmd, args) {
  parts.push(`=== ${cmd} ${args.join(' ')} ===`);
  const r = spawnSync(cmd, args, { cwd: wt, encoding: 'utf8', env: process.env });
  parts.push(r.stdout || '');
  parts.push(r.stderr || '');
  parts.push(`exit=${r.status}`);
  return r.status;
}
run('git', ['status', '-sb']);
run('git', ['log', '--oneline', '-5']);
run('git', ['diff', '--stat', 'HEAD']);
const sib = '/work/OpenSwarm/worktree/007807cd-6302-4922-b324-fcc8a771b48c/node_modules/vitest/vitest.mjs';
let st;
if (require('fs').existsSync(sib)) {
  st = run('node', [sib, 'run', 'src/adapters/codexResponses.test.ts', 'src/tui/sanitize.test.ts', 'src/discord/handleDevProgress.test.ts', '--reporter=verbose']);
} else {
  st = run('npx', ['vitest', 'run', 'src/adapters/codexResponses.test.ts', 'src/tui/sanitize.test.ts', 'src/discord/handleDevProgress.test.ts', '--reporter=verbose']);
}
writeFileSync('/tmp/agt3465-verify-out.txt', parts.join('\n'));
if (st === 0) {
  // cleanup junk
  for (const f of ['cli.json', 'ls', 'ls-run-verify.sh', 'ls-verify-agt3465', 'src/.agt3465-probe.txt', 'scripts/agt3465-verify-once.sh']) {
    try { require('fs').unlinkSync(wt + '/' + f); } catch {}
  }
  run('git', ['add', 'src/adapters/codexResponses.ts', 'src/adapters/codexResponses.test.ts', 'src/tui/sanitize.ts', 'src/tui/sanitize.test.ts', 'src/discord/handleDevProgress.test.ts', 'src/discord/discordHandlers.ts']);
  if (spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: wt }).status === 1) {
    run('git', ['commit', '-m', 'fix(external-integrations): bound SSE reduction and sanitize Discord provider content']);
  }
  run('git', ['status', '-sb']);
  run('git', ['log', '--oneline', '-5']);
}
process.exit(st ?? 1);
