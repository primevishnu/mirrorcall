import { test, expect } from '@playwright/test';
import { inflateSync } from 'node:zlib';

const server = process.env.MIRRORCALL_TEST_SERVER || 'http://127.0.0.1:8765';
const accessKey = 'test-server-access-key-never-use-in-production';
async function revealControls(page) {
  // Reset the timer even if controls are currently visible but about to time out.
  await page.keyboard.press('Tab');
  await expect(page.locator('#call')).not.toHaveClass(/controls-hidden/);
}
async function configure(page, name) {
  await page.goto(server);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByLabel('Your name', { exact: true }).fill(name);
  await page.getByLabel('Private server address').fill(server);
  await page.getByLabel('Server access key', { exact: true }).fill(accessKey);
  await page.getByRole('button', { name: 'Save settings' }).click();
}
// What the receiver actually sees: a real screenshot (including any CSS flip), sampled
// a quarter of the way in from the left edge of the remote video.
function pngPixel(png, fx, fy) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), colorType = png[25];
  const channels = { 2: 3, 6: 4 }[colorType];
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, rows = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[x] = (line[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]) & 255;
    }
    rows.push(line); previous = line;
  }
  const x = Math.floor(width * fx), y = Math.floor(height * fy);
  return [...rows[y].subarray(x * channels, x * channels + 3)];
}
async function seenLeft(page) {
  const ready = await page.locator('#remote-video').evaluate(video => video.videoWidth > 0 && !video.paused);
  if (!ready) return null;
  return pngPixel(await page.locator('#remote-video').screenshot(), 0.25, 0.5);
}
// The frames on the wire stay untouched: no pixel processing on the sender.
async function decodedLeft(page) {
  return page.locator('#remote-video').evaluate(video => {
    if (!video.videoWidth) return null;
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
    return [...ctx.getImageData(canvas.width / 4, canvas.height / 2, 1, 1).data];
  });
}
const blue = p => p && p[2] > p[0] + 70, red = p => p && p[0] > p[2] + 70;

