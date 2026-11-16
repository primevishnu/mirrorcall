import { randomToken, deriveKeys, seal, unseal, parseInvite, validateServer, packCode, unpackCode } from './crypto.mjs';
import { createEngine } from './engine.mjs';
import { sanitizeDiagnostic, videoStats, metric, healthMessage } from './health.mjs';

const $ = id => document.getElementById(id);
const native = globalThis.Android;
// Android app: Google's native libwebrtc engine; desktop browsers and tests: the page's WebRTC.
const engine = createEngine(native);
// Upper limits only. WebRTC congestion control adapts below them to the live network.
const profiles = {
  hd: { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000, degradation: 'maintain-framerate', label: 'HIGH' },
  balanced: { width: 1280, height: 720, fps: 30, bitrate: 2_500_000, degradation: 'maintain-framerate', label: 'BALANCED' },
  data: { width: 640, height: 360, fps: 15, bitrate: 400_000, degradation: 'maintain-framerate', label: 'SAVE DATA' }
};
const AUDIO_BITRATE = 64_000;
const PING_EVERY = 10_000, PONG_TIMEOUT = 8_000, CONNECT_TIMEOUT = 10_000, RECONNECT_WINDOW = 120_000;
const REPLAY_WINDOW = 300_000, SEEN_LIMIT = 1024, MAX_MESSAGES = 200;
// Direct mode needs no account: public STUN servers only tell each phone its public address.
const PUBLIC_STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const GATHER_LIMIT = 6000, DIRECT_CONNECT_LIMIT = 45_000;

let config = { name: '', server: '', accessKey: '', quality: 'balanced', relayOnly: false, remember: false, mirrored: true, turnUrl: '', turnUser: '', turnPass: '', controlTimeout: 4000, startMuted: false, startCameraOff: false, front: true };
try { Object.assign(config, JSON.parse(native ? native.getSettings() : localStorage.getItem('mirrorcall.settings') || '{}')); } catch {}
if (!profiles[config.quality]) config.quality = 'balanced';
config.mirrored = config.mirrored !== false;
if (![0, 4000, 8000].includes(config.controlTimeout)) config.controlTimeout = 4000;
config.startMuted = config.startMuted === true; config.startCameraOff = config.startCameraOff === true; config.front = config.front !== false;
config.displayCompatibility = config.displayCompatibility === true;
// One-time move from the old 1080p default to the steadier 720p default (Best stays available).
const migrateQuality = !config.qualityV2;
if (migrateQuality) { if (config.quality === 'hd') config.quality = 'balanced'; config.qualityV2 = true; }
// Native capture requests a higher minimum frame rate; actual performance still depends on
// the camera, encoder, lighting and network. Keep explicit quality choices on later launches.
const migrateNative = engine.native && !config.qualityV3;
if (migrateNative) { config.quality = 'hd'; config.qualityV3 = true; }

const state = {
  inRoom: false, mode: null, direct: null, busy: false, micOn: !config.startMuted, cameraOn: !config.startCameraOff, front: config.front, speaker: true, routeName: '', suspended: false, interrupted: false,
  mediaPromise: null,
  socket: null, socketOpenedAt: 0, joined: false, lastHeard: 0, pingSentAt: 0, awaitingPong: false,
  reconnects: 0, lostSince: null, clockOffset: 0, iceServers: [], relayAvailable: false, warnedRelay: false,
  conn: null,
  room: null, keys: null, clientId: null, session: null, initiator: false, offerId: 0,
  pendingIce: [], seen: new Set(), peer: {}, connectedAt: null, stats: {}, lastBytes: null,
  epoch: 0, peerEpoch: 0, invite: '', backPressedAt: 0, wakeLock: null,
  sharedSequence: 0, timers: {}, incoming: Promise.resolve(), outgoing: Promise.resolve(), lastSummary: null, statsAt: null, statsPending: false
};
class IntegrityError extends Error {}
const LOG_KEY = 'mirrorcall.log', LOG_LIMIT = 300;
const diagnostics = (() => { try { const saved = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); return Array.isArray(saved) ? saved.slice(-LOG_LIMIT).map(line => sanitizeDiagnostic(line)) : []; } catch { return []; } })();
const cleanDiagnostic = value => sanitizeDiagnostic(value, [config.accessKey, config.turnPass, config.turnUser, config.name, config.server]);
function note(event, detail = '', persist = true) {
  const clean = cleanDiagnostic(detail).slice(0, 240);
  const time = new Date().toISOString().replace('T', ' ').slice(5, 19);
  diagnostics.push(`${time} ${event}${clean ? ' ' + clean : ''}`);
  if (diagnostics.length > LOG_LIMIT) diagnostics.splice(0, diagnostics.length - LOG_LIMIT);
  if (persist) try { localStorage.setItem(LOG_KEY, JSON.stringify(diagnostics)); } catch {}
}
for (const line of String(native?.takeEvents?.() || '').split('\n')) if (line) diagnostics.push(cleanDiagnostic(line));
if (diagnostics.length > LOG_LIMIT) diagnostics.splice(0, diagnostics.length - LOG_LIMIT);
note('app-start', native?.deviceInfo?.() || navigator.userAgent);
addEventListener('error', event => note('js-error', `${event.message} @${event.lineno}`));
addEventListener('unhandledrejection', event => note('js-rejection', event.reason?.message || event.reason));
const clock = () => Date.now() + state.clockOffset;
const micLive = () => state.micOn && !state.interrupted;
const stopTimer = name => { clearTimeout(state.timers[name]); clearInterval(state.timers[name]); state.timers[name] = null; };
const controlsPinned = () => config.controlTimeout === 0 || native?.isTouchExplorationEnabled?.() === true;

// Keep the video unobstructed after connecting. Setup, errors and open dialogs keep
// controls visible; a tap or keyboard interaction always makes them available again.
function showCallControls() {
  stopTimer('controlsTap');
  stopTimer('controls');
  $('call').classList.remove('controls-hidden');
  if (controlsPinned() || !state.inRoom || state.conn?.connectionState !== 'connected' || state.busy || document.querySelector('dialog[open]')) return;
  state.timers.controls = setTimeout(() => {
    if (state.inRoom && state.conn?.connectionState === 'connected' && !state.busy && !document.querySelector('dialog[open]')) {
      $('call').classList.add('controls-hidden');
    }
  }, Math.max(config.controlTimeout, native?.recommendedControlsTimeout?.(config.controlTimeout) || 0));
}
function hideCallControls() {
  stopTimer('controlsTap'); stopTimer('controls');
  if (!controlsPinned() && state.inRoom && state.conn?.connectionState === 'connected' && !state.busy && !document.querySelector('dialog[open]')) {
    $('call').classList.add('controls-hidden');
  }
}

