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
  file: string;
  action: 'modified' | 'created' | 'deleted';
  content?: string;
}

/**
 * Shared context between agents
 */
export interface SharedContext {
  stepOutputs: Record<string, string>;
  changedFiles: string[];
  errors: string[];
  metadata: Record<string, unknown>;
}

// Constants
const MAX_RETAINED_MESSAGES = 1000;
const BUS_DIR = '.openswarm_bus';

/**
 * Assert execution ID is valid
 */
function assertExecutionId(executionId: string): void {
  if (!executionId || typeof executionId !== 'string') {
    throw new Error('Invalid execution ID');
  }
}

/**
 * Agent Message Bus
 * Manages inter-agent communication via file system
 */
export class AgentBus {
  private executionId: string;
  private messagesPath: string;
  private listeners: Map<MessageType, Array<(msg: AgentMessage) => void | Promise<void>>> = new Map();
  private processedMessageIds: Set<string> = new Set();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollPromise: Promise<void> | null = null;

  constructor(executionId: string) {
    assertExecutionId(executionId);
    this.executionId = executionId;
    this.messagesPath = resolve(homedir(), BUS_DIR, executionId);
  }

  /**
   * Get execution ID
   */
  getExecutionId(): string {
    return this.executionId;
  }

  /**
   * Initialize bus directory
   */
  async init(): Promise<void> {
    await fs.mkdir(this.messagesPath, { recursive: true });
  }

  /**
   * Send a message
   */
  async send(message: Omit<AgentMessage, 'id' | 'timestamp' | 'executionId'>): Promise<void> {
    const fullMessage: AgentMessage = {
      ...message,
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      timestamp: Date.now(),
      executionId: this.executionId,
    };

    const fileName = `${fullMessage.timestamp}_${fullMessage.id}.json`;
    const filePath = resolve(this.messagesPath, fileName);
    await atomicWriteFile(filePath, JSON.stringify(fullMessage));
  }

  /**
   * Register a listener for a message type
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
      this.pollOnce().catch((err) => {
        console.warn(`[AgentBus] Poll cycle failed:`, err instanceof Error ? err.message : String(err));
      });
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
    } catch (error) {
      console.warn(`[AgentBus] checkNewMessages error:`, error instanceof Error ? error.message : String(error));
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
   * Clear all messages
   */
  async clearMessages(): Promise<void> {
    try {
      const files = await fs.readdir(this.messagesPath);
      for (const file of files.filter(f => f.endsWith('.json'))) {
        await fs.unlink(resolve(this.messagesPath, file));
      }
      this.processedMessageIds.clear();
    } catch {
      // Directory may not exist
    }
  }

  /**
   * Destroy the bus
   */
  async destroy(): Promise<void> {
    this.stopPolling();
    this.listeners.clear();
    this.processedMessageIds.clear();
    try {
      await fs.rm(this.messagesPath, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}

/**
 * Create a new bus
 */
export function createBus(executionId?: string): AgentBus {
  const id = executionId || `bus_${Date.now()}`;
  return new AgentBus(id);
}

/**
 * Connect to an existing bus
 */
export async function connectToBus(executionId: string): Promise<AgentBus | null> {
  try {
    const busPath = resolve(homedir(), BUS_DIR, executionId);
    if (!existsSync(busPath)) {
      return null;
    }
    const bus = new AgentBus(executionId);
    await bus.init();
    return bus;
  } catch {
    return null;
  }
}

/**
 * List active buses
 */
export async function listActiveBuses(): Promise<string[]> {
  try {
    const busDir = resolve(homedir(), BUS_DIR);
    if (!existsSync(busDir)) {
      return [];
    }
    const entries = await fs.readdir(busDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}