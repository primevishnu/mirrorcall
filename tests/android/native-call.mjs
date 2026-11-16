// End-to-end check of the Android native engine: a real code-swap call between the app on an
// emulator (native libwebrtc) and desktop Chromium (browser engine), verified with an actual
// screenshot of the emulator's screen. Development tool; needs a running emulator with the
// test build installed (python scripts/build-apk.py --test), plus Playwright.
//   node tests/android/native-call.mjs
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { unpackCode } from '../../web/crypto.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { WebSocket } from 'ws';

// Minimal Chrome DevTools Protocol client for the app's WebView (Playwright cannot attach to it).
async function attachPhone() {
  const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
  const target = targets.find(t => t.type === 'page' && /appassets/.test(t.url));
  if (!target) throw new Error('App page not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let seq = 0; const waiting = new Map();
  socket.on('message', data => { const m = JSON.parse(data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 25_000);
    waiting.set(id, m => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async evaluate(fn, arg) {
      const m = await send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
      if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'evaluate failed');
      return m.result?.result?.value;
    },
    close() { socket.close(); }
  };
}

const adb = process.env.ADB || 'C:/Android/Sdk/platform-tools/adb.exe';
const run = (...args) => execFileSync(adb, args, { encoding: 'utf8' });
const shareIntoPhone = code => run('shell', 'am', 'start', '-n', 'app.mirrorcall.android/.MainActivity', '-a', 'android.intent.action.SEND', '-t', 'text/plain', '--es', 'android.intent.extra.TEXT', code);
const server = 'http://127.0.0.1:8765';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what, timeout = 30_000) {
  const start = Date.now();
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${what}`);
    await sleep(400);
  }
}
function pixel(png, fx, fy) { // minimal PNG decoder (8-bit RGB/RGBA, no interlace)
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), channels = { 2: 3, 6: 4 }[png[25]];
  const chunks = [];
  for (let at = 8; at < png.length;) { const length = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8); if (type === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length)); at += 12 + length; }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels;
  let previous = Buffer.alloc(stride), line;
  const targetY = Math.floor(height * fy);
  for (let y = 0; y <= targetY; y++) {
    const filter = raw[y * (stride + 1)]; line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[x] = (line[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]) & 255;
    }
    previous = line;
  }
  const x = Math.floor(width * fx);
  return [...line.subarray(x * channels, x * channels + 3)];
}
const screenshot = () => execFileSync(adb, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 });
async function mirrorPixels(mirrored) {
  return until(async () => {
    const png = screenshot();
    const left = pixel(png, 0.2, 0.55), right = pixel(png, 0.8, 0.55);
    const blueLeft = left[2] > left[0] + 60 && right[0] > right[2] + 60;
    const redLeft = left[0] > left[2] + 60 && right[2] > right[0] + 60;
    return (mirrored ? blueLeft : redLeft) && { left, right };
  }, mirrored ? 'native mirror-on pixels' : 'native mirror-off pixels', 30_000);
}
async function notificationAction(label) {
  run('shell', 'cmd', 'statusbar', 'expand-notifications');
  try {
    const bounds = await until(async () => {
      run('shell', 'uiautomator', 'dump', '/sdcard/mirrorcall-notification.xml');
      const xml = run('shell', 'cat', '/sdcard/mirrorcall-notification.xml');
      const node = [...xml.matchAll(/<node\b[^>]*>/g)].map(m => m[0]).find(n => n.toLowerCase().includes(`text="${label.toLowerCase()}"`) || n.toLowerCase().includes(`content-desc="${label.toLowerCase()}"`));
      return node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)?.slice(1).map(Number);
    }, `notification ${label}`, 20000);
    run('shell', 'input', 'tap', String(Math.round((bounds[0] + bounds[2]) / 2)), String(Math.round((bounds[1] + bounds[3]) / 2)));
  } finally { run('shell', 'cmd', 'statusbar', 'collapse'); }
}

const pid = run('shell', 'pidof', 'app.mirrorcall.android').trim();
if (!pid) throw new Error('Start the app on the emulator first.');
run('forward', 'tcp:9333', `localabstract:webview_devtools_remote_${pid}`);
const web = spawn(process.execPath, ['tests/start-server.mjs'], { stdio: 'ignore' });
await sleep(800);
const desktop = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve('tests/fixtures/two-colors.y4m')}`, '--autoplay-policy=no-user-gesture-required'] });
let phone;
try {
  phone = await until(attachPhone, "Android debugger ready", 45000);
  await phone.evaluate(() => { setTimeout(() => location.reload(), 50); return true; });
  await sleep(2500);
  phone.close();
  phone = await until(attachPhone, "Android debugger after reload", 30000);
  await until(() => phone.evaluate(() => !!window.MirrorNative?.engine), 'page ready');
  const guestContext = await desktop.newContext({ permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'], viewport: { width: 412, height: 892 } });
  const guest = await guestContext.newPage();
  await guest.goto(server);

  // The emulator has no hardware encoder and renders in software: use the light quality profile.
  await phone.evaluate(quality => {
    document.getElementById('open-settings').click();
    document.getElementById('setting-quality').value = quality;
    document.getElementById('setting-controls').value = '4000';
    document.getElementById('setting-display').checked = true;
    document.getElementById('settings-form').requestSubmit();
    for (const id of ['precall-muted', 'precall-camera-off']) { const el = document.getElementById(id); el.checked = false; el.dispatchEvent(new Event('change')); }
    return true;
  }, process.env.QUALITY || 'data');
  console.log('phone: start call (native engine)');
  await phone.evaluate(() => document.getElementById('create-room').click());
  await until(() => phone.evaluate(() => document.getElementById('connection-label').textContent === 'Waiting for their reply'), 'offer code', 40_000);
  await phone.evaluate(() => document.getElementById('direct-copy').click());
  const offer = await until(() => phone.evaluate(() => { const t = window.Android.readClipboard(); return /MC1\./.test(t) && t; }), 'copied offer');
  const nativeOffer = await unpackCode(offer);
  assert.match(offer, /^MC1\.[A-Za-z0-9_-]+$/);
  assert.ok(/typ host/.test(nativeOffer.sdp), 'offer must contain a local-network candidate');
  console.log(`offer code ${offer.length} chars; local-network candidate verified`);

  console.log('desktop: answer');
  await guest.getByRole('button', { name: 'Join with a code' }).click();
  await guest.getByLabel('Call code').fill(offer);
  await guest.getByRole('button', { name: 'Join call' }).click();
  await until(() => guest.evaluate(() => document.getElementById('connection-label').textContent === 'Waiting for them to connect'), 'reply code', 30_000);
  await guest.getByRole('button', { name: 'Copy code' }).click();
  const reply = await guest.evaluate(() => navigator.clipboard.readText());

  console.log('phone: apply reply');
  shareIntoPhone(reply);
  await until(() => phone.evaluate(text => document.getElementById('direct-reply').value === text, reply), 'shared reply is prefilled');
  assert.equal(await phone.evaluate(() => document.getElementById('connection-label').textContent), 'Waiting for their reply');
  await phone.evaluate(() => document.getElementById('direct-reply-form').requestSubmit());
  await until(() => phone.evaluate(() => document.getElementById('connection-label').textContent === 'Encrypted call'), 'phone connected', 45_000);
  await until(() => guest.evaluate(() => document.getElementById('connection-label').textContent === 'Encrypted call'), 'desktop connected', 45_000);
  console.log('connected on both sides');

  // Desktop receives the emulator camera through the native encoder.
  const received = await until(() => guest.evaluate(() => { const v = document.getElementById('remote-video'); return v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : null; }), 'desktop receives phone video', 30_000);
  console.log(`desktop receives phone video: ${received}`);

  // The phone shows the desktop's red|blue video natively. The desktop mirrors by default, so blue is on the left.
  await sleep(3000);
  if (process.env.SHOT) (await import('node:fs')).writeFileSync(process.env.SHOT, screenshot());
  const { left, right } = await mirrorPixels(true);
  console.log(`phone screen left=${left} right=${right}`);
  const blueLeft = left[2] > left[0] + 60 && right[0] > right[2] + 60;
  await guest.keyboard.press('Tab');
  await guest.getByRole('button', { name: 'Mirror the video your partner receives' }).click();
  await sleep(2500);
  const { left: left2, right: right2 } = await mirrorPixels(false);
  console.log(`after partner turns mirror off: left=${left2} right=${right2}`);
  const redLeft = left2[0] > left2[2] + 60 && right2[2] > right2[0] + 60;
  assert.ok(blueLeft && redLeft, 'native received pixels must follow the partner mirror switch');

  // Exercise real native capture teardown/reopen and camera switching, not just the page UI.
  await phone.evaluate(() => document.getElementById('toggle-camera').click());
  await until(() => guest.locator('#peer-state').textContent().then(t => t.includes('Camera off')), 'native camera off');
  await phone.evaluate(() => document.getElementById('toggle-camera').click());
  await until(() => guest.locator('#peer-state').textContent().then(t => !t.includes('Camera off')), 'native camera on');
  await until(() => phone.evaluate(() => !document.body.classList.contains('busy')), 'camera reopened');
  await phone.evaluate(() => document.getElementById('switch-camera').click());
  await until(() => phone.evaluate(() => !document.body.classList.contains('busy') && document.getElementById('toast').textContent === 'Rear camera'), 'rear camera');
  await phone.evaluate(() => window.MirrorNative.lifecycle(false));
  await until(() => guest.locator('#peer-state').textContent().then(t => t.includes('Video paused') && !t.includes('Mic muted')), 'background audio survives');
  await phone.evaluate(() => window.MirrorNative.lifecycle(true));
  await until(() => guest.locator('#peer-state').textContent().then(t => !t.includes('Video paused')), 'native camera resumes');

  await phone.evaluate(() => { document.getElementById('toggle-chat').click(); document.getElementById('chat-input').value = 'native hello'; document.getElementById('chat-form').requestSubmit(); });
  await until(() => guest.locator('#messages').textContent().then(t => t.includes('native hello')), 'native sends chat');
  await phone.evaluate(() => document.querySelector('#chat-dialog .close-dialog').click());

  // Enter actual Android PiP, then restore the activity. CSS-only tests cannot check this.
  await phone.evaluate(() => document.getElementById('enter-pip').click());
  await until(() => phone.evaluate(() => document.body.classList.contains('pip')), 'Android PiP');
  assert.match(run('shell', 'dumpsys', 'activity', 'activities'), /windowingMode=\s*2|mode=pinned/);
  run('shell', 'am', 'start', '-n', 'app.mirrorcall.android/.MainActivity');
  await until(() => phone.evaluate(() => !document.body.classList.contains('pip')), 'exit PiP');
  console.log('native camera off/on, switch, background/resume, chat and PiP passed');

  await phone.evaluate(() => document.getElementById('toggle-speaker').click());
  const routes = await phone.evaluate(() => JSON.parse(Android.getAudioRoutes()));
  assert.ok(routes.devices.length > 0, 'Android exposes audio outputs');
  const speaker = routes.devices.find(d => d.label === 'Speaker');
  const earpiece = routes.devices.find(d => d.label === 'Phone earpiece');
  for (const device of [earpiece, speaker].filter(Boolean)) {
    await phone.evaluate(id => Android.selectAudioRoute(id), device.id);
    await until(() => phone.evaluate(id => JSON.parse(Android.getAudioRoutes()).devices.some(d => d.id === id && d.selected), device.id), 'confirmed audio route');
  }
  await phone.evaluate(() => document.querySelector('#audio-dialog .close-dialog').click());
  await notificationAction('Mute');
  await until(() => guest.locator('#peer-state').textContent().then(t => t.includes('Mic muted')), 'notification mute reaches peer');
  await notificationAction('Unmute');
  await until(() => guest.locator('#peer-state').textContent().then(t => !t.includes('Mic muted')), 'notification unmute reaches peer');
  console.log('actual Android output selection and notification mute/unmute passed');

  await phone.evaluate(() => document.getElementById('call-details').click());
  await sleep(4500);
  const details = await phone.evaluate(() => document.getElementById('connection-details').innerText);
  console.log(details.replace(/\n(?=[A-Z])/g, ' | ').replace(/\n/g, ': '));
  await phone.evaluate(() => document.querySelector('#details-dialog .close-dialog').click());

  await phone.evaluate(() => document.getElementById('copy-log').click());
  const log = await until(() => phone.evaluate(() => { const t = window.Android.readClipboard(); return /diagnostics/.test(t) && t; }), 'diagnostics');
  console.log(log.split('\n').filter(l => /camera|connection|quality|app-start/.test(l)).slice(-8).join('\n'));

  if (process.env.HOLD) { console.log('holding call'); await sleep(Number(process.env.HOLD)); }
  await notificationAction('Hang up');
  await until(() => guest.evaluate(() => !document.getElementById('home').hidden), 'desktop sees hang-up', 15_000);

  await phone.evaluate(() => { document.getElementById('open-settings').click(); document.getElementById('setting-display').checked = false; document.getElementById('settings-form').requestSubmit(); });
  // Reverse roles: the native answer path uses different transceiver setup.
  await guest.getByRole('button', { name: 'Start a private call' }).click();
  await until(() => guest.locator('#connection-label').textContent().then(t => t === 'Waiting for their reply'), 'desktop offer');
  await guest.getByRole('button', { name: 'Copy code' }).click();
  const secondOffer = await guest.evaluate(() => navigator.clipboard.readText());
  await phone.evaluate(() => {
    for (const id of ['precall-muted', 'precall-camera-off']) { const el = document.getElementById(id); el.checked = true; el.dispatchEvent(new Event('change')); }
  });
  await until(() => phone.evaluate(() => !document.body.classList.contains('busy')), 'pre-call media off');
  shareIntoPhone(secondOffer);
  await until(() => phone.evaluate(() => document.getElementById('join-dialog').open), 'native shared offer');
  assert.equal(await phone.evaluate(() => document.getElementById('home').hidden), false);
  await phone.evaluate(() => document.getElementById('join-form').requestSubmit());
  await until(() => phone.evaluate(() => document.getElementById('connection-label').textContent === 'Waiting for them to connect'), 'native answer', 40_000);
  await phone.evaluate(() => document.getElementById('direct-copy').click());
  const secondReply = await until(() => phone.evaluate(() => window.Android.readClipboard()).then(async t => (await unpackCode(t)).type === 'answer' && t), 'native reply');
  await guest.locator('#direct-reply').fill(secondReply);
  await guest.locator('#direct-reply-form').evaluate(form => form.requestSubmit());
  await until(() => phone.evaluate(() => document.getElementById('connection-label').textContent === 'Encrypted call'), 'native answerer connected', 45_000);
  await until(() => guest.locator('#peer-state').textContent().then(t => t.includes('Camera off') && t.includes('Mic muted')), 'native starts muted with camera off');
  await until(async () => /Active Camera Clients:\s*\[\]/.test(run('shell', 'dumpsys', 'media.camera')), 'camera hardware not acquired');
  await phone.evaluate(() => document.getElementById('toggle-camera').click());
  await phone.evaluate(() => document.getElementById('toggle-mic').click());
  await until(() => guest.evaluate(() => document.getElementById('remote-video').videoWidth > 0), 'native answerer sends video');
  await guest.keyboard.press('Tab');
  await guest.getByRole('button', { name: 'End call', exact: true }).click();
  await until(() => phone.evaluate(() => !document.getElementById('home').hidden), 'native sees partner hang-up');
  console.log('native answerer + repeat call + remote hang-up passed');
  await phone.evaluate(() => document.getElementById('last-call').click());
  assert.match(await phone.evaluate(() => document.getElementById('summary-text').textContent), /Call duration/);
  await phone.evaluate(() => document.querySelector('#summary-dialog .close-dialog').click());
  await phone.evaluate(() => document.getElementById('create-room').click());
  await until(() => phone.evaluate(() => !document.getElementById('call').hidden), 'third setup visible');
  await phone.evaluate(() => document.getElementById('hangup').click());
  await until(() => phone.evaluate(() => document.getElementById('call').hidden && !document.body.classList.contains('busy')), 'hang-up cancels pending code');
  console.log('hang-up during setup passed');
  console.log(blueLeft && redLeft ? 'RESULT: native video + mirroring verified on screen' : 'RESULT: on-screen video check FAILED');
  process.exitCode = blueLeft && redLeft ? 0 : 1;
} finally {
  phone?.close();
  await desktop.close();
  web.kill();
}
