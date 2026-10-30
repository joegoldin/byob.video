export class HttpSocket extends EventTarget {
  constructor(url, { fetch = globalThis.fetch } = {}) {
    super();
    this.fetch = fetch.bind(globalThis);
    this.url = new URL(url);
    this.url.protocol = this.url.protocol === 'wss:' ? 'https:' : 'http:';
    this.url.searchParams.set('connection', crypto.randomUUID());
    this.readyState = 0;
    this.abort = new AbortController();
    this.posts = Promise.resolve();
    this.queued = 0;
    void this.connect();
  }

  endpoint(path) {
    const url = new URL(this.url);
    url.pathname = path;
    return url.href;
  }

  async connect() {
    try {
      const response = await this.fetch(this.endpoint('/socket/stream'), { credentials: 'same-origin', signal: this.abort.signal });
      if (!response.ok || !response.body) throw new Error('HTTP stream failed');
      if (this.readyState === 3) { await response.body.cancel(); return; }
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      const reader = this.reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';
      try {
        while (this.readyState === 1) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 4 * 1024 * 1024) throw new Error('HTTP frame too large');
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const message = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (message) this.dispatchEvent(new MessageEvent('message', { data: message }));
          }
        }
      } finally { reader.releaseLock(); }
      this.close();
    } catch {
      if (this.readyState !== 3) this.dispatchEvent(new Event('error'));
      this.close();
    }
  }

  send(frame) {
    if (this.readyState !== 1) throw new Error('HTTP channel is not open');
    if (this.queued >= 64) { this.close(); throw new Error('HTTP channel is congested'); }
    this.queued++;
    // Never retry a POST: its mutation may have committed before a network error.
    this.posts = this.posts.then(async () => {
      if (this.readyState !== 1) return;
      const response = await this.fetch(this.endpoint('/socket/message'), {
        method: 'POST', credentials: 'same-origin', signal: this.abort.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frame }),
      });
      if (!response.ok) throw new Error('HTTP send failed');
    }).catch(() => this.close()).finally(() => { this.queued--; });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.abort.abort();
    void this.reader?.cancel().catch(() => {});
    this.dispatchEvent(new Event('close'));
  }
}
