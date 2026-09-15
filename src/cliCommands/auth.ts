// ============================================
// OpenSwarm - CLI: auth command registration
// Split from cli.ts for the LOC gate.
// ============================================

import type { Command } from 'commander';
import { parseTcpPortOption } from '../cli/optionParsers.js';

export function registerAuthCommand(program: Command): void {
const authCmd = program
  .command('auth')
  .description('Manage OAuth authentication for providers');

authCmd
  .command('login')
  .description('Login via OAuth/PKCE (gpt, openrouter, linear)')
  .option('--provider <provider>', 'Provider to authenticate (gpt | openrouter | linear)', 'gpt')
  .option('--method <method>', 'OpenRouter only: oauth | key (default: auto — browser on desktop, hidden key prompt on SSH/headless)')
  .option('--client-id <clientId>', 'GPT only: override OAuth Client ID (defaults to the public Codex client)')
  .option('--port <port>', 'Callback server port', parseTcpPortOption)
  .action(async (opts: { provider: string; method?: string; clientId?: string; port?: number }) => {
    const { handleAuthLogin } = await import('../cli/authHandler.js');
    await handleAuthLogin(opts.provider, {
      clientId: opts.clientId,
      port: opts.port,
      method: opts.method as 'auto' | 'oauth' | 'key' | undefined,
    });
  });

authCmd
  .command('status')
  .description('Show stored auth profiles')
  .action(async () => {
    const { handleAuthStatus } = await import('../cli/authHandler.js');
    handleAuthStatus();
  });

authCmd
  .command('models')
  .description('List available Codex models (live via OAuth, offline fallback otherwise)')
  .action(async () => {
    const { handleAuthModels } = await import('../cli/authHandler.js');
    await handleAuthModels();
  });

authCmd
  .command('logout')
  .description('Remove stored auth tokens')
  .option('--provider <provider>', 'Provider to remove (gpt | openrouter | linear)', 'gpt')
  .action(async (opts: { provider: string }) => {
    const { handleAuthLogout } = await import('../cli/authHandler.js');
    handleAuthLogout(opts.provider);
  });

// Work-repo management — register which repos the daemon operates on

program
  .command('add')
  .description('Register a repository as a work repo (enabled + pinned)')
  .argument('<path>', 'Path to the git repository')
  .action(async (path: string) => {
    const { handleProjectAdd } = await import('../cli/projectHandler.js');
    await handleProjectAdd(path);
  });

program
  .command('projects')
  .description('List registered work repositories')
  .action(async () => {
    const { handleProjectList } = await import('../cli/projectHandler.js');
    handleProjectList();
  });

program
  .command('remove')
  .description('Unregister a work repository (adds it to the denylist)')
  .argument('<path>', 'Path to the repository')
  .action(async (path: string) => {
    const { handleProjectRm } = await import('../cli/projectHandler.js');
    handleProjectRm(path);
  });

// 서브커맨드 없이 `openswarm`만 입력 시 → TUI chat 실행 (`openswarm chat`과 동일)
}
