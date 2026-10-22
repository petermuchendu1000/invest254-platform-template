/** Order acknowledgement latency, straight against the engine. No browser, no UI timing noise. */
import { createHmac } from 'node:crypto';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const RUN = Date.now().toString(16).padStart(12,'0').slice(-12);
const sign = (n) => { const s=`e${String(n).padStart(7,'0')}-0000-0000-0000-${RUN}`; const h=b64u({alg:'HS256',typ:'JWT'}); const p=b64u({sub:s,iat:(Date.now()/1000|0),exp:(Date.now()/1000|0)+3600,role:'player',site:'00000000-0000-0000-0000-000000000001'}); return `${h}.${p}.${createHmac('sha256','harness-secret-0001').update(`${h}.${p}`).digest('base64url')}`; };

const lat = [];
const run = (n) => new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:8787');
  let sentAt = 0, done = false;
  const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', data: { token: sign(n) } }));
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'auth' || m.type === 'balance') {
      if (!sentAt) { sentAt = performance.now();
        ws.send(JSON.stringify({ type: 'open_position', data: { direction: 'buy', stakeCents: 25000, durationS: 900 } })); }
    }
    if (m.type === 'position_opened') { lat.push(performance.now() - sentAt); finish(true); }
    if (m.type === 'error') { console.log(`   error on #${n}:`, m.data?.code, m.data?.message); finish(false); }
  };
  ws.onerror = () => finish(false);
  setTimeout(() => finish(false), 20000);
});

for (let i = 1; i <= 25; i++) await run(i);
const srt = lat.slice().sort((a,b)=>a-b);
const q = (p) => srt[Math.min(srt.length-1, Math.floor(p*srt.length))];
console.log(`ACK LATENCY  n=${lat.length}/25`);
if (lat.length) {
  console.log(`  min ${srt[0].toFixed(1)}  p50 ${q(0.5).toFixed(1)}  p95 ${q(0.95).toFixed(1)}  max ${srt[srt.length-1].toFixed(1)} ms`);
  console.log(`  all: ${lat.map(x=>x.toFixed(0)).join(', ')}`);
}
