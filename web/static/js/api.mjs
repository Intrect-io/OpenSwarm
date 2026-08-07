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
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
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

export const api = {
  health: () => request('/api/health'),
  localProjects: () => request('/api/local-projects'),
  projects: () => request('/api/projects'),
  workIssues: (path) => request(`/api/work/issues?path=${encodeURIComponent(path)}`),
  dispatchWork: (projectPath, issueIds) =>
    request('/api/work', { method: 'POST', body: JSON.stringify({ projectPath, issueIds }) }),
  stages: () => request('/api/stages'),
};
