// ============================================
// OpenSwarm - outbound request deadlines
// ============================================
//
// Provider requests were bounded only by the caller's AbortSignal, and the
// agentic loop checks its own deadline between turns. A connection that
// accepted the request and then went silent therefore hung with nothing to
// interrupt it — for a background worker, indefinitely.

/**
 * Combine a caller's signal with a deadline for this request.
 *
 * Named for what it returns, not just what it does: mcpClient.ts already
 * exports a `withDeadline` that wraps a Promise, and two functions of that name
 * with different signatures is how a wrong import gets written later.
 *
 * Either one aborts. Returns the caller's signal unchanged when no deadline is
 * given, and undefined when there is neither, so call sites stay unconditional.
 *
 * The deadline covers the streamed body, not just the response headers, which
 * is the point: a stream that stops producing is the failure mode being bounded
 * here. It is therefore the caller's per-call ceiling — not a short network
 * timeout, which would cut off legitimate long generations.
 */
export function abortSignalWithDeadline(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return signal;
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
