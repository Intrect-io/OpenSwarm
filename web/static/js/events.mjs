// SSE subscription with exponential-backoff reconnect. (INT-3388)
//
// On reconnect, `skipReplay=1` avoids re-receiving the server's replay buffer
// (the initial connection consumes it once to seed state).

export class EventStream {
  #listeners = new Map();
  #source = null;
  #backoffMs = 1000;
  #firstConnect = true;
  #closed = false;

  on(type, handler) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(handler);
    return this;
  }

  connect() {
    if (this.#closed) return;
    const url = this.#firstConnect ? '/api/events' : '/api/events?skipReplay=1';
    const source = new EventSource(url);
    this.#source = source;

    source.onopen = () => {
      this.#backoffMs = 1000;
      this.#emit('$open', {});
    };
    source.onmessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (parsed && typeof parsed.type === 'string') {
        this.#emit(parsed.type, parsed.data ?? {});
      }
    };
    source.onerror = () => {
      source.close();
      if (this.#source === source) this.#source = null;
      this.#emit('$down', {});
      if (this.#closed) return;
      this.#firstConnect = false;
      const delay = this.#backoffMs;
      this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000);
      setTimeout(() => this.connect(), delay);
    };
  }

  close() {
    this.#closed = true;
    this.#source?.close();
    this.#source = null;
  }

  #emit(type, data) {
    const handlers = this.#listeners.get(type);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[events] handler for ${type} threw`, err);
      }
    }
  }
}
