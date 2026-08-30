// ============================================
// OpenSwarm - CC-Router Responses adapter
// ============================================

import type { AdapterCapabilities, CliRunOptions } from './types.js';
import { CodexResponsesAdapter } from './codexResponses.js';
import { approvedLocalModelEndpoint, prepareApprovedLocalResponsesRequest } from '../support/approvedEgress.js';

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
      // Availability probing is part of adapter selection and runs before
      // spawnCli's execution boundary. Never resolve a PATH binary here: a fake
      // `cc-router` could execute arbitrary code with the daemon's HOME/env even
      // though strict mode would later refuse the delegated process. The router
      // already exposes the same status payload over its loopback-only health
      // endpoint, so probe that narrow approved egress path directly.
      const endpoint = approvedLocalModelEndpoint(this.baseOrigin(), '/cc-router/health');
      const response = await fetch(endpoint, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return false;
      const status = await response.json() as { status?: string; operational?: { capabilities?: { openAIResponses?: boolean } } };
      return status.status === 'ok' && status.operational?.capabilities?.openAIResponses === true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const endpoint = approvedLocalModelEndpoint(this.baseOrigin(), '/v1/models');
      const response = await fetch(endpoint, { headers: this.headers() });
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
