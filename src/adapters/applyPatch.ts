// V4A patch applier — the format codex models (gpt-5.x, gpt-5.3-codex-spark) are
// RLHF-trained to emit. The ChatGPT codex backend has NO built-in apply_patch tool
// (verified: HTTP 400 "Unsupported tool type: apply_patch"), so apply_patch is
// exposed as an ordinary function tool and the patch is applied here. Non-codex
// models emit structurally-valid-but-wrong V4A (phantom context), so this tool is
// gated to codex adapters only — others keep edit_file.

import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export interface ApplyPatchResult {
  changed: string[]; // paths touched (as written in the patch)
  errors: string[];
}

interface Hunk {
  oldBlock: string[]; // context + removed lines, in order (the text to find)
  newBlock: string[]; // context + added lines, in order (the replacement)
}
interface FileOp {
  kind: 'update' | 'add' | 'delete';
  filePath: string;
  moveTo?: string;
  hunks: Hunk[];
  addLines: string[];
}

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const execFileAsync = promisify(execFile);
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;

type Snapshot =
  | { kind: 'absent' }
  | { kind: 'content'; text: string }
  | { kind: 'opaque' };

interface TrackedPath {
  patchPath: string;
  initial: Snapshot;
  current: Snapshot;
}

/**
 * Patch paths are repository-relative, and a pre-existing symlink must never
 * turn one into a write outside that repository. `resolvePath` validates the
 * path for the tool layer, but it may canonicalize an existing symlink before
 * this applier sees it. Inspect the uncanonicalized patch path first so the
 * applier retains this boundary even when called directly in tests or by a
 * future caller.
 */
async function rejectSymlinkPath(cwd: string, patchPath: string): Promise<void> {
  const root = path.resolve(cwd);
  const candidate = path.resolve(root, patchPath);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`refusing path outside patch root: ${patchPath}`);
  }

  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(`refusing ${patchPath}: path contains a symbolic link`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

async function readRegularFileNoFollow(abs: string): Promise<Snapshot> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) {
      return { kind: 'opaque' };
    }
    return { kind: 'content', text: await handle.readFile('utf-8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'opaque' };
  } finally {
    await handle?.close();
  }
}

function normalizedPatchPath(cwd: string, patchPath: string): string {
  const root = path.resolve(cwd);
  const candidate = path.resolve(root, patchPath);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`refusing path outside patch root: ${patchPath}`);
  }
  return relative.split(path.sep).join('/');
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.kind === b.kind && (a.kind !== 'content' || b.kind !== 'content' || a.text === b.text);
}

async function runGit(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, encoding: 'utf-8', maxBuffer: GIT_OUTPUT_LIMIT });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
    };
  }
}

