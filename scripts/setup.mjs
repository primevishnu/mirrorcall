import { randomBytes } from 'node:crypto';
import { writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  try { await access('.env'); console.log('.env already exists. Keep its existing keys or edit it manually.'); process.exitCode = 1; }
  catch {
    const domain = (await terminal.question('Public calling domain (for example call.example.com): ')).trim();
    const turnDomain = (await terminal.question('TURN domain (for example turn.example.com): ')).trim();
    const publicIp = (await terminal.question('Server public IPv4 address: ')).trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(turnDomain) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(publicIp)) throw new Error('Enter valid public domains and an IPv4 address.');
    await writeFile('.env', `PUBLIC_DOMAIN=${domain}\nTURN_DOMAIN=${turnDomain}\nTURN_EXTERNAL_IP=${publicIp}\nSERVER_ACCESS_KEY=${randomBytes(32).toString('base64url')}\nTURN_SHARED_SECRET=${randomBytes(32).toString('base64url')}\nTURN_URLS=turn:${turnDomain}:3478?transport=udp,turn:${turnDomain}:3478?transport=tcp\nSTUN_URLS=stun:${turnDomain}:3478\nALLOWED_ORIGINS=https://appassets.androidplatform.net,https://${domain}\nMAX_ROOMS=1\nTRUST_PROXY=true\n`, { mode: 0o600, flag: 'wx' });
    console.log('Created .env with random keys. Open it privately and enter SERVER_ACCESS_KEY on both phones. Never publish this file.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { terminal.close(); }
