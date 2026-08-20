// ============================================
// OpenSwarm - First-run onboarding wizard
// `openswarm init` (interactive). INT-1578 / INT-1808.
// ============================================
//
// Walks a fresh user through: AI provider (availability detection + inline
// auth), task backend (Linear with an arrow-key team/project picker, or local
// SQLite), and an optional notification channel. Writes a .env (secrets, 0600)
// + config.yaml + an openswarm.json repo→Linear mapping, then prints next steps.
// `--yes` keeps the config-only path for CI (handled by the caller in cli.ts).

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { select, input, password, confirm } from '@inquirer/prompts';
import { writeEnvVars } from '../core/envFile.js';
import { generateSampleConfig } from '../core/config.js';
import { AuthProfileStore, loginAndSaveLinearProfile, ensureValidToken } from '../auth/index.js';
import { getAdapter } from '../adapters/index.js';
import { type LinearCredential } from '../linear/index.js';
import { pickAndSaveLinearMapping } from './linearMapping.js';
import { banner } from '../support/banner.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { safeConsole as console } from '../support/safeLog.js';

type ProviderId = 'codex-responses' | 'openrouter' | 'atlascloud' | 'gpt' | 'lmstudio' | 'local' | 'codex' | 'claude';
type TaskBackend = 'linear' | 'local';
type NotifyChannel = 'none' | 'discord' | 'slack' | 'telegram' | 'webhook';

const PROVIDER_CHOICES: { name: string; value: ProviderId; description: string }[] = [
  { name: 'codex-responses', value: 'codex-responses', description: 'ChatGPT subscription (OAuth) — Codex models, native loop' },
  { name: 'codex', value: 'codex', description: 'External codex CLI (delegated)' },
  { name: 'openrouter', value: 'openrouter', description: 'OpenRouter API key or OAuth (any model)' },
  { name: 'atlascloud', value: 'atlascloud', description: 'Atlas Cloud API key (OpenAI-compatible models)' },
  { name: 'gpt', value: 'gpt', description: 'OpenAI ChatGPT OAuth (chat/completions)' },
  { name: 'claude', value: 'claude', description: 'Claude Code CLI (claude -p) — opt-in fallback' },
  { name: 'lmstudio', value: 'lmstudio', description: 'Local LM Studio server (no account)' },
  { name: 'local', value: 'local', description: 'Local Ollama models (no account)' },
];

const NOTIFY_CHOICES: { name: string; value: NotifyChannel; description: string }[] = [
  { name: 'none', value: 'none', description: 'No outbound notifications' },
  { name: 'discord', value: 'discord', description: 'Discord bot token + channel id' },
  { name: 'slack', value: 'slack', description: 'Slack incoming webhook URL' },
  { name: 'telegram', value: 'telegram', description: 'Telegram bot token + chat id' },
  { name: 'webhook', value: 'webhook', description: 'Generic webhook URL' },
];