test('relay-only code calls require TURN and bundled licenses can be read', async ({ page }) => {
  await page.goto(server);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.locator('#setting-relay').check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByRole('button', { name: 'Start a private call' }).click();
  await expect(page.locator('#call')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('Relay only needs a TURN server');
  await page.getByRole('button', { name: 'Open-source licenses', exact: true }).click();
  await expect(page.locator('#license-text')).toContainText('The WebRTC project authors');
});

test('two real WebRTC clients receive mirrored pixels, chat, mute, pause, and rejoin', async ({ browser }) => {
  const hostContext = await browser.newContext({ permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'], viewport: { width: 412, height: 892 } });
  const guestContext = await browser.newContext({ permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'], viewport: { width: 412, height: 892 } });
  const host = await hostContext.newPage(), guest = await guestContext.newPage();
  const errors = [];
  host.on('pageerror', error => errors.push(error.message)); guest.on('pageerror', error => errors.push(error.message));
  await host.addInitScript(() => {
    const OriginalPeer = window.RTCPeerConnection;
    window.testPeers = [];
    window.RTCPeerConnection = class extends OriginalPeer {
      constructor(...args) { super(...args); window.testPeers.push(this); }
    };
  });
  try {
    await configure(host, 'Sam');
    await host.screenshot({ path: 'test-results/home.png', fullPage: true });
    await host.getByRole('button', { name: 'Start a private call' }).click();
    await expect(host.locator('#connection-label')).toHaveText('Waiting for your person', { timeout: 20_000 });
    await host.getByRole('button', { name: 'Copy invitation', exact: true }).click();
    const invite = await host.evaluate(() => navigator.clipboard.readText());
    expect(invite).toContain('mirrorcall://invite#'); expect(invite).not.toContain(accessKey);
    await configure(guest, 'Alex');
    await guest.getByRole('button', { name: 'Join with a code' }).click();
    await guest.getByLabel('Call code').fill(invite);
    await guest.getByRole('button', { name: 'Join call' }).click();
    await expect(host.locator('#connection-label')).toHaveText('Encrypted call', { timeout: 25_000 });
    await expect(guest.locator('#connection-label')).toHaveText('Encrypted call', { timeout: 25_000 });
    await expect.poll(() => host.evaluate(() => window.testPeers.at(-1).getSenders().find(s => s.track?.kind === 'video').getParameters().degradationPreference)).toBe('maintain-framerate');
    const negotiated = await host.evaluate(() => window.testPeers.at(-1).localDescription.sdp);
    expect(negotiated).not.toMatch(/a=rtpmap:\d+ (AV1|VP9)\//i);
    await revealControls(host);
    await host.getByRole('button', { name: 'Connection details', exact: true }).click();
    await expect(host.locator('#connection-details')).toContainText('AES-256-GCM signaling');
    await expect(host.locator('#connection-security-notes')).toContainText('invitation key');
    await host.getByRole('button', { name: 'Close details' }).click();
    await expect.poll(async () => blue(await seenLeft(guest)), { timeout: 15_000 }).toBeTruthy();
    expect(red(await decodedLeft(guest))).toBeTruthy();
    expect(await host.locator('#local-video').evaluate(v => getComputedStyle(v).transform)).toContain('matrix(-1');
    await revealControls(host);
    await host.getByRole('button', { name: 'Mirror the video your partner receives' }).click();
    await expect.poll(async () => red(await seenLeft(guest))).toBeTruthy();
    await revealControls(host);
    await host.getByRole('button', { name: 'Mirror the video your partner receives' }).click();
    await expect.poll(async () => blue(await seenLeft(guest))).toBeTruthy();
    await host.screenshot({ path: 'test-results/call.png' });
    await revealControls(host);
    await host.getByRole('button', { name: 'Turn off microphone' }).click();
    await expect(guest.locator('#peer-state')).toContainText('Mic muted');
    await revealControls(host);
    await host.getByRole('button', { name: 'Turn off camera', exact: true }).click();
    await expect(guest.locator('#remote-placeholder')).toBeVisible();
    await expect(guest.locator('#peer-state')).toContainText('Camera off');
    expect(await host.locator('#local-video').evaluate(v => v.srcObject)).toBeNull();
    await revealControls(host);
    await host.getByRole('button', { name: 'Turn on camera', exact: true }).click();
    await expect(guest.locator('#remote-placeholder')).toBeHidden();
    await revealControls(host);
    await host.getByRole('button', { name: 'Open private chat' }).click();
    const message = '<img src=x onerror=alert(1)> A private hello ♥';
    await host.getByRole('textbox', { name: 'Chat message' }).fill(message);
    await host.getByRole('button', { name: 'Send message' }).click();
    await revealControls(guest);
    await guest.getByRole('button', { name: 'Open private chat' }).click();
    await expect(guest.locator('#messages')).toContainText(message);
    expect(await guest.locator('#messages img').count()).toBe(0);
    await host.getByRole('button', { name: 'Close chat' }).click();
    await guest.getByRole('button', { name: 'Close chat' }).click();
    await revealControls(host);
    await host.getByRole('button', { name: 'Turn on microphone' }).click();
    await expect(guest.locator('#peer-state')).not.toContainText('Mic muted');
    // A phone call or alarm mutes the microphone until it ends.
    await host.evaluate(() => window.MirrorNative.interrupted(true));
    await expect(guest.locator('#peer-state')).toContainText('Mic muted');
    await host.evaluate(() => window.MirrorNative.interrupted(false));
    await expect(guest.locator('#peer-state')).not.toContainText('Mic muted');
    await host.evaluate(() => window.MirrorNative.lifecycle(false));
    await expect(guest.locator('#peer-state')).toContainText('Video paused');
    // Only the camera pauses in the background; the microphone keeps going.
    await expect(guest.locator('#peer-state')).not.toContainText('Mic muted');
    expect(await host.locator('#local-video').evaluate(video => video.srcObject)).toBeNull();
    await host.evaluate(() => window.MirrorNative.lifecycle(true));
    await expect(guest.locator('#peer-state')).not.toContainText('Video paused');
    await expect.poll(async () => blue(await seenLeft(guest)), { timeout: 15_000 }).toBeTruthy();
    // Coming back while the camera is busy must keep the call going (audio only), not end it.
    await host.evaluate(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.restoreCamera = () => { navigator.mediaDevices.getUserMedia = original; };
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Camera in use', 'NotReadableError'); };
    });
    await host.evaluate(() => window.MirrorNative.lifecycle(false));
    await host.evaluate(() => window.MirrorNative.lifecycle(true));
    await expect(host.locator('#toast')).toContainText('Could not reopen your camera');
    await expect(host.locator('#call')).toBeVisible();
    await expect(host.locator('#connection-label')).toHaveText('Encrypted call');
    await expect(guest.locator('#peer-state')).toContainText('Camera off');
    await host.evaluate(() => window.restoreCamera());
    await revealControls(host);
    await host.getByRole('button', { name: 'Turn on camera', exact: true }).click();
    await expect.poll(async () => blue(await seenLeft(guest)), { timeout: 15_000 }).toBeTruthy();
    await revealControls(guest);
    await guest.getByRole('button', { name: 'End call', exact: true }).click();
    await expect(host.locator('#connection-label')).toHaveText('Your person left');
    await guest.getByRole('button', { name: 'Join with a code' }).click();
    await guest.getByLabel('Call code').fill(invite);
    await guest.getByRole('button', { name: 'Join call' }).click();
    await expect(host.locator('#connection-label')).toHaveText('Encrypted call', { timeout: 25_000 });
    await expect.poll(async () => blue(await seenLeft(guest)), { timeout: 15_000 }).toBeTruthy();
    await revealControls(host);
    await host.getByRole('button', { name: 'End call', exact: true }).click();
    await expect(host.locator('#home')).toBeVisible();
    expect(await host.locator('#messages .message').count()).toBe(0);
    expect(await host.locator('#local-video').evaluate(video => video.srcObject)).toBeNull();
    expect(errors).toEqual([]);
  } finally { await hostContext.close(); await guestContext.close(); }
});

test('an invitation cannot silently send the saved server key to another host', async ({ page }) => {
  await configure(page, 'Sam');
  await page.getByRole('button', { name: 'Join with a code' }).click();
  const room = 'a'.repeat(22), key = 'b'.repeat(43);
  const hash = new URLSearchParams({ server: 'https://untrusted.example', room, key });
  await page.getByLabel('Call code').fill(`mirrorcall://invite#${hash}`);
  await page.getByRole('button', { name: 'Join call' }).click();
  await expect(page.locator('#toast')).toContainText('different server');
  await expect(page.locator('#call')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('mirrorcall.settings'))).not.toContain(accessKey);
});

test('a network drop mid-call reconnects to the same call instead of failing as a full room', async ({ browser }) => {
  const options = { permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'], viewport: { width: 412, height: 892 } };
  const hostContext = await browser.newContext(options), guestContext = await browser.newContext(options);
  const host = await hostContext.newPage(), guest = await guestContext.newPage();
  try {
    await configure(host, 'Sam');
    await host.getByRole('button', { name: 'Start a private call' }).click();
    await expect(host.locator('#connection-label')).toHaveText('Waiting for your person', { timeout: 20_000 });
    await host.getByRole('button', { name: 'Copy invitation', exact: true }).click();
    const invite = await host.evaluate(() => navigator.clipboard.readText());
    await configure(guest, 'Alex');
    await guest.getByRole('button', { name: 'Join with a code' }).click();
    await guest.getByLabel('Call code').fill(invite);
    await guest.getByRole('button', { name: 'Join call' }).click();
    await expect(guest.locator('#connection-label')).toHaveText('Encrypted call', { timeout: 25_000 });
    await expect.poll(async () => blue(await seenLeft(guest)), { timeout: 15_000 }).toBeTruthy();
    await guestContext.setOffline(true);
    await expect(guest.locator('#connection-label')).toHaveText('Reconnecting…', { timeout: 30_000 });
    await guestContext.setOffline(false);
    await guest.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(guest.locator('#connection-label')).toHaveText('Encrypted call', { timeout: 30_000 });
    await expect(host.locator('#connection-label')).toHaveText('Encrypted call', { timeout: 30_000 });
    await expect(guest.locator('#call')).toBeVisible();
    await expect.poll(async () => blue(await seenLeft(guest)), { timeout: 15_000 }).toBeTruthy();
  } finally { await hostContext.close(); await guestContext.close(); }
});

test('without any server, two codes swapped by hand connect a mirrored call', async ({ browser }) => {
  const options = { permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'], viewport: { width: 412, height: 892 } };
  const hostContext = await browser.newContext(options), guestContext = await browser.newContext(options);
  const host = await hostContext.newPage(), guest = await guestContext.newPage();
  const errors = [];
  host.on('pageerror', error => errors.push(error.message)); guest.on('pageerror', error => errors.push(error.message));
  await guest.addInitScript(() => {
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(...args) { super(...args); window.testPeer = this; }
    };
  });
  try {
    await host.goto(server); await guest.goto(server);
    await host.getByRole('button', { name: 'Start a private call' }).click();
    await expect(host.locator('#connection-label')).toHaveText('Waiting for their reply', { timeout: 20_000 });
    // Leaving for WhatsApp and coming back must not leave a stale "Call paused" label.
    await host.evaluate(() => window.MirrorNative.lifecycle(false));
    await expect(host.locator('#connection-label')).toHaveText('Video paused');
    await host.evaluate(() => window.MirrorNative.lifecycle(true));
    await expect(host.locator('#connection-label')).toHaveText('Waiting for their reply', { timeout: 15_000 });
    await host.getByRole('button', { name: 'Copy code' }).click();
    const offerMessage = await host.evaluate(() => navigator.clipboard.readText());
    const offerCode = offerMessage.match(/MC1\.\S+/)[0];
    console.log(`call code: ${offerCode.length} characters`);
    expect(offerCode.length).toBeLessThan(4000);
    expect(offerMessage).toMatch(/^MC1\.[A-Za-z0-9_-]+$/);
    expect(await host.locator('#home-video').evaluate(v => v.srcObject)).toBeNull();
    expect(await host.locator('#local-video').evaluate(v => v.srcObject?.getVideoTracks().length)).toBe(1);

    await guest.getByRole('button', { name: 'Join with a code' }).click();
    await guest.getByLabel('Call code').fill(offerMessage);
    await guest.getByRole('button', { name: 'Join call' }).click();
    await expect(guest.locator('#connection-label')).toHaveText('Waiting for them to connect', { timeout: 20_000 });
    await guest.getByRole('button', { name: 'Copy code' }).click();
    const replyMessage = await guest.evaluate(() => navigator.clipboard.readText());
    expect(replyMessage).toMatch(/^MC1\.[A-Za-z0-9_-]+$/);
    console.log(`reply code: ${replyMessage.match(/MC1\.\S+/)[0].length} characters`);

    // An ICE failure while sharing the reply must explain the failure, not send the
    // guest home or destroy the call. A subsequent connected event can still recover.
    await guest.evaluate(() => {
      const pc = window.testPeer;
      Object.defineProperty(pc, 'connectionState', { configurable: true, value: 'failed' });
      pc.dispatchEvent(new Event('connectionstatechange'));
      delete pc.connectionState;
    });
    await expect(guest.locator('#call')).toBeVisible();
    await expect(guest.locator('#connection-label')).toHaveText('Could not connect');
    await expect(guest.locator('#direct-card')).toBeVisible();

    // Coming back to the app with the reply copied connects without another tap.
    await host.evaluate(text => navigator.clipboard.writeText(text), replyMessage);
    // The copied reply is detected on return while the user also taps Connect: applied once, no error.
    await host.locator('#direct-reply').fill(replyMessage);
    await host.evaluate(() => { window.dispatchEvent(new Event('focus')); document.getElementById('direct-reply-form').requestSubmit(); });
    await expect(host.locator('#toast')).not.toContainText('Failed');
    await expect(host.locator('#connection-label')).toHaveText('Encrypted call', { timeout: 30_000 });
    await expect(guest.locator('#connection-label')).toHaveText('Encrypted call', { timeout: 30_000 });
    await revealControls(host);
    await host.getByRole('button', { name: 'Connection details', exact: true }).click();
    await expect(host.locator('#connection-details')).toContainText('Manual code exchange');
    await expect(host.locator('#connection-security-notes')).toContainText('does not encrypt them');
    await host.getByRole('button', { name: 'Close details' }).click();
    await expect.poll(async () => blue(await seenLeft(guest)), { timeout: 15_000 }).toBeTruthy();
    await revealControls(host);
    await host.getByRole('button', { name: 'Mirror the video your partner receives' }).click();
    await expect.poll(async () => red(await seenLeft(guest))).toBeTruthy();

    await revealControls(host);
    await host.getByRole('button', { name: 'Open private chat' }).click();
    await host.getByRole('textbox', { name: 'Chat message' }).fill('hello without a server');
    await host.getByRole('button', { name: 'Send message' }).click();
    await revealControls(guest);
    await guest.getByRole('button', { name: 'Open private chat' }).click();
    await expect(guest.locator('#messages')).toContainText('hello without a server');
    await host.getByRole('button', { name: 'Close chat' }).click();
    await guest.getByRole('button', { name: 'Close chat' }).click();

    // Swapping must preserve the SMALL tile's size before CSS expands the local preview.
    const before = await host.locator('#local-preview').boundingBox();
    await host.locator('#local-preview').dblclick();
    await expect(host.locator('#call')).toHaveClass(/swapped/);
    const small = await host.locator('#remote-video').boundingBox();
    expect(Math.abs(small.width - before.width)).toBeLessThan(2);
    expect(Math.abs(small.height - before.height)).toBeLessThan(2);
    await host.locator('#remote-video').dblclick();
    await expect(host.locator('#call')).not.toHaveClass(/swapped/);

    // Hide only the chrome, not the videos. Tapping where a hidden control sits must
    // reveal it without activating it; opening a dialog pauses the inactivity timer.
    const mic = await host.locator('#toggle-mic').boundingBox();
    await expect(host.locator('#call')).toHaveClass(/controls-hidden/, { timeout: 6000 });
    await expect(host.locator('#hangup')).toBeHidden();
    await expect(host.locator('#remote-video')).toBeVisible();
    await expect(host.locator('#local-preview')).toBeVisible();
    await host.mouse.click(mic.x + mic.width / 2, mic.y + mic.height / 2);
    await expect(host.locator('#hangup')).toBeVisible();
    await expect(host.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');
    const videoBounds = await host.locator('#remote-video').boundingBox();
    await host.locator('#call').click({ position: { x: 8, y: 300 } });
    await expect(host.locator('#call')).toHaveClass(/controls-hidden/, { timeout: 1500 });
    expect(await host.locator('#remote-video').boundingBox()).toEqual(videoBounds);
    await host.locator('#call').click({ position: { x: 8, y: 300 } });
    await expect(host.locator('#hangup')).toBeVisible();
    // Two rapid taps far apart are not a double-tap swap.
    await host.locator('#call').click({ position: { x: 8, y: 500 } });
    await expect(host.locator('#call')).toHaveClass(/controls-hidden/, { timeout: 1500 });
    await expect(host.locator('#call')).not.toHaveClass(/swapped/);
    await revealControls(host);
    await host.getByRole('button', { name: 'Connection details', exact: true }).click();
    await host.waitForTimeout(4500);
    await expect(host.locator('#call')).not.toHaveClass(/controls-hidden/);
    await host.getByRole('button', { name: 'Close details' }).click();
    await expect(host.locator('#call')).toHaveClass(/controls-hidden/, { timeout: 6000 });

    await revealControls(host);
    await host.getByRole('button', { name: 'End call', exact: true }).click();
    await expect(guest.locator('#home')).toBeVisible({ timeout: 10_000 });
    await expect(guest.locator('#toast')).toContainText('ended the call');
    // The diagnostics log explains why each side's call ended, without codes or addresses.
    await guest.getByRole('button', { name: 'Open settings', exact: true }).click();
    await guest.getByRole('button', { name: 'Copy diagnostics log' }).click();
    const diagnostics = await guest.evaluate(() => navigator.clipboard.readText());
    expect(diagnostics).toContain('leave partner-hung-up');
    expect(diagnostics).toContain('connection connected');
    expect(diagnostics).not.toMatch(/MC1\.[\w-]{20}/);
    expect(diagnostics).not.toMatch(/\b(?!0\.0\.0\.0)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(errors).toEqual([]);
  } finally { await hostContext.close(); await guestContext.close(); }
});
