import { resolveBaseRef } from '../support/worktreeManager.js';
import { discoverVerifyCommands } from '../verify/discover.js';
import { loadVerifyManifest } from '../verify/manifest.js';
import { runVerify } from '../verify/runner.js';
import type { TesterResult } from './tester.js';
import type { VerifyConfig } from '../core/types.js';
import type { VerifyCommand } from '../verify/manifest.js';
import { isInfraError } from '../adapters/errorClassification.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const VERIFY_INPUTS = ['.openswarm/verify.yaml'];

export async function captureVerifyInputFingerprint(projectPath: string): Promise<string> {
  const hash = createHash('sha256');
  for (const relativePath of VERIFY_INPUTS) {
    hash.update(relativePath).update('\0');
    try { hash.update(await readFile(join(projectPath, relativePath))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('<missing>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface TrustedVerifyPlan {
  commands: VerifyCommand[];
  packageJsonByDirectory: Record<string, string>;
}

async function capturePackageJsons(projectPath: string, commands: VerifyCommand[]): Promise<Record<string, string>> {
  const packages: Array<[string, string]> = [];
  const root = resolve(projectPath);
  for (const command of commands) {
    let directory = resolve(root, command.cwd ?? '.');
    while (directory === root || directory.startsWith(`${root}/`)) {
      const source = await readFile(join(directory, 'package.json'), 'utf8').catch(() => undefined);
      if (source !== undefined) {
        packages.push([relative(root, directory), source]);
        break;
      }
      if (directory === root) break;
      directory = dirname(directory);
    }
  }
  return Object.fromEntries(packages);
}

export async function loadTrustedVerifyPlan(projectPath: string, config: VerifyConfig): Promise<TrustedVerifyPlan> {
  if (!config.enabled) return { commands: [], packageJsonByDirectory: {} };
  const loaded = await loadVerifyManifest(projectPath);
  // A checked-in manifest error is a task/configuration failure, not transient
  // infrastructure: fail closed instead of silently falling back to an LLM.
  if (loaded.error) throw new Error(`verify-config: ${loaded.error}`);
  const commands = (loaded.manifest?.commands ?? await discoverVerifyCommands(projectPath)).slice(0, config.maxCommands);
  return { commands, packageJsonByDirectory: await capturePackageJsons(projectPath, commands) };
}

/** Returns null only when the repository exposes no deterministic verify commands. */
export async function runDeterministicTester(
  projectPath: string,
  config: VerifyConfig,
  trustedCommands?: VerifyCommand[],
  trustedPackageJsonByDirectory?: Record<string, string>,
): Promise<TesterResult | null> {
  if (!config.enabled) return null;
  const plan = trustedCommands ? { commands: trustedCommands, packageJsonByDirectory: trustedPackageJsonByDirectory ?? {} }
    : await loadTrustedVerifyPlan(projectPath, config);
  const commands = plan.commands;
  if (commands.length === 0) return null;

  const base = await resolveBaseRef(projectPath).catch((error) => {
    throw new Error(`verify-runner: failed to resolve base ref: ${error instanceof Error ? error.message : String(error)}`);
  });
  const evidence = await runVerify({
    projectPath, commands, baseRef: base.ref, trustedPackageJsonByDirectory: plan.packageJsonByDirectory,
  });
  const infra = evidence.find((item) => item.headStatus === 'infra'
    || (item.headStatus === 'fail' && item.baseStatus === 'infra'));
  if (infra) {
    throw new Error(`verify-runner: ${infra.command.name} infrastructure failure: ${infra.rawOutputTail}`);
  }
  const headFailures = evidence.filter((item) => item.headStatus === 'fail');
  const newFailures = headFailures.filter((item) => item.newFailure);
  return {
    success: !config.blockOnNewFailures || newFailures.length === 0,
    testsPassed: evidence.filter((item) => item.headStatus === 'pass').length,
    testsFailed: headFailures.length,
    output: evidence.map((item) => `[${item.command.name}] ${item.rawOutputTail}`).join('\n'),
    failedTests: headFailures.map((item) => item.command.name),
    deterministic: true,
    verificationEvidence: evidence,
  };
}

export async function runTesterWithVerification(options: {
  projectPath: string;
  verify?: VerifyConfig;
  trustedCommands?: VerifyCommand[];
  trustedPackageJsonByDirectory?: Record<string, string>;
  trustedInputFingerprint?: string;
  fallback: () => Promise<TesterResult>;
  onInfra?: (error: unknown) => void;
}): Promise<TesterResult> {
  if (options.verify?.enabled) {
    try {
      if (options.trustedInputFingerprint
        && await captureVerifyInputFingerprint(options.projectPath) !== options.trustedInputFingerprint) {
        throw new Error('verify-config: verification inputs changed after worker execution');
      }
      const deterministic = await runDeterministicTester(
        options.projectPath, options.verify, options.trustedCommands, options.trustedPackageJsonByDirectory,
      );
      if (deterministic) return deterministic;
    } catch (error) {
      if (!isInfraError(error)) throw error;
      options.onInfra?.(error);
    }
  }
  return await options.fallback();
}
