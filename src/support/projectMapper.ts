// ============================================
// OpenSwarm - Project Mapper
// Linear project to local path auto-mapping
// ============================================

import { readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { expandPath } from '../core/config.js';
import { loadRepoMetadata, RepoMetadataError } from './repoMetadata.js';

// Types

export interface ProjectMapping {
  linearProjectId: string;
  linearProjectName: string;
  localPath: string;
  confidence: number; // 0-1, matching confidence
  lastVerified: number;
}

export interface LocalProject {
  name: string;
  path: string;
  hasGit: boolean;
  hasPackageJson: boolean;
  hasPyproject: boolean;
}

// State

const mappingCache: Map<string, ProjectMapping> = new Map();
const localProjectsCache = new Map<string, { projects: LocalProject[]; lastScanTime: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
/** Entry caps: each distinct project ID x base-path set adds a key, so neither map may grow without bound. */
export const MAX_MAPPING_CACHE_ENTRIES = 256;
export const MAX_LOCAL_PROJECTS_CACHE_ENTRIES = 32;

/**
 * Insert into a bounded TTL cache. Expired entries are evicted first, then the
 * least recently used ones (Map keeps insertion order; re-setting a key, as a
 * cache hit does, moves it to the end) until the map is within `maxEntries`.
 */
function setBounded<V>(
  cache: Map<string, V>,
  key: string,
  value: V,
  maxEntries: number,
  stampOf: (v: V) => number,
  now: number = Date.now(),
): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size <= maxEntries) return;
  for (const [k, v] of cache) {
    if (now - stampOf(v) >= CACHE_TTL) cache.delete(k);
  }
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function setMapping(key: string, mapping: ProjectMapping): void {
  setBounded(mappingCache, key, mapping, MAX_MAPPING_CACHE_ENTRIES, (m) => m.lastVerified);
}

/** Current entry counts, for tests and diagnostics. */
export function getMappingCacheSizes(): { mappings: number; localProjects: number } {
  return { mappings: mappingCache.size, localProjects: localProjectsCache.size };
}

function basePathsCacheKey(basePaths: string[]): string {
  return basePaths.map((p) => expandPath(p)).sort().join('\n');
}

function mappingCacheKey(linearProjectId: string, basePaths: string[]): string {
  return `${linearProjectId}\n${basePathsCacheKey(basePaths)}`;
}

// Local Project Discovery

/**
 * Scan local project directories
 */
export async function scanLocalProjects(basePaths: string[]): Promise<LocalProject[]> {
  const now = Date.now();
  const cacheKey = basePathsCacheKey(basePaths);
  const cached = localProjectsCache.get(cacheKey);

  // Return if cache is valid
  if (cached && now - cached.lastScanTime < CACHE_TTL) {
    return cached.projects;
  }

  const projects: LocalProject[] = [];

  for (const basePath of basePaths) {
    const expandedPath = expandPath(basePath);

    try {
      const entries = await readdir(expandedPath, { withFileTypes: true });

      const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv', '.tox', 'coverage', '.next', '.turbo']);

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // Exclude hidden directories
        if (SKIP_DIRS.has(entry.name)) continue; // Exclude known non-project dirs

        const projectPath = join(expandedPath, entry.name);
        const project = await analyzeProject(projectPath);

        if (project) {
          projects.push(project);
        }

        // Also search one level of subdirectories (e.g., ~/dev/tools/pykis)
        try {
          const subEntries = await readdir(projectPath, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory()) continue;
            if (subEntry.name.startsWith('.')) continue;
            if (SKIP_DIRS.has(subEntry.name)) continue;

            const subPath = join(projectPath, subEntry.name);
            const subProject = await analyzeProject(subPath);
            if (subProject) {
              projects.push(subProject);
            }
          }
        } catch {
          // Ignore subdirectory access failure
        }
      }
    } catch (err) {
      console.warn(`[ProjectMapper] Failed to scan ${basePath}:`, err);
    }
  }

  setBounded(
    localProjectsCache,
    cacheKey,
    { projects, lastScanTime: now },
    MAX_LOCAL_PROJECTS_CACHE_ENTRIES,
    (entry) => entry.lastScanTime,
    now,
  );

  console.log(`[ProjectMapper] Scanned ${projects.length} local projects`);
  return projects;
}

/**
 * Analyze project directory
 */
async function analyzeProject(path: string): Promise<LocalProject | null> {
  try {
    const [hasGit, hasPackageJson, hasPyproject] = await Promise.all([
      fileExists(join(path, '.git')),
      fileExists(join(path, 'package.json')),
      fileExists(join(path, 'pyproject.toml')),
    ]);

    // Must have git or package file to be considered a project
    if (!hasGit && !hasPackageJson && !hasPyproject) {
      return null;
    }

    return {
      name: basename(path),
      path,
      hasGit,
      hasPackageJson,
      hasPyproject,
    };
  } catch {
    return null;
  }
}

// Fuzzy Matching

/**
 * Match Linear project name to local project
 */
