// ============================================
// OpenSwarm - external human-surface safety policy
// ============================================

import type { ToolDefinition } from '../adapters/tools.js';

export type McpAccess = 'read' | 'write' | 'destructive';
export type McpSurface = 'human' | 'devops' | 'data' | 'sandbox' | 'unknown';

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolPolicySource {
  server: string;
  action?: string;
  description?: string;
  declaredSurface?: McpSurface;
  /** Server id, endpoint host, command, and package names. Never persisted. */
  serverIdentityHints?: readonly string[];
  annotations?: McpToolAnnotations;
}

export interface McpToolPolicyDecision {
  name: string;
  server: string;
  action: string;
  surface: McpSurface;
  access: McpAccess;
  /** True only for the explicit read/list/get/search/fetch contract. */
  humanSurfaceReadAllowed: boolean;
  evidence: readonly string[];
}

const READ_ACTIONS = new Set(['read', 'list', 'get', 'search', 'fetch']);
const WRITE_ACTIONS = new Set([
  'add',
  'approve',
  'cancel',
  'close',
  'comment',
  'create',
  'edit',
  'invite',
  'mark',
  'move',
  'patch',
  'pin',
  'post',
  'publish',
  'put',
  'react',
  'rename',
  'reply',
  'resolve',
  'save',
  'schedule',
  'send',
  'set',
  'share',
  'submit',
  'unpin',
  'update',
  'upload',
  'write',
]);
const DESTRUCTIVE_ACTIONS = new Set([
  'archive',
  'delete',
  'execute',
  'merge',
  'purge',
  'remove',
  'revoke',
  'run',
  'trigger',
  'unshare',
]);

/**
 * Products whose mutations are visible to, or act directly on, people.
 *
 * Exact identifier tokens are used, not substring matching: `signal` is not in
 * this set because it is too common in developer/data tools, and `teams` does
 * not match `upstreamteamsync` unless a descriptor actually separates it.
 * GitHub, Linear, Jira, Cloudflare, databases, and infrastructure providers are
 * intentionally absent: their existing DevOps grants remain role-scoped by
 * mcpPolicy.ts.
 */
const HUMAN_SURFACE_IDENTIFIERS = new Set([
  'airtable',
  'asana',
  'calendar',
  'canva',
  'clickup',
  'confluence',
  'discord',
  'dropbox',
  'email',
  'facebook',
  'figma',
  'gmail',
  'instagram',
  'linkedin',
  'mail',
  'mailgun',
  'mattermost',
  'matrix',
  'notion',
  'outlook',
  'sendgrid',
  'slack',
  'smtp',
  'sms',
  'teams',
  'telegram',
  'trello',
  'twilio',
  'whatsapp',
  'zulip',
]);

// Environment keys need a narrower set than server descriptors. Generic words
// such as CHAT and CALENDAR occur in harmless model/build settings; stripping
// them would break execution without removing a usable service credential.
const HUMAN_SURFACE_ENV_IDENTIFIERS = new Set([
  'airtable',
  'asana',
  'canva',
  'clickup',
  'discord',
  'dropbox',
  'email',
  'figma',
  'gmail',
  'mail',
  'mailgun',
  'mattermost',
  'matrix',
  'notion',
  'outlook',
  'sendgrid',
  'slack',
  'smtp',
  'teams',
  'telegram',
  'trello',
  'twilio',
  'whatsapp',
  'zulip',
]);

const HUMAN_SURFACE_HOST_SUFFIXES = [
  'api.slack.com',
  'hooks.slack.com',
  'slack.com',
  'discord.com',
  'discordapp.com',
  'api.notion.com',
  'notion.so',
  'gmail.googleapis.com',
  'api.telegram.org',
  'api.twilio.com',
  'api.sendgrid.com',
  'api.mailgun.net',
] as const;

const descriptorByTool = new WeakMap<ToolDefinition, McpToolPolicyDecision>();

export function identifierTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function splitQualifiedName(name: string): { server: string; action: string } {
  const separator = name.indexOf('__');
  if (separator < 0) return { server: '', action: name };
  return { server: name.slice(0, separator), action: name.slice(separator + 2) };
}

