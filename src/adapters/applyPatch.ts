// V4A patch applier — the format codex models (gpt-5.x, gpt-5.3-codex-spark) are
// RLHF-trained to emit. The ChatGPT codex backend has NO built-in apply_patch tool
// (verified: HTTP 400 "Unsupported tool type: apply_patch"), so apply_patch is
// exposed as an ordinary function tool and the patch is applied here. Non-codex
// models emit structurally-valid-but-wrong V4A (phantom context), so this tool is
// gated to codex adapters only — others keep edit_file.

import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

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
  const errors: string[] = [];

  // Snapshot every path the patch touches BEFORE applying, so a mid-patch failure
  // rolls the tree back to clean. A partial apply (op 1 ok, op 2 fails) used to
  // leave files modified while the tool reported is_error (editToolCount stays 0),
  // so the model's retry double-applied the same patch onto already-changed files
  // → "context not found". Atomic apply makes is_error mean "nothing changed". (INT-1926)
  const touched = new Set<string>();
  for (const op of ops) {
    touched.add(resolvePath(op.filePath));
    if (op.moveTo) touched.add(resolvePath(op.moveTo));
  }
  // Existence and readability are recorded separately. Collapsing them into
  // "content, or null" made rollback treat a file it could not read as one that
  // had never existed, and rollback deletes those to restore absence — so a
  // mode-000 file, a dangling symlink or a path owned by another user could be
  // removed by a patch that only ever refused to touch it.
  type Snapshot =
    | { kind: 'absent' }
    | { kind: 'content'; text: string }
    | { kind: 'opaque' }; // exists, but its contents could not be captured
  const snapshots = new Map<string, Snapshot>();
  for (const abs of touched) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) snapshots.set(abs, { kind: 'opaque' });
      else snapshots.set(abs, { kind: 'content', text: await handle.readFile('utf-8') });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') snapshots.set(abs, { kind: 'absent' });
      else snapshots.set(abs, { kind: 'opaque' });
    } finally {
      await handle?.close();
    }
  }
  // Paths this patch actually created. Removing an absent-at-snapshot path is
  // only correct for those: the snapshot is taken up front, so a path that
  // appeared afterwards belongs to whoever wrote it, and an add that was
  // refused because the path exists never created anything. Deleting either
  // would be data loss dressed up as a clean rollback.
  const created = new Set<string>();

  const rollback = async () => {
    for (const [abs, snapshot] of snapshots) {
      try {
        if (snapshot.kind === 'opaque') {
          // Nothing can be restored and nothing should be destroyed: leaving it
          // as-is is the only option that cannot make the tree worse.
          continue;
        }
        if (snapshot.kind === 'absent') {
          if (!created.has(abs)) continue;
          await fs.rm(abs).catch(() => {});
        } else {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, snapshot.text, 'utf-8');
        }
      } catch { /* best-effort restore */ }
    }
  };

  for (const op of ops) {
    try {
      const abs = resolvePath(op.filePath);
      if (op.kind === 'delete') {
        await fs.rm(abs);
        changed.push(op.filePath);
        continue;
      }
      if (op.kind === 'add') {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        // 'wx' fails when the path already exists. An "Add File" op naming an
        // existing file used to overwrite it outright — the previous contents
        // were gone with no error raised and nothing recorded as an update, so
        // the agent believed it had created a file when it had replaced one.
        // Failing here runs the rollback below, which is recoverable.
        try {
          await fs.writeFile(abs, op.addLines.join('\n'), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
          created.add(abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
            // Deliberately NOT recorded as created: the file is someone else's,
            // whether it predates the patch or appeared after the snapshot.
            // Marking it here would have rollback delete it.
            throw new Error(
              `refusing to add ${op.filePath}: it already exists — use an update op to change it`,
            );
          }
          // Any other failure may have left a partial file that this patch did
          // create, so it is ours to clean up.
          created.add(abs);
          throw err;
        }
        changed.push(op.filePath);
        continue;
      }
      // update
      const original = await fs.readFile(abs, 'utf-8');
      let lines = original.split('\n');
      for (const hunk of op.hunks) {
        const at = findBlock(lines, hunk.oldBlock);
        if (at < 0) {
          throw new Error(`hunk context not found in ${op.filePath} (old block: ${JSON.stringify(hunk.oldBlock.slice(0, 2))}…)`);
        }
        lines = [...lines.slice(0, at), ...hunk.newBlock, ...lines.slice(at + hunk.oldBlock.length)];
      }
      const target = op.moveTo ? resolvePath(op.moveTo) : abs;
      if (op.moveTo) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const targetHandle = await fs.open(target, 'wx', 0o600);
        try {
          await targetHandle.writeFile(lines.join('\n'), 'utf-8');
        } finally {
          await targetHandle.close();
        }
        // Reserve the destination first. A concurrent creator now yields
        // EEXIST without clobbering either side of the move.
        await fs.rm(abs);
        created.add(target);
        changed.push(op.moveTo);
        continue;
      }
      await fs.writeFile(target, lines.join('\n'), { encoding: 'utf-8', mode: 0o600 });
      changed.push(op.moveTo ?? op.filePath);
    } catch (err) {
      // Roll back every already-applied op so the tree is clean for a retry.
      errors.push(`${op.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      await rollback();
      return { changed: [], errors };
    }
  }
  return { changed, errors };
}
