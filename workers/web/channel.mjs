import { HttpSocket } from './http-socket.mjs';

export class RoomChannel {
  constructor({ origin, roomId, tabId, username, browserId, hasExtension = () => false, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket }) {
    this.origin = origin;
    this.roomId = roomId;
    this.tabId = tabId;
    this.username = username;
    this.browserId = browserId;
    this.hasExtension = hasExtension;
    this.fetch = fetch.bind(globalThis);
    this.WebSocket = WebSocket;
    this.listeners = new Map();
    this.pending = new Map();
    this.ref = 0;
    this.generation = 0;
    this.attempt = 0;
    this.stopped = true;
    this.joined = false;
    this.connectedBefore = false;
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  emit(event, payload) {
    for (const callback of this.listeners.get(event) ?? []) callback(payload);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    return this.connect();
  }

  async connect() {
    const generation = ++this.generation;
    this.abort = new AbortController();
    this.emit('status', { state: 'connecting' });
    try {
      const response = await this.fetch(`${this.origin}/session/${this.roomId}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab_id: this.tabId }), signal: this.abort.signal,
      });
      if (!response.ok) {
        if (response.status === 429) {
          this.attempt = Math.max(this.attempt, 5);
          const result = await response.json().catch(() => ({}));
          throw new Error(typeof result.error === 'string' ? result.error : 'Too many connection attempts. Retrying shortly.');
        }
        throw new Error('Could not establish your room session.');
      }
      const session = await response.json();
      if (this.stopped || generation !== this.generation) return;
      this.session = session;
      this.emit('session', session);
      const url = new URL('/socket/websocket', this.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('token', session.token);
      url.searchParams.set('vsn', '2.0.0');
      const http = this.useHttp === true;
      let socket;
      try { socket = http ? new HttpSocket(url.href, { fetch: this.fetch }) : new this.WebSocket(url.href); }
      catch (error) { if (!http) this.useHttp = true; throw error; }
      this.socket = socket;
      socket.addEventListener('message', event => {
        if (generation === this.generation) this.receive(event.data);
      });
      socket.addEventListener('close', () => {
        if (generation !== this.generation || this.stopped) return;
        this.joined = false;
        clearInterval(this.heartbeat);
        this.rejectPending('Connection interrupted; check the room before retrying an action.');
        this.emit('status', { state: 'disconnected' });
        this.scheduleReconnect();
      });
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new Error('Room connection timed out.')), http ? 12000 : 2500);
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error && !http) this.useHttp = true;
          error ? reject(error) : resolve();
        };
        socket.addEventListener('open', () => finish(), { once: true });
        socket.addEventListener('error', () => finish(new Error('Room connection failed.')), { once: true });
        socket.addEventListener('close', () => finish(new Error('Room connection closed.')), { once: true });
      });
      if (generation !== this.generation || this.stopped) return;
      this.joinRef = String(++this.ref);
      const state = await this.send('phx_join', { username: this.username(), browser_id: this.browserId, has_extension: this.hasExtension() }, `room:${this.roomId}`, this.joinRef, this.joinRef);
      if (generation !== this.generation || this.stopped) return;
      this.joined = true;
      this.attempt = 0;
      this.emit('status', { state: 'connected', reconnected: this.connectedBefore });
      this.connectedBefore = true;
      this.emit('ext:token', { token: session.token, user_id: session.user_id });
      this.emit('sync:state', state);
      this.emit('room:state', state);
      this.emit('ready:count', state.ready_count);
      this.emit('sb:settings', state.sb_settings);
      this.emit('sponsor:segments', { segments: state.sponsor_segments });
      this.heartbeat = setInterval(() => {
        this.send('heartbeat', {}, 'phoenix', null).catch(() => socket.close());
      }, 25000);
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.emit('connection:error', { message: error.message });
      this.socket?.close();
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.attempt++, 5));
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, delay);
  }

  request(event, payload = {}) {
    if (!this.joined) return Promise.reject(new Error('You are disconnected. Wait for the room to reconnect.'));
    return this.send(event, payload, `room:${this.roomId}`, this.joinRef);
  }

  send(event, payload, topic, joinRef, ref = String(++this.ref)) {
    if (this.socket?.readyState !== 1) return Promise.reject(new Error('Room connection is not open.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(ref); reject(new Error('No acknowledgement received; check the room before retrying.')); }, 12000);
      this.pending.set(ref, { resolve, reject, timer, topic, joinRef });
      try { this.socket.send(JSON.stringify([joinRef, ref, topic, event, payload])); }
      catch (error) { clearTimeout(timer); this.pending.delete(ref); reject(error); }
    });
  }

  receive(message) {
    let frame;
    try { frame = JSON.parse(message); } catch { this.socket.close(1002, 'Invalid channel message'); return; }
    if (!Array.isArray(frame) || frame.length !== 5) { this.socket.close(1002, 'Invalid channel frame'); return; }
    const [joinRef, ref, topic, event, payload] = frame;
    if (event === 'phx_reply') {
      const pending = this.pending.get(ref);
      if (!pending || pending.topic !== topic || pending.joinRef !== joinRef) return;
      clearTimeout(pending.timer);
      this.pending.delete(ref);
      if (payload?.status === 'ok') pending.resolve(payload.response);
      else pending.reject(new Error(payload?.response?.reason ?? payload?.response?.error ?? 'The room rejected that action.'));
    } else if (topic === `room:${this.roomId}` && joinRef === this.joinRef) {
      if (event === 'phx_error' || event === 'phx_close') this.socket.close();
      else this.emit(event, payload);
    }
  }

  rejectPending(message) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }

  stop() {
    this.stopped = true;
    this.joined = false;
    this.generation++;
    this.abort?.abort();
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearInterval(this.heartbeat);
    this.rejectPending('Room connection closed.');
    this.socket?.close();
  }
}
