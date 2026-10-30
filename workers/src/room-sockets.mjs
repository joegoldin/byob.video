import { parseFrame, reply, push } from './protocol.mjs';
import { channelState, channelEvent, driftReport } from './channel.mjs';
import { joinPeer, leavePeer } from './peers.mjs';
import { transitionPlayback, seekPlayback, mediaLoaded, setVisibility, changePlaybackRate } from './playback.mjs';
import { recordDrift, adjustRoomClock, currentPosition } from './room-sync.mjs';
import { videoEnded } from './queue.mjs';
import { updateTabs } from './tabs.mjs';
import { roomCommand } from './commands.mjs';
import { fetchComments, fetchCommentReplies } from './comments.mjs';
import { fetchPreview, addPlaylist } from './preview.mjs';
import { startRound } from './room-rounds.mjs';
import { trackAnalytics } from './analytics.mjs';

export class RoomSockets {
  constructor(owner) {
    this.owner = owner;
    this.reports = {};
    const state = owner.room;
    if (!state) return;
    for (const socket of owner.ctx.getWebSockets()) {
      const peer = socket.deserializeAttachment();
      if (!peer?.joined || !state.users[peer.userId]) continue;
      state.users[peer.userId] = { ...state.users[peer.userId], connected: true, hidden: peer.hidden ?? false };
      if (peer.decision) state.user_sync_states[peer.userId] = peer.decision;
      if (peer.report) {
        this.reports[peer.userId] = peer.report;
        state.drift_samples[peer.userId] = { drift_ms: peer.report.drift_ms, updated_at: peer.reportAt };
      }
      for (const field of ['last_clock_adjust_at', 'last_heartbeat_at', 'last_correction_at']) state[field] = Math.max(state[field], peer[field] ?? 0);
    }
  }

  analytics(peer, event, properties = {}) {
    if (peer.role !== 'browser') return;
    trackAnalytics(this.owner.env, this.owner.ctx, event, peer.browserId ?? peer.ownerId.split(':')[0], { room_id: this.owner.room.room_id, ...properties });
  }