function toast(message, duration = 4800) {
  $('toast').textContent = message; $('toast').hidden = false;
  stopTimer('toast'); state.timers.toast = setTimeout(() => { $('toast').hidden = true; }, duration);
}
function setBusy(busy) {
  state.busy = busy; document.body.classList.toggle('busy', busy);
  for (const id of ['create-room', 'preview-button', 'open-join', 'switch-camera', 'toggle-camera']) $(id).disabled = busy;
  for (const id of ['precall-muted', 'precall-camera-off', 'precall-facing']) $(id).disabled = busy;
  $('preview-button').disabled = busy || !state.cameraOn;
  $('join-form').querySelector('button[type=submit]').disabled = busy;
  if (state.inRoom) showCallControls();
}
function openDialog(id) { if (!$(id).open) $(id).showModal(); showCallControls(); }
function showSettings() {
  $('setting-name').value = config.name;
  $('setting-server').value = config.server;
  $('setting-access').value = config.accessKey;
  $('setting-quality').value = config.quality;
  $('setting-controls').value = String(config.controlTimeout);
  $('setting-display').checked = config.displayCompatibility;
  $('setting-relay').checked = config.relayOnly;
  $('setting-remember').checked = config.remember;
  $('setting-turn-url').value = config.turnUrl;
  $('setting-turn-user').value = config.turnUser;
  $('setting-turn-pass').value = config.turnPass;
  openDialog('settings-dialog');
}
function persistSettings() {
  const saved = JSON.stringify({ ...config, accessKey: config.remember ? config.accessKey : '' });
  if (native) native.saveSettings(saved); else localStorage.setItem('mirrorcall.settings', saved);
  $('setup-hint').hidden = !!(config.server && config.accessKey);
}
function readyForServer() {
  if (config.accessKey.length < 24) { showSettings(); toast('Add the server access key first.'); return false; }
  return true;
}
function updateControls() {
  const m = config.mirrored;
  for (const id of ['home-mirror', 'toggle-mirror']) $(id).setAttribute('aria-pressed', String(m));
  // Previews show exactly what your partner sees: their app flips your video on display.
  for (const id of ['home-video', 'local-video']) $(id).classList.toggle('mirrored', m);
  $('home-mirror').querySelector('span').textContent = m ? 'Mirrored' : 'Natural';
  $('toggle-mirror').classList.toggle('selected', m);
  $('toggle-mirror').querySelector('small').textContent = m ? 'Mirror on' : 'Mirror off';
  $('local-mirror-mark').textContent = m ? '↔' : '';
  $('mirror-notice').querySelector('span').textContent = m ? 'Your partner sees your mirrored video' : 'Your partner sees your natural video';
  $('mirror-notice').style.color = m ? 'var(--green)' : '#d0c8da';
  for (const [id, enabled, label] of [['toggle-mic', state.micOn, 'microphone'], ['toggle-camera', state.cameraOn, 'camera']]) {
    $(id).classList.toggle('off', !enabled);
    $(id).setAttribute('aria-pressed', String(!enabled));
    $(id).setAttribute('aria-label', `${enabled ? 'Turn off' : 'Turn on'} ${label}`);
  }
  $('toggle-mic').querySelector('small').textContent = state.micOn ? 'Mic on' : 'Muted';
  $('toggle-camera').querySelector('small').textContent = state.cameraOn ? 'Camera' : 'Cam off';
  $('toggle-speaker').setAttribute('aria-pressed', String(state.speaker));
  $('toggle-speaker').querySelector('span').textContent = state.routeName || (state.speaker ? 'Speaker' : 'Phone / headset');
  $('quality-label').textContent = profiles[config.quality].label;
  $('local-name').textContent = config.name || 'You';
  $('precall-muted').checked = config.startMuted;
  $('precall-camera-off').checked = config.startCameraOff;
  $('precall-facing').value = config.front ? 'front' : 'rear';
  $('preview-button').disabled = state.busy || !state.cameraOn;
  showVideo();
}

// ---- Media: camera and microphone go straight to the encoder, untouched. ----
const showVideo = () => engine.layout(state.inRoom);
function attachPreviews() {
  const has = engine.hasVideo();
  $('home-video').hidden = !has; $('home-preview-placeholder').hidden = has;
  showVideo();
}
function acquireMedia(withAudio = true) {
  if (state.mediaPromise) return state.mediaPromise;
  const epoch = state.epoch;
  const isCurrent = () => epoch === state.epoch && !state.suspended;
  state.mediaPromise = (async () => {
    // Set mute BEFORE creating the microphone track, including a muted first call.
    engine.setMic(micLive());
    const wantAudio = withAudio && !engine.hasAudio(), wantVideo = state.cameraOn && !engine.hasVideo();
    if (!wantAudio && !wantVideo) return;
    const options = { front: state.front, profile: profiles[config.quality], isCurrent };
    try { await engine.open({ ...options, audio: wantAudio, video: wantVideo }); }
    catch (error) {
      note('media-error', `${wantAudio ? 'mic+' : ''}${wantVideo ? 'camera' : ''} ${error?.name} ${error?.message || ''}`);
      // A busy camera must not take the microphone (or the call) down with it.
      if (!(wantAudio && wantVideo) || error?.name === 'NotAllowedError') throw error;
      await engine.open({ ...options, audio: true, video: false });
      state.cameraOn = false; updateControls(); sendPeerState();
      toast('Your camera is busy or unavailable, so the call continues with audio. Tap the camera button to retry.', 7000);
    }
    engine.setMic(micLive());
    attachPreviews();
  })().finally(() => { state.mediaPromise = null; });
  return state.mediaPromise;
}
async function releaseMedia() { await engine.closeAll(); attachPreviews(); }
function mediaError(error) {
  const messages = { NotAllowedError: 'Camera and microphone permission is needed. Allow both in Android Settings → Apps → MirrorCall → Permissions.', NotFoundError: 'A camera or microphone could not be found.', NotReadableError: 'Your camera or microphone is busy. Close other calling apps and try again.', OverconstrainedError: 'This camera does not support the selected quality. Try Balanced or Save data.' };
  return messages[error?.name] || error?.message || 'Could not start the camera.';
}

function tuneSenders() { return state.conn?.tune(profiles[config.quality], AUDIO_BITRATE); }
// Public STUN, plus your own relay (TURN) server if you added one in Settings.
function relayServers() {
  const urls = config.turnUrl.split(',').map(u => u.trim()).filter(Boolean);
  return urls.length ? [{ urls, username: config.turnUser, credential: config.turnPass }] : [];
}

// ---- Signaling ----
function connectionLabel(text) { $('connection-label').textContent = text; }
function refreshLabel() {
  const conn = state.conn;
  if (conn?.connectionState === 'connected') connectionLabel('Encrypted call');
  else if (state.mode === 'direct') {
    if (state.direct?.role === 'host' && !state.direct.answered) connectionLabel('Waiting for their reply');
    else if (state.direct?.role === 'guest') connectionLabel('Waiting for them to connect');
    else connectionLabel('Connecting…');
  } else if (state.mode === 'server') {
    if (!state.joined) connectionLabel('Reconnecting…');
    else connectionLabel(conn ? 'Connecting…' : 'Waiting for your person');
  }
}
function sendSocket(packet) { if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(packet)); }
function sendSecure(payload) {
  const epoch = state.epoch, peerEpoch = state.peerEpoch, room = state.room, key = state.keys?.key;
  const envelope = { ...payload, session: state.session, id: randomToken(), at: clock() };
  state.outgoing = state.outgoing.catch(() => {}).then(async () => {
    if (epoch !== state.epoch || peerEpoch !== state.peerEpoch || !key) return;
    const packet = await seal(key, room, envelope);
    if (epoch === state.epoch && peerEpoch === state.peerEpoch) sendSocket({ type: 'signal', ...packet });
  });
  return state.outgoing;
}
function ping() { state.awaitingPong = true; state.pingSentAt = Date.now(); sendSocket({ type: 'ping' }); }
function heartbeat() {
  const socket = state.socket;
  if (!socket) return;
  const now = Date.now();
  if (socket.readyState === WebSocket.CONNECTING) { if (now - state.socketOpenedAt > CONNECT_TIMEOUT) socketLost(socket); return; }
  if (socket.readyState !== WebSocket.OPEN || !state.joined) return;
  // The browser cannot see a silently dead connection, so prove liveness ourselves.
  if (state.awaitingPong) { if (now - state.pingSentAt > PONG_TIMEOUT) socketLost(socket); }
  else if (now - state.lastHeard >= PING_EVERY) ping();
}
function connectSignaling() {
  stopTimer('reconnect');
  if (!state.inRoom || state.mode !== 'server' || state.socket) return;
  const epoch = state.epoch;
  const url = new URL('/signal', config.server); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  Object.assign(state, { socket, socketOpenedAt: Date.now(), joined: false, awaitingPong: false });
  socket.onopen = () => { if (socket === state.socket) sendSocket({ type: 'join', room: state.room, admission: state.keys.admission, accessKey: config.accessKey, clientId: state.clientId }); };
  socket.onmessage = event => {
    if (socket !== state.socket) return;
    state.lastHeard = Date.now(); state.awaitingPong = false;
    state.incoming = state.incoming.then(() => handleServer(socket, epoch, event.data)).catch(error => {
      if (epoch !== state.epoch) return;
      if (error instanceof IntegrityError) { leaveCall('integrity'); toast(error.message, 8000); }
      else if (state.conn) scheduleRecovery(state.conn, 1000);
    });
  };
  socket.onclose = () => socketLost(socket);
}
function socketLost(socket) {
  if (socket !== state.socket) return;
  state.socket = null; state.joined = false;
  socket.onopen = socket.onmessage = socket.onclose = null;
  try { socket.close(); } catch {}
  if (!state.inRoom) return;
  // Keep the media connection: if only signaling dropped, the call continues meanwhile.
  state.lostSince ??= Date.now();
  if (Date.now() - state.lostSince > RECONNECT_WINDOW) { leaveCall('server-unreachable'); toast('Lost the connection to your private server. Check your internet, then rejoin.', 8000); return; }
  connectionLabel('Reconnecting…');
  // Exponential backoff with jitter.
  const delay = Math.min(500 * 2 ** state.reconnects++, 8000) * (0.75 + Math.random() * 0.5);
  state.timers.reconnect = setTimeout(connectSignaling, delay);
}
async function handleServer(socket, epoch, data) {
  if (epoch !== state.epoch || socket !== state.socket) return;
  const packet = JSON.parse(data);
  if (packet.type === 'pong') return;
  if (packet.type === 'error') { leaveCall(`server-error ${packet.code}`); toast(packet.message || 'Could not join this room.', 8000); return; }
  if (packet.type === 'joined') {
    Object.assign(state, { joined: true, reconnects: 0, lostSince: null, iceServers: packet.iceServers || [], relayAvailable: !!packet.relayAvailable });
    // Both phones share the server's clock, so replay checks tolerate a wrong phone clock.
    if (typeof packet.serverTime === 'number') state.clockOffset = packet.serverTime - Date.now();
    if (config.relayOnly && !state.relayAvailable) { leaveCall('no-relay'); toast('Relay only is enabled, but this server has no TURN relay configured.', 8000); return; }
    if (!state.relayAvailable && !state.warnedRelay) { state.warnedRelay = true; toast('No relay (TURN) is configured. Calls may fail across mobile networks.', 6500); }
    if (state.conn?.connectionState === 'connected') connectionLabel('Encrypted call');
  } else if (packet.type === 'waiting') {
    resetPeer(); connectionLabel('Waiting for your person'); $('waiting-card').hidden = false;
  } else if (packet.type === 'peer-ready') { await createPeer(packet.initiator === true, [...state.iceServers, ...relayServers()]); if (state.initiator) await makeOffer(); }
  else if (packet.type === 'signal') await receiveSecure(packet);
  else if (packet.type === 'peer-left') {
    resetPeer(); connectionLabel('Your person left'); $('waiting-card').hidden = false;
    $('remote-message').textContent = 'They can rejoin using the same invitation.';
    toast('Your person left. Your room is still open.');
  }
}

