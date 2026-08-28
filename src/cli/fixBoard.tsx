// ============================================
// OpenSwarm - `openswarm fix` live worker board (INT-2446)
// ============================================
//
// Effectful Ink boundary for the fix-worker fan-out: renders the shared
// AuditBoard (mode="fix") to stderr so runFixCommand's orchestration stays
// ink-free and unit-testable. TTY-only — returns null when stderr isn't a TTY
// so scripted/piped runs keep the plain per-area line output. Same board the
// review --max fix pass uses, so the two commands look identical. (INT-2006 / INT-2260)

import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { AuditBoard } from '../tui/components/AuditBoard.js';
import type { AuditArea } from './reviewAudit.js';
import type { FixProgress } from './reviewFixPass.js';

export interface FixBoardHandle {
  /** Feed one fan-out event to the live board. */
  emit: (e: FixProgress) => void;
  /** Tear the board down (call before printing anything else to stderr). */
  unmount: () => void;
}

/**
 * Mount the live fix board over `areas`. Returns null when stderr is not a TTY
 * (scripted/piped runs), so the caller falls back to plain line logging. Rendered
 * to stderr so stdout stays clean for anything piped. (INT-2446)
 */
export function renderFixBoard(areas: AuditArea[], concurrency: number): FixBoardHandle | null {
  if (!(process.stderr as NodeJS.WriteStream).isTTY) return null;
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const board = render(<AuditBoard areas={areas} concurrency={concurrency} events={events} mode="fix" />, {
    stdout: process.stderr as unknown as NodeJS.WriteStream,
  });
  return {
    emit: (e) => events.emit('progress', e),
    unmount: () => board.unmount(),
  };
}
