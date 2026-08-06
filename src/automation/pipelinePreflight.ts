import type { PipelineResult } from '../agents/pairPipeline.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

/** Convert a pre-pipeline provider limit into the scheduler's pause contract. */
export function rateLimitedPipelineResult(err: RateLimitError): PipelineResult {
  return {
    success: false,
    sessionId: `rate-limited-${Date.now()}`,
    iterations: 0,
    totalDuration: 0,
    finalStatus: 'rate_limited',
    rateLimitResetsAt: err.resetsAt ? err.resetsAt * 1000 : undefined,
    stages: [],
  };
}
