import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { createCallServer } from '../server/index.mjs';

const accessKey = 'test-server-access-key-never-use-in-production';
const token = (n = 16) => randomBytes(n).toString('base64url');
async function start(t, options = {}) {
  const app = createCallServer({ accessKey, stunUrls: '', ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  return { ...app, url: `http://127.0.0.1:${app.server.address().port}` };
}
async function client(app, join, origin = 'https://appassets.androidplatform.net') {
  const ws = new WebSocket(app.url.replace('http', 'ws') + '/signal', { origin });
  const inbox = [], waiters = [];
  ws.on('error', () => {});
  ws.on('message', data => {
    const packet = JSON.parse(data);
    const index = waiters.findIndex(w => w.type === packet.type);
    if (index !== -1) { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(packet); }
    else inbox.push(packet);
  });
  await once(ws, 'open');
  const next = type => {
    const index = inbox.findIndex(p => p.type === type);
    if (index !== -1) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => { const entry = { type, resolve, timer: setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2500) }; waiters.push(entry); });
  };
  ws.send(JSON.stringify({ type: 'join', accessKey, ...join }));
  return { ws, next, inbox };
}

test('a third person cannot join; remaining person can accept a replacement peer', async t => {
  const app = await start(t), room = token(), admission = token(32);
  const first = await client(app, { room, admission }); await first.next('joined'); await first.next('waiting');
  const second = await client(app, { room, admission }); await second.next('joined');
  assert.equal((await first.next('peer-ready')).initiator, true);
  assert.equal((await second.next('peer-ready')).initiator, false);
  const third = await client(app, { room, admission }); assert.equal((await third.next('error')).code, 'room-full');
  second.ws.close(); await first.next('peer-left');
  const replacement = await client(app, { room, admission }); await replacement.next('joined');
  assert.equal((await first.next('peer-ready')).initiator, true);
  assert.equal((await replacement.next('peer-ready')).initiator, false);
});

test('server access and private-room admission are independently enforced', async t => {
  const app = await start(t), room = token(), admission = token(32);
  const denied = await client(app, { room, admission, accessKey: 'wrong' }); assert.equal((await denied.next('error')).code, 'unauthorized');
  const first = await client(app, { room, admission }); await first.next('joined');
  const wrongKey = await client(app, { room, admission: token(32) }); assert.equal((await wrongKey.next('error')).code, 'wrong-key');
  assert.equal(app.rooms.get(room).peers.size, 1);
  const otherRoom = await client(app, { room: token(), admission: token(32) }); assert.equal((await otherRoom.next('error')).code, 'server-full');
});

test('signaling forwards opaque encrypted packets and never echoes to the sender', async t => {
  const app = await start(t), join = { room: token(), admission: token(32) };
  const first = await client(app, join); await first.next('joined');
  const second = await client(app, join); await second.next('joined'); await first.next('peer-ready'); await second.next('peer-ready');
  const packet = { type: 'signal', iv: token(12), data: token(200) };
  first.ws.send(JSON.stringify(packet));
  assert.deepEqual(await second.next('signal'), packet);
  assert.equal(first.inbox.some(p => p.type === 'signal'), false);
});

test('malformed JSON closes a socket without crashing the server', async t => {
  const app = await start(t), join = { room: token(), admission: token(32) };
  const first = await client(app, join); await first.next('joined');
  first.ws.send('{'); assert.equal((await first.next('error')).code, 'bad-message');
  const response = await fetch(app.url + '/healthz'); assert.equal(response.status, 200);
});

test('TURN credentials last a full day, expire, and are issued only after authentication', async t => {
  const secret = 'server-side-test-relay-secret';
  const app = await start(t, { turnUrls: 'turn:turn.example.com:3478', turnSecret: secret });
  const first = await client(app, { room: token(), admission: token(32) });
  const joined = await first.next('joined');
  assert.equal(joined.relayAvailable, true);
  const turn = joined.iceServers[0];
  assert.equal(turn.credential, createHmac('sha1', secret).update(turn.username).digest('base64'));
  const expiration = Number(turn.username.split(':')[0]);
  assert.ok(expiration > Date.now() / 1000 + 86_000 && expiration <= Date.now() / 1000 + 86_401);
  assert.equal(JSON.stringify(joined).includes(secret), false);
});

test('unknown origins and non-public files are rejected', async t => {
  const app = await start(t);
  const ws = new WebSocket(app.url.replace('http', 'ws') + '/signal', { origin: 'https://untrusted.example' });
  await assert.rejects(once(ws, 'open'), /403/);
  for (const file of ['/.env', '/server/index.mjs', '/package.json', '/%2e%2e/.env']) assert.equal((await fetch(app.url + file)).status, 404);
  const page = await fetch(app.url);
  assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
});
