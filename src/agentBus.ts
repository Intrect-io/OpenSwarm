// ============================================
// Claude Swarm - Agent Message Bus
// Inter-agent context sharing system
// ============================================

import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';

// ============================================
// Types
// ============================================

/**
 * Message type
 */
export type MessageType =
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'context_update'
  | 'file_changed'
  | 'error'
  | 'log'
  | 'request'
  | 'response';

/**
 * Agent message
 */
export interface AgentMessage {
  id: string;
  timestamp: number;
  type: MessageType;
  sender: string;        // Step ID or agent ID
  recipient?: string;    // Specific recipient (broadcast if absent)
  executionId: string;   // Workflow execution ID
  payload: unknown;
}

/**
 * Step completed message payload
 */
export interface StepCompletedPayload {
  stepId: string;
  success: boolean;
  output: string;
  changedFiles: string[];
  duration: number;
  metadata?: Record<string, unknown>;
}

/**
 * Context update payload
 */
export interface ContextUpdatePayload {
  key: string;
  value: unknown;
  operation: 'set' | 'append' | 'delete';
}

/**
 * File changed payload
 */
export interface FileChangedPayload {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  diff?: string;
}

/**
 * Shared context
 */
export interface SharedContext {
  executionId: string;
  workflowId: string;
  startedAt: number;

  // Step results
  stepOutputs: Record<string, string>;

  // Changed files list (across entire workflow)
  changedFiles: string[];

  // Error log
  errors: Array<{ stepId: string; message: string; timestamp: number }>;

  // Custom data (passed between steps)
  data: Record<string, unknown>;
}

// ============================================
// Bus Implementation (File-based)
// ============================================

const BUS_DIR = resolve(homedir(), '.claude-swarm/bus');

/**
 * Message bus class
 */
export class AgentBus {
  private executionId: string;
  private contextPath: string;
  private messagesPath: string;
  private listeners: Map<MessageType, Array<(msg: AgentMessage) => void>> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private lastMessageId: string = '';

  constructor(executionId: string) {
    this.executionId = executionId;
    this.contextPath = resolve(BUS_DIR, executionId, 'context.json');
    this.messagesPath = resolve(BUS_DIR, executionId, 'messages');
  }

  /**
   * Initialize bus
   */
  async init(workflowId: string): Promise<void> {
    await fs.mkdir(resolve(BUS_DIR, this.executionId, 'messages'), { recursive: true });

    // Create initial context
    const context: SharedContext = {
      executionId: this.executionId,
      workflowId,
      startedAt: Date.now(),
      stepOutputs: {},
      changedFiles: [],
      errors: [],
      data: {},
    };

    await this.saveContext(context);
    console.log(`[AgentBus] Initialized for execution: ${this.executionId}`);
  }

  /**
   * Publish message
   */
  async publish(
    type: MessageType,
    sender: string,
    payload: unknown,
    recipient?: string
  ): Promise<string> {
    const message: AgentMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      type,
      sender,
      recipient,
      executionId: this.executionId,
      payload,
    };

    // Save message
    const messagePath = resolve(this.messagesPath, `${message.id}.json`);
    await fs.writeFile(messagePath, JSON.stringify(message, null, 2));

    // Handle special message types
    if (type === 'step_completed') {
      await this.handleStepCompleted(payload as StepCompletedPayload);
    } else if (type === 'context_update') {
      await this.handleContextUpdate(payload as ContextUpdatePayload);
    } else if (type === 'file_changed') {
      await this.handleFileChanged(payload as FileChangedPayload);
    } else if (type === 'error') {
      await this.handleError(sender, payload as string);
    }

