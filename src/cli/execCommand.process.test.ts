// Process-level exit-code contract for the `exec` command family.
//
// These spawn the REAL `src/cli.ts` through tsx — exactly the mechanism
// `reviewMaxHarness.smoke.test.ts` uses — so commander's own routing is under
// test, not a hand-built action object. The contracts:
//
//   bare `exec`                     usage + exit 2 (NOT 0)
//   `exec status <unknown-uuid>`    exit 2 ({"state":"UNKNOWN"})
//   `exec status <unknown-uuid> --json`  exactly one JSON doc on stdout, exit 2
//   `exec --issue X --path <non-git>`    exit 2 (git gate runs first)
//
// The bare-`exec` case is a regression guard: `.help()` calls process.exit(0)
// before any assignment, so `execCommand.help()` would make a bare invocation
// exit 0 despite the documented 2. The wiring uses `outputHelp()` + an explicit
// `process.exitCode = 2`.
//
// Hermetic: an isolated HOME/XDG + a purpose-written `OPENSWARM_CONFIG` (the
// real repo `config.yaml` is git-ignored and absent in CI) + a throwaway
// `OPENSWARM_AUTOMATION_DB`. Nothing here reads or writes `~/.openswarm`.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const cliEntry = join(repoRoot, 'src/cli.ts');

/** A random UUID that no test database can contain. */
const UNKNOWN_UUID = '11111111-2222-3333-4444-555555555555';

let root: string;
let env: Record<string, string>;

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI and capture its exit status even when it is non-zero.
 *
 * Same shape as `reviewMaxHarness.smoke.test.ts`'s failure branch: on a non-zero
 * exit `execFileSync` throws and the status/outputs live on the error object.
 */
function runCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', cliEntry, ...args],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openswarm-exec-cli-'));
  roots.push(root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  // A minimal but schema-valid config. Pinning OPENSWARM_CONFIG makes config
  // discovery deterministic: the repo's own `config.yaml` is git-ignored (so
  // absent in CI) and `findConfigFile` searches `process.cwd()` first.
  await writeFile(
    join(root, 'config.yaml'),
    `agents:\n  - name: main\n    projectPath: ${project}\n`,
  );
  env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.state'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    OPENSWARM_CONFIG: join(root, 'config.yaml'),
    OPENSWARM_AUTOMATION_DB: join(root, 'automation.db'),
    OPENSWARM_NO_AUTO_UPDATE: '1',
    OPENSWARM_TELEMETRY: '0',
    NO_COLOR: '1',
  };
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('exec CLI exit-code contract', () => {
  it('exits 2 (not 0) and prints usage for a bare `exec`', () => {
    const { status, stdout, stderr } = runCli(['exec']);
    // The regression: `.help()` would have exited 0 before the exitCode line.
    expect(status).toBe(2);
    // Commander writes `outputHelp()` to stdout; accept either stream, but the
    // usage text must actually be there — a silent exit 2 would pass this wrong.
    expect(`${stdout}${stderr}`).toMatch(/Usage: openswarm exec/);
    expect(`${stdout}${stderr}`).toMatch(/status \[options\] <runId>/);
  }, 120_000);

  it('exits 2 for `exec status <unknown-uuid>` against an empty database', () => {
    const { status, stdout } = runCli(['exec', 'status', UNKNOWN_UUID]);
    expect(status).toBe(2);
    expect(stdout).toMatch(/no durable run recorded/);
    // The read is read-only: a `status` query must not create the database it
    // failed to find (openReadOnly opens { readonly: true } and returns nothing
    // when the file is absent).
    expect(existsSync(env.OPENSWARM_AUTOMATION_DB)).toBe(false);
  }, 120_000);

  it('exits 2 and writes exactly one JSON document on stdout for `exec status <unknown-uuid> --json`', () => {
    const { status, stdout, stderr } = runCli(['exec', 'status', UNKNOWN_UUID, '--json']);
    expect(status).toBe(2);
    // Exactly one document, nothing else: the config banner must have been
    // rerouted to stderr, so `| jq` sees parseable JSON and nothing more.
    const lines = stdout.trim().split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { runId: string; state: string };
    expect(parsed.state).toBe('UNKNOWN');
    expect(parsed.runId).toBe(UNKNOWN_UUID);
    // The rerouted banner proves the `--json` stdout contract is what kept
    // stdout clean rather than the banner simply never being emitted.
    expect(stderr).toContain(join(root, 'config.yaml'));
  }, 120_000);

  it('exits 2 for `exec --issue <id> --path <non-git dir>` (git gate runs before any Linear call)', () => {
    const notGit = join(root, 'not-a-repo');
    const { status, stdout, stderr } = runCli(['exec', '--issue', 'INT-99', '--path', notGit]);
    // 2 = "refused before deploying" — the documented meaning for a bad target.
    expect(status).toBe(2);
    // The refusal names the git gate, not Linear — proving the ordering: the
    // gate is checked before `resolveContext`/`getIssue` (read in
    // `runExecDeployCommand`), so no tracker call is reachable here.
    expect(`${stdout}${stderr}`).toMatch(/Not a git repository/);
  }, 120_000);
});
