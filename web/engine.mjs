// Media + connection engines behind one small interface.
//  - NativeEngine (the Android app): Google's libwebrtc with a camera capturer tuned for frame rate,
//    hardware encoders and native video surfaces drawn underneath this (transparent) page.
//  - BrowserEngine (desktop browsers / automated tests): the page's own WebRTC.
// The call logic in app.mjs (codes, signalling, reconnects, chat, mirroring) is shared.
const $ = id => document.getElementById(id);
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
const videoConstraints = (p, front, exact = false) => {
  const facing = front ? 'user' : 'environment';
  return { facingMode: exact ? { exact: facing } : { ideal: facing }, width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.fps } };
};
const named = (name, message) => Object.assign(new Error(message || name), { name });

export function createEngine(native) {
  return native?.engine ? new NativeEngine(native) : new BrowserEngine();
}

// ---------------------------------------------------------------- Browser engine
class BrowserEngine {
  native = false;
  audio = null; video = null; micOn = true; peer = null; inCall = false;
  hasAudio() { return !!this.audio; }
  hasVideo() { return !!this.video; }
  async open({ audio, video, front, profile, isCurrent = () => true }) {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.RTCPeerConnection || !crypto.subtle) throw new Error('Update Android System WebView and Chrome, then reopen MirrorCall.');
    const wantAudio = audio && !this.audio, wantVideo = video && !this.video;
    if (!wantAudio && !wantVideo) return;
    // One request opens both devices, so the system shows a single permission prompt.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: wantAudio && AUDIO, video: wantVideo && videoConstraints(profile, front) });
    if (!isCurrent()) { stream.getTracks().forEach(t => t.stop()); return; }
    for (const track of stream.getTracks()) await this.use(track.kind, track);
  }
  async use(kind, track) {
    const old = this[kind];
    if (old === track) return;
    this[kind] = track;
    if (track && kind === 'audio') track.enabled = this.micOn;
    await this.peer?.replace(kind, track);
    old?.stop();
    if (kind === 'video') this.layout(this.inCall);
  }
  setMic(on) { this.micOn = on; if (this.audio) this.audio.enabled = on; }
  closeVideo() { return this.use('video', null); }
  closeAll() {
    for (const kind of ['audio', 'video']) { this[kind]?.stop(); this[kind] = null; this.peer?.replace(kind, null); }
    this.layout(this.inCall);
  }
  async switchCamera({ front, profile }) {
    await this.closeVideo(); // many phones cannot open two cameras at once
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(profile, front, true) });
    await this.use('video', stream.getVideoTracks()[0]);
  }
  layout(inCall) {
    this.inCall = inCall;
    const stream = this.video ? new MediaStream([this.video]) : null;
    for (const id of ['home-video', 'local-video']) {
      const want = (inCall ? id === 'local-video' : id === 'home-video') ? stream : null;
      if ($(id).srcObject !== want) $(id).srcObject = want;
    }
  }
  async createPeer(options) { this.peer = new BrowserPeer(this, options); return this.peer; }
}

