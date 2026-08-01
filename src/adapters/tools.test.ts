import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOOL_DEFINITIONS, executeTool, createReadCache, ToolCall, buildBashToolEnv, validatePath } from './tools.js';
import { homedir } from 'node:os';

// search_memory loads the memory core lazily; stub the shared helper so the tool
// test stays fast and deterministic (no LanceDB / embedding model).
vi.mock('../memory/repoKnowledge.js', () => ({
  searchRepoMemoryText: async (_cwd: string, query: string) =>
    query.trim()
      ? 'Repository knowledge (1):\n- [constraint] Avoid double migrations\n  two paths touched prod tables'
      : 'A non-empty query is required.',
}));

// Check if rg binary is available (not just a shell function wrapper)
let hasRg = false;
try {
  execFileSync('rg', ['--version'], { stdio: 'pipe' });
  hasRg = true;
} catch { /* rg not installed as a binary */ }

// Shared temp directory for all tests
const TMP_DIR = '/tmp/openswarm-tools-test-' + process.pid;

/** Helper to build a ToolCall object */
function makeCall(name: string, args: Record<string, unknown>, id = 'tc-1'): ToolCall {
  return { id, function: { name, arguments: JSON.stringify(args) } };
}

// ──────────────────────────────────────────────
// Setup / Teardown
// ──────────────────────────────────────────────

beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// 1. TOOL_DEFINITIONS
// ──────────────────────────────────────────────

describe('TOOL_DEFINITIONS', () => {
  const expectedNames = ['read_file', 'write_file', 'edit_file', 'search_files', 'bash', 'search_memory'];

  it('exports exactly 6 tool definitions', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(6);
  });

  it.each(expectedNames)('includes "%s" tool', (name) => {
    const found = TOOL_DEFINITIONS.find(t => t.function.name === name);
    expect(found).toBeDefined();
    expect(found!.type).toBe('function');
    expect(found!.function.description).toBeTruthy();
    expect(found!.function.parameters).toBeDefined();
  });
});

describe('validatePath realpath containment', () => {
  it('rejects an in-root symlink that resolves outside the root', async () => {
    const link = path.join(TMP_DIR, 'outside-link.txt');
    await fs.symlink('/etc/hosts', link);
    try {
      expect(() => validatePath(link, TMP_DIR)).toThrow(/outside the project root/);
    } finally {
      await fs.unlink(link);
    }
  });
});

// ──────────────────────────────────────────────
// 1b. search_memory tool
// ──────────────────────────────────────────────

describe('executeTool — search_memory', () => {
  it('rejects an empty query', async () => {
    const r = await executeTool(makeCall('search_memory', { query: '  ' }), TMP_DIR);
    expect(r.is_error).toBe(true);
    expect(r.content).toContain('query');
  });

  it('returns repo-scoped knowledge formatted with type tags', async () => {
    const r = await executeTool(makeCall('search_memory', { query: 'migration' }), TMP_DIR);
    expect(r.is_error).toBe(false);
    expect(r.content).toContain('Repository knowledge');
    expect(r.content).toContain('[constraint] Avoid double migrations');
  });
});

// ──────────────────────────────────────────────
// 2. executeTool — per-tool tests
// ──────────────────────────────────────────────

