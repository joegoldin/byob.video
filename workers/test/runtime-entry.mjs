// Test-only clock/storage probes; Wrangler deploys src/index.mjs, never this module.
import router, { Room as NativeRoom, VideoPool as NativePool } from '../src/index.mjs';

export class Room extends NativeRoom {
  async expireIdleForTest() {
    if (this.ctx.getWebSockets().length) throw new Error('Test room must have no sockets');
    await this.persist({ ...this.room, empty_deadline: Date.now() - 1 });
  }
  async inspectIdleForTest() {
    return { deadline: this.room.empty_deadline, expired_at: this.room.idle_expired_at, alarm: await this.ctx.storage.getAlarm(), connections: this.ctx.getWebSockets().length };
  }
}

export class VideoPool extends NativePool {
  async inspectAlarmForTest() { return { alarm: await this.ctx.storage.getAlarm(), jobs: this.refresh.jobs.length }; }
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/__test\/idle\/([a-z0-9]{8})$/);
    if (match) {
      const room = env.ROOMS.getByName(match[1]);
      if (request.method === 'POST') await room.expireIdleForTest();
      return Response.json(await room.inspectIdleForTest());
    }
    if (url.pathname === '/__test/pool-alarm') return Response.json(await env.POOL.getByName('global').inspectAlarmForTest());
    return router.fetch(request, env, context);
  },
};
