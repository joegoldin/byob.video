// Existing browser extensions use Phoenix Channels' JSON v2 serializer. Keep
// its five-element wire format while replacing the Phoenix transport/runtime.
export function parseFrame(input) {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > 65536) throw new Error('invalid_frame');
  let frame;
  try { frame = JSON.parse(input); } catch { throw new Error('invalid_frame'); }
  if (!Array.isArray(frame) || frame.length !== 5) throw new Error('invalid_frame');
  const [joinRef, ref, topic, event, payload] = frame;
  const validRef = value => value === null || (typeof value === 'string' && value.length <= 64);
  if (!validRef(joinRef) || !validRef(ref) || typeof topic !== 'string' || topic.length > 128 ||
      typeof event !== 'string' || !event.length || event.length > 64 ||
      !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_frame');
  return { joinRef, ref, topic, event, payload };
}

export function reply(frame, status, response) {
  return JSON.stringify([frame.joinRef, frame.ref, frame.topic, 'phx_reply', { status, response }]);
}

export function push(topic, joinRef, event, payload) {
  return JSON.stringify([joinRef, null, topic, event, payload]);
}