// ---- Peer connection ----
function resetPeer() {
  state.peerEpoch++;
  stopTimer('restart'); stopTimer('failure'); stopTimer('stats'); stopTimer('sample'); stopTimer('sampleSoon');
  state.conn?.close();
  Object.assign(state, { conn: null, session: null, offerId: 0, peer: {}, pendingIce: [], stats: {}, lastBytes: null });
  showCallControls();
  state.seen.clear();
  $('remote-video').classList.remove('mirrored');
  $('remote-placeholder').hidden = false; $('peer-state').hidden = true; $('toggle-chat').disabled = true;
  $('remote-name').textContent = 'Your person'; $('remote-avatar').textContent = '♥';
  $('remote-message').textContent = 'Waiting for your person…';
  showVideo();
}
function remember(id) {
  state.seen.add(id);
  // Bounded FIFO: a Set iterates in insertion order, so the oldest id is evicted in O(1).
  if (state.seen.size > SEEN_LIMIT) state.seen.delete(state.seen.values().next().value);
}
function flushLocalIce(conn) {
  if (conn !== state.conn) return;
  conn.bufferIce = false;
  for (const candidate of conn.localIce.splice(0)) sendSecure({ kind: 'candidate', candidate }).catch(() => {});
}
async function flushRemoteIce(conn) { for (const pending of state.pendingIce.splice(0)) if (!pending.session || pending.session === state.session) await conn.addCandidate(pending.candidate); }
async function makeOffer(restart = false) {
  const conn = state.conn;
  if (!conn || !state.initiator) return;
  conn.bufferIce = true; conn.localIce = [];
  const description = await conn.offer(restart);
  if (!description) { conn.bufferIce = false; return; }
  if (conn !== state.conn) return;
  const offerId = ++state.offerId;
  await sendSecure({ kind: 'offer', offerId, description, mirrored: config.mirrored, name: config.name });
  flushLocalIce(conn);
}
function scheduleRecovery(conn, delay) {
  stopTimer('restart');
  state.timers.restart = setTimeout(async () => {
    if (conn !== state.conn || conn.connectionState === 'connected') return;
    try { if (state.initiator) await makeOffer(true); else await sendSecure({ kind: 'restart-request' }); } catch {}
    scheduleRecovery(conn, 8000);
  }, delay);
}
function connectionChanged(conn, connectionState, direct) {
  note('connection', connectionState);
  showCallControls();
  if (connectionState === 'connected') {
    if (!state.timers.sample) state.timers.sample = setInterval(sampleQuality, 30_000);
    native?.setPipEnabled?.(true);
    stopTimer('sampleSoon'); state.timers.sampleSoon = setTimeout(sampleQuality, 5000);
    stopTimer('restart'); stopTimer('failure');
    state.connectedAt ??= Date.now();
    $('waiting-card').hidden = true; $('direct-card').hidden = true;
    connectionLabel(direct || state.joined ? 'Encrypted call' : 'Reconnecting…');
    updatePeer(); sendPeerState();
  } else if (connectionState === 'disconnected' || connectionState === 'failed') {
    connectionLabel('Reconnecting…');
    if (!direct) { scheduleRecovery(conn, connectionState === 'failed' ? 300 : 3000); return; }
    // Without a server there is no way to renegotiate. A brief drop often recovers by itself;
    // a failed path is shown on screen instead of closing the call underneath the user.
    if (connectionState === 'failed') directFailed(conn);
  }
}
async function createPeer(initiator, iceServers) {
  resetPeer();
  const epoch = state.epoch;
  state.initiator = initiator;
  state.session = initiator ? randomToken() : null;
  const direct = state.mode === 'direct';
  let conn = null;
  const live = () => conn && conn === state.conn;
  const on = {
    candidate: candidate => {
      // Direct mode sends every candidate at once inside the code (no trickle).
      if (!live() || direct) return;
      if (conn.bufferIce) conn.localIce.push(candidate);
      else sendSecure({ kind: 'candidate', candidate }).catch(() => {});
    },
    remoteVideo: () => { if (live()) updatePeer(); },
    autoplayBlocked: () => toast('Tap the video to enable sound.'),
    channelOpen: () => { if (live()) { sendPeerState(); $('toggle-chat').disabled = false; } },
    channelClose: () => { if (live()) $('toggle-chat').disabled = true; },
    message: text => { if (live()) peerMessage(text); },
    ice: iceState => { if (live()) note('ice', iceState); },
    connection: connectionState => { if (live()) connectionChanged(conn, connectionState, direct); }
  };
  conn = await engine.createPeer({ iceServers, relayOnly: config.relayOnly, continual: !direct, initiator, on });
  if (epoch !== state.epoch) { conn.close(); throw new Error('Call cancelled'); }
  if (direct) state.relayAvailable = relayServers().length > 0;
  Object.assign(conn, { bufferIce: true, localIce: [] });
  state.conn = conn;
  connectionLabel('Connecting…');
  $('remote-message').textContent = 'Connecting your encrypted call…';
  $('waiting-card').hidden = true;
  if (!direct) state.timers.failure = setTimeout(() => {
    if (!live() || conn.connectionState === 'connected') return;
    connectionLabel('Connection needs attention');
    toast(state.relayAvailable ? 'Still connecting. Check both phones’ internet; the call keeps retrying.' : 'Could not connect directly, and no relay (TURN) is configured. See the setup guide.', 9000);
  }, 35_000);
}
function applyPeerHints(payload) {
  if (typeof payload.mirrored === 'boolean') state.peer.mirrored = payload.mirrored;
  if (typeof payload.name === 'string') state.peer.name = payload.name.slice(0, 32);
  updatePeer();
}
async function receiveSecure(packet) {
  const peerEpoch = state.peerEpoch;
  let payload;
  try { payload = await unseal(state.keys.key, state.room, packet); } catch { throw new IntegrityError('An invitation-key check failed. Leave and use a fresh invitation.'); }
  const conn = state.conn;
  if (peerEpoch !== state.peerEpoch || !conn) return;
  if (!payload || typeof payload.id !== 'string' || typeof payload.at !== 'number' || Math.abs(clock() - payload.at) > REPLAY_WINDOW || state.seen.has(payload.id)) return;
  remember(payload.id);
  if (payload.kind === 'candidate') {
    if (state.session && payload.session !== state.session) return;
    if (conn.hasRemote) await conn.addCandidate(payload.candidate); else state.pendingIce.push(payload);
  } else if (payload.kind === 'offer') {
    if (state.initiator || typeof payload.session !== 'string' || typeof payload.offerId !== 'number' || payload.description?.type !== 'offer') return;
    if (state.session && payload.session !== state.session) return;
    state.session = payload.session;
    applyPeerHints(payload);
    conn.bufferIce = true; conn.localIce = [];
    const description = await conn.answer(payload.description);
    if (conn !== state.conn) return;
    await flushRemoteIce(conn);
    await sendSecure({ kind: 'answer', offerId: payload.offerId, description, mirrored: config.mirrored, name: config.name });
    flushLocalIce(conn);
    await tuneSenders();
  } else if (payload.kind === 'answer') {
    if (!state.initiator || payload.session !== state.session || payload.offerId !== state.offerId || !conn.awaitingAnswer || payload.description?.type !== 'answer') return;
    applyPeerHints(payload);
    await conn.applyAnswer(payload.description);
    await flushRemoteIce(conn);
    await tuneSenders();
  } else if (payload.kind === 'restart-request') {
    if (state.initiator && payload.session === state.session && conn.connectionState !== 'connected') await makeOffer(true);
  }
}

