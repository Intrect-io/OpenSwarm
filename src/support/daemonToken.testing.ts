// Test helper: a known daemon token for tests that call the live web server.
// Mutating routes need the token on loopback too (AGT-4814), so a route test
// that POSTs sets this token up and sends AUTH with its mutations.

import { afterEach, beforeEach } from 'vitest';
import { setActiveDaemonTokenForTesting } from './daemonToken.js';

export const TEST_DAEMON_TOKEN = 'test-daemon-token-0123456789abcdef';

/** Headers that authorize a mutation against a server using TEST_DAEMON_TOKEN. */
export const AUTH: Record<string, string> = { 'x-openswarm-token': TEST_DAEMON_TOKEN };

/** Make the server accept TEST_DAEMON_TOKEN for every test in the calling file. */
export function useTestDaemonToken(): void {
  beforeEach(() => { setActiveDaemonTokenForTesting(TEST_DAEMON_TOKEN); });
  afterEach(() => { setActiveDaemonTokenForTesting(null); });
}
