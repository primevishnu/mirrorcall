// Reporting only: this module never changes media parameters or starts a polling loop.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0 ? value : null;
export const metric = (value, suffix = '', digits = 0) => finite(value) ? `${value.toFixed(digits)}${suffix}` : 'Not reported';

export function sanitizeDiagnostic(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 3) text = text.split(secret).join('[private]');
  return text.replace(/MC1\.[\w-]+/g, 'MC1.[redacted]')
    .replace(/(?:https?|wss?|mirrorcall):\/\/\S+/gi, '[link redacted]')
    .replace(/a=(?:ice-pwd|ice-ufrag|fingerprint):[^\r\n]*/gi, '[SDP redacted]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[address]')
    .replace(/[0-9a-f:]+(?:%[\w.-]+)?/gi, token => token.includes('::') || (token.match(/:/g) || []).length >= 7 ? '[address]' : token);
}

export function videoStats(reports, previous, now) {
  const list = [...reports.values()];
  const video = type => list.find(r => r.type === type && (r.kind || r.mediaType) === 'video' && (r.frameWidth || r.framesEncoded || r.framesDecoded))
    || list.find(r => r.type === type && (r.kind || r.mediaType) === 'video');
  const out = video('outbound-rtp'), incoming = video('inbound-rtp');
  const transport = list.find(r => r.type === 'transport' && r.selectedCandidatePairId);
  const pair = reports.get(transport?.selectedCandidatePairId);
  const local = reports.get(pair?.localCandidateId), remote = reports.get(pair?.remoteCandidateId);
  const lost = nonnegative(incoming?.packetsLost), received = nonnegative(incoming?.packetsReceived);
  const s = {
    width: nonnegative(out?.frameWidth), height: nonnegative(out?.frameHeight), fps: nonnegative(out?.framesPerSecond),
    inWidth: nonnegative(incoming?.frameWidth), inHeight: nonnegative(incoming?.frameHeight), inFps: nonnegative(incoming?.framesPerSecond),
    encoder: out?.encoderImplementation, hardware: out?.powerEfficientEncoder, limitation: out?.qualityLimitationReason,
    codec: reports.get(out?.codecId)?.mimeType?.replace('video/', ''), freezes: nonnegative(incoming?.freezeCount),
    rtt: finite(pair?.currentRoundTripTime) ? Math.max(0, pair.currentRoundTripTime * 1000) : null,
    route: local?.candidateType && remote?.candidateType ? (local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'TURN relay' : 'Direct') : null,
    loss: lost !== null && received !== null && lost + received > 0 ? 100 * lost / (lost + received) : null,
    kbps: null, encodeMs: null
  };
  const sample = { at: now, outId: out?.id, inId: incoming?.id, bytes: nonnegative(out?.bytesSent), encoded: nonnegative(out?.framesEncoded), decoded: nonnegative(incoming?.framesDecoded), encodeSeconds: nonnegative(out?.totalEncodeTime) };
  const elapsed = previous && now - previous.at;
  const delta = key => previous && finite(sample[key]) && finite(previous[key]) && sample[key] >= previous[key] ? sample[key] - previous[key] : null;
  if (elapsed > 0) {
    if (sample.outId && sample.outId === previous.outId) {
      const bytes = delta('bytes'), frames = delta('encoded'), seconds = delta('encodeSeconds');
      if (bytes !== null) s.kbps = bytes * 8 / elapsed;
      if (s.fps === null && frames !== null) s.fps = frames * 1000 / elapsed;
      if (frames > 0 && seconds !== null) s.encodeMs = seconds * 1000 / frames;
    }
    if (s.inFps === null && sample.inId && sample.inId === previous.inId && delta('decoded') !== null) s.inFps = delta('decoded') * 1000 / elapsed;
  }
  return { stats: s, sample };
}

export function healthMessage(s) {
  if (s.limitation === 'cpu') return 'The sender reports a processing limit. This does not measure the camera sensor FPS.';
  if (s.limitation === 'bandwidth') return 'The sender reports limited connection bandwidth.';
  if (finite(s.loss) && s.loss >= 5) return 'Incoming packet loss was observed. Check both connections; this alone does not identify the cause.';
  if (s.limitation === 'none') return 'No encoder limit reported. This does not rule out camera, decoding or display issues.';
  return 'Not enough information to identify a bottleneck.';
}