  upgrade(ownerId, role, siteHost, connection = null) {
    if (!this.owner.room) return new Response('Room not found', { status: 404 });
    if (this.owner.ctx.getWebSockets().length >= 32) return new Response('Room connection limit reached', { status: 429 });
    if (connection && this.owner.ctx.getWebSockets(`http:${connection}`).length) return new Response('Connection already exists', { status: 409 });
    const [client, server] = Object.values(new WebSocketPair());
    const userId = role === 'extension' ? `ext:${ownerId}` : ownerId;
    this.owner.ctx.acceptWebSocket(server, connection ? [userId, `http:${connection}`] : [userId]);
    server.serializeAttachment({ userId, ownerId, role, siteHost, connection, joined: false, topic: null, joinRef: null, windowAt: 0, messageCount: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }

  send(socket, peer, event, payload) {
    if (socket.readyState === 1) socket.send(push(peer.topic, peer.joinRef, event, payload));
  }

  checkpoint(socket, peer) {
    const state = this.owner.room;
    socket.serializeAttachment({
      ...peer, decision: state.user_sync_states[peer.userId] ?? null,
      report: this.reports[peer.userId] ?? null, reportAt: state.drift_samples[peer.userId]?.updated_at ?? null,
      hidden: state.users[peer.userId]?.hidden ?? false,
      last_clock_adjust_at: state.last_clock_adjust_at, last_heartbeat_at: state.last_heartbeat_at,
      last_correction_at: state.last_correction_at,
    });
  }

  broadcast(events, snapshots = false) {
    for (const socket of this.owner.ctx.getWebSockets()) {
      const peer = socket.deserializeAttachment();
      if (!peer?.joined || socket.readyState !== 1) continue;
      for (const event of events) {
        const outgoing = channelEvent(event, peer, this.reports);
        if (outgoing) this.send(socket, peer, ...outgoing);
      }
      if (snapshots && peer.role !== 'extension') this.send(socket, peer, 'room:state', channelState(this.owner.room, peer, Date.now()));
      this.checkpoint(socket, peer);
    }
  }

  async message(socket, message) {
    let frame;
    const peer = socket.deserializeAttachment();
    try {
      frame = parseFrame(message);
      const now = Date.now();
      if (now - peer.windowAt >= 1000) { peer.windowAt = now; peer.messageCount = 0; }
      if (++peer.messageCount > 60) { socket.close(1008, 'Message rate limit exceeded'); return; }
      socket.serializeAttachment(peer);
      if (frame.topic === 'phoenix' && frame.event === 'heartbeat') {
        socket.send(reply(frame, 'ok', {}));
        return;
      }
      const expectedTopic = `${peer.role === 'extension' ? 'extension' : 'room'}:${this.owner.room.room_id}`;
      if (frame.topic !== expectedTopic) throw new Error('unauthorized_topic');
      if (frame.event === 'phx_join') {
        if (peer.joined) throw new Error('already_joined');
        const result = joinPeer(this.owner.room, peer.userId, frame.payload.username, peer.role === 'extension', now);
        peer.joined = true;
        if (typeof frame.payload.browser_id === 'string' && /^[a-f0-9-]{36}$/.test(frame.payload.browser_id)) peer.browserId = frame.payload.browser_id;
        peer.topic = frame.topic;
        peer.joinRef = frame.joinRef ?? frame.ref;
        socket.serializeAttachment(peer);
        const current = result.state.current_index === null ? null : result.state.queue[result.state.current_index];
        if (current?.source_type === 'youtube' && result.state.sponsor_segments.length === 0) result.state = this.owner.metadata.enqueue(result.state, current, now, 'sponsor');
        await this.owner.persist(result.state);
        socket.send(reply(frame, 'ok', channelState(this.owner.room, peer, now)));
        this.broadcast(result.events, true);
        this.analytics(peer, 'room_joined', { has_extension: frame.payload.has_extension === true });
        return;
      }
      if (!peer.joined) throw new Error('not_joined');
      if (frame.event === 'phx_leave') {
        socket.send(reply(frame, 'ok', {}));
        socket.close(1000, 'Channel left');
        return;
      }
      if (['analytics:has_extension', 'video:embed_blocked'].includes(frame.event)) {
        if (peer.role !== 'browser') throw new Error('browser_required');
        if (frame.event === 'analytics:has_extension') this.analytics(peer, '$identify', { has_extension: true });
        else this.analytics(peer, 'video_embed_blocked', { source_type: 'youtube_restricted', error_code: frame.payload.code });
        socket.send(reply(frame, 'ok', {}));
        return;
      }
      if (frame.event === 'room:credentials') {
        if (peer.role !== 'browser') throw new Error('browser_required');
        // Match the existing room settings permission, but never broadcast keys
        // or include them in the public room/player snapshot.
        socket.send(reply(frame, 'ok', { api_key: this.owner.room.api_key }));
        return;
      }
      if (frame.event === 'sync:ping') {
        if (typeof frame.payload.t1 !== 'number' || !Number.isFinite(frame.payload.t1)) throw new Error('invalid_ping');
        const pong = { t1: frame.payload.t1, t2: now, t3: Date.now() };
        if (peer.role !== 'extension') this.send(socket, peer, 'sync:pong', pong);
        socket.send(reply(frame, 'ok', pong));
        return;
      }
      if (frame.event === 'sync:request_state') {
        const snapshot = channelState(this.owner.room, peer, now);
        if (peer.role !== 'extension') this.send(socket, peer, 'sync:state', snapshot);
        socket.send(reply(frame, 'ok', snapshot));
        return;
      }
      if (['preview_url', 'url:preview', 'playlist:add', 'comments:load', 'comments:load_more', 'comments:replies', 'round:start'].includes(frame.event)) {
        if (peer.role !== 'browser') throw new Error('browser_required');
        if (!(await this.owner.env.API_READ_LIMITER.limit({ key: `services:${this.owner.room.room_id}:${peer.userId}` })).success) throw new Error('rate_limited');
      }
      if (frame.event === 'round:start') {
        if (!['voting', 'roulette'].includes(frame.payload.mode)) throw new Error('invalid_round');
        if (this.owner.room.round) throw new Error('round_active');
        if ((this.owner.room.pending_pool_picks?.length ?? 0) >= 100) throw new Error('pool_unavailable');
        const excluded = this.owner.room.queue.filter(item => item.source_type === 'youtube').map(item => item.source_id);
        const candidates = await this.owner.env.POOL.getByName('global').pick(excluded, frame.payload.mode === 'voting' ? 15 : 36);
        const currentIds = new Set(this.owner.room.queue.filter(item => item.source_type === 'youtube').map(item => item.source_id));
        const result = startRound(this.owner.room, frame.payload.mode, peer.userId, candidates.filter(candidate => !currentIds.has(candidate.external_id)), Date.now());
        await this.owner.persist(result.state);
        this.broadcast(result.events, true);
        socket.send(reply(frame, 'ok', { round_id: result.state.round.id }));
        return;
      }
      if (['preview_url', 'url:preview', 'playlist:add'].includes(frame.event)) {
        const preview = await fetchPreview(frame.payload.url, this.owner.env, [peer.siteHost]);
        if (frame.event !== 'playlist:add') socket.send(reply(frame, 'ok', preview));
        else {
          const result = addPlaylist(this.owner.room, peer, preview.preview, frame.payload, Date.now());
          for (const item of result.metadata_items) result.state = this.owner.metadata.enqueue(result.state, item, Date.now());
          await this.owner.persist(result.state);
          this.broadcast(result.events, true);
          socket.send(reply(frame, 'ok', { added_count: result.added_count }));
          if (result.added_count) this.analytics(peer, 'video_added', { source_type: 'youtube' });
        }
        return;
      }
      if (['comments:load', 'comments:load_more', 'comments:replies'].includes(frame.event)) {
        const item = this.owner.room.queue[this.owner.room.current_index];
        if (item?.source_type !== 'youtube') {
          socket.send(reply(frame, 'ok', { comments: [], next_page_token: null, total_count: 0, video_id: null }));
          return;
        }
        if (frame.event === 'comments:replies' && frame.payload.video_id !== item.source_id) {
          socket.send(reply(frame, 'ok', { stale: true }));
          return;
        }
        const result = frame.event === 'comments:replies'
          ? await fetchCommentReplies(item.source_id, frame.payload.parent_id, frame.payload.page_token ?? null, this.owner.env)
          : await fetchComments(item.source_id, frame.payload.page_token ?? null, this.owner.env);
        const current = this.owner.room.queue[this.owner.room.current_index];
        if (current?.id !== item.id || current.url !== item.url) socket.send(reply(frame, 'ok', { stale: true }));
        else socket.send(reply(frame, result.error ? 'error' : 'ok', result));
        return;
      }
      let result;
      const state = this.owner.room;
      let payload = frame.payload;
      switch (frame.event) {
        case 'video:tab_opened':
        case 'video:tab_closed':
        case 'video:ready':
        case 'video:unready':
        case 'video:tabs_resync': result = updateTabs(state, peer, frame.event, payload); break;
        case 'video:all_closed':
          if (peer.role !== 'extension') throw new Error('extension_required');
          result = state.play_state === 'playing' ? transitionPlayback(state, 'pause', peer.userId, currentPosition(state, now), now) : { state, events: [] };
          break;
        case 'video:play': result = transitionPlayback(state, 'play', peer.userId, payload.position, now); break;
        case 'video:pause': result = transitionPlayback(state, 'pause', peer.userId, payload.position, now); break;
        case 'video:seek': result = seekPlayback(state, peer.userId, payload.position, now); break;
        case 'video:loaded': result = mediaLoaded(state, peer.userId, payload.item_id, now); break;
        case 'video:visibility':
          if (typeof payload.hidden !== 'boolean') throw new Error('invalid_visibility');
          result = setVisibility(state, peer.userId, payload.hidden, now);
          break;
        case 'video:ended':
          result = videoEnded(state, payload.item_id ?? payload.index ?? state.queue[state.current_index]?.id, now);
          break;
        case 'video:rate': result = changePlaybackRate(state, peer.userId, payload.rate, now); break;
        case 'video:state': {
          if (peer.role !== 'extension') throw new Error('extension_required');
          const position = payload.position ?? 0;
          if (typeof position !== 'number' || !Number.isFinite(position)) throw new Error('invalid_position');
          const expected = currentPosition(state, now);
          const raw = Math.round((position - expected) * 1000);
          if (payload.playing || payload.hooked) this.broadcast([['extension_player_state', {
            hooked: payload.hooked === true, position, duration: Number.isFinite(payload.duration) ? payload.duration : 0,
            playing: payload.playing === true, user_id: peer.userId,
          }]]);
          payload = { ...payload, raw_drift_ms: raw, drift_ms: raw - (payload.offset_ms ?? 0), server_position: Math.round(expected * 10) / 10, play_state: payload.playing ? 'playing' : 'paused' };
          // State reports feed the same authoritative decision path as drift reports.
        }
        case 'video:drift':
        case 'video:drift_report': {
          const report = driftReport(payload, peer, state, now);
          this.reports[peer.userId] = report;
          result = recordDrift(state, peer.userId, report, now);
          this.owner.room = result.state;
          const tick = this.tick(now);
          if (tick.durable) await this.owner.persist(tick.state);
          else this.owner.room = tick.state;
          this.broadcast([...result.events, ...tick.events]);
          socket.send(reply(frame, 'ok', {}));
          return;
        }
        default: result = roomCommand(state, peer, frame.event, payload, now);
      }
      result.state = this.owner.metadata.enqueue(result.state, result.metadata_item, now);
      if (result.state !== state) await this.owner.persist(result.state);
      this.broadcast(result.events, true);
      if (['add_url', 'queue:add'].includes(frame.event) && result.metadata_item) this.analytics(peer, 'video_added', { source_type: result.metadata_item.source_type });
      socket.send(reply(frame, 'ok', {}));
    } catch (error) {
      const allowed = ['rate_limited', 'unauthorized_topic', 'already_joined', 'not_joined', 'invalid_ping', 'invalid_visibility', 'invalid_stats', 'invalid_position', 'invalid_rate', 'invalid_tab', 'invalid_index', 'invalid_url', 'invalid_username', 'invalid_settings', 'invalid_live_status', 'invalid_media_info', 'invalid_playlist_request', 'no_items', 'queue_full', 'invalid_round', 'round_active', 'no_candidates', 'not_authorized', 'pool_unavailable', 'too_many_tabs', 'extension_required', 'browser_required', 'debounced', 'unsupported_event'];
      if (frame && ['invalid_url', 'self_reference', 'drm_site'].includes(error.code)) socket.send(reply(frame, 'error', { reason: error.code, service: error.service }));
      else if (frame && allowed.includes(error.message)) socket.send(reply(frame, 'error', { reason: error.message }));
      else socket.close(error.message === 'invalid_frame' ? 1007 : 1011, 'Invalid message or unavailable room');
    }
  }

  tick(now) {
    let state = this.owner.room;
    const events = [];
    let durable = false;
    if (now - state.last_clock_adjust_at >= 5000) {
      const adjusted = adjustRoomClock(state, now);
      durable = adjusted.state !== state;
      state = { ...adjusted.state, last_clock_adjust_at: now };
      events.push(...adjusted.events);
    }
    const item = state.current_index === null ? null : state.queue[state.current_index];
    if (!item?.is_live && now - state.last_heartbeat_at >= 5000) {
      events.push(['state_heartbeat', { play_state: state.play_state, current_time: currentPosition(state, now), server_time: now }]);
      state = { ...state, last_heartbeat_at: now };
    }
    if (!item?.is_live && state.play_state === 'playing' && now - state.last_correction_at >= 1000) {
      events.push(['sync_correction', { expected_time: currentPosition(state, now), server_time: now }]);
      state = { ...state, last_correction_at: now };
    }
    return { state, events, durable };
  }

  async close(socket) {
    // Hibernating sockets require an explicit reply to the close handshake;
    // without it browsers remain CLOSING and cannot start their reconnect path.
    if (socket.readyState === 1 || socket.readyState === 2) socket.close(1000, 'Channel closed');
    const peer = socket.deserializeAttachment();
    if (!peer?.joined) return;
    const other = this.owner.ctx.getWebSockets(peer.userId).some(candidate => candidate !== socket && candidate.readyState === 1 && candidate.deserializeAttachment()?.joined);
    if (other) return;
    if (peer.decision) this.owner.room.user_sync_states[peer.userId] = peer.decision;
    await this.owner.persist(leavePeer(this.owner.room, peer.userId, Date.now()));
  }
}
