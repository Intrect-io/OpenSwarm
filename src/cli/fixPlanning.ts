// ============================================
// OpenSwarm - repository-aware fix planning
// ============================================

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ReviewResult } from '../agents/agentPair.js';
import type { TrustedVerifyPlan } from '../agents/deterministicTester.js';
import { scanProject, toProjectSlug } from '../knowledge/index.js';
import { recallRepoKnowledge, repoKey, type RepoMemoryBrief } from '../memory/repoKnowledge.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { resolveSharedPaths, unsharedGitignoredPaths } from '../support/sharedPathDetection.js';

export interface FixDependencyMapEntry {
  imports: string[];
  dependents: string[];
  tests: string[];
}

export interface FixRepositoryContext {
  canonicalRoot: string;
  packageManager?: string;
  workspaces: string[];
  manifests: string[];
  verificationCommands: string[];
  sharedPaths: string[];
  missingGitignoredPaths: string[];
  repoMemories: RepoMemoryBrief[];
  dependencyGraphAvailable: boolean;
  dependencyMap: Record<string, FixDependencyMapEntry>;
  preflight: { ready: boolean; issues: string[] };
}

export interface FixPlanningTarget {
  area: { label: string; dir: string; files: string[] };
  review: ReviewResult;
}

export interface FixUnit {
  label: string;
  targetLabels: string[];
  targets: FixPlanningTarget[];
  primaryFiles: string[];
  dependencyFiles: string[];
  testFiles: string[];
  manifestFiles: string[];
  /** True only when every primary file was covered by a fresh dependency graph. */
  dependencyGraphBacked: boolean;
  /** Exact files or directories the worker may change. */
  allowedPaths: string[];
}

interface PackageManifest {
  packageManager?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
}

type ManifestFamily = 'node' | 'python' | 'rust' | 'go';

const ROOT_MANIFEST_NAMES = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock',
  'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb',
  'pyproject.toml', 'requirements.txt', 'uv.lock', 'poetry.lock', 'Pipfile', 'Pipfile.lock',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'go.work', 'go.work.sum',
] as const;

function manifestFamily(path: string): ManifestFamily | undefined {
  const name = basename(path);
  if (name === 'package.json' || name === 'pnpm-lock.yaml' || name === 'pnpm-workspace.yaml'
    || name === 'yarn.lock' || name === 'package-lock.json' || name === 'npm-shrinkwrap.json'
    || name === 'bun.lock' || name === 'bun.lockb') return 'node';
  if (name === 'pyproject.toml' || /^requirements(?:[-_.].*)?\.txt$/i.test(name)
    || name === 'uv.lock' || name === 'poetry.lock' || name === 'Pipfile' || name === 'Pipfile.lock') return 'python';
  if (name === 'Cargo.toml' || name === 'Cargo.lock') return 'rust';
  if (name === 'go.mod' || name === 'go.sum' || name === 'go.work' || name === 'go.work.sum') return 'go';
  return undefined;
}

function sourceFamily(path: string): ManifestFamily | undefined {
  const extension = extname(path).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'node';
  if (extension === '.py' || extension === '.pyw') return 'python';
  if (extension === '.rs') return 'rust';
  if (extension === '.go') return 'go';
  return undefined;
}

function trackedManifestFiles(projectPath: string): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: projectPath,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter((path) => path && manifestFamily(path));
  } catch {
    return [];
  }
}

function readPackageManifest(projectPath: string): PackageManifest | null {
  try {
    return JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')) as PackageManifest;
  } catch {
    return null;
  }
}

function stringRecordSize(value: unknown): number {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).length
    : 0;
}

function detectPackageManager(projectPath: string, pkg: PackageManifest | null): string | undefined {
  if (typeof pkg?.packageManager === 'string' && pkg.packageManager.trim()) {
    return pkg.packageManager.split('@')[0];
  }
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(projectPath, 'bun.lock')) || existsSync(join(projectPath, 'bun.lockb'))) return 'bun';
  if (existsSync(join(projectPath, 'package-lock.json')) || pkg) return 'npm';
  return undefined;
}

