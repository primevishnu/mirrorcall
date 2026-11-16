// Transport-independent signaling logic shared by the Node server (server/index.mjs)
// and the Cloudflare Durable Object (worker/index.mjs). The server only relays
// opaque, end-to-end encrypted packets between at most two people per room.
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

const digest = value => createHash('sha256').update(String(value)).digest();
export const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));
const roomPattern = /^[A-Za-z0-9_-]{22}$/;
const admissionPattern = /^[A-Za-z0-9_-]{43}$/;
const clientPattern = /^[A-Za-z0-9_-]{22}$/;
const ivPattern = /^[A-Za-z0-9_-]{16}$/;
const dataPattern = /^[A-Za-z0-9_-]+$/;
// 4000-4999 are application close codes accepted by every WebSocket runtime.
export const CLOSE = { normal: 1000, shutdown: 1001, policy: 4008, replaced: 4000, stale: 4001 };

export function createSignalingCore({ accessKey, maxRooms = 1, getIceServers = async () => ({ iceServers: [], relayAvailable: false }), staleAfter = 30_000, authTimeout = 10_000, now = Date.now }) {
  if (!accessKey || accessKey.length < 24) throw new Error('SERVER_ACCESS_KEY must have at least 24 characters.');
  const rooms = new Map();
  const connections = new Set();
  let joinSequence = 0;

  const send = (conn, packet) => { if (!conn.closed) try { conn.socket.send(JSON.stringify(packet)); } catch {} };
  function removeFromRoom(conn, notify) {
    const room = rooms.get(conn.roomId);
    if (!room || !room.peers.delete(conn)) return;
    if (notify) for (const peer of room.peers) send(peer, { type: 'peer-left' });
    if (room.peers.size === 0) rooms.delete(conn.roomId);
  }
  function closeConn(conn, code, reason, notify) {
    if (conn.closed) return;
    clearTimeout(conn.timer);
    removeFromRoom(conn, notify);
    conn.closed = true;
    connections.delete(conn);
    try { conn.socket.close(code, reason); } catch {}
  }
  function fail(conn, code, message) { send(conn, { type: 'error', code, message }); closeConn(conn, CLOSE.policy, code, true); }

  async function join(conn, packet) {
    if (packet.type !== 'join' || typeof packet.accessKey !== 'string' || !safeEqual(packet.accessKey, accessKey)) return fail(conn, 'unauthorized', 'Check the server access key in Settings.');
    if (typeof packet.room !== 'string' || !roomPattern.test(packet.room) || typeof packet.admission !== 'string' || !admissionPattern.test(packet.admission)) return fail(conn, 'bad-room', 'Invalid private invitation.');
    if (packet.clientId !== undefined && (typeof packet.clientId !== 'string' || !clientPattern.test(packet.clientId))) return fail(conn, 'bad-room', 'Invalid private invitation.');
    const clientId = packet.clientId ?? null;
    let room = rooms.get(packet.room);
    if (room && !safeEqual(packet.admission, room.admission)) return fail(conn, 'wrong-key', 'This invitation does not match the private room.');
    let joinOrder = ++joinSequence;
    if (room) {
      // The same person reconnecting (for example after a Wi-Fi to mobile data switch)
      // replaces their previous connection instead of being treated as a third person.
      const previous = clientId && [...room.peers].find(peer => peer.clientId === clientId);
      if (previous) { joinOrder = previous.joinOrder; closeConn(previous, CLOSE.replaced, 'replaced', false); }
      // A peer that stopped sending heartbeats is gone even if its TCP connection never closed.
      for (const peer of [...room.peers]) if (now() - peer.lastSeen > staleAfter) closeConn(peer, CLOSE.stale, 'stale', true);
      room = rooms.get(packet.room);
      if (room && room.peers.size >= 2) return fail(conn, 'room-full', 'This room already has two people.');
    }
    if (!room) {
      if (rooms.size >= maxRooms) return fail(conn, 'server-full', 'Another private room is active. Wait until it ends.');
      room = { admission: packet.admission, peers: new Set() };
      rooms.set(packet.room, room);
    }
    clearTimeout(conn.timer);
    Object.assign(conn, { roomId: packet.room, peerId: randomBytes(16).toString('base64url'), clientId, joinOrder, ready: false });
    room.peers.add(conn);
    let ice = { iceServers: [], relayAvailable: false };
    try { ice = await getIceServers(conn.peerId); } catch {}
    if (conn.closed) return;
    send(conn, { type: 'joined', peerId: conn.peerId, iceServers: ice.iceServers, relayAvailable: !!ice.relayAvailable, serverTime: now() });
    conn.ready = true;
    const current = rooms.get(conn.roomId);
    if (!current?.peers.has(conn)) return;
    if (current.peers.size === 1) send(conn, { type: 'waiting' });
    else if ([...current.peers].every(peer => peer.ready)) {
      // Roles follow the original join order, so they stay stable across reconnects.
      [...current.peers].sort((a, b) => a.joinOrder - b.joinOrder).forEach((peer, i) => send(peer, { type: 'peer-ready', initiator: i === 0 }));
    }
  }

  function message(conn, text) {
    if (conn.closed) return;
    conn.lastSeen = now();
    if (now() - conn.rate.start > 10_000) conn.rate = { start: now(), count: 0 };
    if (++conn.rate.count > 150) return fail(conn, 'rate-limit', 'Too many requests.');
    let packet;
    try { packet = JSON.parse(text); } catch { return fail(conn, 'bad-message', 'Invalid message.'); }
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return fail(conn, 'bad-message', 'Invalid message.');
    if (!conn.roomId) { join(conn, packet).catch(() => fail(conn, 'server-error', 'Please try again.')); return; }
    if (packet.type === 'ping') return send(conn, { type: 'pong', serverTime: now() });
    if (packet.type !== 'signal' || typeof packet.iv !== 'string' || !ivPattern.test(packet.iv) || typeof packet.data !== 'string' || packet.data.length < 22 || packet.data.length > 90_000 || !dataPattern.test(packet.data)) return fail(conn, 'bad-signal', 'Invalid signal.');
    for (const peer of rooms.get(conn.roomId)?.peers || []) if (peer !== conn) send(peer, { type: 'signal', iv: packet.iv, data: packet.data });
  }

  return {
    rooms,
    connections,
    connect(socket) {
      const conn = { socket, roomId: null, closed: false, ready: false, lastSeen: now(), rate: { start: now(), count: 0 } };
      conn.timer = setTimeout(() => { if (!conn.roomId) fail(conn, 'auth-timeout', 'Please reconnect.'); }, authTimeout);
      connections.add(conn);
      return { message: text => message(conn, text), close: () => closeConn(conn, CLOSE.normal, '', true) };
    },
    sweep() { for (const conn of [...connections]) if (conn.roomId && now() - conn.lastSeen > staleAfter) closeConn(conn, CLOSE.stale, 'stale', true); },
    closeAll() { for (const conn of [...connections]) closeConn(conn, CLOSE.shutdown, 'shutdown', false); }
  };
}
