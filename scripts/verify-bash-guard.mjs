#!/usr/bin/env node
/**
 * Standalone lexical check of the bash destructive-command guard
 * (mirrors src/adapters/tools.ts normalizeForGuard / isCommandBlocked).
 * Run with: node scripts/verify-bash-guard.mjs
 */
const BLOCKED_COMMANDS = [
  /\brm\s+(-[rR]f?|--recursive)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fd\b/,
  /\bdrop\s+database\b/i,
  /\btruncate\s+table\b/i,
  /\bchmod\s+777\b/,
  /\bchown\s+-R\b/,
  />\s*\/dev\/sd/,
  /\bdd\s+if=/,
  /\bpkill\s+-9\b/,
  /\bkill\s+-9\b/,
];

function normalizeForGuard(command) {
  return command
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(\d{3})/g, (_m, octal) => String.fromCharCode(parseInt(octal, 8)))
    .replace(/\\(.)/g, '$1')
    .replace(/['"]/g, '');
}

const SUBSTITUTION_SPAN_PATTERNS = [
  /\$\([^()]*\)/g,
  /\$\{[^{}]*\}/g,
  /`[^`]*`/g,
  /<\([^()]*\)/g,
  />\([^()]*\)/g,
];

function hasMidWordSubstitution(command) {
  for (const spanPattern of SUBSTITUTION_SPAN_PATTERNS) {
    for (const match of command.matchAll(spanPattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const before = command[start - 1];
      const after = command[end];
      if ((before && /[A-Za-z0-9_]/.test(before)) || (after && /[A-Za-z0-9_]/.test(after))) {
        return true;
      }
    }
  }
  return false;
}

function isCommandBlocked(command) {
  const normalized = normalizeForGuard(command);
  if (hasMidWordSubstitution(command) || hasMidWordSubstitution(normalized)) return true;
  return BLOCKED_COMMANDS.some((pattern) => pattern.test(command) || pattern.test(normalized));
}

const mustBlock = [
  'rm -rf /foo',
  "printf '\\162\\155 -rf /foo' | bash",
  "printf '\\x72\\x6d -rf /foo' | bash",
  'echo <(rm -rf /foo)',
  'echo >(rm -rf /foo)',
  'cat <(chmod 777 somefile)',
  "r'm' -rf /foo",
  'r\\m -rf /foo',
  'r$(true)m -rf /foo',
];

const mustAllow = [
  "printf '%s\\n' hello",
  'diff <(ls a) <(ls b)',
  'echo >(cat /etc/passwd)',
  'VERSION=$(cat package.json)',
  'echo `date`',
];

let failed = 0;
for (const cmd of mustBlock) {
  if (!isCommandBlocked(cmd)) {
    console.error('FAIL expected blocked:', cmd);
    failed++;
  } else {
    console.log('OK blocked:', cmd);
  }
}
for (const cmd of mustAllow) {
  if (isCommandBlocked(cmd)) {
    console.error('FAIL expected allowed:', cmd);
    failed++;
  } else {
    console.log('OK allowed:', cmd);
  }
}
process.exit(failed === 0 ? 0 : 1);
