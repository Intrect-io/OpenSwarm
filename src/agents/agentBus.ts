// ============================================
// OpenSwarm - Agent Message Bus
// Inter-agent context sharing system
// ============================================

import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { atomicWriteFile } from '../support/atomicFile.js';

// Types

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

// Bus Implementation (File-based)

const BUS_DIR = resolve(homedir(), '.openswarm/bus');
const CONTEXT_LOCK_STALE_MS = 30_000;
const MAX_RETAINED_MESSAGES = 1_000;
const MAX_CONTEXT_ENTRIES = 1_000;
const MAX_CONTEXT_ERRORS = 200;

function assertExecutionId(executionId: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(executionId) ||
    executionId === '.' ||
    executionId === '..'
  ) {
    throw new Error(`Invalid AgentBus execution ID: ${JSON.stringify(executionId)}`);
  }
}

/**
 * Message bus class
 */
export class AgentBus {
  private executionId: string;
  private contextPath: string;
  private messagesPath: string;
  private listeners: Map<MessageType, Array<(msg: AgentMessage) => void | Promise<void>>> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private pollPromise: Promise<void> | null = null;
  private readonly processedMessageIds = new Set<string>();
  private readonly contextLockPath: string;
  private publishedSincePrune = 0;

  constructor(executionId: string) {
    assertExecutionId(executionId);
    this.executionId = executionId;
    this.contextPath = resolve(BUS_DIR, executionId, 'context.json');
    this.messagesPath = resolve(BUS_DIR, executionId, 'messages');
    this.contextLockPath = resolve(BUS_DIR, executionId, 'context.lock');
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

    // Save message. Atomic (write-temp + fsync + rename) because the consumers
    // here poll with readdir + readFile: an in-place write makes the filename
    // visible to readdir before its contents are complete, so a poller can read
    // a truncated message and fail to parse it. rename publishes the name and
    // the content in one step.
    const messagePath = resolve(this.messagesPath, `${message.id}.json`);
    await atomicWriteFile(messagePath, JSON.stringify(message, null, 2), 0o644);
    if (++this.publishedSincePrune >= 100) {
      this.publishedSincePrune = 0;
      await this.pruneMessages();
    }

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
    await this.mutateContext((context) => {
      context.stepOutputs[payload.stepId] = payload.output;
      const stepIds = Object.keys(context.stepOutputs);
      for (const staleId of stepIds.slice(0, Math.max(0, stepIds.length - MAX_CONTEXT_ENTRIES))) {
        delete context.stepOutputs[staleId];
      }
      if (payload.changedFiles) {
        for (const file of payload.changedFiles) {
          if (!context.changedFiles.includes(file)) context.changedFiles.push(file);
        }
        if (context.changedFiles.length > MAX_CONTEXT_ENTRIES) {
          context.changedFiles.splice(0, context.changedFiles.length - MAX_CONTEXT_ENTRIES);
        }
      }
    });
  }

  /**
   * Handle context update
   */
  private async handleContextUpdate(payload: ContextUpdatePayload): Promise<void> {
    await this.mutateContext((context) => {
      switch (payload.operation) {
        case 'set': context.data[payload.key] = payload.value; break;
        case 'append':
          if (!Array.isArray(context.data[payload.key])) context.data[payload.key] = [];
          (context.data[payload.key] as unknown[]).push(payload.value);
          if ((context.data[payload.key] as unknown[]).length > MAX_CONTEXT_ENTRIES) {
            (context.data[payload.key] as unknown[]).splice(0, (context.data[payload.key] as unknown[]).length - MAX_CONTEXT_ENTRIES);
          }
          break;
        case 'delete': delete context.data[payload.key]; break;
      }
    });
  }

  /**
   * Handle file change
   */
  private async handleFileChanged(payload: FileChangedPayload): Promise<void> {
    await this.mutateContext((context) => {
      if (!context.changedFiles.includes(payload.path)) context.changedFiles.push(payload.path);
      if (context.changedFiles.length > MAX_CONTEXT_ENTRIES) {
        context.changedFiles.splice(0, context.changedFiles.length - MAX_CONTEXT_ENTRIES);
      }
    });
  }

  /**
   * Handle error
   */
  private async handleError(stepId: string, message: string): Promise<void> {
    await this.mutateContext((context) => {
      context.errors.push({ stepId, message, timestamp: Date.now() });
      if (context.errors.length > MAX_CONTEXT_ERRORS) {
        context.errors.splice(0, context.errors.length - MAX_CONTEXT_ERRORS);
      }
    });
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
    const temp = `${this.contextPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(temp, JSON.stringify(context, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.contextPath);
  }

  private async mutateContext(mutator: (context: SharedContext) => void): Promise<void> {
    await this.withContextLock(async () => {
      const context = await this.getContext();
      if (!context) return;
      mutator(context);
      await this.saveContext(context);
    });
  }

  private async withContextLock<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await fs.mkdir(this.contextLockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await this.recoverStaleContextLock()) continue;
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    try {
      return await operation();
    } finally {
      await fs.rmdir(this.contextLockPath).catch(() => {});
    }
  }

  private async recoverStaleContextLock(): Promise<boolean> {
    try {
      const stats = await fs.stat(this.contextLockPath);
      if (Date.now() - stats.mtimeMs < CONTEXT_LOCK_STALE_MS) return false;
      const stalePath = `${this.contextLockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
      await fs.rename(this.contextLockPath, stalePath);
      await fs.rm(stalePath, { recursive: true, force: true });
      console.warn(`[AgentBus] Recovered stale context lock for ${this.executionId}`);
      return true;
    } catch (error) {
      if (['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
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
  on(type: MessageType, callback: (msg: AgentMessage) => void | Promise<void>): void {
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

    this.pollInterval = setInterval(() => {
      void this.pollOnce();
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
  pollOnce(): Promise<void> {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.checkNewMessages().finally(() => {
      this.pollPromise = null;
    });
    return this.pollPromise;
  }

  private async checkNewMessages(): Promise<void> {
    try {
      const files = await fs.readdir(this.messagesPath);
      const newFiles = files
        .filter(f => f.endsWith('.json') && !this.processedMessageIds.has(f))
        .sort();

      for (const file of newFiles) {
        const content = await fs.readFile(resolve(this.messagesPath, file), 'utf-8');
        const message: AgentMessage = JSON.parse(content);

        // Invoke listeners
        const callbacks = this.listeners.get(message.type);
        if (callbacks) {
          for (const cb of callbacks) {
            try {
              await cb(message);
            } catch (error) {
              console.warn(`[AgentBus] Listener failed for ${message.type}:`, error instanceof Error ? error.message : String(error));
            }
          }
        }

        this.processedMessageIds.add(file);
        if (this.processedMessageIds.size > MAX_RETAINED_MESSAGES) {
          this.processedMessageIds.delete(this.processedMessageIds.values().next().value!);
        }
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
    await this.pollPromise?.catch(() => {});
    await this.pruneMessages();
    this.processedMessageIds.clear();
    this.listeners.clear();
  }

  private async pruneMessages(): Promise<void> {
    try {
      const files = (await fs.readdir(this.messagesPath)).filter((file) => file.endsWith('.json')).sort();
      const expired = files.slice(0, Math.max(0, files.length - MAX_RETAINED_MESSAGES));
      await Promise.all(expired.map(async (file) => {
        await fs.unlink(resolve(this.messagesPath, file));
        this.processedMessageIds.delete(file);
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

// Helper Functions

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
