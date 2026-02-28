// ============================================
// OpenSwarm - CLI Adapter Base
// Shared spawn logic for all CLI adapters
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { CliAdapter, CliRunOptions, CliRunResult } from './types.js';
import { parseCliStreamChunk } from '../agents/cliStreamParser.js';
import { registerProcess } from './processRegistry.js';

/**
 * Spawn a CLI process using the given adapter and options.
 * Handles: temp file write, spawn with shell, timeout/SIGKILL,
 * stdout/stderr buffering, stream parsing via onLog, cleanup.
 */
export async function spawnCli(
  adapter: CliAdapter,
  options: CliRunOptions,
): Promise<CliRunResult> {
  const promptFile = `/tmp/openswarm-prompt-${Date.now()}.txt`;
  await fs.writeFile(promptFile, options.prompt);

  try {
    const { command, args } = adapter.buildCommand({
      ...options,
      // Pass the temp file path as the prompt so buildCommand can reference it
      prompt: promptFile,
    });

    const cmd = [command, ...args].join(' ');
    const startTime = Date.now();

    return await new Promise<CliRunResult>((resolve, reject) => {
      const proc = spawn(cmd, {
        shell: true,
        cwd: options.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Register process for tracking if context provided
      if (options.processContext && proc.pid) {
        registerProcess({
          pid: proc.pid,
          taskId: options.processContext.taskId,
          stage: options.processContext.stage,
          model: options.model,
          projectPath: options.cwd,
          spawnedAt: startTime,
          lastActivityAt: startTime,
        }, proc);
      }

      let stdout = '';
      let stderr = '';
      let streamBuffer = '';

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        if (options.onLog && adapter.capabilities.supportsStreaming) {
          streamBuffer = parseCliStreamChunk(text, options.onLog, streamBuffer);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const timeoutMs = options.timeoutMs ?? 300000;
      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          proc.kill('SIGKILL');
          reject(new Error(`${adapter.name} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (code !== 0 && code !== null) {
          console.error(`[${adapter.name}] CLI error:`, stderr.slice(0, 500));
          reject(new Error(`${adapter.name} CLI failed with code ${code}`));
          return;
        }

        resolve({ exitCode: code ?? 0, stdout, stderr, durationMs });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(new Error(`${adapter.name} spawn error: ${err.message}`));
      });
    });
  } finally {
    try {
      await fs.unlink(promptFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
