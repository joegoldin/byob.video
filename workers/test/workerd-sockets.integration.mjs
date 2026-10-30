import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'byob-sockets-'));
const config = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
const connections = [], analytics = [], upstreamHosts = [];
let embedCaptured;
const embedCapture = new Promise(resolve => { embedCaptured = resolve; });
let mf;

async function request(path, { method = 'GET', key, body, browserId } = {}) {
  const response = await mf.dispatchFetch(`https://byob.test${path}`, {
    method, headers: { ...(browserId ? { 'X-Byob-Browser-ID': browserId } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status < 400, true, `HTTP ${response.status} for ${path.split('?')[0]}`);
  return response.json();
}

async function connect(ticket, role, username) {
  const endpoint = role === 'extension' ? 'extension' : 'socket';
  const response = await mf.dispatchFetch(`https://byob.test/${endpoint}/websocket?token=${ticket.token}&vsn=2.0.0`, { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  socket.accept();
  connections.push(socket);
  const frames = [], waiters = [];
  socket.addEventListener('message', event => {
    frames.push(JSON.parse(event.data));
    for (const waiter of [...waiters]) waiter.check();
  });
  const wait = (predicate, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const timeoutError = new Error(`Expected WebSocket event did not arrive: ${predicate}`);
    const waiter = { check() {
      const index = frames.findIndex(predicate);
      if (index === -1) return;
      clearTimeout(timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      resolve(frames.splice(index, 1)[0]);
    } };
    const timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      reject(timeoutError);
    }, timeoutMs);
    waiters.push(waiter);
    waiter.check();
  });
  let sequence = 0;
  const topic = `${role === 'extension' ? 'extension' : 'room'}:${ticket.room_id}`;
  const send = async (event, payload = {}, requestedTopic = topic) => {
    const ref = String(++sequence);
    socket.send(JSON.stringify(['1', ref, requestedTopic, event, payload]));
    return (await wait(frame => frame[1] === ref && frame[3] === 'phx_reply'))[4];
  };
  const joined = await send('phx_join', { username });
  assert.equal(joined.status, 'ok');
  return { socket, frames, send, wait, joined: joined.response };
}

try {
  await build({ entryPoints: [join(root, 'test/runtime-entry.mjs')], outfile: join(temp, 'worker.mjs'), bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
  mf = new Miniflare({ ...convertV4MiniflareOptions({
    name: 'byob-test', modules: true, modulesRoot: temp, scriptPath: join(temp, 'worker.mjs'), compatibilityDate: config.compatibility_date,
    durableObjects: { ROOMS: { className: 'Room', useSQLite: true }, POOL: { className: 'VideoPool', useSQLite: true } },
    bindings: { TOKEN_SECRET: randomBytes(32).toString('base64url'), YOUTUBE_API_KEY: 'test-provider-key', POSTHOG_API_KEY: 'fixture-project-key' },
    ratelimits: Object.fromEntries(config.ratelimits.map(({ name, ...binding }) => [name, binding])),
    cf: false,
    outboundService: async request => {
      const upstream = new URL(request.url);
      upstreamHosts.push(upstream.hostname);
      if (upstream.hostname === 'us.i.posthog.com') {
        const body = await request.json();
        analytics.push(...body.batch);
        const embed = body.batch.find(entry => entry.event === 'video_embed_blocked');
        if (embed) embedCaptured(embed);
        return Response.json({ status: 1 });
      }
      if (upstream.hostname === 'www.reddit.com') return Response.json({ data: { children: [] } });
      if (upstream.hostname === 'www.googleapis.com') {
        if (upstream.pathname.endsWith('/videos')) {
          const ids = upstream.searchParams.has('chart') ? Array.from({ length: 12 }, (_, index) => `pool${String(index).padStart(7, '0')}`) : upstream.searchParams.get('id').split(',');
          return Response.json({ items: ids.map(id => ({ id, snippet: { title: 'Fixture video', channelTitle: 'Fixture channel', thumbnails: { high: { url: 'https://i.ytimg.com/fixture.jpg' } } }, contentDetails: { duration: 'PT5M' }, status: { embeddable: true } })) });
        }
        if (upstream.pathname.endsWith('/playlistItems')) return Response.json({ items: ['dQw4w9WgXcQ', 'abcdefghijk'].map((id, position) => ({ snippet: { title: `Playlist ${position}`, position, thumbnails: { medium: { url: 'https://i.ytimg.com/fixture.jpg' } } }, contentDetails: { videoId: id } })) });
        if (upstream.pathname.endsWith('/playlists')) return Response.json({ items: [{ snippet: { title: 'Fixture playlist' }, contentDetails: { itemCount: 2 } }] });
        assert.ok(upstream.pathname.endsWith('/commentThreads'));
        const more = upstream.searchParams.has('pageToken');
        return Response.json({ items: [{ snippet: { topLevelComment: { snippet: { authorDisplayName: 'Viewer', textDisplay: more ? 'Second page' : 'Watch at 1:23', likeCount: 2 } }, totalReplyCount: 1 } }], nextPageToken: more ? null : 'page2', pageInfo: { totalResults: 2 } });
      }
      if (new URL(request.url).hostname === 'sponsor.ajay.app') return Response.json([{ segment: [1, 2], category: 'sponsor', actionType: 'skip', UUID: 'fixture-segment', videoDuration: 300 }]);
      assert.equal(new URL(request.url).hostname, 'www.youtube.com');
      return Response.json({ title: 'Fixture video', author_name: 'Fixture channel', thumbnail_url: 'https://i.ytimg.com/cover.jpg' });
    },
  }), telemetry: { enabled: false }, unsafeInspectDurableObjects: true });
  await mf.ready;
  const browserId = '12345678-1234-4234-8234-123456789abc';
  const created = (await request('/api/rooms', { method: 'POST', browserId })).data;
  const path = `/api/rooms/${created.room_id}`, key = created.api_key;
  const ticketA = await request(`/session/${created.room_id}`, { method: 'POST', body: { tab_id: 'alice' } });
  const ticketB = await request(`/session/${created.room_id}`, { method: 'POST', body: { tab_id: 'bob' } });
  const alice = await connect(ticketA, 'browser', 'Alice');
  const bob = await connect(ticketB, 'browser', 'Bob');
  const extension = await connect(ticketA, 'extension', 'Stale extension name');
  assert.equal((await alice.send('room:credentials')).response.api_key, key);
  assert.equal((await extension.send('room:credentials')).status, 'error');
  assert.equal(JSON.stringify(bob.frames).includes(key), false, 'room credentials must not be broadcast to other viewers');
  assert.equal(JSON.stringify(alice.joined).includes(key), false, 'public room snapshots never carry the API key');
  assert.equal(Object.hasOwn(extension.joined, 'users'), false);
  assert.equal(extension.joined.queue_size, 0);
  const extensionPing = await extension.send('sync:ping', { t1: 456 });
  assert.equal(extensionPing.response.t1, 456, 'extension clock probes receive their timestamps in the channel reply');
  const extensionState = await extension.send('sync:request_state');
  assert.equal(extensionState.response.queue_size, 0, 'extension state requests return state in the channel reply');
  assert.equal((await extension.send('debug:log', { message: 'private-diagnostic-fixture' })).status, 'ok');
  assert.equal((await alice.send('debug:log', { message: 'private-diagnostic-fixture' })).response.reason, 'extension_required');
  assert.equal(JSON.stringify(bob.frames).includes('private-diagnostic-fixture'), false);
  assert.equal((await alice.send('video:embed_blocked', { code: 150, url: 'https://private.example/video', video_id: 'private-video' })).status, 'ok');
  assert.equal((await alice.send('analytics:has_extension')).status, 'ok');
  assert.equal((await extension.send('analytics:has_extension')).response.reason, 'browser_required');
  const embed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Analytics capture did not arrive; received events: ${analytics.map(entry => entry.event).join(',')}; upstream hosts: ${upstreamHosts.join(',')}`)), 5000);
    embedCapture.then(value => { clearTimeout(timer); resolve(value); });
  });
  assert.deepEqual(Object.keys(embed.properties).sort(), ['distinct_id', 'error_code', 'room_id', 'source_type']);
  assert.equal(embed.properties.error_code, 150);
  assert.ok(analytics.some(entry => entry.event === 'room_created' && entry.properties.distinct_id === browserId));
  assert.ok(analytics.some(entry => entry.event === 'room_joined'));
  for (const privateValue of [key, ticketA.token, 'private.example', 'private-video', 'Alice', 'Bob']) assert.equal(JSON.stringify(analytics).includes(privateValue), false);
  console.log('PASS: optional browser-only analytics captures legacy events without URLs, names, keys or tickets');
  await extension.send('video:tabs_resync', { tab_ids: [41], ready_tab_ids: [41] });
  const ready = (await extension.wait(frame => frame[3] === 'ready:count' && frame[4].ready === 1))[4];
  assert.ok(ready.users_with_open_tabs.includes(ticketA.user_id));
  const users = (await request(`${path}/users`, { key })).data.users;
  assert.equal(users.find(user => user.id === `ext:${ticketA.user_id}`).username, 'Alice');
  assert.equal((await alice.send('sync:request_state', {}, 'room:other')).status, 'error');
  assert.equal((await alice.send('sync:ping', { t1: 123 })).status, 'ok');
  assert.equal((await alice.wait(frame => frame[3] === 'sync:pong'))[4].t1, 123);

  assert.deepEqual(await alice.send('add_url', { url: `https://byob.test/room/${created.room_id}`, mode: 'now' }), { status: 'error', response: { reason: 'self_reference' } });
  assert.equal((await alice.send('add_url', { url: 'watch this https://youtu.be/dQw4w9WgXcQ', mode: 'now' })).status, 'ok');
  const changed = (await extension.wait(frame => frame[3] === 'video:change'))[4];
  assert.equal(changed.media_item.source_id, 'dQw4w9WgXcQ');
  for (const peer of [alice, bob, extension]) assert.equal((await peer.send('video:loaded', { item_id: changed.media_item.id })).status, 'ok');
  await alice.wait(frame => frame[3] === 'sync:play' && frame[4].user_id === null, 1000);
  await alice.wait(frame => frame[3] === 'queue:updated' && frame[4].queue[0]?.title === 'Fixture video');
  assert.equal((await request(`${path}/queue`, { key })).data.queue[0].title, 'Fixture video');
  const sponsor = (await alice.wait(frame => frame[3] === 'sponsor:segments'))[4];
  assert.equal(sponsor.video_id, 'dQw4w9WgXcQ');
  assert.deepEqual(sponsor.segments[0].segment, [1, 2]);
  const comments = (await alice.wait(frame => frame[3] === 'comments:updated'))[4];
  assert.equal(comments.comments[0].text, 'Watch at 1:23');
  assert.equal(comments.next_page_token, 'page2');
  const storage = await mf.unsafeGetDurableObjectStorage('byob-test', 'Room', { name: created.room_id });
  await storage.exec('CREATE TABLE test_room_writes (count INTEGER NOT NULL)');
  await storage.exec('INSERT INTO test_room_writes VALUES (0)');
  await storage.exec('CREATE TRIGGER test_count_room_updates AFTER UPDATE ON room_state BEGIN UPDATE test_room_writes SET count = count + 1; END');
  await storage.exec('CREATE TRIGGER test_count_room_inserts AFTER INSERT ON room_state BEGIN UPDATE test_room_writes SET count = count + 1; END');
  bob.frames.length = 0;
  const page = await alice.send('comments:load_more', { page_token: comments.next_page_token });
  assert.equal(page.response.comments[0].text, 'Second page');
  assert.equal(page.response.next_page_token, null);
  assert.equal((await storage.exec('SELECT count FROM test_room_writes'))[0].count, 0, 'private comment pagination must not write room state');
  const directPreview = await alice.send('preview_url', { url: 'https://example.com/private-preview.mp4' });
  assert.equal(directPreview.response.preview.title, 'private-preview.mp4');
  assert.equal((await storage.exec('SELECT count FROM test_room_writes'))[0].count, 0, 'URL previews must not write room state');
  assert.equal(JSON.stringify(bob.frames).includes('private-preview.mp4'), false);
  assert.equal(JSON.stringify(bob.frames).includes('Second page'), false, 'pagination is private to the requesting viewer');
  assert.equal((await extension.send('video:media_info', { title: 'Extension title', item_id: changed.media_item.id })).status, 'ok');
  assert.equal((await request(`${path}/queue`, { key })).data.queue[0].title, 'Extension title');
  assert.equal((await extension.send('video:live_status', { is_live: true, item_id: changed.media_item.id })).status, 'ok');
  await alice.wait(frame => frame[3] === 'live:status' && frame[4].is_live === true);
  assert.equal((await extension.send('video:live_status', { is_live: false, item_id: changed.media_item.id })).status, 'ok');
  await alice.wait(frame => frame[3] === 'live:status' && frame[4].is_live === false);
  await request(`${path}/pause`, { method: 'POST', key, body: { position: 10 } });
  await request(`${path}/play`, { method: 'POST', key, body: { position: 10 } });
  const checkpointBefore = (await storage.exec('SELECT state_json FROM room_state'))[0].state_json;
  await storage.exec('UPDATE test_room_writes SET count = 0');
  alice.frames.length = 0;
  bob.frames.length = 0;
  assert.equal((await alice.send('video:drift_report', { drift_ms: -900, observed_l_ms: 220, noise_floor_ms: 0 })).status, 'ok');
  assert.equal((await alice.send('video:drift_report', { drift_ms: -900, observed_l_ms: 220, noise_floor_ms: 0 })).status, 'ok');
  const seek = (await alice.wait(frame => frame[3] === 'sync:seek_command'))[4];
  assert.ok(seek.position >= 10.22);
  assert.equal(bob.frames.some(frame => frame[3] === 'sync:seek_command'), false, 'a targeted correction must not seek the healthy peer');
  assert.equal((await storage.exec('SELECT state_json FROM room_state'))[0].state_json, checkpointBefore, 'drift reports must not alter the durable checkpoint');
  assert.equal((await storage.exec('SELECT count FROM test_room_writes'))[0].count, 0, 'SQL triggers must observe zero room writes, including identical-value updates');

  alice.frames.length = 0;
  await mf.unsafeEvictDurableObject('byob-test', 'Room', { name: created.room_id, webSockets: 'hibernate' });
  assert.equal(alice.socket.readyState, 1, 'hibernation must retain the live connection');
  assert.equal((await alice.send('video:drift_report', { drift_ms: 0, observed_l_ms: 0 })).status, 'ok');
  const decision = (await alice.wait(frame => frame[3] === 'sync:client_stats' && frame[4].user_id === ticketA.user_id))[4];
  assert.equal(decision.learned_l_ms, 220, 'learned latency survives actual object eviction');
  assert.equal(decision.seek_streak, 1, 'per-user correction state survives actual object eviction');
  const restoredState = (await alice.send('sync:request_state')).response;
  assert.equal(restoredState.sponsor_segments[0].uuid, 'fixture-segment');
  await alice.send('video:visibility', { hidden: true });
  assert.ok((await storage.exec('SELECT count FROM test_room_writes'))[0].count > 0, 'the write counter must detect an actual durable mutation');
  alice.frames.length = 0;
  await alice.send('video:drift_report', { drift_ms: -5000, observed_l_ms: 1000, user_id: ticketB.user_id });
  assert.equal(alice.frames.some(frame => frame[3] === 'sync:seek_command'), false);
  const hiddenDecision = (await alice.wait(frame => frame[3] === 'sync:client_stats' && frame[4].user_id === ticketA.user_id))[4];
  assert.equal(hiddenDecision.learned_l_ms, 220, 'hidden tabs cannot mutate their correction state');
  assert.equal(JSON.stringify(alice.frames).includes(key), false);
  assert.equal((await extension.send('video:update_url', { url: 'https://example.com/handoff.mp4' })).status, 'ok');
  const handoff = (await extension.wait(frame => frame[3] === 'video:change' && frame[4].media_item.url === 'https://example.com/handoff.mp4'))[4];
  assert.equal(handoff.media_item.id, changed.media_item.id);
  assert.equal(handoff.media_item.source_type, 'direct_url');
  for (const peer of [alice, bob, extension]) assert.equal((await peer.send('video:loaded', { item_id: handoff.media_item.id })).status, 'ok');
  await alice.wait(frame => frame[3] === 'sync:play' && frame[4].user_id === null, 1000);
  assert.equal((await request(`${path}/queue`, { key })).data.queue[0].url, 'https://example.com/handoff.mp4');
  const playlistUrl = 'https://www.youtube.com/watch?v=abcdefghijk&list=PL123';
  const playlistPreview = await alice.send('preview_url', { url: playlistUrl });
  assert.equal(playlistPreview.response.preview.items[0].video_id, 'abcdefghijk');
  const playlistAdded = await alice.send('playlist:add', { url: playlistUrl, mode: 'queue', scope: 'selected', selected: ['abcdefghijk'] });
  assert.equal(playlistAdded.response.added_count, 1);
  await alice.wait(frame => frame[3] === 'queue:updated' && frame[4].queue.some(item => item.source_id === 'abcdefghijk' && item.title === 'Fixture video'));
  assert.equal((await request(`${path}/queue`, { key })).data.queue.length, 2);
  assert.equal((await alice.send('round:start', { mode: 'voting' })).status, 'ok');
  const round = (await alice.wait(frame => frame[3] === 'round:started'))[4];
  assert.equal(round.candidates.length, 5);
  assert.equal((await bob.send('round:cancel', { round_id: round.id })).status, 'error');
  const winner = round.candidates[0].external_id;
  for (const peer of [alice, bob]) assert.equal((await peer.send('round:vote', { round_id: round.id, external_id: winner })).status, 'ok');
  const revealed = (await alice.wait(frame => frame[3] === 'round:revealed' && frame[4].mode === 'voting', 18000))[4];
  assert.equal(revealed.winner_external_id, winner);
  await mf.unsafeEvictDurableObject('byob-test', 'Room', { name: created.room_id, webSockets: 'hibernate' });
  await alice.wait(frame => frame[3] === 'round:finalized');
  assert.equal((await request(`${path}/queue`, { key })).data.queue.length, 3);
  const poolStorage = await mf.unsafeGetDurableObjectStorage('byob-test', 'VideoPool', { name: 'global' });
  let picked;
  for (let attempt = 0; attempt < 40; attempt++) {
    picked = (await poolStorage.exec('SELECT last_picked_at FROM video_pool WHERE external_id = ?', winner))[0]?.last_picked_at;
    if (picked) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(picked > 0, 'the durable winner outbox records shared pool repeat-decay timestamps');
  assert.equal((await alice.send('round:start', { mode: 'roulette' })).status, 'ok');
  const roulette = (await alice.wait(frame => frame[3] === 'round:started' && frame[4].mode === 'roulette'))[4];
  assert.equal(roulette.candidates.length, 12);
  const spin = (await alice.wait(frame => frame[3] === 'round:revealed' && frame[4].mode === 'roulette', 8000))[4];
  assert.equal(typeof spin.seed, 'number');
  await mf.unsafeEvictDurableObject('byob-test', 'Room', { name: created.room_id, webSockets: 'hibernate' });
  await alice.wait(frame => frame[3] === 'round:finalized', 10000);
  assert.equal((await request(`${path}/queue`, { key })).data.queue.length, 4);
  assert.equal((await extension.send('video:rate', { rate: 1.5 })).status, 'ok');
  const popupRate = (await extension.wait(frame => frame[3] === 'sync:rate' && frame[4].rate === 1.5))[4];
  assert.equal(typeof popupRate.current_time, 'number');
  assert.equal(popupRate.user_id, `ext:${ticketA.user_id}`);
  const browserRate = (await alice.wait(frame => frame[3] === 'sync:rate' && frame[4].rate === 1.5))[4];
  assert.deepEqual(browserRate, popupRate);
  assert.deepEqual(await request('/__test/pool-alarm'), { alarm: null, jobs: 0 }, 'an unused, refreshed pool has no recurring alarm');
  const idle = (await request('/api/rooms', { method: 'POST' })).data;
  await request(`/__test/idle/${idle.room_id}`, { method: 'POST' });
  let idleState;
  for (let attempt = 0; attempt < 40; attempt++) {
    idleState = await request(`/__test/idle/${idle.room_id}`);
    if (idleState.expired_at != null && idleState.alarm === null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(idleState.expired_at > 0);
  assert.equal(idleState.deadline, null);
  assert.equal(idleState.alarm, null, 'idle retirement is one-shot, not a recurring room timer');
  assert.equal((await request(`/api/rooms/${idle.room_id}`, { key: idle.api_key })).data.room_id, idle.room_id, 'idle expiry must preserve the durable room and API key');
  console.log('PASS: real channels, media services, shared pool and rounds, hibernation, idle retirement and zero recurring idle alarms');
} finally {
  for (const socket of connections) if (socket.readyState === 1) socket.close(1000, 'Test complete');
  if (mf) await mf.dispose();
  await rm(temp, { recursive: true, force: true });
}
