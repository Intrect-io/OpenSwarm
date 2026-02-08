// ============================================
// Claude Swarm - Project Mapper
// Linear 프로젝트 ↔ 로컬 경로 자동 매핑
// ============================================

import { readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';

// ============================================
// Types
// ============================================

export interface ProjectMapping {
  linearProjectId: string;
  linearProjectName: string;
  localPath: string;
  confidence: number; // 0-1, 매칭 신뢰도
  lastVerified: number;
}

export interface LocalProject {
  name: string;
  path: string;
  hasGit: boolean;
  hasPackageJson: boolean;
  hasPyproject: boolean;
}

// ============================================
// State
// ============================================

const mappingCache: Map<string, ProjectMapping> = new Map();
const localProjectsCache: LocalProject[] = [];
let lastScanTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5분

// ============================================
// Local Project Discovery
// ============================================

/**
 * 로컬 프로젝트 디렉토리 스캔
 */
export async function scanLocalProjects(basePaths: string[]): Promise<LocalProject[]> {
  const now = Date.now();

  // 캐시 유효하면 반환
  if (localProjectsCache.length > 0 && now - lastScanTime < CACHE_TTL) {
    return localProjectsCache;
  }

  const projects: LocalProject[] = [];

  for (const basePath of basePaths) {
    const expandedPath = expandPath(basePath);

    try {
      const entries = await readdir(expandedPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // 숨김 디렉토리 제외

        const projectPath = join(expandedPath, entry.name);
        const project = await analyzeProject(projectPath);

        if (project) {
          projects.push(project);
        }

        // 1단계 하위 디렉토리도 검색 (~/dev/tools/pykis 같은 경우)
        try {
          const subEntries = await readdir(projectPath, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory()) continue;
            if (subEntry.name.startsWith('.')) continue;

            const subPath = join(projectPath, subEntry.name);
            const subProject = await analyzeProject(subPath);
            if (subProject) {
              projects.push(subProject);
            }
          }
        } catch {
          // 하위 디렉토리 접근 실패 무시
        }
      }
    } catch (err) {
      console.warn(`[ProjectMapper] Failed to scan ${basePath}:`, err);
    }
  }

  // 캐시 업데이트
  localProjectsCache.length = 0;
  localProjectsCache.push(...projects);
  lastScanTime = now;

  console.log(`[ProjectMapper] Scanned ${projects.length} local projects`);
  return projects;
}

/**
 * 프로젝트 디렉토리 분석
 */
async function analyzeProject(path: string): Promise<LocalProject | null> {
  try {
    const [hasGit, hasPackageJson, hasPyproject] = await Promise.all([
      fileExists(join(path, '.git')),
      fileExists(join(path, 'package.json')),
      fileExists(join(path, 'pyproject.toml')),
    ]);

    // git 또는 패키지 파일이 있어야 프로젝트로 인정
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

// ============================================
// Fuzzy Matching
// ============================================

/**
 * Linear 프로젝트명과 로컬 프로젝트 매칭
 */
export function findBestMatch(
  linearProjectName: string,
  localProjects: LocalProject[]
): { project: LocalProject; confidence: number } | null {
  if (!linearProjectName || localProjects.length === 0) {
    return null;
  }

  const normalizedLinear = normalize(linearProjectName);
  let bestMatch: LocalProject | null = null;
  let bestScore = 0;

  for (const local of localProjects) {
    const normalizedLocal = normalize(local.name);
    const score = calculateSimilarity(normalizedLinear, normalizedLocal);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = local;
    }
  }

  // 최소 신뢰도 0.5 이상이어야 매칭
  if (bestMatch && bestScore >= 0.5) {
    return { project: bestMatch, confidence: bestScore };
  }

  return null;
}

/**
 * 문자열 정규화 (소문자, 특수문자 제거)
 */
function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[-_\s]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * 문자열 유사도 계산 (0-1)
 */
function calculateSimilarity(a: string, b: string): number {
  // 정확히 일치
  if (a === b) return 1.0;

  // 포함 관계
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return 0.7 + (ratio * 0.3);
  }

  // Levenshtein distance 기반 유사도
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;

  const distance = levenshteinDistance(a, b);
  return 1 - (distance / maxLen);
}

/**
 * Levenshtein 거리 계산
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

// ============================================
// Project Mapping
// ============================================

/**
 * Linear 프로젝트 → 로컬 경로 매핑
 */
export async function mapLinearProject(
  linearProjectId: string,
  linearProjectName: string,
  basePaths: string[]
): Promise<string | null> {
  // 캐시 확인
  const cached = mappingCache.get(linearProjectId);
  if (cached && Date.now() - cached.lastVerified < CACHE_TTL) {
    console.log(`[ProjectMapper] Cache hit: ${linearProjectName} → ${cached.localPath}`);
    return cached.localPath;
  }

  // 로컬 프로젝트 스캔
  const localProjects = await scanLocalProjects(basePaths);

  // 매칭 시도
  const match = findBestMatch(linearProjectName, localProjects);

  if (match) {
    // 캐시 저장
    const mapping: ProjectMapping = {
      linearProjectId,
      linearProjectName,
      localPath: match.project.path,
      confidence: match.confidence,
      lastVerified: Date.now(),
    };
    mappingCache.set(linearProjectId, mapping);

    console.log(`[ProjectMapper] Mapped: ${linearProjectName} → ${match.project.path} (confidence: ${(match.confidence * 100).toFixed(0)}%)`);
    return match.project.path;
  }

  console.warn(`[ProjectMapper] No match found for: ${linearProjectName}`);
  return null;
}

/**
 * 모든 매핑 조회
 */
export function getAllMappings(): ProjectMapping[] {
  return Array.from(mappingCache.values());
}

/**
 * 매핑 캐시 초기화
 */
export function clearMappingCache(): void {
  mappingCache.clear();
  localProjectsCache.length = 0;
  lastScanTime = 0;
}

// ============================================
// Utilities
// ============================================

function expandPath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Debug / Status
// ============================================

/**
 * 프로젝트 매퍼 상태 출력
 */
export function getMapperStatus(): string {
  const mappings = getAllMappings();
  const lines = [
    `[ProjectMapper] Status:`,
    `  - Cached mappings: ${mappings.length}`,
    `  - Local projects: ${localProjectsCache.length}`,
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