function readWorkspaces(pkg: PackageManifest | null): string[] {
  const value = pkg?.workspaces;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (value && typeof value === 'object' && Array.isArray((value as { packages?: unknown }).packages)) {
    return (value as { packages: unknown[] }).packages.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function toRelative(projectPath: string, path: string): string {
  const rel = relative(resolve(projectPath), resolve(path));
  return rel || '.';
}

/** Build the repository capsule once, before any fix worker can mutate trusted inputs. */
export async function buildFixRepositoryContext(
  projectPath: string,
  plan: TrustedVerifyPlan | undefined,
  taskText: string,
): Promise<FixRepositoryContext> {
  const canonicalRoot = repoKey(projectPath);
  const pkg = readPackageManifest(projectPath);
  const packageManager = detectPackageManager(projectPath, pkg);
  const workspaces = readWorkspaces(pkg);
  const manifests = new Set<string>();
  for (const name of ROOT_MANIFEST_NAMES) if (existsSync(join(projectPath, name))) manifests.add(name);
  for (const path of trackedManifestFiles(projectPath)) manifests.add(path);
  for (const directory of Object.keys(plan?.packageJsonByDirectory ?? {})) {
    manifests.add(directory ? join(directory, 'package.json') : 'package.json');
  }

  let metadata = null;
  try { metadata = await loadRepoMetadata(canonicalRoot); } catch { metadata = null; }
  const sharedPaths = resolveSharedPaths(canonicalRoot, metadata);

  const issues: string[] = [];
  const declaredNodeDependencies = stringRecordSize(pkg?.dependencies)
    + stringRecordSize(pkg?.devDependencies)
    + stringRecordSize(pkg?.optionalDependencies);
  const nodeRuntimeReady = !pkg || declaredNodeDependencies === 0 || [
    'node_modules', '.pnp.cjs', '.pnp.loader.mjs',
  ].some((name) => existsSync(join(projectPath, name)));
  if (!nodeRuntimeReady) {
    issues.push(
      `package.json declares ${declaredNodeDependencies} dependency entries, but this worktree has no node_modules or Yarn PnP runtime. ` +
      `Install with ${packageManager ?? 'the repository package manager'} in the original repository or expose it through sandbox.sharedPaths.`,
    );
  }

  const dependencyMap: Record<string, FixDependencyMapEntry> = {};
  let dependencyGraphAvailable = false;
  try {
    // Fix planning must describe the exact audit worktree, not a possibly stale
    // graph persisted for another branch or an older canonical checkout.
    const graph = await scanProject(projectPath, toProjectSlug(canonicalRoot));
    for (const node of graph.getAllNodes()) {
      if (node.type !== 'module' && node.type !== 'test_file') continue;
      dependencyMap[node.id] = {
        imports: graph.getImports(node.id).map((item) => item.id),
        dependents: graph.getDependents(node.id).map((item) => item.id),
        tests: graph.getTests(node.id).map((item) => item.id),
      };
    }
    dependencyGraphAvailable = Object.keys(dependencyMap).length > 0;
  } catch {
    dependencyGraphAvailable = false;
  }

  const repoMemories = await recallRepoKnowledge(
    projectPath,
    'Apply repository-wide review fixes',
    taskText,
  );

  return {
    canonicalRoot,
    packageManager,
    workspaces,
    manifests: [...manifests].sort(),
    verificationCommands: (plan?.commands ?? []).map((command) =>
      `${command.cwd ? `(${command.cwd}) ` : ''}${command.run}`),
    sharedPaths: sharedPaths.map((path) => toRelative(canonicalRoot, join(canonicalRoot, path))),
    missingGitignoredPaths: unsharedGitignoredPaths(canonicalRoot, sharedPaths),
    repoMemories,
    dependencyGraphAvailable,
    dependencyMap,
    preflight: { ready: issues.length === 0, issues },
  };
}

class DisjointSet {
  private readonly parent: number[];
  constructor(size: number) { this.parent = Array.from({ length: size }, (_, index) => index); }
  find(value: number): number {
    const parent = this.parent[value];
    if (parent !== value) this.parent[value] = this.find(parent);
    return this.parent[value];
  }
  union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent[b] = a;
  }
}

function relevantManifests(files: string[], manifests: string[]): string[] {
  const selected = new Set<string>();
  for (const file of files) {
    const family = sourceFamily(file);
    const candidates = manifests.filter((manifest) => {
      const directory = dirname(manifest);
      const ancestor = directory === '.' || file === directory || file.startsWith(`${directory}/`);
      return ancestor && (!family || manifestFamily(manifest) === family);
    });
    // A nested package manifest and its workspace-root lock/config files are one
    // dependency contract. Include every ancestor manifest in the same ecosystem,
    // rather than arbitrarily selecting one filename from the nearest directory.
    for (const manifest of candidates) selected.add(manifest);
  }
  return [...selected];
}

function scopedDirectory(directory: string, files: string[]): string[] {
  return directory === '.' ? files : [directory];
}

function dependencyClosure(
  files: Iterable<string>,
  dependencyMap: Record<string, FixDependencyMapEntry>,
): { related: Set<string>; tests: Set<string> } {
  const related = new Set(files);
  const tests = new Set<string>();
  const queue = [...related];
  for (let index = 0; index < queue.length; index++) {
    const entry = dependencyMap[queue[index]];
    if (!entry) continue;
    for (const test of entry.tests) tests.add(test);
    for (const neighbor of [...entry.imports, ...entry.dependents, ...entry.tests]) {
      if (related.has(neighbor)) continue;
      related.add(neighbor);
      queue.push(neighbor);
    }
  }
  return { related, tests };
}

function buildFixUnit(
  members: FixPlanningTarget[],
  context: FixRepositoryContext,
  dependencyGraphBacked: boolean,
): FixUnit {
  const primary = new Set(members.flatMap((member) => member.area.files));
  const dependencies = new Set<string>();
  const tests = new Set<string>();
  if (dependencyGraphBacked) {
    const closure = dependencyClosure(primary, context.dependencyMap);
    for (const test of closure.tests) if (!primary.has(test)) tests.add(test);
    for (const related of closure.related) {
      if (!primary.has(related) && !tests.has(related)) dependencies.add(related);
    }
  }
  const manifestFiles = relevantManifests([...primary, ...dependencies], context.manifests);
  const allowed = dependencyGraphBacked
    ? new Set<string>([
        ...members.flatMap((member) => scopedDirectory(member.area.dir, member.area.files)),
        ...dependencies,
        ...[...tests].flatMap((file) => scopedDirectory(dirname(file), [file])),
        ...manifestFiles,
      ])
    // No/partial graph means independence and closure are unproven. Use one
    // repository-wide sandbox worker instead of several falsely isolated workers.
    : new Set<string>(['.']);
  const labels = members.map((member) => member.area.label);
  return {
    label: labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1} related`,
    targetLabels: labels,
    targets: members,
    primaryFiles: [...primary].sort(),
    dependencyFiles: [...dependencies].sort(),
    testFiles: [...tests].sort(),
    manifestFiles: manifestFiles.sort(),
    dependencyGraphBacked,
    allowedPaths: [...allowed].filter(Boolean).sort(),
  };
}

/** Merge related audit areas into fix units; independent components may run in parallel. */
export function planFixUnits(targets: FixPlanningTarget[], context: FixRepositoryContext): FixUnit[] {
  if (targets.length === 0) return [];
  const graphCoversTargets = context.dependencyGraphAvailable && targets.every((target) =>
    target.area.files.every((file) => context.dependencyMap[file] !== undefined));
  if (!graphCoversTargets) return [buildFixUnit(targets, context, false)];

  const sets = new DisjointSet(targets.length);
  const closures = targets.map((target) =>
    dependencyClosure(target.area.files, context.dependencyMap).related);

  targets.forEach((target, index) => {
    targets.forEach((other, otherIndex) => {
      if (index >= otherIndex) return;
      const sameDirectory = target.area.dir === other.area.dir;
      const connected = [...closures[index]].some((file) => closures[otherIndex].has(file));
      if (sameDirectory || connected) sets.union(index, otherIndex);
    });
  });

  const components = new Map<number, FixPlanningTarget[]>();
  targets.forEach((target, index) => {
    const root = sets.find(index);
    const list = components.get(root) ?? [];
    list.push(target);
    components.set(root, list);
  });

  return [...components.values()].map((members) => buildFixUnit(members, context, true));
}

export function workerContextForFixUnit(unit: FixUnit, context: FixRepositoryContext) {
  const affected = unit.primaryFiles.length + unit.dependencyFiles.length;
  return {
    impactAnalysis: {
      directModules: unit.primaryFiles,
      dependentModules: unit.dependencyFiles,
      testFiles: unit.testFiles,
      estimatedScope: (affected <= 2 ? 'small' : affected <= 8 ? 'medium' : 'large') as 'small' | 'medium' | 'large',
    },
    repoMemories: context.repoMemories,
    repository: {
      packageManager: context.packageManager,
      workspaces: context.workspaces,
      manifests: context.manifests,
      verificationCommands: context.verificationCommands,
      sharedPaths: context.sharedPaths,
      missingGitignoredPaths: context.missingGitignoredPaths,
      dependencyGraphAvailable: unit.dependencyGraphBacked,
    },
  };
}

/** Keep path checks platform-safe and reject sibling-prefix tricks. */
export function pathWithinScope(file: string, allowedPaths: string[]): boolean {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)
    || normalized.split('/').includes('..')) return false;
  return allowedPaths.some((allowed) => {
    const scope = allowed.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (scope === '.') return true;
    return normalized === scope || normalized.startsWith(`${scope}/`);
  });
}
