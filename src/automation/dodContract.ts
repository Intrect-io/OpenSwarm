// ============================================
// OpenSwarm — executable Definition of Done contract
// ============================================
//
// Issue descriptions are untrusted input. This parser deliberately accepts a
// small, versioned JSON policy and never executes commands from it. Commands
// belong to the repository's trusted verify manifest; this contract only tells
// the coordinator which deterministic outcomes it may resolve automatically.

export type DoDNoChangesPolicy = 'park' | 'complete';
export type DoDScopeMismatchPolicy = 'park' | 'retry_ephemeral';

export interface DoDContract {
  version: 1;
  completion: {
    noChanges: DoDNoChangesPolicy;
  };
  automation: {
    scopeMismatch: DoDScopeMismatchPolicy;
    maxRepairs: number;
  };
}

export interface ParsedDoDContract {
  contract?: DoDContract;
  error?: string;
}

const FENCE = /```openswarm:dod\s*\n([\s\S]*?)\n```/i;
const MAX_DESCRIPTION_CONTRACT_BYTES = 16_000;
const MAX_REPAIRS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === 'string' && values.includes(value as T) ? value as T : undefined;
}

function parseMaxRepairs(raw: unknown): { value?: number; error?: string } {
  if (raw === undefined) return { value: 1 };
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_REPAIRS) {
    return { error: `DoD contract automation.maxRepairs must be an integer from 0 to ${MAX_REPAIRS}` };
  }
  return { value: raw };
}

/**
 * Parse the optional fenced contract from an issue description.
 *
 * An absent block is a legacy issue and remains fail-closed for business
 * outcomes. A malformed block is also fail-closed, but is returned as an
 * explicit error so the coordinator can report the authoring problem instead
 * of silently ignoring it.
 */
export function parseDoDContract(description?: string): ParsedDoDContract {
  if (!description) return {};
  const match = description.match(FENCE);
  if (!match) return {};
  const source = match[1];
  if (Buffer.byteLength(source, 'utf8') > MAX_DESCRIPTION_CONTRACT_BYTES) {
    return { error: `DoD contract exceeds ${MAX_DESCRIPTION_CONTRACT_BYTES} bytes` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { error: 'DoD contract is not valid JSON' };
  }
  if (!isRecord(raw) || raw.version !== 1) {
    return { error: 'DoD contract version must be 1' };
  }
  const completion = isRecord(raw.completion) ? raw.completion : undefined;
  const automation = isRecord(raw.automation) ? raw.automation : undefined;
  const noChanges = boundedEnum(completion?.noChanges, ['park', 'complete'] as const);
  const scopeMismatch = boundedEnum(automation?.scopeMismatch, ['park', 'retry_ephemeral'] as const);
  if (!noChanges || !scopeMismatch) {
    return {
      error: 'DoD contract requires completion.noChanges and automation.scopeMismatch',
    };
  }
  const repairs = parseMaxRepairs(automation?.maxRepairs);
  if (repairs.error || repairs.value === undefined) {
    return { error: repairs.error ?? 'DoD contract automation.maxRepairs is invalid' };
  }
  return {
    contract: {
      version: 1,
      completion: { noChanges },
      automation: { scopeMismatch, maxRepairs: repairs.value },
    },
  };
}

export function formatDoDContract(contract: DoDContract): string {
  return [
    '```openswarm:dod',
    JSON.stringify(contract, null, 2),
    '```',
  ].join('\n');
}
