import { test, expect } from '@playwright/test';
import { packCode, unpackCode } from '../../web/crypto.mjs';
const server = process.env.MIRRORCALL_TEST_SERVER || 'http://127.0.0.1:8765';

test('pre-call privacy choices, shared offers/replies, pinned controls and last-call details', async ({ browser }) => {
  const options = { permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'], viewport: { width: 412, height: 892 } };
  const a = await browser.newContext(options), b = await browser.newContext(options);
  const host = await a.newPage(), guest = await b.newPage();
  const errors = [];
  for (const page of [host, guest]) {
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const Peer = RTCPeerConnection; window.testPeers = [];
      window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.testPeers.push(this); } };
    });
  }
  try {
    await host.goto(server); await guest.goto(server);
    for (const page of [host, guest]) {
      await page.getByRole('button', { name: 'Open settings', exact: true }).click();
      await page.getByRole('combobox', { name: 'Call controls', exact: true }).selectOption('0');
      await page.getByRole('button', { name: 'Save settings' }).click();
      await page.getByLabel('Start with microphone muted').check();
      await page.getByLabel('Start with camera off').check();
    }
    await host.reload(); // Choices must survive a restart without acquiring either device.
    await expect(host.getByLabel('Start with microphone muted')).toBeChecked();
    await expect(host.getByLabel('Start with camera off')).toBeChecked();
    expect(await host.locator('#home-video').evaluate(v => v.srcObject)).toBeNull();
    await host.getByRole('button', { name: 'Start a private call' }).click();
    await expect(host.locator('#connection-label')).toHaveText('Waiting for their reply', { timeout: 20000 });
    await host.locator('#direct-copy').click();
    const offer = await host.evaluate(() => navigator.clipboard.readText());
    await guest.evaluate(text => MirrorNative.receiveSharedCode(text), offer);
    await expect(guest.locator('#join-dialog')).toBeVisible();
    await expect(guest.locator('#home')).toBeVisible(); // Share receipt must not start the call.
    expect(await guest.evaluate(() => window.testPeers.length)).toBe(0);
    await guest.getByRole('button', { name: 'Join call', exact: true }).click();
    await expect(guest.locator('#connection-label')).toHaveText('Waiting for them to connect', { timeout: 20000 });
    await guest.locator('#direct-copy').click();
    const reply = await guest.evaluate(() => navigator.clipboard.readText());
    const decoded = await unpackCode(reply);
    const wrong = await packCode({ t: 'answer', c: 'x'.repeat(22), s: decoded.sdp });
    await host.evaluate(text => MirrorNative.receiveSharedCode(text), wrong);
    await expect(host.locator('#toast')).toContainText('different call');
    await expect(host.locator('#call')).toBeVisible();
    await host.evaluate(text => MirrorNative.receiveSharedCode(text), reply);
    await expect(host.locator('#direct-reply')).toHaveValue(reply);
    await expect(host.locator('#connection-label')).toHaveText('Waiting for their reply');
    await host.locator('#direct-reply-form').evaluate(form => form.requestSubmit());
    await expect(host.locator('#connection-label')).toHaveText('Encrypted call', { timeout: 30000 });
    await expect(guest.locator('#connection-label')).toHaveText('Encrypted call', { timeout: 30000 });
    await expect(host.locator('#peer-state')).toContainText('Camera off');
    await expect(guest.locator('#peer-state')).toContainText('Mic muted');
    for (const page of [host, guest]) {
      const tracks = await page.evaluate(() => window.testPeers.at(-1).getSenders().map(s => ({ kind: s.track?.kind, enabled: s.track?.enabled })));
      expect(tracks.find(t => t.kind === 'audio').enabled).toBe(false);
      expect(tracks.some(t => t.kind === 'video')).toBe(false);
    }
    await host.waitForTimeout(4500);
    await expect(host.locator('#call')).not.toHaveClass(/controls-hidden/);
    await host.locator('#call').click({ position: { x: 8, y: 300 } });
    await host.waitForTimeout(500);
    await expect(host.locator('#call')).not.toHaveClass(/controls-hidden/);
    await host.getByRole('button', { name: 'Turn on camera', exact: true }).click();
    await expect.poll(() => guest.locator('#remote-video').evaluate(v => v.videoWidth)).toBeGreaterThan(0);
    await host.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
    await expect(guest.locator('#peer-state')).not.toContainText('Mic muted');
    await host.evaluate(text => MirrorNative.receiveSharedCode(text), offer);
    await expect(host.locator('#toast')).toContainText('Leave your current call');
    await host.getByRole('button', { name: 'End call', exact: true }).click();
    await expect(guest.locator('#home')).toBeVisible();
    await host.getByRole('button', { name: 'Last call details' }).click();
    await expect(host.locator('#summary-text')).toContainText('Call duration');
    await expect(host.locator('#summary-text')).not.toContainText('MC1.');
    await host.getByRole('button', { name: 'Clear last call details' }).click();
    await expect(host.locator('#last-call')).toBeHidden();
    await host.evaluate(() => MirrorNative.receiveSharedCode('MC1.not-a-code'));
    await expect(host.locator('#toast')).toContainText('damaged');
    await expect(host.locator('#home')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await a.close(); await b.close(); }
});

test('preview never opens the microphone and turning pre-call camera off releases capture', async ({ page }) => {
  await page.addInitScript(() => {
    window.requests = []; const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async c => { window.requests.push(c); return get(c); };
  });
  await page.goto(server);
  await page.getByRole('button', { name: 'Preview your camera' }).click();
  await expect.poll(() => page.locator('#home-video').evaluate(v => v.srcObject?.getVideoTracks().length)).toBe(1);
  await page.getByLabel('Start with camera off').check();
  await expect.poll(() => page.locator('#home-video').evaluate(v => v.srcObject)).toBeNull();
  expect(await page.evaluate(() => window.requests.every(c => !c.audio))).toBe(true);
});
