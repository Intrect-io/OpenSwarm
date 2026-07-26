import { describe, it, expect } from 'vitest';
import { isInfraError, isTimeoutError, codexMcpAuthHint } from './errorClassification.js';

describe('isTimeoutError (INT-2659)', () => {
  it('separates wall-clock exhaustion from other infrastructure failures', () => {
    expect(isTimeoutError(new Error('Task timed out after 3600000ms'))).toBe(true);
    expect(isTimeoutError(new DOMException('expired', 'TimeoutError'))).toBe(true);
    expect(isTimeoutError(new Error('spawn codex ENOENT'))).toBe(false);
  });
});

describe('isInfraError (INT-2010)', () => {
  it('flags CLI non-zero exit as infra (the production STUCK driver)', () => {
    expect(isInfraError(new Error('codex CLI failed with code 1: Reading prompt from stdin...'))).toBe(true);
    expect(isInfraError(new Error('Reviewer execution failed: claude CLI failed with code 1'))).toBe(true);
    expect(isInfraError(new Error('process exited with code 127'))).toBe(true);
  });

  it('flags spawn / auth / timeout / network failures', () => {
    expect(isInfraError(new Error('spawn codex ENOENT'))).toBe(true);
    expect(isInfraError(new Error('Request failed: 401 Unauthorized'))).toBe(true);
    expect(isInfraError(new Error('403 Forbidden'))).toBe(true);
    expect(isInfraError(new Error('OpenAI API error (401): invalid key'))).toBe(true);
    expect(isInfraError(new Error('request rejected with status 403'))).toBe(true);
    expect(isInfraError(new Error('connect ETIMEDOUT'))).toBe(true);
    expect(isInfraError(new Error('codex timeout after 300000ms'))).toBe(true);
    expect(isInfraError(new Error('read ECONNRESET'))).toBe(true);
    expect(isInfraError('getaddrinfo ENOTFOUND api.openai.com')).toBe(true);
  });

  it('does NOT flag a bare 401/403 number in prose (needs auth word or wrapper) (INT-2521)', () => {
    expect(isInfraError(new Error('assertion failed at line 401 of the parser'))).toBe(false);
    expect(isInfraError(new Error('the error code 4013 is not a real HTTP status'))).toBe(false);
    expect(isInfraError(new Error('expected 403 rows in the fixture'))).toBe(false);
    // a generic application "error code 401" is NOT an HTTP/auth infra failure
    expect(isInfraError(new Error('validation error code 401: form field missing'))).toBe(false);
  });

  it('does NOT flag genuine task/code failures', () => {
    expect(isInfraError(new Error('TypeError: cannot read property foo of undefined'))).toBe(false);
    expect(isInfraError(new Error('Test failed: expected 3 to equal 4'))).toBe(false);
    expect(isInfraError(new Error('old_string not found in file'))).toBe(false);
    expect(isInfraError(new Error('Reviewer rejected: missing null check'))).toBe(false);
  });

  it('handles non-Error inputs safely', () => {
    expect(isInfraError(undefined)).toBe(false);
    expect(isInfraError(null)).toBe(false);
    expect(isInfraError('')).toBe(false);
  });

  it('recognises undici "fetch failed" via error.cause.code (INT-2520)', () => {
    // undici surfaces connection failures as `TypeError: fetch failed` with the
    // real code on `.cause.code` — the top-level message alone would be missed.
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(isInfraError(refused)).toBe(true);
    const undErr = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
    expect(isInfraError(undErr)).toBe(true);
    // "fetch failed" alone is also treated as infra (server unreachable).
    expect(isInfraError(new TypeError('fetch failed'))).toBe(true);
  });

  it('recognises a git-tracker snapshot/diff failure as infra (INT-2521)', () => {
    expect(isInfraError(new Error('git-tracker: diff since snapshot failed: fatal: bad object'))).toBe(true);
  });

  it('recognises a reviewer-stage parse failure as infra, not a quality reject (INT-2521)', () => {
    expect(isInfraError(new Error('reviewer-stage: produced no parseable verdict: TypeError x'))).toBe(true);
    // …but a task/review that merely discusses the reviewer stage is NOT infra:
    expect(isInfraError(new Error('the reviewer stage should reject empty diffs'))).toBe(false);
  });

  it('recognises host resource exhaustion (disk full / OOM) as infra, not a task failure (INT-2521)', () => {
    // A full disk crashed the daemon in production; ENOSPC must backoff-retry, not STUCK.
    expect(isInfraError(new Error('ENOSPC: no space left on device, open \'/repo/worktree/.openswarm-preserved\''))).toBe(true);
    expect(isInfraError(new Error('write failed: no space left on device'))).toBe(true);
    expect(isInfraError(Object.assign(new Error('spawn failed'), { cause: { code: 'ENOSPC' } }))).toBe(true);
    expect(isInfraError(new Error('ENOMEM: not enough memory'))).toBe(true);
    // …but ordinary prose mentioning space is NOT infra
    expect(isInfraError(new Error('the layout leaves no space left for the label'))).toBe(false);
  });

  it('recognises local server capacity failures (5xx / loading / overloaded) (INT-2520)', () => {
    expect(isInfraError(new Error('Local API error (503): model is loading'))).toBe(true);
    expect(isInfraError(new Error('Local API error (502): bad gateway'))).toBe(true);
    expect(isInfraError(new Error('Server overloaded, try again'))).toBe(true);
  });

  it('does NOT flag a bare 5xx number in task/reviewer prose (needs adapter/HTTP context) (INT-2520)', () => {
    expect(isInfraError(new Error('assertion failed: expected 503 records, got 502'))).toBe(false);
    expect(isInfraError(new Error('the retry loop caps at 504 attempts'))).toBe(false);
    expect(isInfraError(new Error('validation error (503) is the wrong code to return here'))).toBe(false);
    // …but the same code inside an adapter error wrapper IS infra:
    expect(isInfraError(new Error('OpenAI API error (503): upstream'))).toBe(true);
    expect(isInfraError(new Error('Codex responses error (502): bad gateway'))).toBe(true);
    expect(isInfraError(new Error('HTTP 504 gateway timeout'))).toBe(true);
  });
});

