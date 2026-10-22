/**
 * Is the monstrous candle in the ENGINE's data, or made on the client?
 *
 * Asks the engine for history and watches the live tick stream, and flags any bar whose range is a
 * wild outlier against the rest, plus any tick-to-tick jump far outside the usual step.
 */
import wspkg from '/home/user/invest254/node_modules/ws/index.js';
const { WebSocket } = wspkg;
import crypto from 'node:crypto';

const SECRET = 'harness-secret-0001';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const n = Math.floor(Date.now() / 1000);
  const p = b64({ sub, iat: n, exp: n + 7200, role: 'player', site: '00000000-0000-0000-0000-000000000001' });
  return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

const ws = new WebSocket('ws://127.0.0.1:8787/?site=00000000-0000-0000-0000-000000000001');
const send = (type, data) => ws.send(JSON.stringify({ type, data }));
let anchor = null;
const ticks = [];

ws.on('open', () => {
  send('auth', { token: jwt(`c1-0000-0000-0000-${Date.now().toString(16).slice(-12)}`) });
});

ws.on('message', (raw) => {
  let m; try { m = JSON.parse(String(raw)); } catch { return; }
  const { type, data } = m;
  if (type === 'hello') {
    send('candles', { tf: 'M1', count: 400, reqId: 'r1' });
  }
  if (type === 'candles') {
    anchor = data.anchor;
    const bars = data.bars ?? [];
    console.log(`history: ${bars.length} M1 bars, instrument ${data.instrument?.symbol}, anchor`, JSON.stringify(anchor));
    const ranges = bars.map((b) => b.high - b.low).filter((r) => Number.isFinite(r));
    const med = median(ranges);
    console.log(`  median bar range ${med.toFixed(5)}`);
    let bad = 0;
    bars.forEach((b, i) => {
      const r = b.high - b.low;
      if (med > 0 && r > med * 20) {
        bad++;
        if (bad <= 5) console.log(`  OUTLIER bar[${i}] t=${b.time} o=${b.open} h=${b.high} l=${b.low} c=${b.close} range=${r.toFixed(3)} (${(r / med).toFixed(0)}x median)`);
      }
      if (!(b.low <= b.open && b.open <= b.high) || !(b.low <= b.close && b.close <= b.high)) {
        console.log(`  MALFORMED bar[${i}] o=${b.open} h=${b.high} l=${b.low} c=${b.close}`);
      }
    });
    console.log(`  outlier bars in history: ${bad}`);
    // Now watch live ticks for a while.
    setTimeout(() => {
      const rates = ticks.map((t) => t.rate);
      console.log(`\nlive: ${ticks.length} ticks`);
      if (rates.length > 2) {
        const steps = rates.slice(1).map((r, i) => Math.abs(r - rates[i]));
        const medStep = median(steps);
        const big = steps.map((s, i) => ({ s, i })).filter((x) => medStep > 0 && x.s > medStep * 50);
        console.log(`  median |Δrate| ${medStep.toExponential(3)}; jumps >50x: ${big.length}`);
        for (const b of big.slice(0, 5)) {
          console.log(`   JUMP at ${b.i}: ${rates[b.i]} -> ${rates[b.i + 1]} (Δ ${b.s.toExponential(3)})`);
        }
        console.log(`  rate range over the window: ${Math.min(...rates)} .. ${Math.max(...rates)}`);
      }
      ws.close();
    }, 12000);
  }
  if (type === 'tick' && data && typeof data.rate === 'number') ticks.push({ rate: data.rate, t: data.t });
});

ws.on('close', () => process.exit(0));
ws.on('error', (e) => { console.log('WS ERROR', e.message); process.exit(1); });
