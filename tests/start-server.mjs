import { createCallServer } from '../server/index.mjs';
const app = createCallServer({ accessKey: 'test-server-access-key-never-use-in-production', stunUrls: '', trustProxy: false });
app.server.listen(8765, '127.0.0.1');
process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
