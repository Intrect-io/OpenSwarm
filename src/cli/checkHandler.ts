// ============================================
// OpenSwarm - CLI Check Handler
// Created: 2026-04-10
// Purpose: `openswarm check` 명령어 — 코드 레지스트리 조회
// ============================================

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getRegistryStore, closeRegistryStore, LIST_ENTITIES_MAX_LIMIT } from '../registry/sqliteStore.js';
import { scanRepository } from '../registry/entityScanner.js';
import type {
  CodeEntity, EntityStatus, RiskLevel, WarningSeverity, WarningCategory,
} from '../registry/schema.js';
import { c, status } from '../support/colors.js';

/** package.json name → Cargo.toml → go.mod → 폴더명 순으로 프로젝트 ID 추론 */
function resolveProjectId(projectPath: string): string {
  // 1. package.json의 name 필드
  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      if (pkg.name && typeof pkg.name === 'string') {
        return pkg.name.replace(/^@[^/]+\//, '');
      }
    } catch (err) {
      console.warn(`[check] package.json 파싱 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Cargo.toml의 name (Rust)
  const cargoPath = join(projectPath, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    try {
      const cargo = readFileSync(cargoPath, 'utf-8');
      const nameMatch = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (nameMatch) return nameMatch[1];
    } catch (err) {
      console.warn(`[check] Cargo.toml 파싱 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. go.mod의 module path (Go)
  const goModPath = join(projectPath, 'go.mod');
  if (existsSync(goModPath)) {
    try {
      const goMod = readFileSync(goModPath, 'utf-8');
      const modMatch = goMod.match(/^module\s+(\S+)/m);
      if (modMatch) {
        const lastSegment = modMatch[1].split('/').pop();
        if (lastSegment) return lastSegment;
      }
    } catch (err) {
      console.warn(`[check] go.mod 파싱 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. 폴더명 폴백
  return projectPath.split('/').pop() ?? 'unknown';
}

function statusBadge(statusValue: string): string {
  switch (statusValue) {
    case 'active': return `${c.green('●')} active`;
    case 'deprecated': return status.err('deprecated');
    case 'experimental': return `${c.yellow('◎')} experimental`;
    case 'planned': return `${c.blue('○')} planned`;
    case 'broken': return status.warn('broken');
    default: return statusValue;
  }
}

function riskBadge(risk: string): string {
  switch (risk) {
    case 'high': return c.red('HIGH');
    case 'medium': return c.yellow('MED');
    case 'low': return c.green('LOW');
    default: return risk;
  }
}

function severityBadge(sev: string): string {
  switch (sev) {
    case 'critical': return c.red(c.bold('CRITICAL'));
    case 'error': return c.red('ERROR');
    case 'warning': return c.yellow('WARNING');
    case 'info': return c.blue('INFO');
    default: return sev;
  }
}

function formatEntity(e: CodeEntity, verbose = true): string {
  const lines: string[] = [];
  const loc = e.lineStart ? `:${e.lineStart}${e.lineEnd ? `-${e.lineEnd}` : ''}` : '';
  const testIcon = e.hasTests ? status.glyph('ok') : status.glyph('err');

  lines.push(
    `  ${c.bold(e.kind)} ${c.cyan(e.name)}${c.dim(loc)}` +
    `  ${statusBadge(e.status)}  test:${testIcon}  risk:${riskBadge(e.riskLevel)}`
  );

  if (verbose) {
    if (e.signature) lines.push(`    ${c.dim(`sig: ${e.signature}`)}`);
    if (e.author) lines.push(`    ${c.dim(`author: ${e.author}`)}`);
    if (e.description) lines.push(`    ${c.dim(e.description)}`);
    if (e.deprecatedReason) lines.push(`    ${c.red(`reason: ${e.deprecatedReason}`)}`);
    if (e.tags.length > 0) {
      lines.push(`    ${c.magenta(`tags: ${e.tags.map(t => t.value ? `${t.tag}=${t.value}` : t.tag).join(', ')}`)}`);
    }
    for (const w of e.warnings.filter(w => !w.resolved)) {
      lines.push(`    ${severityBadge(w.severity)} [${w.category}] ${w.message}`);
    }
  }

  return lines.join('\n');
}

function formatEntityCompact(e: CodeEntity): string {
  const loc = e.lineStart ? `:${e.lineStart}` : '';
  const testIcon = e.hasTests ? '✓' : '✗';
  return `  ${e.kind.padEnd(9)} ${e.name.padEnd(30)} ${e.filePath}${loc}  ${e.status.padEnd(12)} test:${testIcon}  risk:${e.riskLevel}`;
}

export async function handleCheck(
  filePath: string | undefined,
  opts: {
    stats?: boolean;
    deprecated?: boolean;
    untested?: boolean;
    highRisk?: boolean;
    tag?: string;
    search?: string;
    project?: string;
    scan?: boolean;
    bs?: boolean;
    verbose?: boolean;
    tree?: boolean;
    ci?: boolean;
  },
): Promise<void> {
  try {
    const store = getRegistryStore();

    // --scan: 레포 전체 스캔 → 레지스트리 동기화
    if (opts.scan) {
      const projectPath = process.cwd();
      const projectId = opts.project ?? resolveProjectId(projectPath);

      console.log(`\n${c.bold('Scanning repository...')}`);
      console.log(`  ${c.dim(`path: ${projectPath}`)}`);
      console.log(`  ${c.dim(`project: ${projectId}`)}\n`);

      const result = await scanRepository(projectPath, projectId, {
        verbose: opts.verbose,
      });

      console.log(c.bold('Scan Complete'));
      console.log(`${'─'.repeat(40)}`);
      console.log(`  Files scanned:  ${c.bold(String(result.scanned))}`);
      console.log(`  Entities found: ${c.bold(String(result.extracted))}`);
      console.log(`  New registered: ${c.green(`+${result.registered}`)}`);
      console.log(`  Updated:        ${c.yellow(`~${result.updated}`)}`);
      console.log(`  Marked broken:  ${(result.removed > 0 ? c.red : c.dim)(String(result.removed))}`);
      console.log(`  Tests mapped:   ${c.cyan(String(result.testsMapped))}`);
      console.log(`  Duration:       ${c.dim(`${result.durationMs}ms`)}`);

      if (Object.keys(result.languageBreakdown).length > 0) {
        console.log(`\n  ${c.dim('By language:')}`);
        for (const [lang, count] of Object.entries(result.languageBreakdown).sort((a, b) => b[1] - a[1])) {
          console.log(`    ${lang.padEnd(12)} ${count} files`);
        }
      }

      if (result.errors.length > 0) {
        console.log(`\n  ${c.red(`Errors (${result.errors.length}):`)}`);
        for (const err of result.errors.slice(0, 10)) {
          console.log(`    ${c.dim(err)}`);
        }
        if (result.errors.length > 10) {
          console.log(`    ${c.dim(`...and ${result.errors.length - 10} more`)}`);
        }
      }

      // 스캔 후 통계 표시
      const stats = store.getStats(projectId);
      console.log(`\n${c.bold('Registry Status')}`);
      console.log(`  Total: ${stats.total}  deprecated: ${stats.deprecated}  untested: ${stats.untested}  high-risk: ${stats.highRisk}  warnings: ${stats.withWarnings}\n`);

      return;
    }

    // --bs: BS 패턴 탐지
    if (opts.bs) {
      const { scanRepository: scanBs } = await import('../registry/bsDetector.js');
      const projectPath = process.cwd();

      console.log(`\n${c.bold('BS Detector')} — scanning for bad code patterns...`);
      console.log(`  ${c.dim(`path: ${projectPath}`)}\n`);

      const result = await scanBs(projectPath, { verbose: opts.verbose });

      // 결과 출력
      const statusColor = result.critical > 0 ? c.red : result.warning > 0 ? c.yellow : c.green;
      const statusText = result.critical > 0 ? 'FAIL' : result.warning > 0 ? 'WARN' : 'CLEAN';

      console.log(c.bold('BS Scan Result'));
      console.log(`${'─'.repeat(50)}`);
      console.log(`  Files scanned: ${c.bold(String(result.filesScanned))}`);
      console.log(`  BS Score:      ${statusColor(c.bold(result.bsScore.toFixed(1)))} / 5.0`);
      console.log(`  Status:        ${statusColor(c.bold(statusText))}`);
      console.log(`  CRITICAL:      ${(result.critical > 0 ? c.red : c.green)(String(result.critical))}`);
      console.log(`  WARNING:       ${(result.warning > 0 ? c.yellow : c.green)(String(result.warning))}`);
      console.log(`  MINOR:         ${(result.minor > 0 ? c.dim : c.green)(String(result.minor))}`);

      if (result.issues.length > 0) {
        // CRITICAL 먼저
        const criticals = result.issues.filter(i => i.severity === 'critical');
        if (criticals.length > 0) {
          console.log(`\n  ${c.red(c.bold('CRITICAL (즉시 수정 필요)'))}`);
          for (const issue of criticals) {
            console.log(`    ${c.red(`${issue.filePath}:${issue.line}`)} — ${issue.message}`);
            console.log(`      ${c.dim(issue.matchedText)}`);
          }
        }

        const warnings = result.issues.filter(i => i.severity === 'warning');
        if (warnings.length > 0) {
          console.log(`\n  ${c.yellow('WARNING (권장 수정)')}`);
          for (const issue of warnings.slice(0, 30)) {
            console.log(`    ${c.yellow(`${issue.filePath}:${issue.line}`)} — ${issue.message}`);
          }
          if (warnings.length > 30) {
            console.log(`    ${c.dim(`...and ${warnings.length - 30} more`)}`);
          }
        }

        const minors = result.issues.filter(i => i.severity === 'minor');
        if (minors.length > 0) {
          console.log(`\n  ${c.dim(`MINOR (${minors.length}건)`)}`);
          for (const issue of minors.slice(0, 10)) {
            console.log(`    ${c.dim(`${issue.filePath}:${issue.line} — ${issue.message}`)}`);
          }
          if (minors.length > 10) {
            console.log(`    ${c.dim(`...and ${minors.length - 10} more`)}`);
          }
        }
      }

      console.log();
      return;
    }

    // --tree: directory tree with entity counts and risk indicators
    if (opts.tree) {
      const projectId = opts.project ?? resolveProjectId(process.cwd());
      const scopePath = filePath || '';  // optional dir scope
      const entities: CodeEntity[] = [];
      const pageSize = LIST_ENTITIES_MAX_LIMIT;
      for (let offset = 0; ; offset += pageSize) {
        const page = store.listEntities({ projectId, limit: pageSize, offset });
        entities.push(...page.entities);
        if (
          page.entities.length === 0
          || page.entities.length < pageSize
          || entities.length >= page.total
        ) break;
      }

      // Group entities by directory → file
      const tree = new Map<string, Map<string, { total: number; untested: number; highRisk: number; deprecated: number; kinds: Map<string, number> }>>();

      for (const e of entities) {
        if (scopePath && !e.filePath.startsWith(scopePath)) continue;
        const parts = e.filePath.split('/');
        const fileName = parts.pop()!;
        const dirPath = parts.join('/') || '.';

        if (!tree.has(dirPath)) tree.set(dirPath, new Map());
        const dir = tree.get(dirPath)!;

        if (!dir.has(fileName)) {
          dir.set(fileName, { total: 0, untested: 0, highRisk: 0, deprecated: 0, kinds: new Map() });
        }
        const file = dir.get(fileName)!;
        file.total++;
        if (!e.hasTests) file.untested++;
        if (e.riskLevel === 'high') file.highRisk++;
        if (e.status === 'deprecated') file.deprecated++;
        file.kinds.set(e.kind, (file.kinds.get(e.kind) || 0) + 1);
      }

      // Sort directories
      const sortedDirs = [...tree.keys()].sort();
      const totalFiles = [...tree.values()].reduce((s, d) => s + d.size, 0);
      const totalEntities = entities.filter(e => !scopePath || e.filePath.startsWith(scopePath)).length;

      console.log(`\n${c.bold('Code Tree')}${scopePath ? ` (${scopePath})` : ''} — ${totalFiles} files, ${totalEntities} entities\n`);

      for (const dirPath of sortedDirs) {
        const files = tree.get(dirPath)!;
        const dirTotal = [...files.values()].reduce((s, f) => s + f.total, 0);
        const dirUntested = [...files.values()].reduce((s, f) => s + f.untested, 0);
        const dirHighRisk = [...files.values()].reduce((s, f) => s + f.highRisk, 0);

        // Directory header
        const riskFlag = dirHighRisk > 0 ? ` ${c.red(`${dirHighRisk} high-risk`)}` : '';
        console.log(`${c.bold(`${dirPath}/`)} ${c.dim(`(${dirTotal} entities, ${dirUntested} untested`)}${riskFlag}${c.dim(')')}`);

        // Files in directory
        const sortedFiles = [...files.entries()].sort((a, b) => b[1].total - a[1].total);
        for (const [fileName, info] of sortedFiles) {
          const kindStr = [...info.kinds.entries()].map(([k, n]) => `${n} ${k}`).join(', ');
          const flags: string[] = [];
          if (info.highRisk > 0) flags.push(c.red(`${info.highRisk} high-risk`));
          if (info.deprecated > 0) flags.push(c.red(`${info.deprecated} deprecated`));
          const flagStr = flags.length ? ' ' + flags.join(' ') : '';
          const testPct = info.total > 0 ? Math.round(((info.total - info.untested) / info.total) * 100) : 0;
          const testColor = testPct === 100 ? c.green : testPct > 50 ? c.yellow : c.red;

          console.log(`  ${c.cyan(fileName)} ${c.dim(kindStr)} ${testColor(`${testPct}% tested`)}${flagStr}`);
        }
      }
      console.log();
      return;
    }

    // --ci: CI/CD mode — machine-readable JSON, exit code 1 on critical issues
    if (opts.ci) {
      const projectPath = process.cwd();
      const projectId = opts.project ?? resolveProjectId(projectPath);

      // Run BS scan
      const { scanRepository: scanBs } = await import('../registry/bsDetector.js');
      const bsResult = await scanBs(projectPath, { verbose: false });

      // Registry stats
      const stats = store.getStats(projectId);

      const result = {
        project: projectId,
        path: projectPath,
        registry: {
          total: stats.total,
          deprecated: stats.deprecated,
          untested: stats.untested,
          highRisk: stats.highRisk,
          warnings: stats.withWarnings,
        },
        bs: {
          filesScanned: bsResult.filesScanned,
          score: bsResult.bsScore,
          critical: bsResult.critical,
          warning: bsResult.warning,
          minor: bsResult.minor,
        },
        pass: bsResult.critical === 0,
      };

      console.log(JSON.stringify(result, null, 2));

      // Exit code 1 if critical issues
      if (bsResult.critical > 0) {
        process.exitCode = 1;
      }
      return;
    }

    // --stats: full statistics (기본: 현재 디렉터리 프로젝트 스코프)
    if (opts.stats) {
      const statsProjectId = opts.project ?? resolveProjectId(process.cwd());
      const stats = store.getStats(statsProjectId);
      console.log(`\n${c.bold('Registry Stats')} ${c.dim(`(project: ${statsProjectId})`)}`);
      console.log(`${'─'.repeat(40)}`);
      console.log(`  Total entities:  ${c.bold(String(stats.total))}`);
      console.log(`  Deprecated:      ${(stats.deprecated > 0 ? c.red : c.green)(String(stats.deprecated))}`);
      console.log(`  Untested:        ${(stats.untested > 0 ? c.yellow : c.green)(String(stats.untested))}`);
      console.log(`  High risk:       ${(stats.highRisk > 0 ? c.red : c.green)(String(stats.highRisk))}`);
      console.log(`  With warnings:   ${(stats.withWarnings > 0 ? c.yellow : c.green)(String(stats.withWarnings))}`);
      if (stats.byKind.length > 0) {
        console.log(`\n  ${c.dim('By kind:')}`);
        for (const { kind, count } of stats.byKind) {
          console.log(`    ${kind.padEnd(12)} ${count}`);
        }
      }
      if (stats.byStatus.length > 0) {
        console.log(`\n  ${c.dim('By status:')}`);
        for (const { status: statusName, count } of stats.byStatus) {
          console.log(`    ${statusName.padEnd(14)} ${count}`);
        }
      }
      console.log();
      return;
    }

    // --deprecated
    if (opts.deprecated) {
      const entities = store.deprecatedEntities(opts.project ?? resolveProjectId(process.cwd()));
      console.log(`\n${c.bold('Deprecated Entities')} (${entities.length})\n`);
      if (entities.length === 0) {
        console.log(`  ${c.green('None')}\n`);
      } else {
        for (const e of entities) console.log(formatEntity(e));
        console.log();
      }
      return;
    }

    // --untested
    if (opts.untested) {
      const entities = store.untestedEntities(opts.project ?? resolveProjectId(process.cwd()));
      console.log(`\n${c.bold('Untested Active Entities')} (${entities.length})\n`);
      if (entities.length === 0) {
        console.log(`  ${c.green('All tested')}\n`);
      } else {
        for (const e of entities) console.log(formatEntityCompact(e));
        console.log();
      }
      return;
    }

    // --high-risk
    if (opts.highRisk) {
      const entities = store.highRiskEntities(opts.project ?? resolveProjectId(process.cwd()));
      console.log(`\n${c.bold('High Risk Entities')} (${entities.length})\n`);
      if (entities.length === 0) {
        console.log(`  ${c.green('None')}\n`);
      } else {
        for (const e of entities) console.log(formatEntity(e));
        console.log();
      }
      return;
    }

    // --tag
    if (opts.tag) {
      const projectId = opts.project ?? resolveProjectId(process.cwd());
      const entities = store.entitiesByTag(opts.tag, undefined, projectId);
      console.log(`\n${c.bold(`Entities tagged "${opts.tag}"`)} (${entities.length})\n`);
      if (entities.length === 0) {
        console.log(`  ${c.dim(`No entities with tag "${opts.tag}"`)}\n`);
      } else {
        for (const e of entities) console.log(formatEntityCompact(e));
        console.log();
      }
      return;
    }

    // --search
    if (opts.search) {
      const projectId = opts.project ?? resolveProjectId(process.cwd());
      const entities = store.searchEntities(opts.search, 20, projectId);
      console.log(`\n${c.bold(`Search: "${opts.search}"`)} (${entities.length} results)\n`);
      if (entities.length === 0) {
        console.log(`  ${c.dim('No matches')}\n`);
      } else {
        for (const e of entities) console.log(formatEntity(e));
        console.log();
      }
      return;
    }

    // 파일 경로 지정: fileBrief
    if (filePath) {
      const brief = store.fileBrief(filePath, opts.project ?? resolveProjectId(process.cwd()));
      console.log(`\n${c.bold(`File Brief: ${filePath}`)}`);
      console.log(`${'─'.repeat(40)}`);
      console.log(`  ${c.dim(brief.summary)}\n`);

      if (brief.entities.length === 0) {
        console.log(`  ${c.dim('No registered entities for this file.')}`);
        console.log(`  ${c.dim('Use `registerEntity` mutation to add entries.')}\n`);
      } else {
        for (const e of brief.entities) console.log(formatEntity(e));
        console.log();
      }
      return;
    }

    // 인자 없이 호출 시: 간단 통계 + 도움말 (현재 프로젝트 스코프)
    const summaryProjectId = resolveProjectId(process.cwd());
    const stats = store.getStats(summaryProjectId);
    if (stats.total === 0) {
      console.log(`\n${c.bold('Code Registry')}: empty ${c.dim(`(project: ${summaryProjectId})`)}`);
      console.log(`  ${c.dim('Register entities via GraphQL at :3847/graphql')}`);
      console.log(`  ${c.dim('or use: openswarm check --help')}\n`);
    } else {
      console.log(`\n${c.bold('Code Registry')}: ${stats.total} entities ${c.dim(`(project: ${summaryProjectId})`)}`);
      console.log(`  ${stats.deprecated} deprecated, ${stats.untested} untested, ${stats.highRisk} high-risk, ${stats.withWarnings} with warnings`);
      console.log(`\n  ${c.dim('Usage:')}`);
      console.log(`  ${c.dim('  openswarm check <file>       ')}File brief`);
      console.log(`  ${c.dim('  openswarm check --stats       ')}Full statistics`);
      console.log(`  ${c.dim('  openswarm check --deprecated  ')}Deprecated list`);
      console.log(`  ${c.dim('  openswarm check --untested    ')}Untested list`);
      console.log(`  ${c.dim('  openswarm check --search <q>  ')}Full-text search\n`);
    }
  } finally {
    closeRegistryStore();
  }
}

/**
 * openswarm annotate <qualifiedName> — 엔티티 어노테이션
 */
export async function handleAnnotate(
  qualifiedName: string,
  opts: {
    deprecate?: string | boolean;
    status?: string;
    tag?: string;
    untag?: string;
    note?: string;
    risk?: string;
    warn?: string;
  },
): Promise<void> {
  try {
    const store = getRegistryStore();

    // qualified name으로 검색, 없으면 FTS 검색
    let entity = store.getEntityByName(qualifiedName);
    if (!entity) {
      // 부분 매칭 시도: name만으로 검색
      const results = store.searchEntities(qualifiedName, 5);
      if (results.length === 0) {
        console.error(c.red(`Entity not found: "${qualifiedName}"`));
        console.error(c.dim('Use qualified name (file::name) or search with: openswarm check --search <query>'));
        process.exit(1);
      }
      if (results.length === 1) {
        entity = results[0];
      } else {
        console.log(`${c.yellow(`Multiple matches for "${qualifiedName}":`)}\n`);
        for (const e of results) {
          console.log(`  ${c.cyan(e.qualifiedName)}  ${e.kind}  ${statusBadge(e.status)}`);
        }
        console.log(`\n${c.dim('Use the full qualified name to annotate a specific entity.')}`);
        return;
      }
    }

    console.log(`\n${c.bold('Annotating:')} ${c.cyan(entity.qualifiedName)}\n`);
    let changed = false;

    // --deprecate
    if (opts.deprecate !== undefined) {
      const reason = typeof opts.deprecate === 'string' ? opts.deprecate : undefined;
      store.deprecateEntity(entity.id, reason);
      console.log(`  ${status.err(`Deprecated${reason ? `: ${reason}` : ''}`)}`);
      changed = true;
    }

    // --status
    if (opts.status) {
      const validStatuses = ['active', 'deprecated', 'experimental', 'planned', 'broken'];
      if (!validStatuses.includes(opts.status)) {
        console.error(`  ${c.red(`Invalid status: ${opts.status}. Valid: ${validStatuses.join(', ')}`)}`);
      } else {
        store.changeEntityStatus(entity.id, opts.status as EntityStatus);
        console.log(`  ${statusBadge(opts.status)} Status changed`);
        changed = true;
      }
    }

    // --tag
    if (opts.tag) {
      const [tagKey, tagValue] = opts.tag.split('=', 2);
      store.addTag(entity.id, tagKey, tagValue);
      console.log(`  ${c.magenta('+')} Tag: ${tagKey}${tagValue ? `=${tagValue}` : ''}`);
      changed = true;
    }

    // --untag
    if (opts.untag) {
      store.removeTag(entity.id, opts.untag);
      console.log(`  ${c.dim('-')} Removed tag: ${opts.untag}`);
      changed = true;
    }

    // --note
    if (opts.note) {
      store.addEvent(entity.id, 'note_added', { content: opts.note, actor: 'cli' });
      console.log(`  ${c.blue('📝')} Note added`);
      changed = true;
    }

    // --risk
    if (opts.risk) {
      const validRisks = ['low', 'medium', 'high'];
      if (!validRisks.includes(opts.risk)) {
        console.error(`  ${c.red(`Invalid risk: ${opts.risk}. Valid: ${validRisks.join(', ')}`)}`);
      } else {
        store.updateEntity(entity.id, { riskLevel: opts.risk as RiskLevel }, 'cli');
        console.log(`  Risk: ${riskBadge(opts.risk)}`);
        changed = true;
      }
    }

    // --warn "severity/category: message"
    if (opts.warn) {
      const warnMatch = opts.warn.match(/^(info|warning|error|critical)\/(security|performance|correctness|style):\s*(.+)/);
      if (!warnMatch) {
        console.error(`  ${c.red('Invalid warning format. Use: severity/category: message')}`);
        console.error(`  ${c.dim('Example: --warn "error/security: SQL injection risk"')}`);
      } else {
        store.addWarning(entity.id, warnMatch[1] as WarningSeverity, warnMatch[2] as WarningCategory, warnMatch[3]);
        console.log(`  ${severityBadge(warnMatch[1])} [${warnMatch[2]}] ${warnMatch[3]}`);
        changed = true;
      }
    }

    if (!changed) {
      console.log(`  ${c.dim('No changes. Use --deprecate, --status, --tag, --note, --risk, or --warn')}`);
    }

    // 변경 후 엔티티 상태 표시
    if (changed) {
      const updated = store.getEntity(entity.id);
      if (updated) {
        console.log(`\n${c.dim('Updated state:')}`);
        console.log(formatEntity(updated));
      }
    }
    console.log();
  } finally {
    closeRegistryStore();
  }
}
