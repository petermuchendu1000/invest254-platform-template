/**
 * Every clipped or overflowing piece of text in the terminal, at both widths.
 *
 * A label whose `scrollWidth` exceeds its `clientWidth` is being cut off: the user reads "Currenc"
 * where the control says "Currency". Reported per element with the text and the overflow in px, so
 * the fix can be aimed rather than guessed. Horizontal page overflow is reported separately.
 */
import pkg from '/home/user/invest254/node_modules/playwright-core/index.js';
import { createHmac } from 'node:crypto';
const { chromium } = pkg;
const DIR = '/tmp/claude-0/-home-user/452c9309-f7cb-51b6-8e0c-13816b147fab/scratchpad';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const RUN = Date.now().toString(16).padStart(12, '0').slice(-12);
let uid = 0;
const sign = () => { const s = `e${String(++uid).padStart(7,'0')}-0000-0000-0000-${RUN}`; const h = b64u({ alg:'HS256', typ:'JWT' }); const p = b64u({ sub:s, iat:(Date.now()/1000|0), exp:(Date.now()/1000|0)+3600, role:'player', site:'00000000-0000-0000-0000-000000000001' }); return `${h}.${p}.${createHmac('sha256','harness-secret-0001').update(`${h}.${p}`).digest('base64url')}`; };
const until = async (pg, fn, ms = 60000, step = 400) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await pg.waitForTimeout(step); } };

const SCAN = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    // Only leaf-ish nodes that actually render text of their own.
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!own) continue;
    const over = el.scrollWidth - el.clientWidth;
    // A scrollable box is allowed to overflow; a clipped or ellipsised one is not.
    const scrollable = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    if (over > 1 && !scrollable) {
      out.push({ text: own.slice(0, 60), over, tag: el.tagName.toLowerCase(), cls: (el.className && el.className.baseVal === undefined ? String(el.className) : '').slice(0, 70), ellipsis: cs.textOverflow === 'ellipsis' });
    }
  }
  const doc = document.documentElement;
  return { clipped: out, pageOverflow: doc.scrollWidth - doc.clientWidth };
})()`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
let total = 0;
for (const [name, w, h] of [['desktop 1440x900', 1440, 900], ['laptop 1280x800', 1280, 800], ['phone 360x800', 360, 800], ['phone 390x844', 390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark', ...(w < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const pg = await ctx.newPage();
  await pg.addInitScript((t) => localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 })), sign());
  await pg.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded' });
  await until(pg, async () => (await pg.evaluate(() => document.body.innerText)).length > 400, 60000);
  await pg.waitForTimeout(2500);
  const r = await pg.evaluate(SCAN);
  console.log(`\n=== ${name} ===  page overflow: ${r.pageOverflow}px   clipped: ${r.clipped.length}`);
  for (const c of r.clipped) console.log(`   ${String(c.over).padStart(4)}px  <${c.tag}> ${JSON.stringify(c.text)}${c.ellipsis ? '  [ellipsis]' : ''}`);
  total += r.clipped.length + (r.pageOverflow > 0 ? 1 : 0);
  await pg.screenshot({ path: `${DIR}/clip-${w}.png` });
  await pg.close();
}
await browser.close();
console.log(`\n${total} problem(s)`);
