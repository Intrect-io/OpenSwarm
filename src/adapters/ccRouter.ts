// ============================================
// OpenSwarm - CC-Router Responses adapter
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdapterCapabilities, CliRunOptions } from './types.js';
import { CodexResponsesAdapter } from './codexResponses.js';
import { prepareApprovedLocalResponsesRequest } from '../support/approvedEgress.js';

const execFileAsync = promisify(execFile);

export class CcRouterAdapter extends CodexResponsesAdapter {
  readonly name = 'cc-router';
  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: true,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
    enforcesReadOnly: true,
    enforcesHumanSurfaceReadOnly: true,
  };

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('cc-router', ['status', '--json'], { timeout: 5_000 });
      const status = JSON.parse(stdout) as { status?: string; operational?: { capabilities?: { openAIResponses?: boolean } } };
      return status.status === 'ok' && status.operational?.capabilities?.openAIResponses === true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl()}/models`, { headers: this.headers() });
      if (!response.ok) return [];
      const body = await response.json() as { data?: Array<{ id?: string }> };
      return (body.data ?? []).flatMap((entry) => typeof entry.id === 'string' ? [entry.id] : []);
    } catch {
      return [];
    }
  }

  async getDefaultModel(): Promise<string> {
    const [first] = await this.listModels();
    return first ?? process.env.CC_ROUTER_MODEL ?? 'gpt-5.6-terra';
  }

  protected responsesUrl(): string {
    return `${this.baseUrl()}/responses`;
  }

  protected authHeaders(_options: CliRunOptions): Record<string, string> {
    return this.headers();
  }

  protected async credentials(_options: CliRunOptions): Promise<{ accessToken: string; accountId: string }> {
    return { accessToken: process.env.CC_ROUTER_TOKEN ?? '', accountId: '' };
  }

  protected prepareRequest(payload: unknown) {
    return prepareApprovedLocalResponsesRequest(this.baseOrigin(), payload);
  }

  private baseOrigin(): string {
    const configured = (process.env.CC_ROUTER_BASE_URL ?? 'http://127.0.0.1:3456').replace(/\/$/, '');
    return configured.endsWith('/v1') ? configured.slice(0, -3) : configured;
  }

  private baseUrl(): string { return `${this.baseOrigin()}/v1`; }

  private headers(): Record<string, string> {
    const token = process.env.CC_ROUTER_TOKEN;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}
