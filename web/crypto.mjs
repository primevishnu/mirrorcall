const encoder = new TextEncoder();
export function encode(bytes) {
  // Chunked: spreading a large array into one call can overflow the argument stack.
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid invitation');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export function randomToken(size = 16) { return encode(crypto.getRandomValues(new Uint8Array(size))); }
export async function deriveKeys(secret, room) {
  const bytes = decode(secret);
  if (bytes.length !== 32 || decode(room).length !== 16) throw new Error('Invalid invitation');
  const material = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = info => ({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(room), info: encoder.encode(info) });
  const key = await crypto.subtle.deriveKey(params('mirrorcall-signaling-v1'), material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const admission = encode(await crypto.subtle.deriveBits(params('mirrorcall-admission-v1'), material, 256));
  return { key, admission };
}
export async function seal(key, room, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(room) }, key, encoder.encode(JSON.stringify(payload)));
  return { iv: encode(iv), data: encode(data) };
}
export async function unseal(key, room, packet) {
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(packet.iv), additionalData: encoder.encode(room) }, key, decode(packet.data));
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function parseInvite(input) {
  const url = new URL(input.trim());
  if (url.protocol !== 'mirrorcall:' && url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Not a MirrorCall invitation');
  const p = new URLSearchParams(url.hash.slice(1));
  const server = validateServer(p.get('server') || (url.protocol.startsWith('http') ? url.origin : ''));
  const room = p.get('room') || '', secret = p.get('key') || '';
  if (decode(room).length !== 16 || decode(secret).length !== 32) throw new Error('This invitation is incomplete');
  return { server, room, secret };
}
export function validateServer(value) {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Use only the server address, such as https://call.example.com');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('The server must use HTTPS');
  return url.origin;
}

// ---- Direct (serverless) call codes: compressed connection details swapped over WhatsApp. ----
const CODE_PREFIX = 'MC1.';
const MAX_CODE_CHARS = 20_000, MAX_CODE_BYTES = 200_000;
export async function packCode(details) {
  const compressed = new Blob([JSON.stringify({ v: 1, ...details })]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return CODE_PREFIX + encode(await new Response(compressed).arrayBuffer());
}
export async function unpackCode(text) {
  const match = /MC1\.([A-Za-z0-9_-]+)/.exec(String(text || ''));
  if (!match) throw new Error('No MirrorCall code found. Copy the whole message and try again.');
  if (match[1].length > MAX_CODE_CHARS) throw new Error('This code is too long to be a MirrorCall code.');
  let details;
  try {
    // Read incrementally with a hard cap, so a malicious code cannot expand into huge memory use.
    const reader = new Blob([decode(match[1])]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_CODE_BYTES) { reader.cancel().catch(() => {}); throw new Error('too large'); }
      parts.push(value);
    }
    details = JSON.parse(new TextDecoder().decode(await new Blob(parts).arrayBuffer()));
  } catch { throw new Error('This code is damaged or incomplete. Ask your person for a fresh one.'); }
  if (details?.v !== 1 || !['offer', 'answer'].includes(details.t) || typeof details.c !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(details.c) || typeof details.s !== 'string' || !details.s.startsWith('v=0')) throw new Error('This code is damaged or incomplete. Ask your person for a fresh one.');
  return { type: details.t, callId: details.c, sdp: details.s, name: typeof details.n === 'string' ? details.n.slice(0, 32) : '', mirrored: details.m === true };
}
