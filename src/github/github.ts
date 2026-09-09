/**
	 * Wait for CI to complete on a PR.
	 * @param repo - Repository name (e.g., "owner/repo")
	 * @param prNumber - PR number
	 * @param options
	 * @param options.timeoutMs - Fallback timeout (default 10 min). Used when deadlineMs is not set.
	 * @param options.deadlineMs - Absolute epoch deadline. When set, throws if exceeded before CI passes.
	 * @param options.pollIntervalMs - Polling interval (default 30s)
	 * @param options.expectedHeadSha - Exact published commit this wait is allowed to accept.
	 * @param options.onProgress - Progress callback
	 * @returns Final CI status
	 */
	export async function waitForCICompletion(
	  repo: string,
	  prNumber: number,
	  options: {
	    timeoutMs?: number;
	    deadlineMs?: number;
	    pollIntervalMs?: number;
	    /** Exact published commit this wait is allowed to accept. */
	    expectedHeadSha?: string;
	    onProgress?: (status: CIStatus, elapsed: number) => void;
	  } = {}
	): Promise<CIStatus> {
	  const timeoutMs = options.timeoutMs ?? 600_000; // 10 minutes default
	  const deadlineMs = options.deadlineMs;
	  const pollIntervalMs = options.pollIntervalMs ?? 30_000; // 30 seconds default
	  const startTime = Date.now();
	  let expectedHeadSha = options.expectedHeadSha?.trim();
	  let lastPending: Extract<CIStatus, { status: 'pending' }> | undefined;

	  while (true) {
	    const elapsed = Date.now() - startTime;
	    const now = Date.now();

	    // deadlineMs is the configured end-to-end deadline — throw if exceeded.
	    if (deadlineMs !== undefined && now >= deadlineMs) {
	      throw new Error(
	        `CI deadline exceeded for ${repo}#${prNumber}: deadline ${deadlineMs} passed at ${now} (elapsed ${elapsed}ms)`,
	      );
	    }

	    if (elapsed >= timeoutMs) {
	      console.log(`[GitHub] CI timeout for ${repo}#${prNumber} (${elapsed}ms)`);
	      return lastPending ?? {
	        status: 'unknown',
	        reason: expectedHeadSha ? 'head_unavailable' : 'expected_head_unavailable',
	        expectedHeadSha,
	      };
	    }

	    const status = await checkPRCIStatus(repo, prNumber, expectedHeadSha);

	    // Legacy callers that did not provide an expected SHA are pinned to the
	    // first head they actually observe. A later push can no longer replace a
	    // pending head A with a green head B inside the same wait.
	    if (!expectedHeadSha && status.status !== 'unknown') {
	      expectedHeadSha = status.headSha;
	    }

	    if (options.onProgress) {
	      options.onProgress(status, elapsed);
	    }

	    if (status.status !== 'pending') {
	      return status;
	    }
	    lastPending = status;

	    // Wait before next poll
	    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
	  }
	}