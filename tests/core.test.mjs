import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSignalingCore, CLOSE } from '../server/core.mjs';

const accessKey = 'test-server-access-key-never-use-in-production';
const token = (n = 16) => randomBytes(n).toString('base64url');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  let clock = 1_000_000;
  const core = createSignalingCore({ accessKey, now: () => clock, authTimeout: 60_000, ...options });
  const open = () => {
    const socket = { sent: [], closed: null, send(text) { this.sent.push(JSON.parse(text)); }, close(code, reason) { this.closed = { code, reason }; } };
    const conn = core.connect(socket);
    socket.conn = conn;
    socket.of = type => socket.sent.filter(p => p.type === type);
    socket.join = async extra => { conn.message(JSON.stringify({ type: 'join', accessKey, ...extra })); await tick(); };
    return socket;
  };
  return { core, open, advance: ms => { clock += ms; } };
}

test('the same person reconnecting replaces their stale connection instead of filling the room', async () => {
  const { open } = harness(), room = token(), admission = token(32), hostId = token(), guestId = token();
  const host = open(); await host.join({ room, admission, clientId: hostId });
  const guest = open(); await guest.join({ room, admission, clientId: guestId });
  assert.equal(host.of('peer-ready').at(-1).initiator, true);
  // The guest's phone switched networks: its old socket never closed, and it connects again.
  const guestAgain = open(); await guestAgain.join({ room, admission, clientId: guestId });
  assert.deepEqual(guestAgain.of('error'), []);
  assert.equal(guest.closed.code, CLOSE.replaced);
  assert.equal(host.of('peer-left').length, 0, 'a seamless replacement is not reported as leaving');
  assert.equal(host.of('peer-ready').length, 2);
  assert.equal(host.of('peer-ready').at(-1).initiator, true, 'roles stay stable after reconnecting');
  assert.equal(guestAgain.of('peer-ready').at(-1).initiator, false);
  // The host reconnecting keeps the host role too.
  const hostAgain = open(); await hostAgain.join({ room, admission, clientId: hostId });
  assert.equal(hostAgain.of('peer-ready').at(-1).initiator, true);
  assert.equal(guestAgain.of('peer-ready').at(-1).initiator, false);
});

test('a silent peer is evicted so a rejoin is not blocked by a full room', async () => {
  const { open, advance, core } = harness(), room = token(), admission = token(32);
  const host = open(); await host.join({ room, admission, clientId: token() });
  const guest = open(); await guest.join({ room, admission, clientId: token() });
  advance(20_000); host.conn.message(JSON.stringify({ type: 'ping' }));
  advance(15_000); // the guest has now been silent for 35 seconds
  const rejoin = open(); await rejoin.join({ room, admission, clientId: token() });
  assert.deepEqual(rejoin.of('error'), []);
  assert.equal(guest.closed.code, CLOSE.stale);
  assert.equal(host.of('peer-left').length, 1);
  assert.equal(rejoin.of('peer-ready').length, 1);
  // The periodic sweep also removes silent peers without waiting for a rejoin.
  advance(31_000); host.conn.message(JSON.stringify({ type: 'ping' })); core.sweep();
  assert.equal(rejoin.closed.code, CLOSE.stale);
  assert.equal(host.of('peer-left').length, 2);
});

test('heartbeats are answered with the server time, and a third distinct person is still refused', async () => {
  const { open } = harness(), room = token(), admission = token(32);
  const host = open(); await host.join({ room, admission, clientId: token() });
  assert.equal(typeof host.of('joined')[0].serverTime, 'number');
  host.conn.message(JSON.stringify({ type: 'ping' }));
  assert.equal(host.of('pong').length, 1);
  const guest = open(); await guest.join({ room, admission, clientId: token() });
  const third = open(); await third.join({ room, admission, clientId: token() });
  assert.equal(third.of('error')[0].code, 'room-full');
  assert.equal(guest.closed, null);
});

test('peer-ready waits until both people have their relay settings', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { open } = harness({ getIceServers: async () => { if (++calls === 1) await gate; return { iceServers: [{ urls: ['stun:example.org'] }], relayAvailable: false }; } });
  const room = token(), admission = token(32);
  const first = open(); const firstJoin = first.join({ room, admission });
  const second = open(); await second.join({ room, admission });
  assert.equal(second.of('peer-ready').length, 0, 'not before the first person has received its settings');
  release(); await firstJoin; await tick();
  assert.equal(first.sent.findIndex(p => p.type === 'joined') < first.sent.findIndex(p => p.type === 'peer-ready'), true);
  assert.equal(second.of('peer-ready').length, 1);
});