// ---- Data channel: peer state and chat ----
function peerMessage(text) {
  let packet; try { packet = JSON.parse(text); } catch { return; }
  if (packet.kind === 'state') {
    state.peer = { name: typeof packet.name === 'string' ? packet.name.slice(0, 32) : '', micOn: packet.micOn === true, cameraOn: packet.cameraOn === true, mirrored: packet.mirrored === true, suspended: packet.suspended === true };
    updatePeer();
  } else if (packet.kind === 'bye') {
    if (state.mode === 'direct') { leaveCall('partner-hung-up'); toast('Your person ended the call.'); }
  } else if (packet.kind === 'chat' && typeof packet.text === 'string' && packet.text.length <= 2000) {
    addMessage(packet.text, false);
    if (!$('chat-dialog').open) $('chat-badge').hidden = false;
  }
}
function sendPeerState() {
  state.conn?.send(JSON.stringify({ kind: 'state', name: config.name, micOn: micLive(), cameraOn: state.cameraOn, mirrored: config.mirrored, suspended: state.suspended }));
}
function updatePeer() {
  const p = state.peer;
  $('remote-video').classList.toggle('mirrored', p.mirrored === true);
  $('remote-name').textContent = p.name || 'Your person';
  $('remote-avatar').textContent = (p.name || '♥').slice(0, 1).toUpperCase();
  if (state.conn?.connectionState === 'connected') {
    $('remote-placeholder').hidden = p.cameraOn !== false && !p.suspended;
    $('remote-message').textContent = p.suspended ? 'They switched to another app. Their video is paused; you can still hear each other.' : 'Their camera is off. You’re still together.';
  }
  const labels = [];
  if (p.suspended) labels.push('Video paused');
  if (p.micOn === false) labels.push('Mic muted');
  if (!p.suspended && p.cameraOn === false) labels.push('Camera off');
  if (p.mirrored) labels.push('Video mirrored');
  $('peer-state').textContent = labels.join(' · ');
  $('peer-state').hidden = labels.length === 0;
  showVideo();
}
function addMessage(text, mine) {
  const div = document.createElement('div'); div.className = `message${mine ? ' mine' : ''}`;
  const who = document.createElement('small'); who.textContent = mine ? 'You' : state.peer.name || 'Your person';
  div.append(who, document.createTextNode(text));
  const list = $('messages'); list.append(div);
  if (list.childElementCount > MAX_MESSAGES) list.firstElementChild.remove();
  div.scrollIntoView({ block: 'nearest' });
}

// ---- Call lifecycle ----
function updateTimer() {
  if (!state.connectedAt) return;
  const elapsed = Math.floor((Date.now() - state.connectedAt) / 1000);
  $('call-timer').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
}
async function holdWakeLock() { if (navigator.wakeLock && !state.wakeLock) state.wakeLock = await navigator.wakeLock.request('screen').catch(() => null); }
function dropWakeLock() { state.wakeLock?.release().catch(() => {}); state.wakeLock = null; }
// Shared by both modes: open the camera and microphone, then show the call screen.
async function enterCall(mode) {
  note('call-start', `${mode} quality=${config.quality}`);
  const epoch = ++state.epoch;
  Object.assign(state, { mode, direct: null, suspended: false, connectedAt: null, reconnects: 0, lostSince: null, warnedRelay: false, statsAt: null, micOn: !config.startMuted, cameraOn: !config.startCameraOff, front: config.front, routeName: '' });
  await acquireMedia();
  if (epoch !== state.epoch) throw new Error('Cancelled');
  state.inRoom = true;
  attachPreviews();
  $('home').hidden = true; $('call').hidden = false;
  $('waiting-card').hidden = mode !== 'server'; $('direct-card').hidden = true;
  $('messages').replaceChildren(); $('chat-badge').hidden = true; $('call-timer').textContent = '00:00';
  for (const dialog of document.querySelectorAll('dialog')) dialog.close();
  state.speaker = !native?.hasHeadset?.();
  updateControls();
  native?.setPipMic?.(state.micOn);
  native?.setCallActive(true);
  state.timers.clock = setInterval(updateTimer, 1000);
  await holdWakeLock();
}
async function joinRoom(room, secret) {
  if (state.busy || state.inRoom) return;
  setBusy(true);
  try {
    const keys = await deriveKeys(secret, room);
    await enterCall('server');
    Object.assign(state, { room, keys, clientId: randomToken(), invite: `mirrorcall://invite#${new URLSearchParams({ server: config.server, room, key: secret })}` });
    state.timers.heartbeat = setInterval(heartbeat, 1000);
    connectSignaling();
  } catch (error) { leaveCall(`join-failed ${error?.name}`); toast(mediaError(error), 8500); }
  finally { setBusy(false); }
}

