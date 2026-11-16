import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createSignalingCore } from './core.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const CRLF = String.fromCharCode(13, 10);
const reject = (socket, status) => { socket.write(`HTTP/1.1 ${status}${CRLF}Connection: close${CRLF}${CRLF}`); socket.destroy(); };

export function createCallServer(options = {}) {
  const accessKey = options.accessKey ?? process.env.SERVER_ACCESS_KEY;
  const attempts = new Map();
  const maxRooms = options.maxRooms ?? Number(process.env.MAX_ROOMS || 1);
  const origins = new Set((options.origins ?? process.env.ALLOWED_ORIGINS ?? 'https://appassets.androidplatform.net').split(',').filter(Boolean));
  const turnUrls = (options.turnUrls ?? process.env.TURN_URLS ?? '').split(',').filter(Boolean);
  const turnSecret = options.turnSecret ?? process.env.TURN_SHARED_SECRET;
  const stunUrls = (options.stunUrls ?? process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').filter(Boolean);
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === 'true';
  const turnTtl = options.turnTtl ?? Number(process.env.TURN_TTL_SECONDS || 86_400);
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https: wss: ws://127.0.0.1:* ws://localhost:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.mjs', 'engine.mjs', 'health.mjs', 'crypto.mjs', 'styles.css', 'icon.svg', 'NOTICE.txt'].includes(filename)) { res.writeHead(404); res.end('Not found'); return; }
    try { const data = await readFile(path.join(webRoot, filename)); res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] }); res.end(req.method === 'HEAD' ? undefined : data); }
    catch { res.writeHead(500); res.end('Unable to load app'); }
  });
  const core = createSignalingCore({ accessKey, maxRooms, getIceServers: async peerId => {
    const iceServers = [];
    if (stunUrls.length) iceServers.push({ urls: stunUrls });
    const relayAvailable = !!(turnUrls.length && turnSecret);
    if (relayAvailable) {
      // coturn "use-auth-secret" credentials. They must outlast the longest call,
      // because coturn re-checks them whenever the relay allocation is refreshed.
      const username = `${Math.floor(Date.now() / 1000) + turnTtl}:${peerId}`;
      iceServers.push({ urls: turnUrls, username, credential: createHmac('sha1', turnSecret).update(username).digest('base64') });
    }
    return { iceServers, relayAvailable };
  } });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 100_000, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const hostOrigin = `${trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
    if (req.url !== '/signal' || !origin || (!origins.has(origin) && origin !== hostOrigin)) { reject(socket, '403 Forbidden'); return; }
    const address = trustProxy ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
    const now = Date.now();
    let bucket = attempts.get(address);
    if (!bucket || now - bucket.start > 60_000) { bucket = { start: now, count: 0 }; attempts.set(address, bucket); }
    if (++bucket.count > 40 || wss.clients.size >= 12) { reject(socket, '429 Too Many Requests'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    const conn = core.connect({ send: text => { if (ws.readyState === WebSocket.OPEN) ws.send(text); }, close: (code, reason) => ws.close(code, reason) });
    ws.on('message', (raw, binary) => conn.message(binary ? '' : raw.toString()));
    ws.on('close', conn.close);
    ws.on('error', () => {});
  });
  const heartbeat = setInterval(() => {
    core.sweep();
    for (const [address, bucket] of attempts) if (Date.now() - bucket.start > 120_000) attempts.delete(address);
  }, 10_000).unref();
  const close = async () => {
    clearInterval(heartbeat);
    core.closeAll();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  };
  return { server, close, rooms: core.rooms };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.env.SERVER_ACCESS_KEY) {
      const { loadEnvFile } = await import('node:process');
      try { loadEnvFile(); } catch {}
    }
    const app = createCallServer();
    const port = Number(process.env.PORT || 3000);
    app.server.listen(port, '0.0.0.0', () => console.log(`MirrorCall listening on port ${port}. No calls or messages are recorded.`));
    process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
