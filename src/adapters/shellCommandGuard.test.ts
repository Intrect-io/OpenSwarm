import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { executeTool, ToolCall } from './tools.js';
import { isCommandBlocked } from './shellCommandGuard.js';

/** Helper to build a ToolCall object */
function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'tc-1', function: { name, arguments: JSON.stringify(args) } };
}

const TMP_DIR = await fs.mkdtemp('/tmp/openswarm-guard-test-');

beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// AGT-3436 — destructive commands that never contain the literal
// ──────────────────────────────────────────────

/**
 * Each of these executes a destructive command while containing no literal any
 * of the old patterns looked for. Bash rewrites the line before running it:
 * quote removal (`r"m"`), backslash escapes (`\rm`), empty-quote splicing
 * (`g''it`), and brace expansion (`r{m,}`) all reconstruct the verb.
 */
const rewriteBypasses = [
  'r"m" -rf /foo',
  '\\rm -rf /foo',
  "g''it clean -fdx",
  'r{m,} -rf /foo',
  "$'\\x72\\x6d' -rf /foo",
  'rm -r -f /foo',
  'rm -fr /foo',
  'git clean -fd',
  'git clean -f -d',
];

describe('destructive-command guard sees what the shell will run (AGT-3436)', () => {
  it.each(rewriteBypasses)('blocks the shell-rewritten form: %s', (command) => {
    expect(isCommandBlocked(command)).toBe(true);
  });

  it.each(rewriteBypasses)('refuses it through the bash tool too: %s', async (command) => {
    const result = await executeTool(makeCall('bash', { command }), TMP_DIR);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('BLOCKED');
    // A refused command ran nothing, so it is no evidence of anything.
    expect(result.executed).toBeUndefined();
  });

  // Destructive verbs reached through a launcher or a nested shell are still
  // that verb; the guard follows both.
  it.each([
    "sh -c 'rm -rf /foo'",
    'bash -c "git reset --hard"',
    'sudo -u root rm -rf /foo',
    'env FOO=1 rm -rf /foo',
    'echo "x" | xargs rm -rf',
    'FOO=bar rm -rf /foo',
    'cd /tmp && rm -rf /foo',
    'true; rm -rf /foo',
    'rm -rf /foo > /dev/sda',
  ])('blocks a destructive command reached indirectly: %s', (command) => {
    expect(isCommandBlocked(command)).toBe(true);
  });

  /**
   * The other half of AGT-3436: text that merely MENTIONS a destructive command
   * is data, not a command. Refusing it teaches the model to route around the
   * guard instead of respecting it.
   */
  it.each([
    '# rm -rf /tmp/x',
    'echo "rm -rf is blocked"',
    'echo "run rm -rf only when you mean it"',
    'git status',
    'git log --oneline -5',
    'grep -rn "rm -rf" docs',
    'chmod 755 script.sh',
    "python -c 'print(1)'",
    'VERSION=$(cat package.json)',
    'for f in $(ls); do echo "$f"; done',
    'echo `date`',
    'git commit -m "fix: rename variable"',
    // `rm` without the recursive flag, and `git clean` without force, are
    // ordinary parts of a build loop — flagging them would make the guard noise.
    'rm -f ./dist/bundle.js',
    'rm build/output.txt',
    'git clean -n',
    'git clean -nd',
    'chown user:group file.txt',
    'kill -0 1234',
    'pkill -f local-server',
    // Ordinary build/verification commands, the guard's main traffic.
    'npm test',
    'npx vitest run src/adapters/tools.test.ts',
    'npx tsc --noEmit',
    'git status --porcelain',
    'git diff HEAD~1',
    'git log --oneline -5 | head -20',
    'rg -n "pattern" src | head -30',
    'sed -n \'1,50p\' src/adapters/tools.ts',
    'python3 -m pytest tests/ -q',
    'cat package.json | jq .version',
    'mkdir -p a/b && touch a/b/c',
    'echo "hello" > out.txt',
    'ls nonexistent 2>&1 | head -3',
    'node -e "console.log(1+1)"',
    'for f in src/*.ts; do echo "$f"; done',
    'git add -A && git commit -m "fix: thing"',
    'git stash',
    "curl -sS https://example.com -o /tmp/out.html",
    'find src -name "*.ts" -type f | wc -l',
    'timeout 30 npm test',
    'env NODE_ENV=test npm test',
    "bash -c 'echo hello'",
    'sudo -n true 2>/dev/null || echo nope',
    "awk '{print $1}' file.txt",
    "printf 'a\\nb\\n' > f.txt",
    'npx oxlint src/adapters/tools.ts',
  ])('allows a command that only mentions one: %s', (command) => {
    expect(isCommandBlocked(command)).toBe(false);
  });

  it('does not refuse a mention that actually runs', async () => {
    const result = await executeTool(makeCall('bash', { command: 'echo "rm -rf is blocked"' }), TMP_DIR);
    expect(result.is_error).toBe(false);
    expect(result.content).toContain('rm -rf is blocked');
    expect(result.content).not.toContain('BLOCKED');
  });

  // Text the guard cannot resolve is refused rather than guessed at: a false
  // positive costs a retry, a false negative costs the working tree.
  it.each([
    'echo "unterminated',
    'echo "r$(true)m -rf /foo"',
    'rm -rf /{a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v}',
  ])('refuses what it cannot resolve: %s', (command) => {
    expect(isCommandBlocked(command)).toBe(true);
  });

  // A brace that is not an expansion group must not send the scan looking for
  // the previous one forever: `awk '{print $1}'` is an ordinary command, and a
  // guard that never returns is a denial of service on every bash call.
  it.each([
    "awk '{print $1}' file.txt",
    "awk '{print}' f.txt",
    'echo "{a,b}"',
    'grep -E "{2,3}" file',
    'echo "}"',
    'echo "{unclosed"',
  ])('returns promptly for a brace that is not a group: %s', (command) => {
    expect(isCommandBlocked(command)).toBe(false);
  });
});