// ---- Direct mode: two codes swapped over WhatsApp replace the server. ----
function showDirectCard(kind) {
  const offer = kind === 'offer';
  $('direct-step').textContent = offer ? 'STEP 1 OF 2' : 'STEP 2 OF 2';
  $('direct-title').textContent = offer ? 'Send them this code.' : 'Send this reply back.';
  $('direct-text').textContent = offer ? 'Share it on WhatsApp. They send a reply code back: copy it, then come back here.' : 'Share it with your person on WhatsApp. The call starts as soon as they open it.';
  $('direct-share').lastChild.textContent = offer ? 'Share code' : 'Share reply code';
  $('direct-reply-form').hidden = !offer;
  $('direct-reply').value = '';
  $('direct-note').textContent = offer ? 'Keep MirrorCall open in the background until you connect.' : 'Keep MirrorCall open. This reply works for the next few minutes.';
  connectionLabel(offer ? 'Waiting for their reply' : 'Waiting for them to connect');
  $('remote-message').textContent = offer ? 'Send your code to start.' : 'Almost there…';
  $('direct-card').hidden = false;
}
function startDirectTimeout(conn, limit, message) {
  stopTimer('failure');
  state.timers.failure = setTimeout(() => { if (conn === state.conn && conn.connectionState !== 'connected') directFailed(conn, message); }, limit);
}
function directFailed(conn, message) {
  if (conn !== state.conn) return;
  note('direct-failed', `${conn.connectionState} ice=${conn.iceConnectionState} connected-before=${!!state.connectedAt}`);
  if (state.connectedAt) {
    stopTimer('restart'); stopTimer('failure');
    connectionLabel('Connection lost');
    $('remote-placeholder').hidden = false;
    $('remote-message').textContent = 'The connection dropped. Tap Leave call, then start a new call and swap fresh codes.';
    toast('The connection dropped. Leave the call and start a new one to reconnect.', 10_000);
    return;
  }
  stopTimer('failure');
  connectionLabel('Could not connect');
  $('remote-placeholder').hidden = false;
  $('remote-message').textContent = message || 'The phones could not reach each other. Check both internet connections. Try the same Wi-Fi, or add a TURN relay in Settings on both phones, then leave and exchange fresh codes.';
  // Keep the call and its explanation visible. A timeout is not a user hang-up.
  toast(message || 'Connection failed. See the explanation on the call screen.', 8000);
}
async function startDirectCall() {
  if (state.busy || state.inRoom) return;
  if (config.relayOnly && !relayServers().length) { showSettings(); toast('Relay only needs a TURN server. Add one or turn Relay only off.'); return; }
  setBusy(true);
  try {
    await enterCall('direct');
    await createPeer(true, [...PUBLIC_STUN, ...relayServers()]);
    const conn = state.conn, callId = randomToken();
    await conn.offer(false);
    const description = await conn.waitGathering(relayServers().length ? 12_000 : GATHER_LIMIT);
    if (conn !== state.conn || !description) return;
    if (!/\na=candidate:/.test(description.sdp)) throw new Error('No usable network address was found. Check your connection or TURN settings and start a fresh call.');
    state.direct = { role: 'host', callId, code: await packCode({ t: 'offer', c: callId, s: description.sdp, n: config.name, m: config.mirrored }) };
    showDirectCard('offer');
  } catch (error) { leaveCall(`start-failed ${error?.name}`); toast(mediaError(error), 8500); }
  finally { setBusy(false); }
}
async function answerDirectCall(offer) {
  if (state.busy || state.inRoom) return;
  if (config.relayOnly && !relayServers().length) { showSettings(); toast('Relay only needs a TURN server. Add one or turn Relay only off.'); return; }
  setBusy(true);
  try {
    await enterCall('direct');
    await createPeer(false, [...PUBLIC_STUN, ...relayServers()]);
    const conn = state.conn;
    applyPeerHints(offer);
    await conn.answer({ type: 'offer', sdp: offer.sdp });
    const description = await conn.waitGathering(relayServers().length ? 12_000 : GATHER_LIMIT);
    if (conn !== state.conn || !description) return;
    if (!/\na=candidate:/.test(description.sdp)) throw new Error('No usable network address was found. Check your connection or TURN settings and start a fresh call.');
    state.direct = { role: 'guest', callId: offer.callId, code: await packCode({ t: 'answer', c: offer.callId, s: description.sdp, n: config.name, m: config.mirrored }) };
    showDirectCard('answer');
    await tuneSenders();
    startDirectTimeout(conn, 5 * 60_000, 'Your person did not connect in time. Start again with a fresh code.');
  } catch (error) { leaveCall(`answer-failed ${error?.name}`); toast(error?.name === 'InvalidAccessError' || error?.name === 'OperationError' ? 'This code could not be used. Ask your person for a fresh one.' : mediaError(error), 8500); }
  finally { setBusy(false); }
}
async function applyDirectAnswer(text) {
  const conn = state.conn, direct = state.direct;
  if (state.mode !== 'direct' || direct?.role !== 'host' || !conn || direct.applying) return false;
  if (!conn.awaitingAnswer) { toast('You are already connected.'); return false; }
  direct.applying = true;
  try {
    const answer = await unpackCode(text);
    if (answer.type !== 'answer') throw new Error('That is a call code, not a reply. Your person needs to open it and send you their reply.');
    if (answer.callId !== direct.callId) throw new Error('That reply belongs to a different call. Ask your person to answer your latest code.');
    if (conn !== state.conn || !conn.awaitingAnswer) return false;
    applyPeerHints(answer);
    try { await conn.applyAnswer({ type: 'answer', sdp: answer.sdp }); }
    catch { throw new Error('This reply could not be used. Ask your person to open your latest code again.'); }
    direct.answered = true;
    $('direct-card').hidden = true;
    refreshLabel();
    await tuneSenders();
    startDirectTimeout(conn, DIRECT_CONNECT_LIMIT);
    return true;
  } finally { direct.applying = false; }
}
function readClipboard() {
  try { return native ? Promise.resolve(native.readClipboard() || '') : navigator.clipboard.readText(); } catch { return Promise.resolve(''); }
}
// When you come back from WhatsApp with the reply copied, connect without any extra taps.
async function useCopiedReply() {
  if (state.mode !== 'direct' || state.direct?.role !== 'host' || !state.conn?.awaitingAnswer || state.busy) return;
  const text = await readClipboard().catch(() => '');
  if (!/MC1\./.test(text)) return;
  try { if (await applyDirectAnswer(text)) toast('Reply code found. Connecting…'); } catch {}
}
async function shareCode() {
  const text = state.direct.code;
  try {
    if (native) native.shareInvite(text);
    else if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Code copied. Paste it into WhatsApp.'); }
  } catch (error) { if (error.name !== 'AbortError') toast('Could not share. Use Copy code instead.'); }
}
function leaveCall(reason = 'ended', { goodbye = false } = {}) {
  note('leave', reason);
  if (state.connectedAt) {
    state.lastSummary = { duration: Math.max(0, Math.floor((Date.now() - state.connectedAt) / 1000)), stats: { ...state.stats }, measuredAt: state.statsAt };
    $('last-call').hidden = false;
  }
  if (goodbye) try { state.conn?.send(JSON.stringify({ kind: 'bye' })); } catch {}
  state.epoch++;
  for (const name of Object.keys(state.timers)) if (name !== 'toast') stopTimer(name);
  const socket = state.socket;
  state.socket = null; state.joined = false;
  if (socket) { socket.onopen = socket.onmessage = socket.onclose = null; try { socket.close(); } catch {} }
  resetPeer(); releaseMedia(); dropWakeLock();
  Object.assign(state, { inRoom: false, mode: null, direct: null, suspended: false, connectedAt: null, keys: null, room: null, clientId: null, invite: '', micOn: !config.startMuted, cameraOn: !config.startCameraOff, front: config.front, routeName: '' });
  $('direct-card').hidden = true;
  swapViews(false);
  native?.setPipEnabled?.(false);
  native?.setCallActive(false);
  $('home').hidden = false; $('call').hidden = true;
  showCallControls();
  $('messages').replaceChildren(); $('chat-input').value = '';
  for (const dialog of document.querySelectorAll('dialog')) dialog.close();
  if (location.hash) history.replaceState(null, '', location.pathname);
  attachPreviews();
  updateControls();
}
async function toggleCamera() {
  if (state.busy) return;
  state.cameraOn = !state.cameraOn; updateControls(); sendPeerState();
  // Off releases the camera completely (the privacy indicator turns off), not just blanks it.
  if (!state.cameraOn) { await engine.closeVideo(); attachPreviews(); return; }
  if (state.suspended || !state.inRoom) return;
  setBusy(true);
  try { await acquireMedia(); }
  catch (error) { state.cameraOn = false; updateControls(); sendPeerState(); toast(mediaError(error)); }
  finally { setBusy(false); }
}
async function switchCamera() {
  if (state.busy || state.suspended) return;
  state.front = !state.front;
  if (!state.cameraOn) { toast(state.front ? 'Front camera selected' : 'Rear camera selected'); return; }
  setBusy(true);
  try {
    await engine.switchCamera({ front: state.front, profile: profiles[config.quality] });
    attachPreviews();
    toast(state.front ? 'Front camera' : 'Rear camera');
  } catch {
    state.front = !state.front;
    try { await acquireMedia(state.inRoom); } catch {}
    toast(engine.hasVideo() ? 'Could not switch cameras. Your previous camera was restored.' : 'Could not reopen the camera. Try the camera control again.');
  } finally { setBusy(false); }
}
async function suspendCall(suspended) {
  if (state.suspended === suspended) return;
  state.suspended = suspended;
  if (!state.inRoom) { if (suspended) { state.epoch++; releaseMedia(); } return; }
  note(suspended ? 'background' : 'foreground');
  if (suspended) { await engine.closeVideo(); attachPreviews(); sendPeerState(); connectionLabel('Video paused'); dropWakeLock(); return; }
  try {
    try { await acquireMedia(); }
    catch (error) {
      note('resume-media-error', error?.name);
      if (!engine.hasAudio()) toast('Could not reopen your microphone. Leave and rejoin if your person cannot hear you.', 8000);
      else if (!engine.hasVideo() && state.cameraOn) { state.cameraOn = false; updateControls(); toast('Could not reopen your camera. Tap the camera button to retry.', 7000); }
    }
    if (!state.inRoom || state.suspended) return;
    // The web engine resets call audio routing whenever the microphone reopens.
    if (native?.restoreAudioRoute) native.restoreAudioRoute(); else native?.setSpeaker(state.speaker);
    state.lostSince = null;
    if (state.mode === 'server') { if (!state.socket) connectSignaling(); else if (state.joined) ping(); }
    refreshLabel();
    sendPeerState();
    await holdWakeLock();
  } catch (error) { note('resume-error', error?.message); }
}