function hostFromHint(hint: string): string | undefined {
  try {
    return new URL(hint).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function knownHumanHost(host: string): boolean {
  return HUMAN_SURFACE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function hasHumanIdentifier(value: string): string | undefined {
  const tokens = identifierTokens(value);
  const exact = tokens.find((token) => HUMAN_SURFACE_IDENTIFIERS.has(token));
  if (exact) return exact;
  if (tokens.includes('google') && tokens.includes('drive')) return 'google-drive';
  if (tokens.includes('google') && tokens.includes('docs')) return 'google-docs';
  if (tokens.includes('google') && tokens.includes('sheets')) return 'google-sheets';
  return undefined;
}

function classifyAccess(action: string, annotations?: McpToolAnnotations): McpAccess {
  const tokens = identifierTokens(action);
  if (annotations?.destructiveHint || tokens.some((token) => DESTRUCTIVE_ACTIONS.has(token))) {
    return 'destructive';
  }
  // MCP annotations are untrusted hints. They may make the decision stricter,
  // but readOnlyHint=true never turns a mutating action name into a read.
  if (annotations?.readOnlyHint === false || tokens.some((token) => WRITE_ACTIONS.has(token))) {
    return 'write';
  }
  return 'read';
}

function inferSurface(source: McpToolPolicySource): { surface: McpSurface; evidence: string[] } {
  const evidence: string[] = [];
  if (source.declaredSurface === 'human') evidence.push('server is declared as a human surface');

  for (const hint of [source.server, ...(source.serverIdentityHints ?? [])]) {
    const host = hostFromHint(hint);
    if (host && knownHumanHost(host)) {
      evidence.push(`known human-surface endpoint ${host}`);
      continue;
    }
    const identifier = hasHumanIdentifier(hint);
    if (identifier) evidence.push(`human-surface identifier ${identifier}`);
  }

  // A server may be configured under an opaque alias. Tool descriptions are
  // untrusted, so they can only tighten policy (identify a human surface),
  // never relax it or prove that a tool is read-only.
  const descriptionIdentifier = hasHumanIdentifier(source.description ?? '');
  if (descriptionIdentifier) evidence.push(`tool descriptor identifies ${descriptionIdentifier}`);

  if (evidence.length > 0) return { surface: 'human', evidence: [...new Set(evidence)] };
  return { surface: source.declaredSurface ?? 'unknown', evidence: [] };
}

export function describeMcpToolPolicy(
  tool: ToolDefinition | string,
  source: Partial<McpToolPolicySource> = {},
): McpToolPolicyDecision {
  if (typeof tool !== 'string') {
    const attached = descriptorByTool.get(tool);
    if (attached && Object.keys(source).length === 0) return attached;
  }

  const name = typeof tool === 'string' ? tool : tool.function.name;
  const split = splitQualifiedName(name);
  const server = source.server ?? split.server;
  const action = source.action ?? split.action;
  const description = source.description ?? (typeof tool === 'string' ? '' : tool.function.description);
  const normalizedSource: McpToolPolicySource = {
    server,
    action,
    description,
    declaredSurface: source.declaredSurface,
    serverIdentityHints: source.serverIdentityHints,
    annotations: source.annotations,
  };
  const { surface, evidence } = inferSurface(normalizedSource);
  const access = classifyAccess(action, normalizedSource.annotations);
  const hasExplicitReadAction = identifierTokens(action).some((token) => READ_ACTIONS.has(token));
  const humanSurfaceReadAllowed = surface !== 'human'
    || (access === 'read' && normalizedSource.annotations?.readOnlyHint !== false && hasExplicitReadAction);

  return {
    name,
    server,
    action,
    surface,
    access,
    humanSurfaceReadAllowed,
    evidence,
  };
}

export function attachMcpToolPolicy(
  tool: ToolDefinition,
  source: McpToolPolicySource,
): McpToolPolicyDecision {
  const decision = describeMcpToolPolicy(tool, source);
  descriptorByTool.set(tool, decision);
  return decision;
}

export function filterHumanSurfaceMcpTools(
  tools: ToolDefinition[],
): { tools: ToolDefinition[]; denied: Array<{ name: string; reason: string }> } {
  const accepted: ToolDefinition[] = [];
  const denied: Array<{ name: string; reason: string }> = [];
  for (const tool of tools) {
    const decision = describeMcpToolPolicy(tool);
    if (decision.surface === 'human' && !decision.humanSurfaceReadAllowed) {
      denied.push({
        name: decision.name,
        reason: 'external human surface is read-only; only read/list/get/search/fetch actions are allowed',
      });
    } else {
      accepted.push(tool);
    }
  }
  return { tools: accepted, denied };
}

/** Remove credentials that would turn an agent shell into a human-surface writer. */
export function stripHumanSurfaceEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const tokens = identifierTokens(key);
    const googleCollaborationCredential = tokens.includes('google')
      && (tokens.includes('drive') || tokens.includes('docs') || tokens.includes('sheets'));
    if (googleCollaborationCredential || tokens.some((token) => HUMAN_SURFACE_ENV_IDENTIFIERS.has(token))) continue;
    env[key] = value;
  }
  return env;
}

const SHELL_NETWORK_EXECUTORS = new Set([
  'bash',
  'bun',
  'curl',
  'deno',
  'discord',
  'http',
  'httpie',
  'eval',
  'fish',
  'mail',
  'mailx',
  'mutt',
  'node',
  'notion',
  'parallel',
  'perl',
  'php',
  'python',
  'python3',
  'powershell',
  'pwsh',
  'ruby',
  'sendmail',
  'sh',
  'slack',
  'wget',
  'xargs',
  'zsh',
]);

function hasShellWriteSignal(command: string): boolean {
  if (/(?:^|\s)(?:-X|--request|--method|-Method)(?:=|\s*)(?:POST|PUT|PATCH|DELETE)\b/i.test(command)) return true;
  const forceGet = /(?:^|\s)(?:-G|--get)(?=\s|$)/i.test(command);
  if (!forceGet && /(?:^|\s)(?:-d|-F|-T)(?=\S|\s|$)/i.test(command)) return true;
  if (!forceGet && /(?:^|\s)(?:--data(?:-[a-z-]+)?|--form(?:-[a-z-]+)?|--upload-file|--post-data|--post-file|--body-data|--json|--config)(?:=|\s|$)/i.test(command)) return true;
  if (!forceGet && /(?:^|\s)-K(?=\S|\s|$)/.test(command)) return true;
  if (/\b(?:requests?|client|fetch|axios)\s*\.\s*(?:post|put|patch|delete)\b/i.test(command)) return true;
  return identifierTokens(command).some((token) => WRITE_ACTIONS.has(token) || DESTRUCTIVE_ACTIONS.has(token));
}

function shellExecutors(command: string): string[] {
  const executors: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*'|`[^`]*`)+/g) ?? [];
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;

    // Common process wrappers do not change the executable's authority. Skip
    // their flags and fixed operands so `env -i curl ...` cannot bypass the
    // same check as a direct `curl` call.
    while (index < words.length) {
      const word = words[index].replace(/^["']|["']$/g, '');
      const base = (word.split('/').pop() ?? word).toLowerCase();
      if (!['command', 'env', 'nohup', 'sudo', 'time', 'timeout'].includes(base)) break;
      index++;
      while (index < words.length && words[index].startsWith('-')) {
        const option = words[index++];
        if ((base === 'sudo' && ['-u', '-g', '-h', '-p', '-C', '-T'].includes(option)) && index < words.length) index++;
      }
      if (base === 'timeout' && index < words.length) index++; // duration
      while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
    }

    if (index >= words.length) continue;
    const word = words[index].replace(/^["']|["']$/g, '');
    const executable = word.split('/').pop() ?? word;
    executors.push(executable.toLowerCase());
  }
  return executors;
}

/**
 * Guard the direct, common shell escape hatch without disabling DevOps or DB
 * networking wholesale. Credentials are independently removed by
 * stripHumanSurfaceEnv; this catches literal webhooks and service CLIs.
 */
export function humanSurfaceShellWriteReason(command: string): string | undefined {
  const hosts = [...command.matchAll(/https?:\/\/[^\s'"`]+/gi)]
    .map((match) => hostFromHint(match[0]))
    .filter((host): host is string => !!host);
  const humanIdentifier = hasHumanIdentifier(command);
  const humanHost = hosts.find(knownHumanHost);
  if (!humanIdentifier && !humanHost) return undefined;
  if (!hasShellWriteSignal(command)) return undefined;

  // A literal protected endpoint plus a write signal is sufficient evidence,
  // regardless of how many shell wrappers surround the network client. This
  // closes `bash -c`, `xargs`, aliases, and variable-command wrappers without
  // treating a plain `rg 'slack post'` search as network execution.
  if (!humanHost && !shellExecutors(command).some((executable) => SHELL_NETWORK_EXECUTORS.has(executable))) {
    return undefined;
  }

  const target = humanHost ? `endpoint ${humanHost}` : `service ${humanIdentifier}`;
  return `external human-surface write blocked (${target}); use read-only access or ask the operator`;
}
