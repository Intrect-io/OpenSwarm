/**
 * GitHub repository discovery and cloning for the web dashboard (AGT-4005).
 *
 * Serves GET /api/github/repos and POST /api/repos/clone. Split out of web.ts
 * so the route table stays under its size cap.
 *
 * Credential rule: GH_TOKEN reaches git only through the child environment,
 * read at runtime by an inline credential helper. It never appears in argv,
 * in a clone URL, in .git/config or in an error message.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { readBody } from './httpBody.js';
import { writeJson } from './webAuth.js';

export const GIT_CLONE_TIMEOUT_MS = 10 * 60_000;
const GIT_REMOTE_TIMEOUT_MS = 10_000;
export const GITHUB_REPO_CACHE_TTL_MS = 60_000;
export const GITHUB_REPO_MAX_PAGES = 10;
const GITHUB_API_ORIGIN = 'https://api.github.com/';
const FIRST_PAGE_URL = 'https://api.github.com/user/repos?per_page=100&sort=updated';
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const STATE_CONCURRENCY = 8;

/**
 * Credential helper body. `$GH_TOKEN` is expanded by the helper's shell at
 * run time, so the literal token is never written anywhere git can persist it.
 */
export const GIT_TOKEN_HELPER = '!f() { if [ "$1" = get ]; then echo username=x-access-token; echo "password=$GH_TOKEN"; fi; }; f';

/** One destination policy for GitHub discovery and cloning. */
export function getWorkspaceRoot(): string {
  const configured = process.env.OPENSWARM_WORKSPACE_ROOT?.trim();
  if (configured) return resolvePath(configured);
  if (existsSync('/work')) return resolvePath('/work');
  return resolvePath(homedir(), 'dev');
}

export function getCloneDestination(fullName: string): string | null {
  const root = getWorkspaceRoot();
  const destination = resolvePath(root, fullName.split('/')[1]!);
  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  return destination !== root && destination.startsWith(rootPrefix) ? destination : null;
}

/**
 * Environment for every git child: never prompt on the daemon's terminal, and
 * when a token is configured, hand it to git through an env-scoped helper.
 */
export function gitEnv(token: string | undefined = process.env.GH_TOKEN?.trim()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (token) {
    env.GH_TOKEN = token;
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper';
    env.GIT_CONFIG_VALUE_0 = GIT_TOKEN_HELPER;
  }
  return env;
}

export class GitCloneError extends Error {
  constructor(readonly timedOut: boolean) {
    super(timedOut ? `Git clone timed out after ${GIT_CLONE_TIMEOUT_MS / 60_000} minutes` : 'Git clone failed');
    this.name = 'GitCloneError';
  }
}

export function runGitClone(fullName: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['clone', '--', `https://github.com/${fullName}.git`, destination],
      { timeout: GIT_CLONE_TIMEOUT_MS, env: gitEnv() },
      (error) => {
        if (!error) { resolve(); return; }
        const killed = (error as { killed?: boolean }).killed === true
          || (error as { signal?: unknown }).signal === 'SIGTERM';
        reject(new GitCloneError(killed));
      },
    );
  });
}

/** True when a remote URL names github.com/<fullName> (https or ssh, optional .git). */
export function remoteMatchesRepo(remoteUrl: string, fullName: string): boolean {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/i
    .exec(remoteUrl.trim());
  return match !== null && match[1]!.toLowerCase() === fullName.toLowerCase();
}

function readOriginUrl(directory: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', directory, 'remote', 'get-url', 'origin'],
      { timeout: GIT_REMOTE_TIMEOUT_MS, env: gitEnv('') },
      (error, stdout) => resolve(error || typeof stdout !== 'string' ? null : stdout.trim()),
    );
  });
}

export interface CloneState {
  destination: string | null;
  /** The destination holds this repository. */
  cloned: boolean;
  /** The destination exists but holds something else (another owner's repo, or no git). */
  nameTaken: boolean;
}

export async function getCloneState(fullName: string): Promise<CloneState> {
  const destination = getCloneDestination(fullName);
  if (destination === null || !existsSync(destination)) return { destination, cloned: false, nameTaken: false };
  const origin = await readOriginUrl(destination);
  const cloned = origin !== null && remoteMatchesRepo(origin, fullName);
  return { destination, cloned, nameTaken: !cloned };
}

export interface GithubRepoMeta {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

class GithubListError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    // Follow only GitHub's API origin: the bearer token goes wherever this points.
    if (match && match[1]!.startsWith(GITHUB_API_ORIGIN)) return match[1]!;
  }
  return null;
}

function normalizeRepo(repo: unknown): GithubRepoMeta {
  if (!repo || typeof repo !== 'object') throw new GithubListError(502, 'Invalid GitHub repository response');
  const data = repo as Record<string, unknown>;
  // Validate every emitted field: a partial upstream response is not safe to normalize.
  if (typeof data.full_name !== 'string' || !REPO_NAME.test(data.full_name)
    || typeof data.private !== 'boolean' || typeof data.default_branch !== 'string'
    || typeof data.updated_at !== 'string') {
    throw new GithubListError(502, 'Invalid GitHub repository response');
  }
  return { fullName: data.full_name, private: data.private, defaultBranch: data.default_branch, updatedAt: data.updated_at };
}

