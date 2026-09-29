import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const VERIFY_MANIFEST_PATH = join('.openswarm', 'verify.yaml');
const MAX_MANIFEST_BYTES = 64 * 1024;
const MANIFEST_IO_TIMEOUT_MS = 5_000;

async function withIoTimeout<T>(operation: Promise<T>, label: string, onLate?: (value: T) => void): Promise<T> {
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} timed out after ${MANIFEST_IO_TIMEOUT_MS}ms`));
    }, MANIFEST_IO_TIMEOUT_MS);
    timeout.unref();
  });
  operation.then((value) => {
    if (timedOut) onLate?.(value);
  }).catch(() => undefined);
  try {
    return await Promise.race([operation, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readBoundedManifest(path: string): Promise<string> {
  const handle = await withIoTimeout(
    open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600),
    'manifest open',
    (lateHandle) => { void lateHandle.close(); },
  );
  try {
    const stat = await withIoTimeout(handle.stat(), 'manifest stat');
    if (!stat.isFile()) throw new Error('manifest must be a regular file');
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await withIoTimeout(
        handle.read(buffer, offset, buffer.length - offset, null),
        'manifest read',
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_MANIFEST_BYTES) throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await withIoTimeout(handle.close(), 'manifest close').catch(() => undefined);
  }
}

export const VerifyCommandSchema = z.object({
  name: z.string().min(1, 'Command name is required'),
  run: z.string()
    .min(1, 'Command is required')
    .regex(/^[^\r\n]+$/, 'Command must be a single line')
    .refine((value) => !value.includes(String.fromCharCode(0)), 'Command must not contain NUL bytes'),
  kind: z.enum(['typecheck', 'test', 'lint', 'build']),
  timeoutMs: z.number().int().positive().max(900_000).default(300_000),
  cwd: z.string().min(1).refine(
    (value) => !/^(?:[A-Za-z]:)?[\\/]/.test(value) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value),
    'cwd must stay within the repository',
  ).refine((value) => !value.includes(String.fromCharCode(0)), 'cwd must not contain NUL bytes').optional(),
}).strict();

/** A manifest is repository-controlled; its size bounds nothing about its cost. */
const MAX_VERIFY_COMMANDS = 20;
/**
 * The aggregate ceiling, not the per-command one, is what bounds a run.
 *
 * 64 KiB of YAML holds several hundred commands, and each is allowed 15 minutes
 * on its own, so a manifest could schedule tens of hours of execution before a
 * single result existed — twice over, since every failing command is also run
 * at the merge base. Two hours is chosen so the largest plan the command cap
 * allows still validates at the DEFAULT per-command timeout (20 × 5 min = 100
 * min); it only rejects a plan that also maxes out every per-command timeout
 * (20 × 15 min = 5 h), and the error states the exact total.
 */
const MAX_TOTAL_VERIFY_TIMEOUT_MS = 2 * 60 * 60_000;

export const VerifyManifestSchema = z.object({
  version: z.literal(1),
  commands: z.array(VerifyCommandSchema)
    .min(1, 'At least one verify command is required')
    .max(MAX_VERIFY_COMMANDS, `At most ${MAX_VERIFY_COMMANDS} verify commands are allowed`),
}).strict().superRefine((value, ctx) => {
  const total = value.commands.reduce((sum, command) => sum + command.timeoutMs, 0);
  if (total > MAX_TOTAL_VERIFY_TIMEOUT_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['commands'],
      message: `Total command timeout must not exceed ${MAX_TOTAL_VERIFY_TIMEOUT_MS} ms (got ${total} ms)`,
    });
  }
});

export type VerifyCommand = z.infer<typeof VerifyCommandSchema>;
export type VerifyManifest = z.infer<typeof VerifyManifestSchema>;

export interface VerifyManifestLoadResult {
  manifest: VerifyManifest | null;
  error?: string;
}

export async function loadVerifyManifest(projectPath: string): Promise<VerifyManifestLoadResult> {
  const manifestPath = join(projectPath, VERIFY_MANIFEST_PATH);
  let source: string;
  try {
    source = await readBoundedManifest(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { manifest: null };
    return { manifest: null, error: `Failed to read ${VERIFY_MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    return { manifest: null, error: `Failed to parse ${VERIFY_MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}` };
  }

  const result = VerifyManifestSchema.safeParse(parsed);
  if (!result.success) {
    const reason = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return { manifest: null, error: `Invalid ${VERIFY_MANIFEST_PATH}: ${reason}` };
  }
  return { manifest: result.data };
}
