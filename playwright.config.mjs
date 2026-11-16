import { defineConfig } from '@playwright/test';
import path from 'node:path';

// MIRRORCALL_TARGET=worker runs the same tests against the Cloudflare Worker in the local workerd runtime.
const worker = process.env.MIRRORCALL_TARGET === 'worker';
const accessKey = 'test-server-access-key-never-use-in-production';
process.env.MIRRORCALL_TEST_SERVER = worker ? 'http://127.0.0.1:8787' : 'http://127.0.0.1:8765';
export default defineConfig({
  testDir: './tests/browser', timeout: 90_000, workers: 1, retries: 0,
  use: {
    browserName: 'chromium', headless: true,
    viewport: { width: 412, height: 892 },
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve('tests/fixtures/two-colors.y4m')}`, '--autoplay-policy=no-user-gesture-required'] },
    trace: 'retain-on-failure'
  },
  webServer: worker
    ? { command: `npx wrangler dev --ip 127.0.0.1 --port 8787 --var SERVER_ACCESS_KEY:${accessKey} --log-level warn`, url: 'http://127.0.0.1:8787/healthz', reuseExistingServer: false, timeout: 120_000 }
    : { command: 'node tests/start-server.mjs', url: 'http://127.0.0.1:8765/healthz', reuseExistingServer: false }
});
