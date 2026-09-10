// ============================================
// OpenSwarm - usePipelineEvents (EPIC INT-1813 S5 / INT-1938)
// Connects to the daemon SSE stream and reduces events into pipeline state.
// Network/effect boundary — the pure reducer (pipelineEvents.ts) and parser
// (sse.ts parseSseFrames) carry the tested logic.
// ============================================

import { useEffect, useReducer, useState } from 'react';
import type { HubEvent } from '../../core/eventHub.js';
import { connectEventStream } from '../sse.js';
import { createCoalescer } from '../eventCoalescer.js';
import {
  reducePipelineEvent,
  reducePipelineEvents,
  initialPipelineState,
  type PipelineState,
} from '../pipelineEvents.js';

export interface PipelineEventsResult extends PipelineState {
  connected: boolean;
}

// Coalesce SSE bursts into at most one repaint per window. In the alternate
// screen every commit repaints the whole frame, so dispatching per event made
// the Pipeline tab flicker on every log/stage event. (INT-2407)
const DEFAULT_FLUSH_MS = 90;

type PipelineAction =
  | Parameters<typeof reducePipelineEvent>[1]
  | { type: 'reset' }
  | { type: 'batch'; events: HubEvent[] };

function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
  if (action.type === 'reset') return initialPipelineState;
  if (action.type === 'batch') return reducePipelineEvents(state, action.events);
  return reducePipelineEvent(state, action);
}

export function usePipelineEvents(
  port: number | undefined,
  flushMs: number = DEFAULT_FLUSH_MS,
): PipelineEventsResult {
  const [state, dispatch] = useReducer(pipelineReducer, initialPipelineState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    dispatch({ type: 'reset' });
    setConnected(false);
    if (!port) return;
    let disposed = false;
    // Buffer events and flush a single batched dispatch per window; connection
    // status stays immediate (not coalesced) so the live indicator is snappy.
    const coalescer = createCoalescer<HubEvent>({
      delayMs: flushMs,
      maxBatch: 256,
      onFlush: (events) => {
        if (!disposed) dispatch({ type: 'batch', events });
      },
    });
    const handle = connectEventStream({
      port,
      onEvent: (e) => { if (!disposed) coalescer.push(e); },
      onStatus: (status) => { if (!disposed) setConnected(status); },
    });
    return () => {
      disposed = true;
      coalescer.cancel();
      handle.close();
    };
  }, [port, flushMs]);

  return { ...state, connected };
}