describe('codexMcpAuthHint (INT-2408)', () => {
  it('returns a hint for the real codex rmcp AuthRequired transport failure', () => {
    const err = new Error(
      'codex CLI failed with code 1: rmcp::transport::worker: worker quit with fatal: ' +
        'Transport channel closed, when AuthRequired',
    );
    const hint = codexMcpAuthHint(err);
    expect(hint).toContain('~/.codex/config.toml');
    expect(hint).toContain('401');
    expect(hint).toContain("url=");
  });

  it('matches the bare "Transport channel closed ... AuthRequired" stderr text too', () => {
    expect(codexMcpAuthHint('Transport channel closed, when AuthRequired')).not.toBeNull();
  });

  it('requires BOTH an AuthRequired signal and an rmcp/transport marker', () => {
    // rmcp marker but no AuthRequired -> not our case
    expect(codexMcpAuthHint('rmcp::transport::worker: worker quit with fatal: EOF')).toBeNull();
    // AuthRequired but no rmcp/transport marker -> not our case
    expect(codexMcpAuthHint('AuthRequired: token expired')).toBeNull();
    // generic 401 with neither marker
    expect(codexMcpAuthHint('Request failed: 401 Unauthorized')).toBeNull();
  });

  it('returns null for unrelated and empty inputs', () => {
    expect(codexMcpAuthHint(new Error('TypeError: cannot read property foo of undefined'))).toBeNull();
    expect(codexMcpAuthHint(undefined)).toBeNull();
    expect(codexMcpAuthHint(null)).toBeNull();
    expect(codexMcpAuthHint('')).toBeNull();
  });
});

describe('a request that ran past its deadline', () => {
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError whose
  // message is "The operation was aborted due to timeout" — which matches none
  // of the message patterns ('timed out', 'timeout after'). Without an explicit
  // check a provider that accepted a request and then went silent was reported
  // as the task itself failing, which changes how the worker retries.
  it('is infrastructure, not a task failure', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(isInfraError(timeout)).toBe(true);
    expect(isTimeoutError(timeout)).toBe(true);
  });

  // A user abort is a stop, not a fault — it must stay out of the infra bucket
  // or a deliberate cancellation would be retried as though something broke.
  it('is distinguished from a user abort', () => {
    const aborted = new DOMException('This operation was aborted', 'AbortError');
    expect(isInfraError(aborted)).toBe(false);
  });

  it('still classifies the message-based timeouts it always did', () => {
    expect(isInfraError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe(true);
    expect(isInfraError(new Error('claude timeout after 300000ms'))).toBe(true);
  });
});
