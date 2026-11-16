import { WebSocket } from 'ws';
const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
const t = targets.find(x => x.type === 'page' && /appassets/.test(x.url));
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.once('open', r));
let id = 0; const ev = expr => new Promise(r => { const i = ++id; const h = d => { const m = JSON.parse(d); if (m.id === i) { ws.off('message', h); r(m.result?.result?.value); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
console.log(await ev(process.argv[2]));
ws.close();
