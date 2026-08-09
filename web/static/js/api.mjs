// Fetch wrapper: JSON in/out, normalized errors. (INT-3388)

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response (unexpected) — body stays null
  }
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  return body;
}

/**
 * For endpoints a daemon may predate: a 404 resolves to null instead of
 * throwing, so callers branch on data rather than on exception type. Real
 * failures (500, network) still throw.
 */
async function optional(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export const api = {
  health: () => request('/api/health'),
  // The dispatchable repo set — matches dispatchWork's boundary check exactly.
  workProjects: () => request('/api/work/projects'),
  workIssues: (path) => request(`/api/work/issues?path=${encodeURIComponent(path)}`),
  dispatchWork: (projectPath, issueIds) =>
    request('/api/work', { method: 'POST', body: JSON.stringify({ projectPath, issueIds }) }),
  stages: () => request('/api/stages'),
  quota: () => request('/api/quota'),

  // Cockpit surfaces (INT-3402). `optional` so an older daemon degrades to a
  // reduced cockpit instead of an error screen.
  workSessions: (limit) => optional(request(`/api/work/sessions${limit ? `?limit=${limit}` : ''}`)),
  sessionLog: (taskId) => optional(request(`/api/work/sessions/${encodeURIComponent(taskId)}/log`)),
  workDiff: (taskId) => optional(request(`/api/work/diff?taskId=${encodeURIComponent(taskId)}`)),
  projects: () => request('/api/projects'),
  cancelTask: (taskId) => request(`/api/processes/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),
};
