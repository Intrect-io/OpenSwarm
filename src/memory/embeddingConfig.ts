// ============================================
// OpenSwarm — Cognitive memory embedding configuration
// ============================================
//
// Deliberately independent of the main config loader (src/core/config.ts): the
// memory MCP server (src/mcp/memoryServer.ts) is launched as a bare stdio
// process per subagent and never reads config.yaml, so the embedding stack has
// to be resolvable from the environment alone. Everything here is pure except
// the signature sidecar helpers at the bottom.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** ONNX weight variant. Maps to the `dtype` option of @huggingface/transformers. */
export type EmbeddingDtype = 'q8' | 'q4' | 'q4f16' | 'fp16' | 'fp32';

const VALID_DTYPES: readonly EmbeddingDtype[] = ['q8', 'q4', 'q4f16', 'fp16', 'fp32'];

export interface EmbeddingModelSpec {
  /** Hugging Face repo id. */
  id: string;
  /** Vector dimension. Baked into the LanceDB table — changing it requires a rebuild. */
  dim: number;
  /** Encoder ceiling in TOKENS. Not characters — conflating the two was the bug this replaced. */
  maxTokens: number;
  dtype: EmbeddingDtype;
  /** Prepended when embedding a stored record. */
  passagePrefix: string;
  /** Prepended when embedding a search query. */
  queryPrefix: string;
}

// E5 models are trained with an asymmetric retrieval convention: stored text is a
// "passage", the search string is a "query". Using `query:` for both (as this code
// did before) throws away the distinction the model was trained to exploit.
const E5 = { passagePrefix: 'passage: ', queryPrefix: 'query: ' } as const;

type KnownSpec = Omit<EmbeddingModelSpec, 'id' | 'dtype'>;

/**
 * Models we have measured on this repo's store. Anything outside this table still
 * works, but must declare its dimension explicitly (see resolveEmbeddingConfig) —
 * guessing it would silently corrupt the LanceDB schema.
 */
export const KNOWN_EMBEDDING_MODELS: Readonly<Record<string, KnownSpec>> = {
  'Xenova/multilingual-e5-base': { dim: 768, maxTokens: 512, ...E5 },
  'Xenova/multilingual-e5-small': { dim: 384, maxTokens: 512, ...E5 },
  'Xenova/multilingual-e5-large': { dim: 1024, maxTokens: 512, ...E5 },
};

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/multilingual-e5-base';
export const DEFAULT_EMBEDDING_DTYPE: EmbeddingDtype = 'q8';

