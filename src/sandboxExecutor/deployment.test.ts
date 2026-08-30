import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ambientCredentialKeys } from '../cli/sandboxExecutorCommand.js';
import {
  assertOpenPathIdentity,
  assertSecretMaskWitnesses,
  discoverWorkspaceSecretMasks,
  SANDBOX_BWRAP_ISOLATION_ARGS,
  SANDBOX_BWRAP_LAUNCHER_ARGS,
  SANDBOX_CHILD_IDENTITY_PROBE,
  SANDBOX_CHILD_PRIVILEGE_DROP_ARGS,
  SANDBOX_NETWORK_INIT_SCRIPT,
  sandboxFdBindArgs,
  validatedDependencyTargets,
  validatedGitCommonDirectory,
} from './bubblewrap.js';
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
    expect(masks).toContainEqual(expect.objectContaining({ path: join(workspace, '.aws'), kind: 'directory' }));
    expect(masks).toContainEqual(expect.objectContaining({ path: linkedSsh, kind: 'directory' }));
    for (const name of examples) expect(paths).not.toContain(join(workspace, name));
  });

  it('masks an empty sensitive file instead of leaving a populate-after-scan race', async () => {
    disposableRoot = await mkdtemp(join(tmpdir(), 'openswarm-sandbox-empty-secret-'));
    const root = await realpath(disposableRoot);
    const workspace = join(root, 'repo');
    await mkdir(workspace);
    await writeFile(join(workspace, '.env'), '');

    await expect(discoverWorkspaceSecretMasks(workspace, [root])).resolves.toContainEqual(
      expect.objectContaining({ path: join(workspace, '.env'), kind: 'file' }),
    );
  });

  it('rejects a workspace root replaced after secret scanning before spawn', async () => {
    disposableRoot = await mkdtemp(join(tmpdir(), 'openswarm-sandbox-root-race-'));
    const root = await realpath(disposableRoot);
    const workspace = join(root, 'repo');
    const moved = join(root, 'repo-before-race');
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeFile(join(workspace, '.env'), 'secret=value\n');
    const handle = await open(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const identity = await handle.stat({ bigint: true });
      await discoverWorkspaceSecretMasks(workspace, [root]);
      await rename(workspace, moved);
      await mkdir(join(workspace, '.git'), { recursive: true });

      await expect(assertOpenPathIdentity(
        workspace,
        handle,
        { dev: identity.dev, ino: identity.ino },
        'directory',
        'Sandbox workspace',
      )).rejects.toThrow('identity changed before sandbox spawn');
    } finally {
      await handle.close();
    }
  });

  it('rejects a sensitive symlink retargeted after scanning', async () => {
    disposableRoot = await mkdtemp(join(tmpdir(), 'openswarm-sandbox-mask-race-'));
    const root = await realpath(disposableRoot);
    const workspace = join(root, 'repo');
    const first = join(root, 'first-ssh');
    const second = join(root, 'second-ssh');
    const witness = join(workspace, '.ssh');
    await Promise.all([mkdir(workspace), mkdir(first), mkdir(second)]);
    await symlink(first, witness);
    const [mask] = await discoverWorkspaceSecretMasks(workspace, [root]);
    await rm(witness);
    await symlink(second, witness);

    await expect(assertSecretMaskWitnesses(mask)).rejects.toThrow(
      'Sensitive mask witness changed before sandbox spawn',
    );
  });

  it('rejects a sensitive target replaced after its file descriptor is fixed', async () => {
    disposableRoot = await mkdtemp(join(tmpdir(), 'openswarm-sandbox-mask-target-race-'));
    const root = await realpath(disposableRoot);
    const workspace = join(root, 'repo');
    const secret = join(workspace, '.env');
    const moved = join(workspace, '.env-before-race');
    await mkdir(workspace);
    await writeFile(secret, 'first=value\n');
    const handle = await open(secret, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const identity = await handle.stat({ bigint: true });
      await rename(secret, moved);
      await writeFile(secret, 'replacement=value\n');

      await expect(assertOpenPathIdentity(
        secret,
        handle,
        { dev: identity.dev, ino: identity.ino },
        'file',
        'Sensitive mask target',
      )).rejects.toThrow('identity changed before sandbox spawn');
    } finally {
      await handle.close();
    }
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
  it('uses the measured non-userns bwrap path and proves the child has uid 1001 with no capabilities', () => {
    expect(SANDBOX_BWRAP_ISOLATION_ARGS).not.toContain('--unshare-user');
    expect(SANDBOX_BWRAP_ISOLATION_ARGS).toEqual(expect.arrayContaining([
      '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--unshare-net',
      '--cap-drop', 'ALL', '--cap-add', 'CAP_SETUID', '--cap-add', 'CAP_DAC_READ_SEARCH',
      '--cap-add', 'CAP_NET_ADMIN', '--clearenv',
    ]));
    expect(SANDBOX_BWRAP_LAUNCHER_ARGS).toEqual(['--reuid', '0', '/usr/bin/bwrap']);
    expect(SANDBOX_CHILD_PRIVILEGE_DROP_ARGS).toEqual([
      '/usr/bin/setpriv', '--reuid', '1001',
      '--inh-caps', '-all', '--ambient-caps', '-all',
    ]);
    expect(SANDBOX_NETWORK_INIT_SCRIPT).toContain('0x8914');
    expect(SANDBOX_NETWORK_INIT_SCRIPT).toContain('&& exec "$@"');
    expect(SANDBOX_CHILD_IDENTITY_PROBE).toEqual([
      'test "$(id -u)" = 1001',
      'test "$(awk \'/^CapEff:/ {print $2}\' /proc/self/status)" = 0000000000000000',
      'test "$(awk \'/^CapPrm:/ {print $2}\' /proc/self/status)" = 0000000000000000',
      'test "$(awk \'/^CapInh:/ {print $2}\' /proc/self/status)" = 0000000000000000',
      'test "$(awk \'/^CapAmb:/ {print $2}\' /proc/self/status)" = 0000000000000000',
    ]);
    expect(sandboxFdBindArgs(true, 3, '/work/repo')).toEqual(['--bind-fd', '3', '/work/repo']);
    expect(sandboxFdBindArgs(false, 4, '/work/repo/.git')).toEqual(['--ro-bind-fd', '4', '/work/repo/.git']);
    expect(sandboxFdBindArgs(true, 3, '/work/repo').join(' ')).not.toContain('/proc/self/fd');
  });

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
    const strictSource = await readFile(join(process.cwd(), 'docker-compose.strict-sandbox.yml'), 'utf8');
    const strict = parse(strictSource) as Record<string, any>;
    const baseDaemon = base.services.openswarm;
    const strictDaemon = strict.services.openswarm;
    const sidecar = strict.services['sandbox-executor'];
    const targets = (sidecar.volumes as Array<string | Record<string, unknown>>).map((volume) => (
      typeof volume === 'string' ? volume.split(':').at(-1) : volume.target
    ));

    expect(base.services).not.toHaveProperty('sandbox-executor');
    expect(strictSource).toContain('sudo install -d -o 1001 -g 1001 -m 0700 sandbox-socket');
    expect(JSON.stringify(baseDaemon.volumes)).not.toContain('/run/openswarm-sandbox');
    expect(strictDaemon.depends_on).toEqual({ 'sandbox-executor': { condition: 'service_healthy' } });
    expect(strictDaemon.stop_grace_period).toBe('60s');
    expect(strictDaemon.volumes).toContainEqual(expect.objectContaining({
      target: '/run/openswarm-sandbox', read_only: true,
    }));

    expect(sidecar.network_mode).toBe('none');
    expect(sidecar.user).toBe('0:0');
    expect(sidecar.read_only).toBe(true);
    expect(sidecar.stop_grace_period).toBe('60s');
    expect(sidecar).not.toHaveProperty('env_file');
    expect(sidecar.cap_drop).toEqual(['ALL']);
    expect(sidecar.cap_add).toEqual(['SYS_ADMIN', 'SETUID', 'SETGID', 'DAC_READ_SEARCH', 'NET_ADMIN']);
    expect(sidecar.security_opt).toEqual(expect.arrayContaining(['no-new-privileges:true', 'seccomp=unconfined']));
    expect(sidecar.security_opt).not.toContain('apparmor=unconfined');
    expect(targets).toEqual(expect.arrayContaining(['/work', '/run/openswarm-sandbox']));
    expect(targets).not.toEqual(expect.arrayContaining([
      '/home/openswarm', '/run', '/var/run/docker.sock', '/run/ssh-agent', '/var/run/postgresql',
      '/app/config.yaml', '/warehouse', '/warehouse-rw',
    ]));
    expect(sidecar.environment).toEqual(['TZ=Asia/Seoul']);
    expect(sidecar.command.slice(0, 11)).toEqual([
      '/usr/bin/setpriv', '--reuid', '1001', '--regid', '1001', '--clear-groups',
      '--inh-caps', '+sys_admin,+setuid,+dac_read_search,+net_admin',
      '--ambient-caps', '+sys_admin,+setuid,+dac_read_search,+net_admin', 'node',
    ]);
    expect(sidecar.command).toEqual(expect.arrayContaining(['dist/sandboxExecutor/entrypoint.js', 'serve']));
    expect(sidecar.healthcheck.test.slice(0, 8)).toEqual([
      'CMD', '/usr/bin/setpriv', '--reuid', '1001', '--regid', '1001', '--clear-groups', 'node',
    ]);
    expect(sidecar.healthcheck.test).toEqual(expect.arrayContaining(['dist/sandboxExecutor/entrypoint.js', 'health']));
  });
});

