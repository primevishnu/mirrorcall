// Real Windows camera integration test. Publishes a synthetic image through the
// native OBS protocol and reads that registered camera through Chromium/WebRTC.
// Does not open the physical webcam, use the microphone, or contact a website.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const executable = fileURLToPath(new URL('../build/CameraFlipTests.exe', import.meta.url));
const publisher = spawn(executable, ['--publish'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let log = '', errorLog = '';
publisher.stdout.on('data', data => { log += data.toString(); });
publisher.stderr.on('data', data => { errorLog += data.toString(); });
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><title>Camera Flip integration test</title><video id="camera" muted autoplay playsinline></video><video id="received" muted autoplay playsinline></video>');
});
let browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await pause(100); }
  throw new Error(message);
}
try {
  await until(() => log.includes('READY') || publisher.exitCode !== null, 'Native publisher did not start');
  assert.equal(publisher.exitCode, null, `Publisher failed: ${errorLog}`);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const camera = await page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const device = devices.find(d => d.kind === 'videoinput' && d.label.includes('OBS Virtual Camera'));
    if (!device) throw new Error('The registered OBS Virtual Camera is not visible to Chromium.');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: device.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
    document.querySelector('#camera').srcObject = stream;
    await document.querySelector('#camera').play();
    window.testStream = stream;
    return { label: device.label, settings: stream.getVideoTracks()[0].getSettings() };
  });
  console.log(`Registered virtual camera opened: ${camera.label}, ${camera.settings.width}x${camera.settings.height}`);
  const colors = id => page.evaluate(selector => {
    const video = document.querySelector(selector);
    if (!video.videoWidth) return null;
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
    return [0.25, 0.75].map(x => [...ctx.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height / 2), 1, 1).data]);
  }, '#' + id);
  const isBlue = pixel => pixel && pixel[2] > pixel[0] + 100;
  const isRed = pixel => pixel && pixel[0] > pixel[2] + 100;
  await until(async () => { const c = await colors('camera'); return c && isBlue(c[0]) && isRed(c[1]); }, 'Flipped virtual camera should have blue left and red right');
  console.log('PASS: receiving camera pixels are horizontally flipped');
  publisher.stdin.write('OFF\n');
  await until(async () => { const c = await colors('camera'); return c && isRed(c[0]) && isBlue(c[1]); }, 'Mirror OFF should restore red left and blue right');
  console.log('PASS: mirror OFF restores the original image live');
  await page.evaluate(async () => {
    const sending = new RTCPeerConnection({ iceServers: [] });
    const receiving = new RTCPeerConnection({ iceServers: [] });
    sending.onicecandidate = e => { if (e.candidate) receiving.addIceCandidate(e.candidate).catch(() => {}); };
    receiving.onicecandidate = e => { if (e.candidate) sending.addIceCandidate(e.candidate).catch(() => {}); };
    receiving.ontrack = e => { document.querySelector('#received').srcObject = e.streams[0]; };
    window.testStream.getTracks().forEach(t => sending.addTrack(t, window.testStream));
    await sending.setLocalDescription(await sending.createOffer());
    await receiving.setRemoteDescription(sending.localDescription);
    await receiving.setLocalDescription(await receiving.createAnswer());
    await sending.setRemoteDescription(receiving.localDescription);
    window.testConnections = [sending, receiving];
  });
  await until(async () => { const c = await colors('received'); return c && isRed(c[0]) && isBlue(c[1]); }, 'WebRTC receiver did not receive the normal video');
  publisher.stdin.write('ON\n');
  await until(async () => { const c = await colors('received'); return c && isBlue(c[0]) && isRed(c[1]); }, 'WebRTC receiver did not receive the flipped video');
  console.log('PASS: flip changes the video received over WebRTC, independently of preview mirroring');
  await page.evaluate(() => { window.testConnections.forEach(pc => pc.close()); window.testStream.getTracks().forEach(t => t.stop()); });
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (publisher.exitCode === null) {
    publisher.stdin.end('STOP\n');
    await Promise.race([once(publisher, 'exit'), pause(5000).then(() => { if (publisher.exitCode === null) publisher.kill(); })]);
  }
}
