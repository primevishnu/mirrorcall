import test from 'node:test';
import assert from 'node:assert/strict';
import { randomToken, deriveKeys, seal, unseal, parseInvite, validateServer } from '../web/crypto.mjs';

test('private signaling round-trips and rejects a different key, room, or modified packet', async () => {
  const room = randomToken(), secret = randomToken(32);
  const host = await deriveKeys(secret, room), guest = await deriveKeys(secret, room);
  assert.equal(host.admission, guest.admission);
  assert.equal(host.admission.length, 43);
  const payload = { kind: 'offer', description: 'private-media-fingerprint' };
  const packet = await seal(host.key, room, payload);
  assert.deepEqual(await unseal(guest.key, room, packet), payload);
  const wrong = await deriveKeys(randomToken(32), room);
  assert.notEqual(wrong.admission, host.admission);
  await assert.rejects(unseal(wrong.key, room, packet));
  await assert.rejects(unseal(guest.key, randomToken(), packet));
  await assert.rejects(unseal(guest.key, room, { ...packet, data: (packet.data[0] === 'A' ? 'B' : 'A') + packet.data.slice(1) }));
  assert.notEqual((await seal(host.key, room, payload)).iv, packet.iv);
});

test('invitations round-trip without including the server access key', () => {
  const room = randomToken(), secret = randomToken(32);
  const hash = new URLSearchParams({ server: 'https://call.example.com', room, key: secret });
  const parsed = parseInvite(`mirrorcall://invite#${hash}`);
  assert.deepEqual(parsed, { server: 'https://call.example.com', room, secret });
  assert.throws(() => parseInvite('mirrorcall://invite#room=short&key=short'));
  assert.throws(() => parseInvite(`javascript:alert(1)#${hash}`));
});

test('production endpoints require HTTPS and do not allow embedded credentials or paths', () => {
  assert.equal(validateServer('https://call.example.com/'), 'https://call.example.com');
  assert.equal(validateServer('http://127.0.0.1:8765'), 'http://127.0.0.1:8765');
  for (const value of ['http://call.example.com', 'https://u:p@call.example.com', 'https://call.example.com/path', 'https://call.example.com?secret=123', 'https://call.example.com#secret']) assert.throws(() => validateServer(value));
});

test('direct call codes round-trip compressed and reject damaged, oversized, or foreign text', async () => {
  const { packCode, unpackCode, randomToken } = await import('../web/crypto.mjs');
  const sdp = 'v=0\r\n' + 'a=candidate:1 1 udp 2122260223 192.168.1.20 54400 typ host generation 0\r\n'.repeat(40);
  const callId = randomToken();
  const code = await packCode({ t: 'offer', c: callId, s: sdp, n: 'Sam', m: true });
  assert.ok(code.startsWith('MC1.') && code.length < sdp.length / 3, `compressed to ${code.length} chars`);
  const message = `MirrorCall code. Copy this whole message:\n\n${code}\n`;
  assert.deepEqual(await unpackCode(message), { type: 'offer', callId, sdp, name: 'Sam', mirrored: true });
  await assert.rejects(unpackCode('hello'), /No MirrorCall code/);
  await assert.rejects(unpackCode(code.slice(0, -12)), /damaged/);
  const bomb = await packCode({ t: 'offer', c: callId, s: 'v=0' + 'a'.repeat(500_000) });
  await assert.rejects(unpackCode(bomb), /damaged/);
  const wrongShape = await packCode({ t: 'other', c: callId, s: sdp });
  await assert.rejects(unpackCode(wrongShape), /damaged/);
});
