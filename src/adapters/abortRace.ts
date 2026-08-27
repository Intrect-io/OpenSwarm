/**
 * Await an operation until it settles or the lifecycle signal aborts.
 *
 * Passing AbortSignal to an adapter is advisory: third-party or buggy adapters
 * may ignore it. This wrapper enforces the caller-facing deadline while keeping
 * a rejection handler attached to the abandoned operation so a late failure
 * cannot become an unhandled rejection.
 */
export function raceWithAbort<T>(
  operation: T | PromiseLike<T>,
  signal: AbortSignal,
  fallbackMessage = 'Operation aborted',
): Promise<T> {
  const pending = Promise.resolve(operation);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error(fallbackMessage));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        // This rejection handler remains attached after an abort. Returning
        // here is intentional: the caller already received the abort reason.
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );

    // Close the gap between the initial check and listener installation.
    if (signal.aborted) onAbort();
  });
}
