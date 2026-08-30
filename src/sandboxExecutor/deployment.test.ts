import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ambientCredentialKeys } from '../cli/sandboxExecutorCommand.js';
import { discoverWorkspaceSecretMasks } from './bubblewrap.js';
import { parseSandboxExecutorArgs } from './entrypoint.js';

describe('sandbox executor secret and environment preflight', () => {
  let disposableRoot: string | undefined;

  afterEach(async () => {
    if (disposableRoot) await rm(disposableRoot, { recursive: true, force: true });
    disposableRoot = undefined;
  });

  it('masks live dotenv, tool credentials, private keys, and secret directories but preserves explicit examples', async () => {
    disposableRoot = await mkdtemp(join(tmpdir(), 'openswarm-sandbox-masks-'));
    const root = await realpath(disposableRoot);
    const workspace = join(root, 'repo');
    await mkdir(join(workspace, '.aws'), { recursive: true });
    const linkedSsh = join(root, 'linked-ssh');
    await mkdir(linkedSsh);
    await symlink(linkedSsh, join(workspace, '.ssh'));
    const masked = [
      '.env', '.env.local', '.env.intrect', '.dev.vars', '.envrc', '.npmrc', '.pypirc', '.netrc',
      'credentials.json', 'service-account.json', 'client.key', 'client.pem', 'client.p12', 'client.pfx',
    ];
    const examples = ['.env.example', '.env.sample', '.env.template'];
    await Promise.all([
      ...masked.map((name) => writeFile(join(workspace, name), 'secret=value\n')),
      ...examples.map((name) => writeFile(join(workspace, name), 'EXAMPLE=value\n')),
      writeFile(join(workspace, '.aws', 'credentials'), 'aws_secret_access_key=value\n'),
    ]);

    const masks = await discoverWorkspaceSecretMasks(workspace, [root]);
    const paths = masks.map((mask) => mask.path);

    for (const name of masked) expect(paths).toContain(join(workspace, name));
    expect(masks).toContainEqual({ path: join(workspace, '.aws'), kind: 'directory' });
    expect(masks).toContainEqual({ path: linkedSsh, kind: 'directory' });
    for (const name of examples) expect(paths).not.toContain(join(workspace, name));
  });

  it('rejects representative cloud, database, agent, cookie, and generic key credentials from ambient env', () => {
    const env = {
      TZ: 'UTC',
      PATH: '/usr/bin:/bin',
      NODE_ENV: 'production',
      AWS_ACCESS_KEY_ID: 'a',
      AWS_SECRET_ACCESS_KEY: 'b',
      GOOGLE_APPLICATION_CREDENTIALS: '/secret/google.json',
      LINEAR_API_KEY: 'c',
      SLACK_BOT_TOKEN: 'd',
      POSTGRES_DSN: 'e',
      PGPASSWORD: 'f',
      SSH_AUTH_SOCK: '/run/ssh-agent',
      DOCKER_HOST: 'unix:///run/docker.sock',
      SESSION_COOKIE: 'g',
      INTERNAL_SIGNING_KEY: 'h',
    };

    expect(ambientCredentialKeys(env)).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'DOCKER_HOST',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'INTERNAL_SIGNING_KEY',
      'LINEAR_API_KEY',
      'PGPASSWORD',
      'POSTGRES_DSN',
      'SESSION_COOKIE',
      'SLACK_BOT_TOKEN',
      'SSH_AUTH_SOCK',
    ]);
  });
});

describe('sandbox executor standalone entrypoint and compose boundary', () => {
  it('parses only the standalone serve/health vocabulary and exact numeric options', () => {
    expect(parseSandboxExecutorArgs([
      'node', 'entrypoint.js', 'serve', '--socket', '/run/openswarm-sandbox/executor.sock',
      '--allow-root', '/work', '--max-concurrent', '3',
    ])).toMatchObject({
      mode: 'serve',
      options: { socketPath: '/run/openswarm-sandbox/executor.sock', allowedRoots: ['/work'], maxConcurrent: 3 },
    });
    expect(() => parseSandboxExecutorArgs(['node', 'entrypoint.js', 'serve', '--env-file', '.env']))
      .toThrow('Unknown sandbox executor argument');
  });

  it('keeps the base compose unchanged and makes every privileged mount/capability strict-opt-in', async () => {
    const base = parse(await readFile(join(process.cwd(), 'docker-compose.yml'), 'utf8')) as Record<string, any>;
    const strict = parse(await readFile(join(process.cwd(), 'docker-compose.strict-sandbox.yml'), 'utf8')) as Record<string, any>;
    const baseDaemon = base.services.openswarm;
    const strictDaemon = strict.services.openswarm;
    const sidecar = strict.services['sandbox-executor'];
    const targets = (sidecar.volumes as Array<string | Record<string, unknown>>).map((volume) => (
      typeof volume === 'string' ? volume.split(':').at(-1) : volume.target
    ));

    expect(base.services).not.toHaveProperty('sandbox-executor');
    expect(JSON.stringify(baseDaemon.volumes)).not.toContain('/run/openswarm-sandbox');
    expect(strictDaemon.depends_on).toEqual({ 'sandbox-executor': { condition: 'service_healthy' } });
    expect(strictDaemon.stop_grace_period).toBe('60s');
    expect(strictDaemon.volumes).toContainEqual(expect.objectContaining({
      target: '/run/openswarm-sandbox', read_only: true,
    }));

    expect(sidecar.network_mode).toBe('none');
    expect(sidecar.user).toBe('1001:1001');
    expect(sidecar.read_only).toBe(true);
    expect(sidecar.stop_grace_period).toBe('60s');
    expect(sidecar).not.toHaveProperty('env_file');
    expect(sidecar.cap_drop).toEqual(['ALL']);
    expect(sidecar.cap_add).toEqual(['SYS_ADMIN']);
    expect(sidecar.security_opt).toEqual(expect.arrayContaining(['no-new-privileges:true', 'seccomp=unconfined']));
    expect(sidecar.security_opt).not.toContain('apparmor=unconfined');
    expect(targets).toEqual(expect.arrayContaining(['/work', '/run/openswarm-sandbox']));
    expect(targets).not.toEqual(expect.arrayContaining([
      '/home/openswarm', '/run', '/var/run/docker.sock', '/run/ssh-agent', '/var/run/postgresql',
      '/app/config.yaml', '/warehouse', '/warehouse-rw',
    ]));
    expect(sidecar.environment).toEqual(['TZ=Asia/Seoul']);
    expect(sidecar.command).toEqual(expect.arrayContaining(['dist/sandboxExecutor/entrypoint.js', 'serve']));
    expect(sidecar.healthcheck.test).toEqual(expect.arrayContaining(['dist/sandboxExecutor/entrypoint.js', 'health']));
  });
});
