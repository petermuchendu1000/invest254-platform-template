/**
 * The actual race, recreated: HISTORY ARRIVES, LIVE TICKS ARE STILL IN FLIGHT.
 *
 * That is the window the monstrous candle lived in. Against a local engine it is sub-millisecond,
 * which is why it never showed here and showed constantly in production; the only difference is
 * network latency. So the page's WebSocket is wrapped and every `tick` / `tick_batch` frame is held
 * back for HOLD_MS while `candles`, `hello` and everything else pass straight through.
 *
 * With real ticks withheld, the only ticks in the buffer are the ones the client invents. If any of
 * them can reach the chart, the forming bar is built from a fabricated rate priced through the real
 * day anchor, and it lands tens of points off the market: exactly the reported candle.
 */
import pkg from '/home/user/invest254/node_modules/playwright-core/index.js';
const { chromium } = pkg;
import crypto from 'node:crypto';
const SECRET = 'harness-secret-0001';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const n = Math.floor(Date.now() / 1000);
  const p = b64({ sub, iat: n, exp: n + 7200, role: 'player', site: '00000000-0000-0000-0000-000000000001' });
  return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
const DIR = '/tmp/claude-0/-home-user/452c9309-f7cb-51b6-8e0c-13816b147fab/scratchpad';
const HOLD_MS = Number(process.argv[2] ?? 9000);
const RUNS = Number(process.argv[3] ?? 4);

const fails = [];
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails.push(m); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(([t, hold]) => {
  localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 }));
  const Native = window.WebSocket;
  const started = Date.now();
  function Wrapped(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    const realAdd = ws.addEventListener.bind(ws);
    let onmsg = null;
    const deliver = (handler, ev) => {
      let type = '';
      try { type = JSON.parse(ev.data).type; } catch { /* not ours */ }
      const held = (type === 'tick' || type === 'tick_batch') && Date.now() - started < hold;
      if (held) return;              // the live quote has not reached this client yet
      handler(ev);
    };
    realAdd('message', (ev) => { if (onmsg) deliver(onmsg, ev); });
    Object.defineProperty(ws, 'onmessage', {
      get: () => onmsg,
      set: (fn) => { onmsg = fn; },
      configurable: true,
    });
    ws.addEventListener = (t, fn, o) => {
      if (t !== 'message') return realAdd(t, fn, o);
      return realAdd(t, (ev) => deliver(fn, ev), o);
    };
    return ws;
  }
  Wrapped.prototype = Native.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Wrapped[k] = Native[k];
  window.WebSocket = Wrapped;
}, [jwt(`t1-0000-0000-0000-${Date.now().toString(16).slice(-12)}`), HOLD_MS]);

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 160)));

let spikes = 0;
for (let run = 1; run <= RUNS; run++) {
  await page.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded' });
  let worst = null;
  const deadline = Date.now() + HOLD_MS + 6000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(350);
    const info = await page.evaluate(() => {
      const m = document.body.innerText.match(/O\s+([\d.]+)\s+H\s+([\d.]+)\s+L\s+([\d.]+)\s+C\s+([\d.]+)/);
      return m ? { o: +m[1], h: +m[2], l: +m[3], c: +m[4] } : null;
    });
    if (info) {
      const range = info.h - info.l;
      if (!worst || range > worst.range) worst = { ...info, range };
    }
  }
  if (!worst) { console.log(`run ${run}: no legend (chart drew nothing while quotes were withheld)`); continue; }
  const bad = worst.range > 3;
  if (bad) {
    spikes++;
    console.log(`run ${run}: SPIKE  O ${worst.o} H ${worst.h} L ${worst.l} C ${worst.c}  range ${worst.range.toFixed(3)}`);
    await page.screenshot({ path: `${DIR}/race-${run}.png` });
  } else {
    console.log(`run ${run}: ok (max bar range ${worst.range.toFixed(3)})`);
  }
}
ok(spikes === 0, `no fabricated candle while the live quote is withheld (${spikes}/${RUNS} runs spiked)`);
await browser.close();
console.log(fails.length ? `\n${fails.length} failure(s)` : '\nTICK-RACE CLEAN');
process.exit(fails.length ? 1 : 0);
