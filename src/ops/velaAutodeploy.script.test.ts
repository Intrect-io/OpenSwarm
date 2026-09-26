// ============================================
// OpenSwarm - vela autodeploy gate tests (AGT-4182)
// ============================================
//
// Host script lives at repo root / ~/openswarm-deploy. These tests drive the
// real bash checklist with a temp deploy dir + PATH stubs so CI can prove
// skip reasons and dry-run non-mutation without touching rtx.

import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const AUTODEPLOY = join(REPO_ROOT, 'vela-autodeploy.sh');
const BUILD = join(REPO_ROOT, 'vela-build.sh');

const MAIN_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function hasBin(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

const hasSqlite3 = hasBin('sqlite3');
const hasFlock = hasBin('flock');

let root: string;
let deployDir: string;
let binDir: string;
let automationDb: string;
let homeDir: string;

function writeExec(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function seedLedger(states: string[]): void {
  const db = new Database(automationDb);
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      issue_id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'test',
      project_path TEXT NOT NULL DEFAULT '/work',
      state TEXT NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 1,
      attempt_no INTEGER NOT NULL DEFAULT 0,
      lease_epoch INTEGER NOT NULL DEFAULT 0,
      discovered_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = db.prepare(
    `INSERT INTO automation_runs (issue_id, state, discovered_at, updated_at) VALUES (?, ?, 1, 1)`,
  );
  states.forEach((state, i) => insert.run(`ISSUE-${i}`, state));
  db.close();
}

function seedCompose(tag = 'openswarm:vela-20260902-1200-amd64'): void {
  writeFileSync(
    join(deployDir, 'docker-compose.yml'),
    `services:\n  openswarm:\n    image: ${tag}\n`,
  );
  writeFileSync(join(deployDir, 'docker-compose.strict-sandbox.yml'), 'services: {}\n');
}

type StubOpts = {
  mainSha?: string;
  startedAt?: string | null;
  healthStatus?: string;
  curlOk?: boolean;
  sockOk?: boolean;
  buildTag?: string;
};

function installStubs(opts: StubOpts = {}): void {
  const mainSha = opts.mainSha ?? MAIN_SHA;
  const startedAt = opts.startedAt === undefined
    ? new Date(Date.now() - 60 * 60_000).toISOString()
    : opts.startedAt;
  const healthStatus = opts.healthStatus ?? 'healthy';
  const curlOk = opts.curlOk ?? true;
  const sockOk = opts.sockOk ?? true;
  const buildTag = opts.buildTag ?? 'openswarm:vela-20260910-0800-amd64';

  writeExec(
    join(binDir, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "ls-remote" ]]; then
  echo "${mainSha}\trefs/heads/main"
  exit 0
fi
echo "unexpected git args: $*" >&2
exit 1
`,
  );

  writeExec(
    join(binDir, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
if [[ "\$cmd" == "inspect" ]]; then
  fmt=""
  while [[ \$# -gt 0 ]]; do
    if [[ "\$1" == "--format" ]]; then fmt="\$2"; shift 2; continue; fi
    shift || true
  done
  case "\$fmt" in
    '{{.State.StartedAt}}')
      ${startedAt === null ? 'exit 1' : `echo '${startedAt}'`}
      ;;
    '{{.State.Health.Status}}') echo '${healthStatus}' ;;
    '{{.State.Status}}') echo 'running' ;;
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}') echo '${healthStatus}' ;;
    *) echo '' ;;
  esac
  exit 0
fi
if [[ "\$cmd" == "compose" ]]; then
  echo "compose ok"
  exit 0
fi
if [[ "\$cmd" == "exec" ]]; then
  ${sockOk ? 'exit 0' : 'exit 1'}
fi
if [[ "\$cmd" == "build" ]]; then
  echo "built"
  exit 0
fi
echo "unexpected docker args: $*" >&2
exit 1
`,
  );

  writeExec(
    join(binDir, 'curl'),
    `#!/usr/bin/env bash
${curlOk ? 'exit 0' : 'exit 22'}
`,
  );

  writeExec(
    join(binDir, 'vela-build.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "building..."
echo "${buildTag}"
`,
  );
}

function runAutodeploy(args: string[] = [], extraEnv: Record<string, string> = {}): {
  status: number;
  stdout: string;
} {
  const pathEnv = `${binDir}:${process.env.PATH ?? ''}`;
  try {
    const stdout = execFileSync('bash', [AUTODEPLOY, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: pathEnv,
        HOME: homeDir,
        OPENSWARM_DEPLOY_DIR: deployDir,
        OPENSWARM_AUTOMATION_DB: automationDb,
        OPENSWARM_AUTODEPLOY_LOG: join(deployDir, 'autodeploy.log'),
        OPENSWARM_AUTODEPLOY_LOCK: join(deployDir, '.autodeploy.lock'),
        OPENSWARM_LAST_BUILT_SHA_FILE: join(deployDir, '.last-built-sha'),
        OPENSWARM_COMPOSE_FILE: join(deployDir, 'docker-compose.yml'),
        OPENSWARM_COMPOSE_STRICT: join(deployDir, 'docker-compose.strict-sandbox.yml'),
        VELA_BUILD_SCRIPT: join(binDir, 'vela-build.sh'),
        OPENSWARM_HEALTH_TIMEOUT_SEC: '5',
        ...extraEnv,
      },
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`,
    };
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vela-autodeploy-'));
  deployDir = join(root, 'deploy');
  binDir = join(root, 'bin');
  homeDir = join(root, 'home');
  automationDb = join(homeDir, '.openswarm', 'automation.db');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(deployDir, { recursive: true });
  mkdirSync(dirname(automationDb), { recursive: true });
  seedCompose();
  seedLedger([]);
  installStubs();
  chmodSync(AUTODEPLOY, 0o755);
  chmodSync(BUILD, 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('vela shell script syntax', () => {
  it('bash -n passes for both scripts', () => {
    execFileSync('bash', ['-n', AUTODEPLOY], { stdio: 'pipe' });
    execFileSync('bash', ['-n', BUILD], { stdio: 'pipe' });
  });
});

describe.skipIf(!hasSqlite3 || !hasFlock)('vela-autodeploy.sh gates', () => {
  it('dry-run SKIP when .last-built-sha matches origin/main', () => {
    writeFileSync(join(deployDir, '.last-built-sha'), MAIN_SHA);
    const before = readFileSync(join(deployDir, 'docker-compose.yml'), 'utf8');
    const { status, stdout } = runAutodeploy(['--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/SKIP\s+running image already built from/);
    expect(readFileSync(join(deployDir, 'docker-compose.yml'), 'utf8')).toBe(before);
    expect(existsSync(join(deployDir, '.last-built-sha'))).toBe(true);
    expect(readFileSync(join(deployDir, '.last-built-sha'), 'utf8').trim()).toBe(MAIN_SHA);
  });

  it('dry-run SKIP when ledger has active VERIFYING/PUBLISHING/EXECUTING/CLAIMED rows', () => {
    writeFileSync(join(deployDir, '.last-built-sha'), OTHER_SHA);
    seedLedger(['EXECUTING', 'READY']);
    const before = readFileSync(join(deployDir, 'docker-compose.yml'), 'utf8');
    const { status, stdout } = runAutodeploy(['--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/SKIP\s+ledger has 1 active run/);
    expect(readFileSync(join(deployDir, 'docker-compose.yml'), 'utf8')).toBe(before);
  });

  it('dry-run SKIP when automation DB is missing', () => {
    writeFileSync(join(deployDir, '.last-built-sha'), OTHER_SHA);
    rmSync(automationDb, { force: true });
    const { status, stdout } = runAutodeploy(['--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/SKIP\s+cannot query automation DB/);
  });

  it('dry-run SKIP when container StartedAt is within rate limit', () => {
    writeFileSync(join(deployDir, '.last-built-sha'), OTHER_SHA);
    installStubs({ startedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const { status, stdout } = runAutodeploy(['--dry-run'], { OPENSWARM_RATE_LIMIT_MIN: '55' });
    expect(status).toBe(0);
    expect(stdout).toMatch(/SKIP\s+container started \d+m ago/);
  });

  it('dry-run prints would-deploy plan without mutating compose or sha file', () => {
    writeFileSync(join(deployDir, '.last-built-sha'), OTHER_SHA);
    const beforeCompose = readFileSync(join(deployDir, 'docker-compose.yml'), 'utf8');
    const beforeSha = readFileSync(join(deployDir, '.last-built-sha'), 'utf8');
    const { status, stdout } = runAutodeploy(['--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/DRY-RUN would build/);
    expect(stdout).toMatch(/DRY-RUN would sed compose tag/);
    expect(stdout).not.toMatch(/SUCCESS deployed/);
    expect(readFileSync(join(deployDir, 'docker-compose.yml'), 'utf8')).toBe(beforeCompose);
    expect(readFileSync(join(deployDir, '.last-built-sha'), 'utf8')).toBe(beforeSha);
  });

  it('live pass updates compose tag and .last-built-sha when gates clear', () => {
    writeFileSync(join(deployDir, '.last-built-sha'), OTHER_SHA);
    const newTag = 'openswarm:vela-20260910-0800-amd64';
    installStubs({ buildTag: newTag });
    const { status, stdout } = runAutodeploy([]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/SUCCESS deployed/);
    expect(readFileSync(join(deployDir, 'docker-compose.yml'), 'utf8')).toContain(newTag);
    expect(readFileSync(join(deployDir, '.last-built-sha'), 'utf8').trim()).toBe(MAIN_SHA);
  });

  it('verify failure rolls back compose tag and exits non-zero', () => {
    writeFileSync(join(deployDir, '.last-built-sha'), OTHER_SHA);
    const prev = 'openswarm:vela-20260902-1200-amd64';
    seedCompose(prev);
    installStubs({ curlOk: false, buildTag: 'openswarm:vela-20260910-0900-amd64' });
    const { status, stdout } = runAutodeploy([]);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/VERIFY FAILED|rollback/i);
    expect(readFileSync(join(deployDir, 'docker-compose.yml'), 'utf8')).toContain(prev);
    expect(readFileSync(join(deployDir, '.last-built-sha'), 'utf8').trim()).toBe(OTHER_SHA);
  });
});

describe('vela-build.sh', () => {
  it('rejects non-40-char hex SHA', () => {
    let failed = false;
    try {
      execFileSync('bash', [BUILD, 'notasha'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      failed = true;
      const e = err as { status?: number; stderr?: string; stdout?: string };
      expect(e.status).not.toBe(0);
      expect(`${e.stderr ?? ''}${e.stdout ?? ''}`).toMatch(/invalid SHA/);
    }
    expect(failed).toBe(true);
  });
});