// ---- Diagnostics: reuse the existing 30-second sample and 2-second open-sheet cadence. ----
async function updateStats() {
  const conn = state.conn;
  if (!conn || conn.connectionState !== 'connected' || state.statsPending) return;
  state.statsPending = true;
  try {
    const reports = await conn.stats();
    if (conn !== state.conn) return;
    const { stats, sample } = videoStats(reports, state.lastBytes, performance.now());
    state.stats = stats; state.lastBytes = sample; state.statsAt = Date.now();
    if ($('details-dialog').open) renderDetails();
  } finally { state.statsPending = false; }
}
async function sampleQuality() {
  const conn = state.conn;
  if (conn?.connectionState !== 'connected') return;
  await updateStats().catch(() => {});
  if (conn !== state.conn) return;
  const s = state.stats;
  note('quality', `${s.codec || '?'} ${s.encoder || ''} send=${s.width ?? '?'}x${s.height ?? '?'}@${metric(s.fps)} recv=${s.inWidth ?? '?'}x${s.inHeight ?? '?'}@${metric(s.inFps)} limit=${s.limitation || '?'} rtt=${metric(s.rtt)} loss=${metric(s.loss, '%', 2)} freezes=${s.freezes ?? '?'} route=${s.route || '?'}`);
}
function renderDetails() {
  const s = state.stats;
  const direct = state.mode === 'direct';
  const rows = [
    ['Status', $('connection-label').textContent], ['Media encryption', 'WebRTC DTLS-SRTP'],
    ['Call setup', direct ? 'Manual code exchange' : 'AES-256-GCM signaling'],
    ['Network route', s.route || 'Not reported'], ['Round-trip time', metric(s.rtt, ' ms')],
    ['Video codec', s.codec || 'Not reported'], ['Encoder', s.encoder ? `${s.encoder}${s.hardware === true ? ' (power efficient)' : ''}` : 'Not reported'],
    ['Sending', s.width && s.height ? `${s.width} x ${s.height} / ${metric(s.fps, ' fps')}` : 'Not reported'],
    ['Encoder constraint', { cpu: 'Phone processing', bandwidth: 'Connection bandwidth', none: 'None reported', other: 'Other' }[s.limitation] || 'Not reported'],
    ['Encoding time / frame', metric(s.encodeMs, ' ms', 1)],
    ['Received frame rate', metric(s.inFps, ' fps')], ['Received freezes', metric(s.freezes)],
    ['Send bitrate', Number.isFinite(s.kbps) ? `${(s.kbps / 1000).toFixed(2)} Mbit/s` : 'Not reported'],
    ['Receiving', s.inWidth && s.inHeight ? `${s.inWidth} x ${s.inHeight}` : 'Not reported'],
    ['Incoming packet loss (call)', metric(s.loss, '%', 2)], ['Outgoing mirror', config.mirrored ? 'On' : 'Off'],
    ['Relay configured', state.relayAvailable ? 'Yes' : 'No']
  ];
  $('connection-details').replaceChildren(...rows.map(([label, value]) => { const div = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; div.append(dt, dd); return div; }));
  $('health-message').textContent = healthMessage(s);
  $('connection-security-notes').textContent = direct
    ? 'WebRTC encrypts audio, video, and chat in transit. Setup codes contain network addresses and connection fingerprints; MirrorCall compresses these codes but does not encrypt them. Share them privately. This app has not had an independent security audit.'
    : 'WebRTC encrypts audio, video, and chat in transit. Your invitation key also encrypts signaling. This app has not had an independent security audit.';
}
function showDetails() {
  renderDetails(); openDialog('details-dialog');
  updateStats().catch(() => {});
  stopTimer('stats'); state.timers.stats = setInterval(() => updateStats().catch(() => {}), 2000);
}
function receiveInvite(value) {
  if (state.inRoom || state.busy) { toast('Leave your current room before opening another invitation.'); return; }
  try { if (!/MC1\./.test(value)) parseInvite(value); $('join-invite').value = value; openDialog('join-dialog'); }
  catch { toast('This is not a complete MirrorCall invitation.'); }
}

async function receiveSharedCode(value) {
  const sequence = ++state.sharedSequence;
  if (typeof value !== 'string' || value.length > 20_000) { toast('This shared text is too large.'); return; }
  if (state.busy) { toast('Call setup is busy. Share the code again when it finishes.'); return; }
  const epoch = state.epoch;
  try {
    const code = await unpackCode(value);
    if (epoch !== state.epoch || sequence !== state.sharedSequence || state.busy) return;
    if (code.type === 'answer') {
      if (state.mode !== 'direct' || state.direct?.role !== 'host' || !state.conn?.awaitingAnswer) throw new Error('Start a private call first. Reply codes go back to the person who started it.');
      if (code.callId !== state.direct.callId) throw new Error('That reply belongs to a different call. Ask for a reply to your latest code.');
      $('direct-reply').value = value.match(/MC1\.[A-Za-z0-9_-]+/)[0];
      $('direct-card').hidden = false;
      showCallControls();
      toast('Reply received. Tap Connect to use it.');
    } else {
      if (state.inRoom) throw new Error('Leave your current call before joining another one.');
      $('join-invite').value = value.match(/MC1\.[A-Za-z0-9_-]+/)[0];
      openDialog('join-dialog');
    }
  } catch (error) { toast(error.message, 8000); }
}

function renderAudioRoutes(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.devices)) return;
  state.speaker = snapshot.speaker === true;
  state.routeName = snapshot.label || 'System default';
  $('audio-note').textContent = snapshot.note || 'The selected output is the one currently reported by Android.';
  $('audio-routes').replaceChildren(...snapshot.devices.map(device => {
    const button = document.createElement('button');
    button.className = 'secondary-button'; button.textContent = device.label;
    button.setAttribute('aria-pressed', String(device.selected === true));
    button.onclick = () => {
      $('audio-note').textContent = 'Requesting audio output...';
      native?.selectAudioRoute?.(device.id);
    };
    return button;
  }));
  updateControls();
}