class BrowserPeer {
  constructor(engine, { iceServers, relayOnly, initiator, on }) {
    this.engine = engine; this.on = on; this.tx = { audio: null, video: null }; this.closed = false;
    const pc = this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    this.stream = new MediaStream();
    pc.onicecandidate = e => { if (e.candidate && !this.closed) on.candidate?.(e.candidate.toJSON()); };
    pc.ontrack = e => {
      if (this.closed) return;
      this.remote ??= new MediaStream();
      if (!this.remote.getTracks().includes(e.track)) this.remote.addTrack(e.track);
      const video = $('remote-video');
      if (video.srcObject !== this.remote) video.srcObject = this.remote;
      video.play().catch(() => on.autoplayBlocked?.());
      if (e.track.kind === 'video') on.remoteVideo?.();
    };
    pc.ondatachannel = e => { if (!this.closed) this.wire(e.channel); };
    pc.onconnectionstatechange = () => { if (!this.closed) on.connection?.(pc.connectionState); };
    pc.oniceconnectionstatechange = () => { if (!this.closed) on.ice?.(pc.iceConnectionState); };
    if (initiator) {
      // Transceivers exist even with the camera off, so turning it on never needs renegotiation.
      for (const kind of ['audio', 'video']) this.tx[kind] = pc.addTransceiver(engine[kind] || kind, { direction: 'sendrecv', streams: [this.stream] });
      this.preferCodecs();
      this.wire(pc.createDataChannel('private-chat', { ordered: true }));
    }
  }
  get connectionState() { return this.pc.connectionState; }
  get iceConnectionState() { return this.pc.iceConnectionState; }
  get awaitingAnswer() { return this.pc.signalingState === 'have-local-offer'; }
  get hasRemote() { return !!this.pc.remoteDescription; }
  get channelOpen() { return this.channel?.readyState === 'open'; }
  wire(channel) {
    this.channel = channel;
    channel.onopen = () => { if (this.channel === channel) this.on.channelOpen?.(); };
    channel.onclose = () => { if (this.channel === channel) this.on.channelClose?.(); };
    channel.onmessage = e => { if (typeof e.data === 'string' && e.data.length <= 5000) this.on.message?.(e.data); };
  }
  async replace(kind, track) { await this.tx[kind]?.sender.replaceTrack(track).catch(() => {}); }
  // H.264 first (hardware-encoded on practically every phone), then VP8; keep RTX/RED/FEC.
  preferCodecs() {
    const transceiver = this.tx.video;
    if (!transceiver?.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
    try {
      const codecs = RTCRtpReceiver.getCapabilities('video').codecs.filter(c => /video\/(H264|VP8|rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType));
      if (!codecs.some(c => /video\/(H264|VP8)$/i.test(c.mimeType))) return;
      const rank = c => /H264$/i.test(c.mimeType) ? 0 : /VP8$/i.test(c.mimeType) ? 1 : 2;
      transceiver.setCodecPreferences(codecs.sort((a, b) => rank(a) - rank(b)));
    } catch {}
  }
  async offer(restart = false) {
    const pc = this.pc;
    if (pc.signalingState === 'have-local-offer') {
      if (!restart) return null;
      await pc.setLocalDescription({ type: 'rollback' }); // the previous offer was lost; replace it
    }
    if (pc.signalingState !== 'stable') return null;
    await pc.setLocalDescription(await pc.createOffer(restart ? { iceRestart: true } : undefined));
    return pc.localDescription.toJSON();
  }
  async answer(description) {
    const pc = this.pc;
    await pc.setRemoteDescription(description);
    if (!this.tx.video) {
      for (const transceiver of pc.getTransceivers()) {
        const kind = transceiver.receiver.track.kind;
        if (this.tx[kind] || transceiver.stopped) continue;
        this.tx[kind] = transceiver;
        transceiver.direction = 'sendrecv';
        transceiver.sender.replaceTrack(this.engine[kind]).catch(() => {});
        transceiver.sender.setStreams?.(this.stream);
      }
      this.preferCodecs();
    }
    await pc.setLocalDescription(await pc.createAnswer());
    return pc.localDescription.toJSON();
  }
  async applyAnswer(description) { await this.pc.setRemoteDescription(description); }
  addCandidate(candidate) { return this.pc.addIceCandidate(candidate).catch(() => {}); } // stale ones after an ICE restart are harmless
  waitGathering(limit) {
    const pc = this.pc;
    const done = () => pc.localDescription?.toJSON();
    if (pc.iceGatheringState === 'complete') return Promise.resolve(done());
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(done()); };
      const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(finish, limit);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }
  send(text) {
    if (!this.channelOpen) return false;
    if (this.channel.bufferedAmount > 64_000) return 'busy';
    this.channel.send(text);
    return true;
  }
  async tune(p, audioBitrate) {
    const set = async (sender, change) => {
      if (!sender) return;
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      change(params);
      try { await sender.setParameters(params); }
      catch { delete params.degradationPreference; try { await sender.setParameters(params); } catch {} }
    };
    await Promise.all([
      set(this.tx.video?.sender, params => { params.degradationPreference = 'maintain-framerate'; for (const e of params.encodings) { e.maxBitrate = p.bitrate; e.maxFramerate = p.fps; } }),
      // Speech must never starve: audio gets priority on the network and in the encoder.
      set(this.tx.audio?.sender, params => { for (const e of params.encodings) { e.maxBitrate = audioBitrate; e.priority = 'high'; e.networkPriority = 'high'; } })
    ]);
  }
  stats() { return this.pc.getStats(); }
  close() {
    this.closed = true;
    const pc = this.pc;
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = pc.onicecandidate = pc.ontrack = pc.ondatachannel = null;
    pc.close();
    $('remote-video').srcObject = null;
    if (this.engine.peer === this) this.engine.peer = null;
  }
}