function yamlScalar(value: string): string {
  return value === '' || /[\r\n#]/.test(value) || /:\s/.test(value) || /^\s|\s$/.test(value)
    ? JSON.stringify(value)
    : value;
}

/** ChatGPT-OAuth providers share the openai-gpt profile; openrouter has its own. */
function authPlanFor(provider: ProviderId): { providerArg: 'gpt' | 'openrouter'; profileKey: string } | null {
  if (provider === 'codex-responses' || provider === 'gpt') return { providerArg: 'gpt', profileKey: 'openai-gpt:default' };
  if (provider === 'openrouter') return { providerArg: 'openrouter', profileKey: 'openrouter:default' };
  return null; // lmstudio / local / codex / claude need no OAuth here
}

/** Apply the wizard's choices onto the static sample config via targeted replaces. */
export function buildWizardConfig(
  adapter: ProviderId,
  channel: NotifyChannel,
  agent?: { name: string; projectPath: string },
): string {
  let cfg = generateSampleConfig();
  cfg = cfg.replace(/^adapter: codex$/m, `adapter: ${adapter}`);
  cfg = cfg.replace(/^ {2}channel: discord$/m, `  channel: ${channel === 'none' ? 'none' : channel}`);
  // Replace the sample's placeholder agents (main/backend) with a single agent
  // for THIS repo so the user doesn't have to hand-edit projectPath.
  if (agent) {
    cfg = cfg.replace(
      /agents:\n[\s\S]*?\n\n(# Default heartbeat)/,
      `agents:\n  - name: ${yamlScalar(agent.name)}\n    projectPath: ${yamlScalar(agent.projectPath)}\n    heartbeatInterval: 1800000\n    enabled: true\n    paused: false\n\n$1`,
    );
  }
  const uncomment = (field: string) => {
    cfg = cfg.replace(`  # ${field}:`, `  ${field}:`);
  };
  if (channel === 'slack') uncomment('slackWebhookUrl');
  if (channel === 'telegram') {
    uncomment('telegramBotToken');
    uncomment('telegramChatId');
  }
  if (channel === 'webhook') uncomment('webhookUrl');
  return cfg;
}

export interface InitWizardOptions {
  force?: boolean;
}

/**
 * Provider bootstrap. `adapter.isAvailable()` is the canonical "already
 * configured?" probe — it covers env keys, OAuth profiles, PATH binaries, and
 * local servers (the old wizard only checked OAuth profiles). When not available,
 * branch on how to set the provider up. Returns whether to run inline OAuth after
 * the wizard, plus the auth plan.
 */
async function bootstrapProvider(
  provider: ProviderId,
): Promise<{ doAuthNow: boolean; plan: ReturnType<typeof authPlanFor> }> {
  let available = false;
  try {
    available = await getAdapter(provider).isAvailable();
  } catch { // cxt-ignore: error_swallow,exception_hiding — unknown/unconfigured provider treated as unavailable
    available = false;
  }

  if (provider === 'claude') {
    // claude = the `claude -p` CLI wrapper; isAvailable() is just `which claude`.
    // PATH presence ≠ logged in, so guide explicitly instead of claiming "configured".
    if (available) console.log('   ✓ `claude` on PATH. If not logged in yet, run `claude` once to authenticate.');
    else console.log('   `claude` not found. Install: npm i -g @anthropic-ai/claude-code, then run `claude` to log in.');
    return { doAuthNow: false, plan: null };
  }

  if (available) {
    console.log(`   ✓ ${provider} already configured.`);
    return { doAuthNow: false, plan: authPlanFor(provider) };
  }

  if (provider === 'codex') {
    console.log('   `codex` not found. Install the OpenAI Codex CLI and ensure `codex` is on PATH.');
    return { doAuthNow: false, plan: null };
  }
  if (provider === 'lmstudio' || provider === 'local') {
    console.log(`   No ${provider} server detected — start it (LM Studio :1234 / Ollama :11434) before running.`);
    return { doAuthNow: false, plan: null };
  }

  const plan = authPlanFor(provider);
  if (plan) {
    const doAuthNow = await confirm({
      message: `   ${provider} needs login — run \`auth login --provider ${plan.providerArg}\` now?`,
      default: true,
    });
    return { doAuthNow, plan };
  }
  return { doAuthNow: false, plan: null };
}

/**
 * Interactive Linear setup: paste API key → arrow-key pick teams (multi) → pick
 * THIS repo's project → write LINEAR_* env + an openswarm.json mapping so the
 * daemon resolves this repo without fuzzy name matching. Falls back to manual
 * team-id entry if the Linear API can't be reached.
 */
async function setupLinear(envVars: Record<string, string>, cwd: string): Promise<void> {
  // OAuth (browser, no key to paste) vs personal API key.
  const method = await select({
    message: '   Linear authentication:',
    choices: [
      { name: 'OAuth (browser login)', value: 'oauth', description: 'no API key to paste — recommended' },
      { name: 'API key (paste)', value: 'apikey', description: 'personal key from linear.app/settings/api' },
    ],
  });

  let cred: LinearCredential;
  if (method === 'oauth') {
    try {
      const authStore = new AuthProfileStore();
      let token: string;
      if (authStore.getProfile('linear:default')) {
        token = await ensureValidToken(authStore, 'linear:default'); // reuse — no browser
        console.log('   ✓ Reusing existing Linear OAuth profile.');
      } else {
        token = await loginAndSaveLinearProfile(); // browser PKCE → linear:default profile
      }
      cred = { accessToken: token };
    } catch (err) { // cxt-ignore: error_swallow,exception_hiding — OAuth failure → API-key fallback
      console.log(`   ⚠ Linear OAuth failed (${(err as Error).message}). Falling back to API key.`);
      const apiKey = (await password({ message: '   LINEAR_API_KEY (hidden):' })).trim();
      if (!apiKey) {
        console.log('   Skipped Linear (no key).');
        return;
      }
      envVars.LINEAR_API_KEY = apiKey;
      cred = { apiKey };
    }
  } else {
    console.log('   Get a key at https://linear.app/settings/api');
    const apiKey = (await password({ message: '   LINEAR_API_KEY (hidden):' })).trim();
    if (!apiKey) {
      console.log('   Skipped Linear (no key).');
      return;
    }
    envVars.LINEAR_API_KEY = apiKey;
    cred = { apiKey };
  }

  // Team→project picker + openswarm.json write is shared with `openswarm add`.
  const result = await pickAndSaveLinearMapping(cwd, cred);
  if (result.kind === 'no-teams') {
    // Manual team-id fallback keeps init usable when the Linear API is unreachable.
    const tid = (await input({ message: '   LINEAR_TEAM_ID:' })).trim();
    if (tid) envVars.LINEAR_TEAM_ID = tid;
    return;
  }
  // Record the selected team for the daemon even if the project pick was skipped.
  if (result.teamId) envVars.LINEAR_TEAM_ID = result.teamId;
}

export async function runInitWizard(opts: InitWizardOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const configPath = join(cwd, 'config.yaml');
  const envPath = join(cwd, '.env');

  if (existsSync(configPath)) {
    // Guard: if cwd/config.yaml is a symlink into the daemon's global config
    // (~/.config/openswarm), `init` here would clobber the running daemon's
    // settings (agents, allowedProjects, …). Refuse even with --force.
    let symlinkTarget: string | null = null;
    try {
      if (lstatSync(configPath).isSymbolicLink()) symlinkTarget = realpathSync(configPath);
    } catch {
      symlinkTarget = null; // cxt-ignore: error_swallow — stat failure → treat as a plain file
    }
    if (symlinkTarget && symlinkTarget.startsWith(join(homedir(), '.config', 'openswarm'))) {
      console.error(`config.yaml is a symlink to the daemon's global config:\n    ${symlinkTarget}`);
      console.error('Running `init` here would overwrite your running daemon configuration.');
      console.error('Run init in a different repo, or edit the daemon config directly.');
      process.exit(1);
    }
    if (!opts.force) {
      console.error('config.yaml already exists. Use --force to overwrite, or edit it directly.');
      process.exit(1);
    }
  }

  const envVars: Record<string, string> = {};
  let provider: ProviderId = 'codex';
  let taskBackend: TaskBackend = 'local';
  let notify: NotifyChannel = 'none';
  let doAuthNow = false;
  let plan: ReturnType<typeof authPlanFor> = null;

  try {
    console.log(banner('first-run setup'));

    // 1) AI provider
    provider = await select({
      message: '1) AI provider for worker/reviewer:',
      choices: PROVIDER_CHOICES.map((c) => ({ name: c.name, value: c.value, description: c.description })),
    });
    ({ doAuthNow, plan } = await bootstrapProvider(provider));

    // 2) Task backend
    taskBackend = await select({
      message: '\n2) Task backend:',
      choices: [
        { name: 'local', value: 'local' as TaskBackend, description: 'Local SQLite issue store (~/.openswarm/issues.db) — no account' },
        { name: 'linear', value: 'linear' as TaskBackend, description: 'Linear (arrow-key team/project picker)' },
      ],
    });
    if (taskBackend === 'linear') await setupLinear(envVars, cwd);

    // 3) Notification channel
    notify = await select({
      message: '\n3) Notification channel (optional):',
      choices: NOTIFY_CHOICES.map((c) => ({ name: c.name, value: c.value, description: c.description })),
    });
    if (notify === 'discord') {
      envVars.DISCORD_TOKEN = (await password({ message: '   DISCORD_TOKEN (hidden):' })).trim();
      envVars.DISCORD_CHANNEL_ID = (await input({ message: '   DISCORD_CHANNEL_ID:' })).trim();
    } else if (notify === 'slack') {
      envVars.SLACK_WEBHOOK_URL = (await input({ message: '   SLACK_WEBHOOK_URL:' })).trim();
    } else if (notify === 'telegram') {
      envVars.TELEGRAM_BOT_TOKEN = (await password({ message: '   TELEGRAM_BOT_TOKEN (hidden):' })).trim();
      envVars.TELEGRAM_CHAT_ID = (await input({ message: '   TELEGRAM_CHAT_ID:' })).trim();
    } else if (notify === 'webhook') {
      envVars.NOTIFY_WEBHOOK_URL = (await input({ message: '   NOTIFY_WEBHOOK_URL:' })).trim();
    }
  } catch (err) {
    // @inquirer throws ExitPromptError on Ctrl-C — exit cleanly, no stack trace.
    if (err instanceof Error && err.name === 'ExitPromptError') {
      console.log('\nSetup cancelled.');
      return;
    }
    throw err;
  }

  // Drop empty answers so we never write `KEY=` for a skipped field.
  for (const k of Object.keys(envVars)) {
    if (!envVars[k]) delete envVars[k];
  }

  // Write .env (secrets) + config.yaml.
  if (Object.keys(envVars).length > 0) {
    writeEnvVars(envPath, envVars);
    console.log(`\nWrote ${envPath} (${Object.keys(envVars).join(', ')}) — chmod 600.`);
  }
  atomicWriteFileSync(configPath, buildWizardConfig(provider, notify, { name: basename(cwd), projectPath: cwd }), 0o600);
  console.log(`Wrote ${configPath}.`);

  // Inline auth last (browser OAuth) — after all prompts.
  if (doAuthNow && plan) {
    console.log(`\nLaunching login for ${plan.providerArg}...`);
    const { handleAuthLogin } = await import('./authHandler.js');
    await handleAuthLogin(plan.providerArg, {});
  }

  // Next steps.
  console.log('\nNext steps:');
  console.log('  1. Edit config.yaml — set your project path(s) under `agents:`.');
  if (plan && !doAuthNow) {
    const store = new AuthProfileStore();
    if (store.getProfile(plan.profileKey) === null) {
      console.log(`  2. Authenticate: openswarm auth login --provider ${plan.providerArg}`);
    }
  }
  console.log('  • Diagnose: openswarm doctor   (verify providers, native deps, ports, config)');
  console.log('  • Validate: openswarm validate');
  console.log('  • Start:    openswarm start    (or `openswarm` for the TUI)');
  if (taskBackend === 'local') {
    console.log('  • Task backend: local SQLite (~/.openswarm/issues.db) — no Linear account needed.');
  }
}
