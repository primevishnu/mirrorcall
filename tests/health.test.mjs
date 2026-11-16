import test from 'node:test';
import assert from 'node:assert/strict';
import { videoStats, metric, sanitizeDiagnostic, healthMessage } from '../web/health.mjs';

const report = (...items) => new Map(items.map(item => [item.id, item]));
test('missing metrics remain unknown, while reported zero stays zero', () => {
  const { stats } = videoStats(new Map(), null, 0);
  for (const key of ['fps', 'inFps', 'loss', 'rtt', 'kbps', 'freezes']) assert.equal(stats[key], null);
  assert.equal(metric(stats.fps), 'Not reported');
  assert.equal(metric(0, ' fps'), '0 fps');
  assert.match(healthMessage(stats), /Not enough information/);
});
test('rates use monotonic counter deltas and preserve source-provided FPS', () => {
  const make = (bytes, frames, decoded, encode) => report(
    { id: 'out', type: 'outbound-rtp', kind: 'video', bytesSent: bytes, framesEncoded: frames, totalEncodeTime: encode, framesPerSecond: 30 },
    { id: 'in', type: 'inbound-rtp', kind: 'video', framesDecoded: decoded, packetsReceived: 99, packetsLost: 1 });
  const first = videoStats(make(1000, 100, 100, 1), null, 1000);
  const second = videoStats(make(501000, 160, 150, 1.6), first.sample, 3000).stats;
  assert.equal(second.kbps, 2000);
  assert.equal(second.fps, 30);
  assert.equal(second.inFps, 25);
  assert.ok(Math.abs(second.encodeMs - 10) < 0.001);
  assert.equal(second.loss, 1);
});
test('counter resets and different streams cannot produce fabricated rates', () => {
  const first = videoStats(report({ id: 'old', type: 'outbound-rtp', kind: 'video', framesEncoded: 100, bytesSent: 1000 }), null, 1000);
  for (const id of ['old', 'new']) {
    const next = videoStats(report({ id, type: 'outbound-rtp', kind: 'video', framesEncoded: 1, bytesSent: 10 }), first.sample, 2000).stats;
    assert.equal(next.fps, null); assert.equal(next.kbps, null);
  }
});
test('route and zero RTT are reported only with supporting transport data', () => {
  const { stats } = videoStats(report(
    { id: 't', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'pair', type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0 },
    { id: 'local', candidateType: 'host' }, { id: 'remote', candidateType: 'relay' }), null, 1);
  assert.equal(stats.rtt, 0); assert.equal(stats.route, 'TURN relay');
});
test('diagnostics remove IPv4, IPv6, setup links, SDP credentials and configured secrets', () => {
  const original = '11-08 17:20:30 host=192.168.1.9 peer=2001:db8::1 full=2001:db8:0:0:0:0:0:1 zone=fe80::2%wlan0 MC1.abcDEF123 https://example.com/secret a=ice-pwd:otherSecret\nconfigured=private-password';
  const clean = sanitizeDiagnostic(original, ['private-password']);
  for (const secret of ['192.168.1.9', '2001:db8', 'fe80::2', 'abcDEF123', 'example.com', 'otherSecret', 'private-password']) assert.ok(!clean.includes(secret));
  assert.ok(clean.includes('17:20:30'));
});
test('health text identifies reported limits without inferring a camera diagnosis', () => {
  assert.match(healthMessage({ limitation: 'cpu' }), /processing limit/);
  assert.match(healthMessage({ limitation: 'bandwidth' }), /bandwidth/);
  assert.match(healthMessage({ limitation: 'none' }), /does not rule out/);
});