function showLastCall() {
  const last = state.lastSummary;
  if (!last) return;
  const s = last.stats;
  $('summary-text').textContent = [
    `Call duration: ${last.duration} seconds`,
    `Measurement: ${last.measuredAt ? new Date(last.measuredAt).toLocaleTimeString() : 'Not collected (short call)'}`,
    `Sending: ${s.width && s.height ? `${s.width} x ${s.height}` : 'Not reported'} / ${metric(s.fps, ' fps')}`,
    `Receiving: ${s.inWidth && s.inHeight ? `${s.inWidth} x ${s.inHeight}` : 'Not reported'} / ${metric(s.inFps, ' fps')}`,
    `Codec: ${s.codec || 'Not reported'}`, `Route: ${s.route || 'Not reported'}`,
    `Incoming packet loss (call): ${metric(s.loss, '%', 2)}`, `Received freezes: ${metric(s.freezes)}`, healthMessage(s)
  ].join('\n');
  openDialog('summary-dialog');
}

// ---- Event wiring ----
$('open-settings').onclick = $('setup-link').onclick = showSettings;
$('last-call').onclick = showLastCall;
$('clear-summary').onclick = () => { state.lastSummary = null; $('last-call').hidden = true; $('summary-text').textContent = ''; $('summary-dialog').close(); };
$('precall-muted').onchange = () => {
  if (state.busy || state.inRoom) return;
  config.startMuted = $('precall-muted').checked; state.micOn = !config.startMuted;
  persistSettings(); updateControls();
};
$('precall-camera-off').onchange = async () => {
  if (state.busy || state.inRoom) return;
  config.startCameraOff = $('precall-camera-off').checked; state.cameraOn = !config.startCameraOff;
  persistSettings(); updateControls();
  if (!state.cameraOn) { setBusy(true); try { await engine.closeVideo(); attachPreviews(); } finally { setBusy(false); } }
};
$('precall-facing').onchange = async () => {
  if (state.busy || state.inRoom) return;
  const front = $('precall-facing').value === 'front';
  if (front === state.front) return;
  if (engine.hasVideo()) await switchCamera(); else state.front = front;
  config.front = state.front; persistSettings(); updateControls();
};
$('show-licenses').onclick = async () => {
  try {
    const response = await fetch('NOTICE.txt');
    if (!response.ok) throw new Error('Notice unavailable');
    $('license-text').textContent = await response.text();
    openDialog('licenses-dialog');
  } catch { toast('Could not load licenses. The NOTICE.txt file is also included with the source.'); }
};
for (const button of document.querySelectorAll('.close-dialog')) button.onclick = () => button.closest('dialog').close();
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', showCallControls);
// Buttons restart the inactivity timer; video taps are handled by the gesture recognizer.
$('call').addEventListener('pointerdown', event => {
  if (event.target.closest('button,input,textarea,a')) { lastTap = { at: 0, target: null }; showCallControls(); }
  stopTimer('controls');
});
$('call').addEventListener('click', event => { if (event.target.closest('button,input,textarea,a')) showCallControls(); });
document.addEventListener('keydown', () => { if (state.inRoom) showCallControls(); }, true);
$('details-dialog').addEventListener('close', () => { stopTimer('stats'); state.lastBytes = null; });
$('settings-form').onsubmit = event => {
  event.preventDefault();
  if (state.inRoom) { toast('Finish the call before changing setup settings.'); return; }
  try {
    const serverText = $('setting-server').value.trim();
    const next = { ...config, controlTimeout: Number($('setting-controls').value), name: $('setting-name').value.trim().slice(0, 32), server: serverText ? validateServer(serverText) : '', accessKey: serverText ? $('setting-access').value.trim() : '', quality: $('setting-quality').value, relayOnly: $('setting-relay').checked, remember: $('setting-remember').checked, mirrored: config.mirrored };
    if (next.server && next.accessKey.length < 24) throw new Error('The server access key must have at least 24 characters.');
    next.turnUrl = $('setting-turn-url').value.trim();
    next.turnUser = $('setting-turn-user').value.trim();
    next.turnPass = $('setting-turn-pass').value;
    next.displayCompatibility = $('setting-display').checked;
    if (next.turnUrl && !next.turnUrl.split(',').every(u => /^turns?:[^\s]+$/i.test(u.trim()))) throw new Error('Relay addresses start with turn: or turns:, for example turn:relay.example.com:3478');
    next.qualityV3 = config.qualityV3;
    if (!profiles[next.quality]) next.quality = 'balanced';
    if (![0, 4000, 8000].includes(next.controlTimeout)) next.controlTimeout = 4000;
    next.qualityV2 = true;
    config = next;
    applyDisplayMode();
    persistSettings(); updateControls();
    state.epoch++; releaseMedia();
    $('settings-dialog').close(); toast('Settings saved.');
  } catch (error) { toast(error.message); }
};
$('preview-button').onclick = async () => { setBusy(true); try { await acquireMedia(false); } catch (error) { toast(mediaError(error), 8500); } finally { setBusy(false); } };
$('create-room').onclick = () => {
  if (!config.server) startDirectCall();
  else if (readyForServer()) joinRoom(randomToken(), randomToken(32));
};
$('open-join').onclick = async () => {
  openDialog('join-dialog');
  // Pre-fill a code you just copied from WhatsApp.
  const text = await readClipboard().catch(() => '');
  if (/MC1\.|mirrorcall:\/\/invite/.test(text) && !$('join-invite').value) $('join-invite').value = text;
};
$('join-paste').onclick = async () => { $('join-invite').value = await readClipboard().catch(() => '') || $('join-invite').value; };
$('join-form').onsubmit = async event => {
  event.preventDefault();
  const text = $('join-invite').value;
  if (/MC1\./.test(text)) {
    try {
      const code = await unpackCode(text);
      if (code.type !== 'offer') throw new Error('That is a reply code. It goes back to the person who started the call.');
      $('join-invite').value = '';
      answerDirectCall(code);
    } catch (error) { toast(error.message, 9000); }
    return;
  }
  if (!config.server) { toast('That is not a MirrorCall code. Copy the whole message your person sent.', 9000); return; }
  if (!readyForServer()) return;
  try {
    const invitation = parseInvite(text);
    if (invitation.server !== config.server) throw new Error('This invitation uses a different server. Verify it with your person, then update Settings before joining.');
    joinRoom(invitation.room, invitation.secret);
  } catch (error) { toast(error.message, 9000); }
};
for (const id of ['home-mirror', 'toggle-mirror']) $(id).onclick = () => { config.mirrored = !config.mirrored; persistSettings(); updateControls(); sendPeerState(); };
function toggleMic() { state.micOn = !state.micOn; engine.setMic(micLive()); updateControls(); sendPeerState(); native?.setPipMic?.(state.micOn); }
$('toggle-mic').onclick = toggleMic;
$('enter-pip').hidden = !native?.enterPip;
$('enter-pip').onclick = () => { if (!native.enterPip()) toast('Picture-in-picture is off for MirrorCall. Turn it on in Android Settings → Apps → MirrorCall.', 7000); };
// Keep the floating window's shape matched to your partner's video.
$('remote-video').addEventListener('resize', () => { const v = $('remote-video'); if (v.videoWidth && v.videoHeight) native?.setPipAspect?.(v.videoWidth, v.videoHeight); });
$('toggle-camera').onclick = toggleCamera;
$('switch-camera').onclick = switchCamera;
$('toggle-speaker').onclick = () => {
  if (!native) { toast('Audio routing follows your browser and system settings.'); return; }
  if (native.getAudioRoutes) {
    try { renderAudioRoutes(JSON.parse(native.getAudioRoutes())); openDialog('audio-dialog'); }
    catch { toast('Could not read audio outputs. Try again.'); }
    return;
  }
  state.speaker = !state.speaker; native.setSpeaker(state.speaker); updateControls();
};
$('hangup').onclick = () => leaveCall('hangup', { goodbye: true });
for (const id of ['copy-log', 'copy-log-details']) $(id).onclick = async () => {
  const text = `MirrorCall diagnostics\n${diagnostics.map(cleanDiagnostic).join('\n')}`.slice(-19_000);
  try { if (native) native.copyText(text); else await navigator.clipboard.writeText(text); toast('Diagnostics copied. Paste them to whoever is helping you.'); }
  catch { toast('Could not copy the diagnostics.'); }
};
$('direct-share').onclick = shareCode;
$('direct-copy').onclick = async () => {
  const text = state.direct.code;
  try { if (native) native.copyText(text); else await navigator.clipboard.writeText(text); toast('Code copied. Paste it into WhatsApp.'); }
  catch { toast('Could not copy. Use Share instead.'); }
};
$('direct-paste').onclick = async () => { $('direct-reply').value = await readClipboard().catch(() => '') || $('direct-reply').value; };
$('direct-reply-form').onsubmit = async event => {
  event.preventDefault();
  try { await applyDirectAnswer($('direct-reply').value); } catch (error) { toast(error.message, 9000); }
};
$('remote-video').onclick = () => $('remote-video').play().catch(() => {});
$('call-details').onclick = showDetails;
$('toggle-chat').onclick = () => { $('chat-badge').hidden = true; openDialog('chat-dialog'); };
$('chat-form').onsubmit = async event => {
  event.preventDefault(); const text = $('chat-input').value.trim();
  if (!text) return;
  const sent = await state.conn?.send(JSON.stringify({ kind: 'chat', text }));
  if (sent === 'busy') { toast('Your connection is busy. Try again in a moment.'); return; }
  if (!sent) { toast('Chat is available once your person connects.'); return; }
  addMessage(text, true); $('chat-input').value = '';
};
$('copy-invite').onclick = async () => {
  try { if (native) native.copyText(state.invite); else await navigator.clipboard.writeText(state.invite); toast('Private invitation copied. Send it only to your person.'); }
  catch { toast('Could not copy. Use Share invitation instead.'); }
};
$('share-invite').onclick = async () => {
  try {
    if (native) native.shareInvite(state.invite);
    else if (navigator.share) await navigator.share({ title: 'Join me on MirrorCall', text: state.invite });
    else await navigator.clipboard.writeText(state.invite).then(() => toast('Private invitation copied.'));
  } catch (error) { if (error.name !== 'AbortError') toast('Could not share the invitation. Try Copy invitation.'); }
};
// The small tile is your preview, or their video after a double-tap swap.
const isSwapped = () => $('call').classList.contains('swapped');
const smallTile = () => isSwapped() ? $('remote-video') : $('local-preview');
function swapViews(swapped = !isSwapped()) {
  if (swapped === isSwapped()) return;
  const from = smallTile(), box = { left: `${from.offsetLeft}px`, top: `${from.offsetTop}px` };
  const size = { width: `${from.offsetWidth}px`, height: `${from.offsetHeight}px` };
  $('call').classList.toggle('swapped', swapped);
  const to = smallTile();
  if (swapped) Object.assign(to.style, box, size);
  else { $('remote-video').removeAttribute('style'); Object.assign(to.style, box, { right: 'auto' }); }
  note('swap-views', swapped ? 'you-big' : 'partner-big');
  showVideo();
}
let gesture = null, lastTap = { at: 0, target: null };
for (const id of ['local-preview', 'remote-video', 'remote-placeholder']) {
  const el = $(id);
  el.addEventListener('pointerdown', event => {
    const tile = el === smallTile();
    gesture = { el, tile, x: event.clientX, y: event.clientY, top: el.offsetTop, left: el.offsetLeft, moved: false };
    if (tile) el.setPointerCapture(event.pointerId);
  });
  el.addEventListener('pointermove', event => {
    if (gesture?.el !== el) return;
    if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 8) return;
    gesture.moved = true;
    if (!gesture.tile) return;
    const parent = $('call');
    el.style.left = `${Math.min(parent.clientWidth - el.offsetWidth - 12, Math.max(12, gesture.left + event.clientX - gesture.x))}px`;
    el.style.top = `${Math.min(parent.clientHeight - el.offsetHeight - 215, Math.max(75, gesture.top + event.clientY - gesture.y))}px`;
    el.style.right = 'auto';
    showVideo();
  });
  el.addEventListener('pointerup', () => {
    const g = gesture; gesture = null;
    if (g?.el !== el || !state.inRoom) return;
    if (g.moved) { lastTap = { at: 0, target: null }; showCallControls(); return; }
    const now = Date.now(), view = el === smallTile() ? 'small' : 'big';
    if (lastTap.target === view && now - lastTap.at < 350 && Math.hypot(g.x - lastTap.x, g.y - lastTap.y) < 24) {
      lastTap = { at: 0, target: null }; showCallControls(); swapViews();
    } else {
      lastTap = { at: now, target: view, x: g.x, y: g.y };
      if ($('call').classList.contains('controls-hidden')) showCallControls();
      else {
        // Wait only long enough to distinguish a single tap from a double-tap swap.
        stopTimer('controlsTap');
        state.timers.controlsTap = setTimeout(hideCallControls, 350);
      }
    }
  });
  el.addEventListener('pointercancel', () => { gesture = null; lastTap = { at: 0, target: null }; showCallControls(); });
}
// A network change (Wi-Fi ↔ mobile data) is the moment a connection is most likely dead: check now.
window.addEventListener('online', () => {
  if (!state.inRoom || state.mode !== 'server') return;
  if (!state.socket) connectSignaling();
  else if (state.joined && !state.awaitingPong) ping();
});
document.addEventListener('visibilitychange', () => { if (!native) suspendCall(document.hidden); });
window.addEventListener('beforeunload', () => { state.socket?.close(); releaseMedia(); });
window.addEventListener('focus', () => { if (!native) useCopiedReply(); });
engine.onCameraLost = reason => {
  note('camera-lost', reason);
  attachPreviews();
  if (!state.inRoom || state.suspended || !state.cameraOn) return;
  state.cameraOn = false; updateControls(); sendPeerState();
  toast('Another app took the camera. Tap the camera button to turn it back on.', 7000);
};
engine.onEvent = message => {
  if (message.event === 'camera' && message.state === 'started') note('camera', message.detail);
  else if (message.event === 'audioError') note('audio-error', message.message);
  else if (message.event === 'displayMode') note('display-mode', message.state);
  else if (message.event === 'displayFrame' || message.event === 'displayLayout') note(message.event, message.detail, false);
};
globalThis.MirrorNative = {
  receiveInvite,
  receiveSharedCode,
  controlsChanged: showCallControls,
  audioRoutes: renderAudioRoutes,
  audioRouteError: () => { $('audio-note').textContent = 'Android could not select that output. Check the headset and try again.'; toast('Could not select that audio output.'); },
  engine: json => engine.receive?.(json),
  focus: () => useCopiedReply(),
  lifecycle: foreground => suspendCall(!foreground),
  pip: on => {
    note('pip', on);
    document.body.classList.toggle('pip', on);
    if (on) { swapViews(false); for (const dialog of document.querySelectorAll('dialog')) dialog.close(); }
    showVideo();
    showCallControls();
  },
  pipAction: action => {
    if (action === 'mute' && state.inRoom) toggleMic();
    else if (action === 'leave' && state.inRoom) leaveCall('pip-leave', { goodbye: true });
  },
  speakerChanged: speaker => { note('audio-route', speaker ? 'speaker' : 'headset'); state.speaker = speaker === true; updateControls(); },
  interrupted: on => {
    note('audio-interrupted', on);
    state.interrupted = on;
    engine.setMic(micLive());
    if (!on && state.inRoom) { if (native?.restoreAudioRoute) native.restoreAudioRoute(); else native?.setSpeaker(state.speaker); }
    sendPeerState();
  },
  back: () => {
    const dialog = [...document.querySelectorAll('dialog')].find(d => d.open);
    if (dialog) { dialog.close(); return; }
    if (!state.inRoom) { native?.closeApp(); return; }
    if (Date.now() - state.backPressedAt < 2500) { leaveCall('back-button', { goodbye: true }); return; }
    state.backPressedAt = Date.now(); toast('Press back again to leave the call.', 2500);
  }
};
if (migrateQuality || migrateNative) persistSettings();
updateControls();
$('setup-hint').hidden = !!(config.server && config.accessKey);
if (location.hash.includes('room=')) receiveInvite(location.href);
native?.ready();
$('setting-display-row').hidden = !engine.native;
function applyDisplayMode() { engine.configureDisplay?.(config.displayCompatibility).catch(() => toast('Could not apply the display setting. Reopen the app and try again.')); }
applyDisplayMode();
