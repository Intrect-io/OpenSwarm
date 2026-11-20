import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAndCreateAuditPR, commitAndCreatePRWithHead } from './worktreeManager.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

// 2026-09-10: every open swarm PR on vega-agent failed version-label with
// `LABELS: []` — OpenSwarm opened them unlabelled (AGT-4269).
describe('commitAndCreatePRWithHead version:* label', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function publish(title: string, repoLabels: string[]): Promise<string[]> {
    root = mkdtempSync(join(tmpdir(), 'openswarm-version-label-'));
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    writeFileSync(join(repo, 'a.ts'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'initial');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    const branchName = 'swarm/AGT-LBL-x';
    git(repo, 'checkout', '-qb', branchName);
    writeFileSync(join(repo, 'a.ts'), 'changed\n');

    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const captured = join(root, 'pr-create-args.txt');
    const labels = repoLabels.join('\\n');
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\ncase "$*" in\n  *"label list"*) printf '${labels}\\n';;\n  *"pr create"*) printf '%s\\n' "$@" > '${captured}'; echo "https://example.test/pr/1";;\nesac\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      await commitAndCreatePRWithHead(
        { worktreePath: repo, originalPath: repo, branchName, issueId: 'AGT-LBL' },
        title, 'AGT-LBL', '', { draft: true },
      );
    } finally {
      process.env.PATH = prevPath;
    }
    return readFileSync(captured, 'utf8').split('\n');
  }

  const VERSION_LABELS = ['version:major', 'version:minor', 'version:patch', 'version:skip'];

  it('opens the PR with exactly one mapped label', async () => {
    const args = await publish('[BUG] crash on empty input', VERSION_LABELS);
    const at = args.indexOf('--label');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('version:patch');
    expect(args.filter((a) => a === '--label')).toHaveLength(1);
  });

  it('opens unlabelled with the reason in the body when the title does not decide', async () => {
    const args = await publish('refactor: split a module', VERSION_LABELS);
    expect(args).not.toContain('--label');
    expect(args.join('\n')).toContain('## Version label');
  });

  it('leaves a repository without version labels exactly as before', async () => {
    const args = await publish('[BUG] crash', ['bug', 'enhancement']);
    expect(args).not.toContain('--label');
    expect(args.join('\n')).not.toContain('## Version label');
  });
});

