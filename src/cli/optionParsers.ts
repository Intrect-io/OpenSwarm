import { InvalidArgumentError } from 'commander';

export function parsePositiveIntegerOption(value: string): number {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError('must be a safe positive integer');
  }
  return parsed;
}

export function parseTcpPortOption(value: string): number {
  const port = parsePositiveIntegerOption(value);
  if (port > 65_535) {
    throw new InvalidArgumentError('must be a TCP port between 1 and 65535');
  }
  return port;
}

/** Default for every --port option that names the daemon: OPENSWARM_WEB_PORT, else 3847. */
export { daemonPort } from '../core/daemonPort.js';