export interface EnvLike {
  [key: string]: string | undefined;
}

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer (got "${raw}")`);
  }
  return n;
}

/**
 * Resolve the active embedding model from the environment.
 *
 * `OPENSWARM_EMBEDDING_MODEL` selects the model. For models outside
 * KNOWN_EMBEDDING_MODELS, `OPENSWARM_EMBEDDING_DIM` is mandatory — a wrong
 * dimension does not fail loudly, it produces a table whose vectors can never be
 * searched, so we refuse to guess.
 */
export function resolveEmbeddingConfig(env: EnvLike = process.env): EmbeddingModelSpec {
  const id = env.OPENSWARM_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;

  const rawDtype = env.OPENSWARM_EMBEDDING_DTYPE?.trim();
  if (rawDtype && !VALID_DTYPES.includes(rawDtype as EmbeddingDtype)) {
    throw new Error(
      `OPENSWARM_EMBEDDING_DTYPE "${rawDtype}" is not supported (expected one of: ${VALID_DTYPES.join(', ')})`,
    );
  }
  const dtype = (rawDtype as EmbeddingDtype | undefined) ?? DEFAULT_EMBEDDING_DTYPE;

  const known = KNOWN_EMBEDDING_MODELS[id];
  const dimOverride = parsePositiveInt(env.OPENSWARM_EMBEDDING_DIM, 'OPENSWARM_EMBEDDING_DIM');
  const maxTokensOverride = parsePositiveInt(env.OPENSWARM_EMBEDDING_MAX_TOKENS, 'OPENSWARM_EMBEDDING_MAX_TOKENS');

  if (!known && dimOverride === undefined) {
    throw new Error(
      `Unknown embedding model "${id}". Set OPENSWARM_EMBEDDING_DIM to its vector dimension, ` +
        `or use one of: ${Object.keys(KNOWN_EMBEDDING_MODELS).join(', ')}`,
    );
  }

  return {
    id,
    dim: dimOverride ?? known!.dim,
    maxTokens: maxTokensOverride ?? known?.maxTokens ?? 512,
    dtype,
    passagePrefix: env.OPENSWARM_EMBEDDING_PASSAGE_PREFIX ?? known?.passagePrefix ?? '',
    queryPrefix: env.OPENSWARM_EMBEDDING_QUERY_PREFIX ?? known?.queryPrefix ?? '',
  };
}

/**
 * Upper bound on characters handed to the tokenizer.
 *
 * This is a cost guard, not a semantic limit: at 12 chars/token it sits far above
 * the ~4.6 (English) and ~1.5 (Korean) chars/token measured on this store, so
 * ordinary text is never cut before the encoder's own token ceiling applies. It
 * only exists so a pathological multi-megabyte record cannot stall tokenization.
 */
export function characterGuard(spec: EmbeddingModelSpec): number {
  return spec.maxTokens * 12;
}

/**
 * Canonical text embedded for a stored record.
 *
 * Some writers derive `title` from the head of `content` (saveCognitiveMemory
 * slices the first 100 chars). Concatenating blindly would double-weight that
 * opening, so a title that is already a prefix of the content is dropped. Keeping
 * this in one place is what lets the re-embed migration reproduce exactly what the
 * save path would have produced.
 */
export function embeddingTextFor(title: string, content: string): string {
  const t = (title ?? '').trim();
  const c = (content ?? '').trim();
  if (!t) return c;
  if (!c) return t;
  if (c.startsWith(t)) return c;
  return `${t}\n${c}`;
}

/**
 * Fingerprint of everything that changes the vector space. Stored alongside the
 * table so a model, dtype, dimension or prefix change is detected instead of
 * silently producing a store whose vectors were built by two different encoders.
 */
export function embeddingSignature(spec: EmbeddingModelSpec): string {
  return [
    spec.id,
    `dtype=${spec.dtype}`,
    `dim=${spec.dim}`,
    `max=${spec.maxTokens}`,
    `pp=${spec.passagePrefix}`,
    `qp=${spec.queryPrefix}`,
  ].join('|');
}

/**
 * Where ONNX weights are cached.
 *
 * Defaults under the user's home rather than node_modules: the library's own
 * default cache lives inside the package directory, so every `npm install`,
 * update or reinstall of OpenSwarm throws away ~280MB of weights and re-downloads
 * them on the next memory search.
 */
export function modelCacheDir(env: EnvLike = process.env): string {
  const override = env.OPENSWARM_MODEL_CACHE_DIR?.trim();
  if (override) return resolve(override);
  return resolve(homedir(), '.openswarm/models');
}

const SIGNATURE_FILE = 'embedding.json';

export interface StoredEmbeddingSignature {
  signature: string;
  updatedAt: string;
}

/** Read the signature recorded for a store directory. Null when absent or unreadable. */
export function readStoredSignature(memoryDir: string): StoredEmbeddingSignature | null {
  const path = resolve(memoryDir, SIGNATURE_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredEmbeddingSignature>;
    if (typeof parsed?.signature !== 'string') return null;
    return { signature: parsed.signature, updatedAt: String(parsed.updatedAt ?? '') };
  } catch {
    return null;
  }
}

/** Record the signature for a store directory. Best-effort — never throws. */
export function writeStoredSignature(memoryDir: string, signature: string): void {
  try {
    mkdirSync(memoryDir, { recursive: true });
    const payload: StoredEmbeddingSignature = { signature, updatedAt: new Date().toISOString() };
    writeFileSync(resolve(memoryDir, SIGNATURE_FILE), `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // A missing signature file degrades to "cannot detect drift", not to a broken store.
  }
}
