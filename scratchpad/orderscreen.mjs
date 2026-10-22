/** The phone order ticket, against the reference screenshot. */
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
const fails = [];
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails.push(m); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
// The reference is 324x512 CSS px; a common phone viewport exercises the same layout.
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await ctx.addInitScript(([t]) => localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 })), [jwt(`o1-0000-0000-0000-${Date.now().toString(16).slice(-12)}`)]);
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log('  [pageerror]', e.message.slice(0, 180)); fails.push('pageerror'); });
await page.goto('http://127.0.0.1:3100/', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

// Reach the order ticket: the Trade tab's new-order button (a document with a plus).
const tradeTab = page.locator('button', { hasText: /^Trade$/ }).last();
if (await tradeTab.count()) { await tradeTab.click().catch(() => {}); await page.waitForTimeout(900); }
const newOrder = page.locator('[aria-label="New order"]').first();
await newOrder.waitFor({ state: 'visible', timeout: 20000 });
await newOrder.click();
await page.waitForTimeout(1500);
ok(await page.locator('text=Market Execution').count() > 0, 'the order ticket is open');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${DIR}/order.png`, fullPage: false });

const body = await page.locator('body').innerText();
console.log('--- screen text ---');
console.log(body.replace(/\n{2,}/g, '\n').slice(0, 900));
console.log('-------------------');

ok(/Market Execution/.test(body), 'row 1: Market Execution');
ok(/Fill policy:/.test(body), 'Fill policy: carries MetaTrader’s colon');
ok(/Fill or Kill/.test(body), 'the fill policy this engine actually performs');
ok(/by market/.test(body) && !/BY MARKET/.test(body), '`by market` in lower case under SELL and BUY');
ok(/SELL/.test(body) && /BUY/.test(body), 'both trade buttons');
ok(/With Market Execution the price depends on the market situation/.test(body),
  "MetaTrader's Market Execution hint, verbatim as far as it is true");

// SL and TP: side by side on one row, each with its own coloured rule.
const sl = page.locator('[data-level-underline="SL"]');
const tp = page.locator('[data-level-underline="TP"]');
ok(await sl.count() === 1 && await tp.count() === 1, 'one SL rule and one TP rule');
const slBox = await sl.boundingBox();
const tpBox = await tp.boundingBox();
if (slBox && tpBox) {
  ok(Math.abs(slBox.y - tpBox.y) < 4, `SL and TP sit on the SAME row (y ${slBox.y.toFixed(0)} vs ${tpBox.y.toFixed(0)})`);
  ok(slBox.x < tpBox.x, 'SL on the left, TP on the right');
}
const slColour = await sl.evaluate((el) => getComputedStyle(el).backgroundColor);
const tpColour = await tp.evaluate((el) => getComputedStyle(el).backgroundColor);
console.log('   SL rule', slColour, '| TP rule', tpColour);
ok(/242, 54, 69/.test(slColour), 'the stop rule is red');
ok(/14, 181, 46/.test(tpColour), 'the target rule is green');

// Bid and Ask: two prices, in MetaTrader's big-figure typography.
const quotes = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('span[aria-label]')) {
    const l = el.getAttribute('aria-label') || '';
    if (/^\d+\.\d+$/.test(l) && el.className.includes('text-[24px]')) out.push(l);
  }
  return out;
});
console.log('   quotes:', JSON.stringify(quotes));
ok(quotes.length === 2, `two prices, a bid and an ask (got ${quotes.length})`);
if (quotes.length === 2) {
  const [bid, ask] = quotes.map(Number);
  ok(ask > bid, `the ask is above the bid (${bid} / ${ask}, spread ${(ask - bid).toFixed(2)})`);
}
// And the tick band carries them as tagged lines.
const bandInfo = await page.evaluate(() => {
  const svg = document.querySelector('svg[aria-label="Tick chart"]');
  const holder = document.querySelector('.min-h-28');
  return {
    svg: !!svg,
    holder: holder ? { w: holder.clientWidth, h: holder.clientHeight } : null,
    holders: document.querySelectorAll('.min-h-28').length,
    inner: (() => {
      const h = document.querySelector('.min-h-28');
      if (!h) return null;
      return { html: h.innerHTML.slice(0, 200), kids: h.children.length,
               kid0: h.firstElementChild ? { tag: h.firstElementChild.tagName, w: h.firstElementChild.clientWidth, h: h.firstElementChild.clientHeight } : null };
    })(),
  };
});
console.log('   band debug:', JSON.stringify(bandInfo));
ok(await page.locator('svg[aria-label="Tick chart"]').count() === 1, 'the tick chart is drawn');
const tags = await page.locator('svg[aria-label="Tick chart"] text').allInnerTexts();
console.log('   band tags:', JSON.stringify(tags));
ok(tags.length >= 2, `the band tags its lines (${tags.length})`);

// The ordering the reference screen uses: SL/TP and Fill policy ABOVE the prices.
const order = await page.evaluate(() => {
  const yOf = (re) => {
    for (const el of document.querySelectorAll('span,div,p')) {
      if (el.children.length === 0 && re.test(el.textContent || '')) return el.getBoundingClientRect().top;
    }
    return null;
  };
  return { fill: yOf(/^Fill policy:$/), exec: yOf(/^Market Execution$/) };
});
const quoteY = await page.locator('span[aria-label]').filter({ hasText: /\d/ }).first().boundingBox();
console.log('   y: exec', order.exec, 'fill', order.fill);
if (order.exec !== null && order.fill !== null) ok(order.exec < order.fill, 'Market Execution is above Fill policy');
if (order.fill !== null && slBox) ok(slBox.y < order.fill, 'SL/TP sit ABOVE Fill policy, as the reference orders them');

await browser.close();
console.log(fails.length ? `\n${fails.length} failure(s):\n - ${fails.join('\n - ')}` : '\nORDER SCREEN CLEAN');