export function findBestMatch(
  linearProjectName: string,
  localProjects: LocalProject[]
): { project: LocalProject; confidence: number } | null {
  if (!linearProjectName || localProjects.length === 0) {
    return null;
  }

  const normalizedLinear = normalize(linearProjectName);
  if (!normalizedLinear) {
    return null;
  }
  let bestMatch: LocalProject | null = null;
  let bestScore = 0;

  for (const local of localProjects) {
    const normalizedLocal = normalize(local.name);
    if (!normalizedLocal) continue;
    const score = calculateSimilarity(normalizedLinear, normalizedLocal);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = local;
    }
  }

  // Minimum confidence of 0.5 required for matching
  if (bestMatch && bestScore >= 0.5) {
    return { project: bestMatch, confidence: bestScore };
  }

  return null;
}

/**
 * Normalize string (lowercase, remove special characters)
 */
function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[-_\s]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Calculate string similarity (0-1)
 */
function calculateSimilarity(a: string, b: string): number {
  // Exact match
  if (a === b) return 1.0;

  // Containment relationship
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return 0.7 + (ratio * 0.3);
  }

  // Levenshtein distance-based similarity
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;

  const distance = levenshteinDistance(a, b);
  return 1 - (distance / maxLen);
}

/**
 * Calculate Levenshtein distance
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

// Project Mapping

/**
 * Map Linear project to local path
 */
export async function mapLinearProject(
  linearProjectId: string,
  linearProjectName: string,
  basePaths: string[]
): Promise<string | null> {
  // Check cache
  const cacheKey = mappingCacheKey(linearProjectId, basePaths);
  const cached = mappingCache.get(cacheKey);
  if (cached && Date.now() - cached.lastVerified < CACHE_TTL) {
    // LRU: a hit moves the key to the newest end so eviction takes the least
    // recently used mapping. lastVerified is left alone: reads must not extend the TTL.
    mappingCache.delete(cacheKey);
    mappingCache.set(cacheKey, cached);
    console.log(`[ProjectMapper] Cache hit: ${linearProjectName} → ${cached.localPath}`);
    return cached.localPath;
  }
  if (cached) mappingCache.delete(cacheKey);

  // Scan local projects
  const localProjects = await scanLocalProjects(basePaths);

  // 1) Explicit mapping via openswarm.json wins over any fuzzy match.
  //    Walk every local project, read its openswarm.json (if present), and
  //    pick the one whose linear.projectId matches.
  for (const project of localProjects) {
    let meta;
    try {
      meta = await loadRepoMetadata(project.path);
    } catch (err) {
      if (err instanceof RepoMetadataError) {
        console.warn(`[ProjectMapper] ${err.message}`);
      }
      continue;
    }
    if (meta?.linear?.projectId === linearProjectId) {
      const mapping: ProjectMapping = {
        linearProjectId,
        linearProjectName,
        localPath: project.path,
        confidence: 1,
        lastVerified: Date.now(),
      };
      setMapping(cacheKey, mapping);
      console.log(
        `[ProjectMapper] Explicit mapping: ${linearProjectName} → ${project.path} (openswarm.json)`,
      );
      return project.path;
    }
  }

  // 2) Fall back to fuzzy name matching for repos without metadata.
  const match = findBestMatch(linearProjectName, localProjects);

  if (match) {
    // Save to cache
    const mapping: ProjectMapping = {
      linearProjectId,
      linearProjectName,
      localPath: match.project.path,
      confidence: match.confidence,
      lastVerified: Date.now(),
    };
    setMapping(cacheKey, mapping);

    console.log(`[ProjectMapper] Mapped: ${linearProjectName} → ${match.project.path} (confidence: ${(match.confidence * 100).toFixed(0)}%)`);
    return match.project.path;
  }

  console.warn(`[ProjectMapper] No match found for: ${linearProjectName}`);
  return null;
}

/**
 * Get all mappings
 */
export function getAllMappings(): ProjectMapping[] {
  return Array.from(mappingCache.values());
}

/**
 * Clear mapping cache
 */
export function clearMappingCache(): void {
  mappingCache.clear();
  localProjectsCache.clear();
}

/**
 * Invalidate the local projects cache and the mappings derived from it (force
 * a re-scan on the next call). A mapping cached before a scan path was added or
 * removed could otherwise keep pointing at a stale or removed directory.
 */
export function invalidateProjectCache(): void {
  localProjectsCache.clear();
  mappingCache.clear();
}

// Utilities

// expandPath imported from core/config.ts (deduplicated)

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Debug / Status

/**
 * Get project mapper status
 */
export function getMapperStatus(): string {
  const mappings = getAllMappings();
  const localProjectCount = [...localProjectsCache.values()].reduce((sum, entry) => sum + entry.projects.length, 0);
  const lastScanTime = Math.max(0, ...[...localProjectsCache.values()].map((entry) => entry.lastScanTime));
  const lines = [
    `[ProjectMapper] Status:`,
    `  - Cached mappings: ${mappings.length}`,
    `  - Local projects: ${localProjectCount}`,
    `  - Last scan: ${lastScanTime ? new Date(lastScanTime).toISOString() : 'never'}`,
  ];

  if (mappings.length > 0) {
    lines.push('  - Mappings:');
    for (const m of mappings) {
      lines.push(`    ${m.linearProjectName} → ${m.localPath} (${(m.confidence * 100).toFixed(0)}%)`);
    }
  }

  return lines.join('\n');
}