// Review of #905: the reuse, race and audit paths never labelled, and a failed
// label lookup looked exactly like "no labels".
describe('version:* label on reuse, race, audit and lookup failure', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  interface Scenario {
    labels?: string[];
    lookupFails?: boolean;
    /** Successive outputs of `gh pr list --head`: reuse = [url], race = ['', url]. */
    listOutputs?: string[];
    createFails?: boolean;
    /** Labels already on the PR for `gh pr view --json labels`. */
    prLabels?: string[];
  }

  function setup(sc: Scenario) {
    root = mkdtempSync(join(tmpdir(), 'openswarm-version-label2-'));
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    writeFileSync(join(repo, 'a.ts'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'initial');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    const baseSha = git(repo, 'rev-parse', 'HEAD').trim();
    const branchName = 'swarm/AGT-LBL-y';
    git(repo, 'checkout', '-qb', branchName);
    writeFileSync(join(repo, 'a.ts'), 'changed\n');

    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const log = join(root, 'calls.log');
    writeFileSync(join(bin, 'labels.txt'), (sc.labels ?? []).join('\n') + '\n');
    writeFileSync(join(bin, 'list.txt'), (sc.listOutputs ?? ['']).join('\n') + '\n');
    writeFileSync(join(bin, 'view.txt'), (sc.prLabels ?? []).join('\n') + '\n');
    if (sc.lookupFails) writeFileSync(join(bin, 'lookup-fails'), '');
    if (sc.createFails) writeFileSync(join(bin, 'create-fails'), '');
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/bin/sh',
        `D='${bin}'`,
        `{ echo '--CALL--'; printf '%s\\n' "$@"; } >> '${log}'`,
        'case "$*" in',
        '  *"pr create"*) if [ -f "$D/create-fails" ]; then echo "a pull request already exists" >&2; exit 1; fi; echo "https://example.test/pr/1";;',
        '  *"label list"*) if [ -f "$D/lookup-fails" ]; then echo "HTTP 403: rate limit exceeded" >&2; exit 1; fi; cat "$D/labels.txt";;',
        '  *"pr list --head"*) n=$(cat "$D/cnt" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/cnt"; sed -n "${n}p" "$D/list.txt";;',
        '  *"--json labels"*) cat "$D/view.txt";;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const calls = (): string[][] => {
      const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
      return text.split('--CALL--\n').filter(Boolean).map((c) => c.split('\n').slice(0, -1));
    };
    return { repo, branchName, baseSha, bin, calls };
  }

  async function withGh<T>(bin: string, fn: () => Promise<T>): Promise<T> {
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = prevPath;
    }
  }

  const ALL = ['version:major', 'version:minor', 'version:patch', 'version:skip'];
  const edits = (calls: string[][]) => calls.filter((c) => c[0] === 'pr' && c[1] === 'edit' && c.includes('--add-label'));
  const publish = (t: ReturnType<typeof setup>, title: string) => withGh(t.bin, () => commitAndCreatePRWithHead(
    { worktreePath: t.repo, originalPath: t.repo, branchName: t.branchName, issueId: 'AGT-LBL' },
    title, 'AGT-LBL', '', { draft: true },
  ));
  const auditInfo = (t: ReturnType<typeof setup>) => ({ worktreePath: t.repo, originalPath: t.repo, branchName: t.branchName, issueId: 'AGT-LBL' });

  it('labels a reused open PR that has no version label', async () => {
    const t = setup({ labels: ALL, listOutputs: ['https://example.test/pr/9'] });
    const result = await publish(t, '[BUG] crash');
    expect(result.prUrl).toBe('https://example.test/pr/9');
    expect(edits(t.calls())).toEqual([['pr', 'edit', 'https://example.test/pr/9', '--add-label', 'version:patch']]);
  });

  it('does not touch a reused PR that already carries a version label', async () => {
    const t = setup({ labels: ALL, listOutputs: ['https://example.test/pr/9'], prLabels: ['version:minor'] });
    await publish(t, '[BUG] crash');
    expect(edits(t.calls())).toHaveLength(0);
  });

  it('labels the PR that won a create race', async () => {
    const t = setup({ labels: ALL, listOutputs: ['', 'https://example.test/pr/9'], createFails: true });
    const result = await publish(t, '[BUG] crash');
    expect(result.prUrl).toBe('https://example.test/pr/9');
    expect(edits(t.calls())).toEqual([['pr', 'edit', 'https://example.test/pr/9', '--add-label', 'version:patch']]);
  });

  it('notes a failed label lookup in the PR body and still opens the PR', async () => {
    const t = setup({ lookupFails: true });
    await publish(t, '[BUG] crash');
    const create = t.calls().find((c) => c[0] === 'pr' && c[1] === 'create')!;
    expect(create).not.toContain('--label');
    expect(create.join('\n')).toContain('Version label: lookup failed: HTTP 403: rate limit exceeded; add one by hand');
    expect(create.join('\n')).toContain('add one by hand');
  });

  it('labels the audit-fix PR', async () => {
    const t = setup({ labels: ALL });
    const result = await withGh(t.bin, () => commitAndCreateAuditPR(auditInfo(t), {
      title: 'fix: audit findings', body: 'body', commitMessage: 'fix: audit', forkedFromBranch: 'main', baseSha: t.baseSha,
    }));
    expect(result).toBe('https://example.test/pr/1');
    const create = t.calls().find((c) => c[0] === 'pr' && c[1] === 'create')!;
    expect(create[create.indexOf('--label') + 1]).toBe('version:patch');
  });

  it('reports the reason in the audit PR body when the title does not map', async () => {
    const t = setup({ labels: ALL });
    await withGh(t.bin, () => commitAndCreateAuditPR(auditInfo(t), {
      title: 'refactor: audit findings', body: 'body', commitMessage: 'fix: audit', forkedFromBranch: 'main', baseSha: t.baseSha,
    }));
    const create = t.calls().find((c) => c[0] === 'pr' && c[1] === 'create')!;
    expect(create).not.toContain('--label');
    expect(create.join('\n')).toContain('## Version label');
  });
});
