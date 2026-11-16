// Cloudflare Workers deployment of the MirrorCall signaling server.
// One Durable Object instance ("main") holds the private room, so both phones always
// reach the same place. Relay (TURN) credentials come from Cloudflare Realtime TURN.
import { DurableObject } from 'cloudflare:workers';
import { createSignalingCore, CLOSE } from '../server/core.mjs';

const PUBLIC_FILES = new Set(['/', '/index.html', '/app.mjs', '/engine.mjs', '/health.mjs', '/crypto.mjs', '/styles.css', '/icon.svg', '/NOTICE.txt']);
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};
const withHeaders = (response, extra = {}) => {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(name, value);
  return out;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return withHeaders(Response.json({ ok: true }));
    if (url.pathname === '/signal') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return withHeaders(new Response('Expected a WebSocket', { status: 426 }));
      const origin = request.headers.get('Origin');
      const allowed = new Set(String(env.ALLOWED_ORIGINS || 'https://appassets.androidplatform.net').split(',').map(s => s.trim()).filter(Boolean));
      if (!origin || (!allowed.has(origin) && origin !== url.origin)) return withHeaders(new Response('Forbidden', { status: 403 }));
      return env.ROOMS.get(env.ROOMS.idFromName('main')).fetch(request);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return withHeaders(new Response(null, { status: 405 }));
    if (!PUBLIC_FILES.has(url.pathname)) return withHeaders(new Response('Not found', { status: 404 }));
    return withHeaders(await env.ASSETS.fetch(request));
  }
};

async function cloudflareIceServers(env, ttl) {
  const stunOnly = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], relayAvailable: false };
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return stunOnly;
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl })
  });
  if (!response.ok) { console.error('TURN credential request failed', response.status); return stunOnly; }
  const data = await response.json();
  const servers = (Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers]).filter(Boolean).map(server => ({
    ...server,
    // Browsers block port 53, so those URLs only add a timeout.
    urls: [].concat(server.urls || []).filter(u => typeof u === 'string' && !/:53(\?|$)/.test(u))
  })).filter(server => server.urls.length);
  return { iceServers: servers, relayAvailable: servers.some(server => server.urls.some(u => /^turns?:/.test(u))) };
}

export class Rooms extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const ttl = Math.min(Number(env.TURN_TTL_SECONDS || 86_400), 172_800);
    this.attempts = new Map();
    this.sockets = 0;
    this.core = createSignalingCore({
      accessKey: env.SERVER_ACCESS_KEY,
      maxRooms: Number(env.MAX_ROOMS || 1),
      getIceServers: () => cloudflareIceServers(env, ttl)
    });
  }
  startSweep() {
    // The sweep only runs while someone is connected, so an idle object can be evicted.
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      this.core.sweep();
      for (const [address, bucket] of this.attempts) if (Date.now() - bucket.start > 120_000) this.attempts.delete(address);
      if (this.sockets === 0) { clearInterval(this.sweeper); this.sweeper = null; }
    }, 10_000);
  }
  async fetch(request) {
    const address = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    let bucket = this.attempts.get(address);
    if (!bucket || now - bucket.start > 60_000) { bucket = { start: now, count: 0 }; this.attempts.set(address, bucket); }
    if (++bucket.count > 40 || this.sockets >= 12) return new Response('Too many requests', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.sockets++;
    let counted = true;
    const release = () => { if (counted) { counted = false; this.sockets--; } };
    const conn = this.core.connect({ send: text => server.send(text), close: (code, reason) => { try { server.close(code, reason); } catch {} } });
    server.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > 100_000) { conn.close(); try { server.close(CLOSE.policy, 'bad-message'); } catch {} release(); return; }
      conn.message(event.data);
    });
    server.addEventListener('close', () => { conn.close(); release(); });
    server.addEventListener('error', () => { conn.close(); release(); });
    this.startSweep();
    return new Response(null, { status: 101, webSocket: client });
  }
}