async function fetchAllRepos(token: string): Promise<GithubRepoMeta[]> {
  const repos: GithubRepoMeta[] = [];
  let url: string | null = FIRST_PAGE_URL;
  for (let page = 0; url && page < GITHUB_REPO_MAX_PAGES; page += 1) {
    const upstream: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!upstream.ok) {
      throw new GithubListError(upstream.status === 401 || upstream.status === 403 ? 502 : 503, 'GitHub repository request failed');
    }
    const body: unknown = await upstream.json();
    if (!Array.isArray(body)) throw new GithubListError(502, 'Invalid GitHub repository response');
    for (const repo of body) repos.push(normalizeRepo(repo));
    url = nextPageUrl(upstream.headers.get('link'));
  }
  return repos;
}

/** Full repository list per token (hashed), shared by concurrent requests, kept 60 s. */
const repoCache = new Map<string, { at: number; repos: Promise<GithubRepoMeta[]> }>();

export function resetGithubRepoCache(): void {
  repoCache.clear();
}

export function listGithubRepos(token: string, now: number = Date.now()): Promise<GithubRepoMeta[]> {
  for (const [key, entry] of repoCache) if (now - entry.at >= GITHUB_REPO_CACHE_TTL_MS) repoCache.delete(key);
  const key = createHash('sha256').update(token).digest('hex');
  const cached = repoCache.get(key);
  if (cached) return cached.repos;
  const repos = fetchAllRepos(token);
  const entry = { at: now, repos };
  repoCache.set(key, entry);
  // Never cache a failure: the next keystroke retries.
  repos.catch(() => { if (repoCache.get(key) === entry) repoCache.delete(key); });
  return repos;
}

async function withCloneState(repos: GithubRepoMeta[]): Promise<Array<GithubRepoMeta & { cloned: boolean; nameTaken: boolean }>> {
  const out: Array<GithubRepoMeta & { cloned: boolean; nameTaken: boolean }> = [];
  for (let i = 0; i < repos.length; i += STATE_CONCURRENCY) {
    const batch = repos.slice(i, i + STATE_CONCURRENCY);
    const states = await Promise.all(batch.map((repo) => getCloneState(repo.fullName)));
    batch.forEach((repo, j) => out.push({ ...repo, cloned: states[j]!.cloned, nameTaken: states[j]!.nameTaken }));
  }
  return out;
}

/** GET /api/github/repos?q= */
export async function handleGithubReposRoute(searchParams: URLSearchParams, res: ServerResponse): Promise<void> {
  const token = process.env.GH_TOKEN?.trim();
  if (!token) { writeJson(res, 503, { error: 'GH_TOKEN not configured' }); return; }
  try {
    const repos = await listGithubRepos(token);
    const query = searchParams.get('q')?.toLowerCase() ?? null;
    const filtered = query === null ? repos : repos.filter((repo) => repo.fullName.toLowerCase().includes(query));
    // Clone state is per request: a fresh clone must not read as missing for the cache TTL.
    writeJson(res, 200, await withCloneState(filtered));
  } catch (error) {
    if (error instanceof GithubListError) writeJson(res, error.status, { error: error.message });
    else writeJson(res, 502, { error: 'GitHub repository request failed' });
  }
}

/** POST /api/repos/clone { fullName } */
export async function handleRepoCloneRoute(
  req: IncomingMessage,
  res: ServerResponse,
  register: (destination: string) => void,
): Promise<void> {
  const token = process.env.GH_TOKEN?.trim();
  if (!token) { writeJson(res, 503, { error: 'GH_TOKEN not configured' }); return; }
  let parsed: { fullName?: unknown };
  try {
    parsed = JSON.parse(await readBody(req)) as { fullName?: unknown };
  } catch {
    writeJson(res, 400, { error: 'Invalid JSON' });
    return;
  }
  const fullName = parsed?.fullName;
  const segments = typeof fullName === 'string' ? fullName.split('/') : [];
  if (typeof fullName !== 'string' || !REPO_NAME.test(fullName) || segments.includes('.') || segments.includes('..')) {
    writeJson(res, 400, { error: 'Invalid repository name' });
    return;
  }
  const state = await getCloneState(fullName);
  const destination = state.destination;
  if (!destination) { writeJson(res, 400, { error: 'Invalid repository destination' }); return; }
  if (state.cloned) {
    writeJson(res, 409, { error: `Already cloned at ${destination}`, cloned: true });
    return;
  }
  if (state.nameTaken) {
    writeJson(res, 409, { error: `Name taken: ${destination} already exists and is not ${fullName}`, nameTaken: true });
    return;
  }
  try {
    await runGitClone(fullName, destination);
  } catch (error) {
    if (error instanceof GitCloneError && error.timedOut) writeJson(res, 504, { error: error.message });
    else writeJson(res, 502, { error: 'Git clone failed' });
    return;
  }
  try {
    register(destination);
    writeJson(res, 201, { fullName, destination });
  } catch {
    writeJson(res, 500, { error: 'Repository registration failed' });
  }
}