describe('executeTool', () => {
  // ── read_file ──
  describe('read_file', () => {
    const filePath = path.join(TMP_DIR, 'read-target.txt');

    beforeAll(async () => {
      await fs.writeFile(filePath, 'alpha\nbeta\ngamma\ndelta\n', 'utf-8');
    });

    it('reads a file and returns numbered lines', async () => {
      const result = await executeTool(makeCall('read_file', { path: filePath }), TMP_DIR);
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('1\talpha');
      expect(result.content).toContain('2\tbeta');
      expect(result.content).toContain('3\tgamma');
    });

    it('respects offset and limit', async () => {
      const result = await executeTool(
        makeCall('read_file', { path: filePath, offset: 1, limit: 2 }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      // offset=1 means start from line index 1 → "beta" is line 2
      expect(result.content).toContain('2\tbeta');
      expect(result.content).toContain('3\tgamma');
      expect(result.content).not.toContain('1\talpha');
    });
  });

  // ── write_file ──
  describe('write_file', () => {
    it('creates a file with given content', async () => {
      const filePath = path.join(TMP_DIR, 'write-target.txt');
      const result = await executeTool(
        makeCall('write_file', { path: filePath, content: 'hello world' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('Written');

      const written = await fs.readFile(filePath, 'utf-8');
      expect(written).toBe('hello world');
    });

    it('creates intermediate directories', async () => {
      const filePath = path.join(TMP_DIR, 'sub', 'deep', 'nested.txt');
      const result = await executeTool(
        makeCall('write_file', { path: filePath, content: 'nested' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);

      const written = await fs.readFile(filePath, 'utf-8');
      expect(written).toBe('nested');
    });
  });

  // ── edit_file ──
  describe('edit_file', () => {
    it('replaces a unique string in a file', async () => {
      const filePath = path.join(TMP_DIR, 'edit-target.txt');
      await fs.writeFile(filePath, 'foo bar baz', 'utf-8');

      const result = await executeTool(
        makeCall('edit_file', { path: filePath, old_string: 'bar', new_string: 'REPLACED' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('Edited');

      const updated = await fs.readFile(filePath, 'utf-8');
      expect(updated).toBe('foo REPLACED baz');
    });

    it('returns error when old_string is not found', async () => {
      const filePath = path.join(TMP_DIR, 'edit-notfound.txt');
      await fs.writeFile(filePath, 'hello world', 'utf-8');

      const result = await executeTool(
        makeCall('edit_file', { path: filePath, old_string: 'MISSING', new_string: 'x' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('returns error when old_string is not unique', async () => {
      const filePath = path.join(TMP_DIR, 'edit-duplicate.txt');
      await fs.writeFile(filePath, 'aaa bbb aaa', 'utf-8');

      const result = await executeTool(
        makeCall('edit_file', { path: filePath, old_string: 'aaa', new_string: 'x' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('2 times');
      expect(result.content).toContain('unique');
    });

    // ── fuzzy fallback (INT-2011) ──
    it('fuzzy: matches despite a trailing-whitespace difference', async () => {
      const filePath = path.join(TMP_DIR, 'edit-fuzzy-ws.txt');
      await fs.writeFile(filePath, 'line one   \nline two\nline three', 'utf-8'); // line one has trailing spaces
      const result = await executeTool(
        makeCall('edit_file', { path: filePath, old_string: 'line one\nline two', new_string: 'X\nY' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('normalization');
      expect(await fs.readFile(filePath, 'utf-8')).toBe('X\nY\nline three');
    });

    it('fuzzy: matches despite smart-quote difference', async () => {
      const filePath = path.join(TMP_DIR, 'edit-fuzzy-quote.txt');
      await fs.writeFile(filePath, "const s = 'hello';", 'utf-8'); // straight quotes in file
      const result = await executeTool(
        makeCall('edit_file', { path: filePath, old_string: "const s = ‘hello’;", new_string: "const s = 'bye';" }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(await fs.readFile(filePath, 'utf-8')).toBe("const s = 'bye';");
    });

    it('fuzzy: refuses when the normalized match is ambiguous', async () => {
      const filePath = path.join(TMP_DIR, 'edit-fuzzy-ambig.txt');
      await fs.writeFile(filePath, "a = 'x'\nb\na = 'x'", 'utf-8'); // two straight-quote lines
      const result = await executeTool(
        makeCall('edit_file', { path: filePath, old_string: "a = ‘x’", new_string: 'CHANGED' }), // smart quotes → exact miss, fuzzy hits 2
        TMP_DIR,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not found');
      expect(await fs.readFile(filePath, 'utf-8')).toBe("a = 'x'\nb\na = 'x'"); // unchanged
    });
  });

  // ── search_files ──
  // Requires `rg` (ripgrep) binary — skip if not installed
  describe.skipIf(!hasRg)('search_files', () => {
    beforeAll(async () => {
      const searchDir = path.join(TMP_DIR, 'search');
      await fs.mkdir(searchDir, { recursive: true });
      await fs.writeFile(path.join(searchDir, 'a.txt'), 'findme_marker line one\nline two\n');
      await fs.writeFile(path.join(searchDir, 'b.txt'), 'nothing here\n');
      await fs.writeFile(path.join(searchDir, 'c.ts'), 'findme_marker in ts\n');
    });

    it('finds matching lines across files', async () => {
      const searchDir = path.join(TMP_DIR, 'search');
      const result = await executeTool(
        makeCall('search_files', { pattern: 'findme_marker', path: searchDir }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('findme_marker');
      // Should match in both a.txt and c.ts
      expect(result.content).toContain('a.txt');
      expect(result.content).toContain('c.ts');
    });

    it('filters by glob pattern', async () => {
      const searchDir = path.join(TMP_DIR, 'search');
      const result = await executeTool(
        makeCall('search_files', { pattern: 'findme_marker', path: searchDir, glob: '*.ts' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('c.ts');
      expect(result.content).not.toContain('a.txt');
    });

    it('returns "(no matches)" when pattern not found', async () => {
      const searchDir = path.join(TMP_DIR, 'search');
      const result = await executeTool(
        makeCall('search_files', { pattern: 'NONEXISTENT_xyz_999', path: searchDir }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toBe('(no matches)');
    });
  });

  // ── bash ──
  describe('bash', () => {
    it('executes a simple command and returns stdout', async () => {
      const result = await executeTool(
        makeCall('bash', { command: 'echo hello' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(false);
      expect(result.content.trim()).toBe('hello');
    });

    it('blocks rm -rf', async () => {
      const result = await executeTool(
        makeCall('bash', { command: 'rm -rf /' }),
        TMP_DIR,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('BLOCKED');
    });
  });
});

// ──────────────────────────────────────────────
// 3. Safety guards — blocked commands via bash tool
// ──────────────────────────────────────────────

describe('Safety guards (isCommandBlocked via bash)', () => {
  const blockedCommands = [
    'rm -rf /foo',
    'git reset --hard',
    'chmod 777 somefile',
  ];

  it.each(blockedCommands)('blocks dangerous command: %s', async (cmd) => {
    const result = await executeTool(makeCall('bash', { command: cmd }), TMP_DIR);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('BLOCKED');
  });

  const allowedCommands = [
    'ls -la',
    'npm test',
  ];

  it.each(allowedCommands)('allows safe command: %s', async (cmd) => {
    const result = await executeTool(makeCall('bash', { command: cmd }), TMP_DIR);
    // Should not be blocked (may still fail for other reasons, but not BLOCKED)
    expect(result.content).not.toContain('BLOCKED');
  });

  it('refuses mutation and shell tools in read-only mode', async () => {
    const filePath = path.join(TMP_DIR, 'readonly-target.txt');
    await fs.writeFile(filePath, 'keep', 'utf-8');

    const write = await executeTool(
      makeCall('write_file', { path: filePath, content: 'changed' }),
      TMP_DIR,
      undefined,
      { readOnly: true },
    );
    const bash = await executeTool(
      makeCall('bash', { command: 'echo changed > readonly-target.txt' }),
      TMP_DIR,
      undefined,
      { readOnly: true },
    );

    expect(write.is_error).toBe(true);
    expect(write.content).toContain('READ_ONLY');
    expect(bash.is_error).toBe(true);
    expect(bash.content).toContain('READ_ONLY');
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('keep');
  });

  it('refuses the web tools too, since a fetch is an outbound channel', async () => {
    // Read-only runs exist because the material under inspection is untrusted.
    // A fetch would carry out whatever the agent can read, credentials included.
    // The tool list already withholds these; this is the enforcement behind it,
    // for a model that calls a tool it was never shown. (INT-3189)
    const fetched = await executeTool(
      makeCall('web_fetch', { url: 'https://example.com/' }),
      TMP_DIR,
      undefined,
      { readOnly: true },
    );
    const searched = await executeTool(
      makeCall('web_search', { query: 'anything' }),
      TMP_DIR,
      undefined,
      { readOnly: true },
    );

    expect(fetched.is_error).toBe(true);
    expect(fetched.content).toContain('READ_ONLY');
    expect(searched.is_error).toBe(true);
    expect(searched.content).toContain('READ_ONLY');
  });
});

// ──────────────────────────────────────────────
// 4. Path validation
// ──────────────────────────────────────────────

describe('Path validation', () => {
  it('accepts project files when cwd is relative', () => {
    expect(validatePath('package.json', '.')).toBe(path.resolve('package.json'));
  });

  it('does not accept a sibling whose name only shares the project prefix', () => {
    expect(() => validatePath('/workspace/repository-evil/secret', '/workspace/repository'))
      .toThrow('outside the project root');
  });

  it('rejects paths outside cwd and /tmp', async () => {
    const result = await executeTool(
      makeCall('read_file', { path: '/etc/passwd' }),
      TMP_DIR,
    );
    expect(result.is_error).toBe(true);
    // 거부 메시지는 모델 자가수정을 돕도록 안내형 — "outside the project root" 포함.
    expect(result.content).toContain('outside the project root');
  });

  it('allows paths under /tmp', async () => {
    const filePath = path.join(TMP_DIR, 'allowed.txt');
    await fs.writeFile(filePath, 'ok', 'utf-8');

    const result = await executeTool(
      makeCall('read_file', { path: filePath }),
      // Use a different cwd to prove /tmp is allowed regardless
      '/Users/unohee/dev/OpenSwarm',
    );
    expect(result.is_error).toBe(false);
    expect(result.content).toContain('ok');
  });
});

// ──────────────────────────────────────────────
// 3. ReadCache — token-saving read deduplication
// ──────────────────────────────────────────────

describe('ReadCache', () => {
  it('returns cached content marked unchanged on a repeated read', async () => {
    const filePath = path.join(TMP_DIR, 'cache-a.txt');
    await fs.writeFile(filePath, 'hello\nworld\n');
    const cache = createReadCache();

    const first = await executeTool(makeCall('read_file', { path: filePath }), TMP_DIR, cache);
    expect(first.content).toContain('hello');
    expect(first.content).not.toContain('unchanged');

    const second = await executeTool(makeCall('read_file', { path: filePath }), TMP_DIR, cache);
    // New behavior: a re-read returns a STUB (content omitted to save context),
    // not the full content again — re-injecting it is what bloats read-heavy workers.
    expect(second.content).toContain('already read');
    expect(second.content).toContain('UNCHANGED');
    expect(second.content).not.toContain('hello'); // content NOT re-injected
  });

  it('invalidates the cache after edit_file so the next read is fresh', async () => {
    const filePath = path.join(TMP_DIR, 'cache-b.txt');
    await fs.writeFile(filePath, 'foo = 1\n');
    const cache = createReadCache();

    await executeTool(makeCall('read_file', { path: filePath }), TMP_DIR, cache);
    await executeTool(
      makeCall('edit_file', { path: filePath, old_string: 'foo = 1', new_string: 'foo = 2' }),
      TMP_DIR,
      cache,
    );

    const afterEdit = await executeTool(makeCall('read_file', { path: filePath }), TMP_DIR, cache);
    expect(afterEdit.content).not.toContain('unchanged');
    expect(afterEdit.content).toContain('foo = 2');
  });

  it('edit_file returns the resulting region so a re-read is unnecessary', async () => {
    const filePath = path.join(TMP_DIR, 'cache-c.txt');
    await fs.writeFile(filePath, 'line1\ntarget\nline3\n');
    const cache = createReadCache();

    const edit = await executeTool(
      makeCall('edit_file', { path: filePath, old_string: 'target', new_string: 'fixed' }),
      TMP_DIR,
      cache,
    );
    expect(edit.is_error).toBe(false);
    expect(edit.content).toContain('Resulting region');
    expect(edit.content).toContain('fixed');
  });

  it('caches by path+range so different offsets are not confused', async () => {
    const filePath = path.join(TMP_DIR, 'cache-d.txt');
    await fs.writeFile(filePath, Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
    const cache = createReadCache();

    const head = await executeTool(makeCall('read_file', { path: filePath, offset: 0, limit: 5 }), TMP_DIR, cache);
    const tail = await executeTool(makeCall('read_file', { path: filePath, offset: 10, limit: 5 }), TMP_DIR, cache);
    // Different range → not served from cache
    expect(tail.content).not.toContain('unchanged');
    expect(head.content).toContain('line1');
    expect(tail.content).toContain('line11');
  });

  it('evicts the least-recently-used entry once the bound (64) is exceeded', async () => {
    const filePath = path.join(TMP_DIR, 'cache-lru.txt');
    await fs.writeFile(filePath, Array.from({ length: 80 }, (_, i) => `row${i + 1}`).join('\n') + '\n');
    const cache = createReadCache();

    // 65 distinct ranges (offset 0..64, limit 1) — one past the 64-entry cap,
    // so the first read (offset 0, the LRU) must be evicted.
    for (let off = 0; off <= 64; off++) {
      await executeTool(makeCall('read_file', { path: filePath, offset: off, limit: 1 }), TMP_DIR, cache);
    }

    // The evicted entry re-reads from disk (no cache-stub marker)...
    const evicted = await executeTool(makeCall('read_file', { path: filePath, offset: 0, limit: 1 }), TMP_DIR, cache);
    expect(evicted.content).not.toContain('already read');
    // ...while a recently-read entry is still cached (returns the stub).
    const recent = await executeTool(makeCall('read_file', { path: filePath, offset: 64, limit: 1 }), TMP_DIR, cache);
    expect(recent.content).toContain('already read');
  });
});

// ──────────────────────────────────────────────
// ToolExecOptions — verification harness protection
// ──────────────────────────────────────────────

describe('ToolExecOptions', () => {
  it('edit_file refuses protected files with guidance back to source code', async () => {
    const filePath = path.join(TMP_DIR, 'run_tests.sh');
    await fs.writeFile(filePath, '#!/bin/bash\necho ok\n');

    const res = await executeTool(
      makeCall('edit_file', { path: filePath, old_string: 'echo ok', new_string: 'echo hacked' }),
      TMP_DIR,
      undefined,
      { protectedFiles: ['run_tests.sh'] },
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain('PROTECTED');
    expect(await fs.readFile(filePath, 'utf-8')).toContain('echo ok');
  });

  it('write_file refuses protected files', async () => {
    const filePath = path.join(TMP_DIR, 'run_tests.sh');
    const res = await executeTool(
      makeCall('write_file', { path: filePath, content: 'overwritten' }),
      TMP_DIR,
      undefined,
      { protectedFiles: ['run_tests.sh'] },
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain('PROTECTED');
  });

  it('edit_file still works on non-protected files when protection is active', async () => {
    const filePath = path.join(TMP_DIR, 'source.py');
    await fs.writeFile(filePath, 'x = 1\n');
    const res = await executeTool(
      makeCall('edit_file', { path: filePath, old_string: 'x = 1', new_string: 'x = 2' }),
      TMP_DIR,
      undefined,
      { protectedFiles: ['run_tests.sh'] },
    );
    expect(res.is_error).toBe(false);
    expect(await fs.readFile(filePath, 'utf-8')).toContain('x = 2');
  });

  it('bash reports TIMEOUT explicitly instead of a silent failure', async () => {
    const res = await executeTool(
      makeCall('bash', { command: 'sleep 5' }),
      TMP_DIR,
      undefined,
      { bashTimeoutMs: 300 },
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain('TIMEOUT');
    expect(res.content).toContain('NOT evidence');
  });

  it('buildBashToolEnv prepends user tool bins (cargo/local) to PATH', () => {
    const env = buildBashToolEnv({ PATH: '/usr/bin:/bin' });
    const parts = (env.PATH ?? '').split(':');
    expect(parts).toContain(path.join(homedir(), '.cargo', 'bin'));
    expect(parts).toContain(path.join(homedir(), '.local', 'bin'));
    // Base entries survive, and the augmentation comes first so shims win.
    expect(parts).toContain('/usr/bin');
    expect(parts.indexOf(path.join(homedir(), '.cargo', 'bin'))).toBeLessThan(parts.indexOf('/usr/bin'));
  });

  it('buildBashToolEnv does not duplicate a path already present', () => {
    const env = buildBashToolEnv({ PATH: `${path.join(homedir(), '.cargo', 'bin')}:/usr/bin` });
    const cargo = path.join(homedir(), '.cargo', 'bin');
    expect((env.PATH ?? '').split(':').filter((p) => p === cargo)).toHaveLength(1);
  });
});
