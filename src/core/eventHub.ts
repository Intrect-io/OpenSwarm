function sendToAllClients(data: string) {
  for (const res of sseClients) {
    try {
      // Enforce backpressure limit: disconnect clients with too much pending data
      if (res.connection && (res.connection as any).writableLength > MAX_PENDING_BYTES) {
        sseClients.delete(res);
        res.destroy();
        continue;
      }
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Maximum pending data in bytes before disconnecting SSE client (1MB)
const MAX_PENDING_BYTES = 1024 * 1024;

export function addSSEClient(res: ServerResponse, skipReplay = false): () => void {
  // Replay buffered events to new client so they see current state
  if (!skipReplay && replayBuffer.length > 0) {
    try {
      for (const event of replayBuffer) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch {
      // A client that cannot consume replay is already gone. Do not retain it
      // until a future broadcast happens to discover the failure again.
      return () => {};
    }
  }
  
  // Check if client's pending write queue is too large
  if (res.connection && (res.connection.bufferSize > MAX_PENDING_BYTES)) {
    res.destroy();
    return () => {};
  }
  
  sseClients.add(res);

  // Cleanup function that removes client from set
  const cleanup = () => {
    sseClients.delete(res);
    // Remove the close listener after cleanup to prevent memory leak
    res.removeListener('close', cleanup);
  };

  // Register close listener to auto-cleanup when client disconnects
  res.once('close', cleanup);

  return cleanup;
}