// ---------------------------------------------------------------- Native engine (Android)
class NativeEngine {
  native = true;
  media = { audio: false, video: false };
  peer = null; inCall = false; seq = 0; pending = new Map(); lastLayout = ''; frame = 0;
  onCameraLost = null; onEvent = null;
  constructor(bridge) {
    this.bridge = bridge;
    document.documentElement.classList.add('native-video');
    addEventListener('resize', () => this.layout(this.inCall));
    addEventListener('scroll', () => this.layout(this.inCall), true);
  }
  call(method, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.bridge.engine(JSON.stringify({ id, method, args }));
    });
  }
  receive(json) {
    const message = JSON.parse(json);
    if (message.id) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!waiter) return;
      if (message.error) waiter.reject(named(message.error.name, message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if (message.event === 'camera' && message.state === 'lost') { this.media.video = false; this.layout(this.inCall); this.onCameraLost?.(message.detail); }
    this.peer?.handle(message);
    this.onEvent?.(message);
  }
  hasAudio() { return this.media.audio; }
  hasVideo() { return this.media.video; }
  configureDisplay(compatibility) { return this.call('displayMode', { compatibility }); }
  async open({ audio, video, front, profile, isCurrent = () => true }) {
    if (!(audio && !this.media.audio) && !(video && !this.media.video)) return;
    this.media = await this.call('open', { audio, video, front, width: profile.width, height: profile.height, fps: profile.fps });
    if (!isCurrent()) { await this.closeAll(); return; }
    this.layout(this.inCall);
  }
  setMic(on) { this.call('setMic', { enabled: on }).catch(() => {}); }
  async closeVideo() { this.media.video = false; await this.call('closeVideo'); this.layout(this.inCall); }
  async closeAll() { this.media = { audio: false, video: false }; await this.call('closeAll').catch(() => {}); this.layout(this.inCall); }
  async switchCamera({ front, profile }) {
    await this.closeVideo();
    await this.open({ audio: false, video: true, front, profile });
  }
  // Native video is drawn underneath the page: tell it where the (transparent) video elements are.
  layout(inCall) {
    this.inCall = inCall;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      const scale = devicePixelRatio || 1;
      const rect = el => {
        if (!el || el.hidden || el.closest('[hidden]')) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        return { x: Math.round(r.left * scale), y: Math.round(r.top * scale), w: Math.round(r.width * scale), h: Math.round(r.height * scale) };
      };
      const pip = document.body.classList.contains('pip');
      const swapped = $('call').classList.contains('swapped');
      const args = inCall
        ? { remote: rect($('remote-video')), local: pip || !this.media.video ? null : rect($('local-preview')), localOnTop: !swapped, bottomFill: false,
            localMirror: $('local-video').classList.contains('mirrored'), remoteMirror: $('remote-video').classList.contains('mirrored') }
        : { remote: null, local: this.media.video ? rect($('home-video')) : null, localOnTop: false, bottomFill: true,
            localMirror: $('home-video').classList.contains('mirrored'), remoteMirror: false };
      const key = JSON.stringify(args);
      if (key === this.lastLayout) return;
      this.lastLayout = key;
      this.call('layout', args).catch(() => {});
    });
  }
  async createPeer({ iceServers, relayOnly, continual, initiator, on }) {
    this.peer?.detach();
    const peer = new NativePeer(this, on);
    this.peer = peer;
    await this.call('createPeer', { iceServers, relayOnly, continual, initiator });
    return peer;
  }
}

class NativePeer {
  connectionState = 'new'; iceConnectionState = 'new'; channelOpen = false; hasRemote = false; awaitingAnswer = false; closed = false;
  constructor(engine, on) { this.engine = engine; this.on = on; }
  handle(m) {
    if (this.closed) return;
    if (m.event === 'candidate') this.on.candidate?.(m.candidate);
    else if (m.event === 'connection') { this.connectionState = m.state; this.on.connection?.(m.state); }
    else if (m.event === 'ice') { this.iceConnectionState = m.state; this.on.ice?.(m.state); }
    else if (m.event === 'channel') { this.channelOpen = m.state === 'open'; this.channelOpen ? this.on.channelOpen?.() : this.on.channelClose?.(); }
    else if (m.event === 'message') { if (typeof m.text === 'string' && m.text.length <= 5000) this.on.message?.(m.text); }
    else if (m.event === 'remoteVideo') { this.engine.layout(this.engine.inCall); this.on.remoteVideo?.(); }
  }
  async offer(restart = false) {
    const description = await this.engine.call('offer', { restart });
    if (description) { this.awaitingAnswer = true; }
    return description;
  }
  async answer(description) {
    const local = await this.engine.call('answer', { sdp: description.sdp });
    this.hasRemote = true;
    return local;
  }
  async applyAnswer(description) {
    await this.engine.call('applyAnswer', { sdp: description.sdp });
    this.hasRemote = true; this.awaitingAnswer = false;
  }
  addCandidate(candidate) { return this.engine.call('addCandidate', candidate || {}).catch(() => {}); }
  waitGathering(limit) { return this.engine.call('waitGathering', { ms: limit }); }
  send(text) {
    if (!this.channelOpen) return false;
    return this.engine.call('send', { text }).catch(() => false);
  }
  tune(p, audioBitrate) { return this.engine.call('tune', { bitrate: p.bitrate, fps: p.fps, audioBitrate }).catch(() => {}); }
  async stats() {
    const reports = await this.engine.call('stats');
    return new Map((reports || []).map(report => [report.id, report]));
  }
  detach() { this.closed = true; if (this.engine.peer === this) this.engine.peer = null; }
  close() { this.detach(); this.engine.call('closePeer').catch(() => {}); }
}