async function writeScratchFile(root: string, patchPath: string, text: string): Promise<string> {
  const target = path.resolve(root, patchPath);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`refusing unsafe scratch path: ${patchPath}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, text, { encoding: 'utf-8', mode: 0o600 });
  return target;
}

/** Parse a V4A patch envelope into file operations. Throws on malformed envelope. */
export function parseV4A(patchText: string): FileOp[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() !== BEGIN) i++;
  if (i >= lines.length) throw new Error('missing "*** Begin Patch"');
  i++; // skip Begin

  const ops: FileOp[] = [];
  let cur: FileOp | null = null;
  let curHunk: Hunk | null = null;

  const pushHunk = () => {
    if (cur && curHunk && (curHunk.oldBlock.length || curHunk.newBlock.length)) cur.hunks.push(curHunk);
    curHunk = null;
  };
  const pushOp = () => { pushHunk(); if (cur) ops.push(cur); cur = null; };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t === END) { pushOp(); return ops; }

    let m: RegExpMatchArray | null;
    if ((m = t.match(/^\*\*\* Update File: (.+)$/))) {
      pushOp();
      cur = { kind: 'update', filePath: m[1].trim(), hunks: [], addLines: [] };
    } else if ((m = t.match(/^\*\*\* Add File: (.+)$/))) {
      pushOp();
      cur = { kind: 'add', filePath: m[1].trim(), hunks: [], addLines: [] };
    } else if ((m = t.match(/^\*\*\* Delete File: (.+)$/))) {
      pushOp();
      cur = { kind: 'delete', filePath: m[1].trim(), hunks: [], addLines: [] };
    } else if ((m = t.match(/^\*\*\* Move to: (.+)$/))) {
      if (cur) cur.moveTo = m[1].trim();
    } else if (t.startsWith('@@')) {
      pushHunk();
      curHunk = { oldBlock: [], newBlock: [] };
    } else if (cur?.kind === 'add') {
      // Add File: body is all '+' lines.
      cur.addLines.push(line.startsWith('+') ? line.slice(1) : line);
    } else if (cur?.kind === 'update') {
      if (!curHunk) curHunk = { oldBlock: [], newBlock: [] };
      const marker = line[0];
      const body = line.slice(1);
      if (marker === '-') { curHunk.oldBlock.push(body); }
      else if (marker === '+') { curHunk.newBlock.push(body); }
      else { // context line (leading space, or a bare line)
        const ctx = marker === ' ' ? body : line;
        curHunk.oldBlock.push(ctx);
        curHunk.newBlock.push(ctx);
      }
    }
  }
  throw new Error('missing "*** End Patch"');
}

/** Locate `block` in `content` lines; return start index, or -1. Tries exact, then trimEnd-fuzzy. */
function findBlock(contentLines: string[], block: string[]): number {
  if (block.length === 0) return -1;
  const eq = (a: string, b: string) => a === b;
  const fuzzy = (a: string, b: string) => a.trimEnd() === b.trimEnd();
  for (const cmp of [eq, fuzzy]) {
    outer: for (let i = 0; i + block.length <= contentLines.length; i++) {
      for (let j = 0; j < block.length; j++) if (!cmp(contentLines[i + j], block[j])) continue outer;
      return i;
    }
  }
  return -1;
}

/** Apply a parsed V4A patch under `cwd`. Returns touched paths + per-op errors. */
export async function applyV4APatch(
  patchText: string,
  cwd: string,
  resolvePath: (p: string) => string,
): Promise<ApplyPatchResult> {
  const ops = parseV4A(patchText);
  const changed: string[] = [];

  // Do this before snapshotting: `resolvePath` can intentionally return a
  // canonical path, which would otherwise hide the symlink named in the patch.
  try {
    for (const op of ops) {
      await rejectSymlinkPath(cwd, op.filePath);
      if (op.moveTo) await rejectSymlinkPath(cwd, op.moveTo);
    }
  } catch (error) {
    return { changed: [], errors: [error instanceof Error ? error.message : String(error)] };
  }

  // Build the complete desired tree state in memory first. A failed hunk or
  // collision therefore has no filesystem side effect to roll back.
  const paths = new Map<string, TrackedPath>();
  const getPath = async (rawPath: string): Promise<TrackedPath> => {
    const patchPath = normalizedPatchPath(cwd, rawPath);
    const existing = paths.get(patchPath);
    if (existing) return existing;
    const resolvedBeforeSnapshot = resolvePath(rawPath);
    const initial = await readRegularFileNoFollow(resolvedBeforeSnapshot);
    // The caller owns policy validation. Resolve once more after the snapshot
    // so a changing resolver cannot silently point the generated Git patch at
    // a different file than the one whose preimage we checked.
    const resolvedAfterSnapshot = resolvePath(rawPath);
    if (resolvedAfterSnapshot !== resolvedBeforeSnapshot) {
      throw new Error(`refusing ${rawPath}: resolved path changed during patch preparation`);
    }
    const tracked = { patchPath, initial, current: initial };
    paths.set(patchPath, tracked);
    return tracked;
  };

  try {
    for (const op of ops) {
      const source = await getPath(op.filePath);
      if (op.kind === 'delete') {
        if (source.current.kind !== 'content') throw new Error(`refusing to delete ${op.filePath}: not a readable regular file`);
        source.current = { kind: 'absent' };
        changed.push(op.filePath);
        continue;
      }
      if (op.kind === 'add') {
        if (source.current.kind !== 'absent') {
          throw new Error(`refusing to add ${op.filePath}: it already exists — use an update op to change it`);
        }
        source.current = { kind: 'content', text: op.addLines.join('\n') };
        changed.push(op.filePath);
        continue;
      }
      if (source.current.kind !== 'content') throw new Error(`refusing to update ${op.filePath}: not a readable regular file`);
      let lines = source.current.text.split('\n');
      for (const hunk of op.hunks) {
        const at = findBlock(lines, hunk.oldBlock);
        if (at < 0) {
          throw new Error(`hunk context not found in ${op.filePath} (old block: ${JSON.stringify(hunk.oldBlock.slice(0, 2))}…)`);
        }
        lines = [...lines.slice(0, at), ...hunk.newBlock, ...lines.slice(at + hunk.oldBlock.length)];
      }
      const updated = { kind: 'content' as const, text: lines.join('\n') };
      if (op.moveTo) {
        const target = await getPath(op.moveTo);
        if (target.current.kind !== 'absent') throw new Error(`refusing to move to ${op.moveTo}: it already exists`);
        source.current = { kind: 'absent' };
        target.current = updated;
        changed.push(op.moveTo);
      } else {
        source.current = updated;
        changed.push(op.filePath);
      }
    }
  } catch (error) {
    return { changed: [], errors: [error instanceof Error ? error.message : String(error)] };
  }

  const changedPaths = [...paths.values()].filter((entry) => !sameSnapshot(entry.initial, entry.current));
  if (changedPaths.length === 0) return { changed, errors: [] };

  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'openswarm-v4a-'));
  try {
    const beforeRoot = path.join(scratch, 'before');
    const afterRoot = path.join(scratch, 'after');
    const diffs: string[] = [];
    for (const entry of changedPaths) {
      const before = entry.initial.kind === 'content'
        ? await writeScratchFile(beforeRoot, entry.patchPath, entry.initial.text)
        : '/dev/null';
      const after = entry.current.kind === 'content'
        ? await writeScratchFile(afterRoot, entry.patchPath, entry.current.text)
        : '/dev/null';
      const diff = await runGit(['diff', '--no-index', '--no-ext-diff', '--binary', before, after], scratch);
      if (diff.exitCode === 1) diffs.push(diff.stdout);
      else if (diff.exitCode !== 0) throw new Error(diff.stderr || 'git could not generate the patch');
    }
    const patch = path.join(scratch, 'patch.diff');
    await fs.writeFile(patch, diffs.join(''), { encoding: 'utf-8', mode: 0o600 });
    // The generated files live below equally deep before/after roots. Strip
    // their absolute-prefix components so Git applies only repository-relative
    // paths. Git rejects any path that traverses a symlink at check *and* write
    // time, which closes the intermediate-directory replacement race that a
    // sequence of Node pathname calls cannot safely represent.
    const strip = 1 + path.resolve(afterRoot).split(path.sep).filter(Boolean).length;
    for (const args of [
      ['apply', '--check', '--whitespace=nowarn', `-p${strip}`, patch],
      ['apply', '--whitespace=nowarn', `-p${strip}`, patch],
    ]) {
      const result = await runGit(args, cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'git rejected the patch');
    }
    return { changed, errors: [] };
  } catch (error) {
    return { changed: [], errors: [error instanceof Error ? error.message : String(error)] };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
