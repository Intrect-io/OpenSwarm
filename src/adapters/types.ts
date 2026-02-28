// ============================================
// OpenSwarm - CLI Adapter Types
// Interface definitions for CLI tool adapters
// ============================================

import type { WorkerResult, ReviewResult } from '../agents/agentPair.js';

// Re-export for convenience
export type { WorkerResult, ReviewResult };

/**
 * Raw result from a CLI process execution
 */
export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Context for process registry tracking
 */
export interface ProcessContext {
  taskId: string;
  stage: string;
}

/**
 * Options for running a CLI adapter
 */
export interface CliRunOptions {
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  model?: string;
  onLog?: (line: string) => void;
  processContext?: ProcessContext;
}

/**
 * Describes what a CLI adapter can do
 */
export interface AdapterCapabilities {
  supportsStreaming: boolean;
  supportsJsonOutput: boolean;
  supportsModelSelection: boolean;
  managedGit: boolean;
  supportedSkills: string[];
}

/**
 * CLI adapter interface — all adapters must implement this
 */
export interface CliAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  /** Check if the CLI tool is installed and available */
  isAvailable(): Promise<boolean>;

  /** Build the shell command and args for execution */
  buildCommand(options: CliRunOptions): { command: string; args: string[] };

  /** Parse raw CLI output into a WorkerResult */
  parseWorkerOutput(raw: CliRunResult): WorkerResult;

  /** Parse raw CLI output into a ReviewResult */
  parseReviewerOutput(raw: CliRunResult): ReviewResult;
}