    console.log(`[AgentBus] Published ${type} from ${sender}`);
    return message.id;
  }

  /**
   * Handle step completion
   */
  private async handleStepCompleted(payload: StepCompletedPayload): Promise<void> {
    const context = await this.getContext();
    if (!context) return;

    context.stepOutputs[payload.stepId] = payload.output;

    if (payload.changedFiles) {
      for (const file of payload.changedFiles) {
        if (!context.changedFiles.includes(file)) {
          context.changedFiles.push(file);
        }
      }
    }

    await this.saveContext(context);
  }

  /**
   * Handle context update
   */
  private async handleContextUpdate(payload: ContextUpdatePayload): Promise<void> {
    const context = await this.getContext();
    if (!context) return;

    switch (payload.operation) {
      case 'set':
        context.data[payload.key] = payload.value;
        break;
      case 'append':
        if (!Array.isArray(context.data[payload.key])) {
          context.data[payload.key] = [];
        }
        (context.data[payload.key] as unknown[]).push(payload.value);
        break;
      case 'delete':
        delete context.data[payload.key];
        break;
    }

    await this.saveContext(context);
  }

  /**
   * Handle file change
   */
  private async handleFileChanged(payload: FileChangedPayload): Promise<void> {
    const context = await this.getContext();
    if (!context) return;

    if (!context.changedFiles.includes(payload.path)) {
      context.changedFiles.push(payload.path);
    }

    await this.saveContext(context);
  }

  /**
   * Handle error
   */
  private async handleError(stepId: string, message: string): Promise<void> {
    const context = await this.getContext();
    if (!context) return;

    context.errors.push({
      stepId,
      message,
      timestamp: Date.now(),
    });

    await this.saveContext(context);
  }

  /**
   * Get context
   */
  async getContext(): Promise<SharedContext | null> {
    try {
      const content = await fs.readFile(this.contextPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Save context
   */
  private async saveContext(context: SharedContext): Promise<void> {
    await fs.writeFile(this.contextPath, JSON.stringify(context, null, 2));
  }

  /**
   * Get output from specific step
   */
  async getStepOutput(stepId: string): Promise<string | null> {
    const context = await this.getContext();
    return context?.stepOutputs[stepId] ?? null;
  }

  /**
   * Get all changed files
   */
  async getChangedFiles(): Promise<string[]> {
    const context = await this.getContext();
    return context?.changedFiles ?? [];
  }

  /**
   * Get custom data
   */
  async getData<T>(key: string): Promise<T | null> {
    const context = await this.getContext();
    return (context?.data[key] as T) ?? null;
  }

  /**
   * Set custom data
   */
  async setData(key: string, value: unknown): Promise<void> {
    await this.publish('context_update', 'system', {
      key,
      value,
      operation: 'set',
    } as ContextUpdatePayload);
  }

  /**
   * Register message listener
   */
  on(type: MessageType, callback: (msg: AgentMessage) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(callback);
  }

  /**
   * Start polling (detect new messages)
   */
  startPolling(intervalMs: number = 1000): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      await this.checkNewMessages();
    }, intervalMs);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Check for new messages
   */
  private async checkNewMessages(): Promise<void> {
    try {
      const files = await fs.readdir(this.messagesPath);
      const newFiles = files
        .filter(f => f.endsWith('.json') && f > this.lastMessageId)
        .sort();

      for (const file of newFiles) {
        const content = await fs.readFile(resolve(this.messagesPath, file), 'utf-8');
        const message: AgentMessage = JSON.parse(content);

        // Invoke listeners
        const callbacks = this.listeners.get(message.type);
        if (callbacks) {
          for (const cb of callbacks) {
            cb(message);
          }
        }

        this.lastMessageId = file;
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Get all messages
   */
  async getAllMessages(): Promise<AgentMessage[]> {
    try {
      const files = await fs.readdir(this.messagesPath);
      const messages: AgentMessage[] = [];

      for (const file of files.filter(f => f.endsWith('.json')).sort()) {
        const content = await fs.readFile(resolve(this.messagesPath, file), 'utf-8');
        messages.push(JSON.parse(content));
      }

      return messages;
    } catch {
      return [];
    }
  }

  /**
   * Create step context (including previous step results)
   */
  async createStepContext(stepId: string, dependsOn?: string[]): Promise<string> {
    const context = await this.getContext();
    if (!context) return '';

    const parts: string[] = [
      '## Workflow Context',
      '',
      `Execution ID: ${context.executionId}`,
      `Started: ${new Date(context.startedAt).toISOString()}`,
      '',
    ];

    // Previous step results
    if (dependsOn && dependsOn.length > 0) {
      parts.push('### Previous Step Results');
      for (const depId of dependsOn) {
        const output = context.stepOutputs[depId];
        if (output) {
          parts.push(`\n#### ${depId}:`);
          parts.push(output.slice(0, 2000));  // Truncate if too long
        }
      }
      parts.push('');
    }

    // Changed files
    if (context.changedFiles.length > 0) {
      parts.push('### Changed Files So Far');
      parts.push(context.changedFiles.map(f => `- ${f}`).join('\n'));
      parts.push('');
    }

    // Error log
    if (context.errors.length > 0) {
      parts.push('### Previous Errors');
      for (const err of context.errors) {
        parts.push(`- [${err.stepId}] ${err.message}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * Clean up bus
   */
  async cleanup(): Promise<void> {
    this.stopPolling();
    // Clean up files if needed
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Create new bus instance
 */
export function createBus(executionId?: string): AgentBus {
  const id = executionId || `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new AgentBus(id);
}

/**
 * Connect to existing bus
 */
export async function connectToBus(executionId: string): Promise<AgentBus | null> {
  const contextPath = resolve(BUS_DIR, executionId, 'context.json');
  if (!existsSync(contextPath)) {
    return null;
  }
  return new AgentBus(executionId);
}

/**
 * List active buses
 */
export async function listActiveBuses(): Promise<string[]> {
  try {
    await fs.mkdir(BUS_DIR, { recursive: true });
    const dirs = await fs.readdir(BUS_DIR);
    const active: string[] = [];

    for (const dir of dirs) {
      const contextPath = resolve(BUS_DIR, dir, 'context.json');
      if (existsSync(contextPath)) {
        active.push(dir);
      }
    }

    return active;
  } catch {
    return [];
  }
}