describe('sandbox executor Git and dependency support boundary', () => {
  let disposableRoot: string | undefined;

  afterEach(async () => {
    if (disposableRoot) await rm(disposableRoot, { recursive: true, force: true });
    disposableRoot = undefined;
  });

  async function linkedFixture(): Promise<{ root: string; main: string; workspace: string }> {
    disposableRoot = await mkdtemp(join(tmpdir(), 'openswarm-sandbox-linked-'));
    const root = await realpath(disposableRoot);
    const main = join(root, 'main');
    const workspace = join(root, 'worker');
    const gitDir = join(main, '.git', 'worktrees', 'worker');
    await Promise.all([mkdir(gitDir, { recursive: true }), mkdir(workspace)]);
    await writeFile(join(workspace, '.git'), `gitdir: ${gitDir}\n`);
    await writeFile(join(gitDir, 'gitdir'), `${join(workspace, '.git')}\n`);
    return { root, main, workspace };
  }

  it('accepts only a Git common directory with the reverse worktree backlink', async () => {
    const { root, main, workspace } = await linkedFixture();
    await expect(validatedGitCommonDirectory(workspace)).resolves.toBe(join(main, '.git'));

    const siblingCheckout = join(root, 'sibling-worker');
    const siblingGitDir = join(root, 'sibling', '.git', 'worktrees', 'sibling-worker');
    await Promise.all([mkdir(siblingCheckout), mkdir(siblingGitDir, { recursive: true })]);
    await writeFile(join(siblingCheckout, '.git'), `gitdir: ${siblingGitDir}\n`);
    await writeFile(join(siblingGitDir, 'gitdir'), `${join(siblingCheckout, '.git')}\n`);
    await writeFile(join(workspace, '.git'), `gitdir: ${siblingGitDir}\n`);

    await expect(validatedGitCommonDirectory(workspace)).resolves.toBeUndefined();
  });

  it('mounts only local or same-relative-path dependencies from the validated main checkout', async () => {
    const { root, main, workspace } = await linkedFixture();
    const mainNodeModules = join(main, 'node_modules');
    const siblingVenv = join(root, 'sibling', '.venv');
    const localVenv = join(workspace, 'venv');
    await Promise.all([
      mkdir(mainNodeModules),
      mkdir(siblingVenv, { recursive: true }),
      mkdir(localVenv),
    ]);
    await Promise.all([
      symlink(mainNodeModules, join(workspace, 'node_modules')),
      symlink(siblingVenv, join(workspace, '.venv')),
      symlink(mainNodeModules, join(workspace, '.venv-verify')),
    ]);

    await expect(validatedDependencyTargets(workspace, [root])).resolves.toEqual([
      mainNodeModules,
      localVenv,
    ]);
  });
});
