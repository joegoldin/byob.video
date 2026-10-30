export function mountHook(definition, el, channel) {
  const subscriptions = new Set();
  const telemetry = new Set(['sync:ping', 'video:drift_report', 'video:visibility']);
  const hook = {
    ...definition, el, serverAuthoritativeReconnect: true,
    handleEvent(event, callback) {
      const off = channel.on(event, callback);
      subscriptions.add(off);
      return off;
    },
    removeHandleEvent(off) { off(); subscriptions.delete(off); },
    pushEvent(event, payload, callback) {
      return channel.request(event, payload).then(result => callback?.(result)).catch(error => {
        if (channel.joined && !telemetry.has(event)) channel.emit('action:error', { message: error.message });
      });
    },
  };
  subscriptions.add(channel.on('status', status => {
    if (status.state === 'connected' && status.reconnected) hook.reconnected?.();
    if (status.state === 'disconnected') hook.disconnected?.();
  }));
  hook.mounted?.();
  return {
    hook,
    update() { hook.updated?.(); },
    destroy() {
      for (const off of subscriptions) off();
      subscriptions.clear();
      hook.destroyed?.();
    },
  };
}
