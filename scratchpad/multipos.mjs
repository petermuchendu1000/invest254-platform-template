/**
 * The three reports, re-measured after the fixes.
 *
 *   1. no invented prose under Stop Loss / Take Profit, and no level rows a brand cannot honour
 *   2. SEVERAL positions at once, each its own row, ticket, levels and close
 *   3. the order result does not cover the by-Market buttons
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
const fails = [];
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails.push(m); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(([t]) => localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 })), [jwt(`m1-0000-0000-0000-${Date.now().toString(16).slice(-12)}`)]);
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 160)); });
page.on('pageerror', (e) => { console.log('  [pageerror]', e.message.slice(0, 200)); fails.push(`pageerror: ${e.message.slice(0, 80)}`); });
await page.goto('http://127.0.0.1:3100/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);

async function openToolbox() {
  for (let i = 0; i < 4; i++) {
    if (await page.locator('button', { hasText: /^Journal$/ }).count()) return;
    const strip = page.locator('button').filter({ hasText: /Balance:/ }).first();
    if (await strip.count()) await strip.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
  }
}

// ── 1. no invented prose ────────────────────────────────────────────────────────────────────
const body0 = await page.locator('body').innerText();
ok(!/Neither it nor/.test(body0), 'the "Neither it nor Target fires on this brand" sentence is gone');
ok(!/Stops processing is performed on the server side/.test(body0), 'no "server side" (MetaQuotes writes "broker side")');
ok(!/Max loss KES/.test(body0), 'the ticket prints no invented "Max loss" line');
ok(/Stop Loss/.test(body0) && /Take Profit/.test(body0), 'this brand CAN fire levels, so the rows are drawn');

// ── 2. several positions ────────────────────────────────────────────────────────────────────
const buy = page.locator('button', { hasText: /^Buy by Market$/ }).first();
const sellBtn = page.locator('button', { hasText: /^Sell by Market$/ }).first();
await buy.waitFor({ state: 'visible', timeout: 20000 });
await buy.click();
await page.waitForTimeout(2500);

ok(await page.locator('button', { hasText: /^Buy by Market$/ }).count() === 1,
  'the ticket SURVIVES the first trade (the buttons are still there)');

await sellBtn.click();
await page.waitForTimeout(2500);
await buy.click();
await page.waitForTimeout(2500);

await openToolbox();
await page.locator('button', { hasText: /^Trade/ }).last().click();
await page.waitForTimeout(900);

const rows = page.locator('tr[title="Open the position menu"]');
const n = await rows.count();
ok(n === 3, `the Trade grid lists all three positions (got ${n})`);

const tickets = [];
for (let i = 0; i < n; i++) {
  const cells = await rows.nth(i).locator('td').allInnerTexts();
  tickets.push((cells[1] ?? '').trim());
  console.log(`   row ${i + 1}:`, JSON.stringify([cells[0], cells[1], cells[3], cells[4]]));
}
ok(new Set(tickets).size === n, `each row has its own ticket (${tickets.join(', ')})`);
ok(tickets.every((t) => /^\d{6,}$/.test(t)), 'every ticket is a MetaTrader integer');
const asc = tickets.map(Number);
ok(asc.every((v, i) => i === 0 || v > asc[i - 1]), 'the tickets ascend in the order the trades were opened');

const sides = [];
for (let i = 0; i < n; i++) sides.push(((await rows.nth(i).locator('td').allInnerTexts())[3] ?? '').trim());
ok(sides.includes('buy') && sides.includes('sell'), `both directions are held at once (${sides.join(', ')})`);

const badge = await page.locator('span', { hasText: /^\d+ open$/ }).first().innerText().catch(() => '');
ok(badge === `${n} open`, `the badge counts them (${JSON.stringify(badge)})`);

await page.screenshot({ path: `${DIR}/m-three.png` });

// Each row closes ITS OWN position.
const firstTicket = tickets[0];
const closeX = rows.nth(0).locator('button[aria-label="Close position"]');
if (await closeX.count()) {
  await closeX.evaluate((el) => el.click());
  await page.waitForTimeout(3000);
  const after = [];
  const n2 = await rows.count();
  for (let i = 0; i < n2; i++) after.push(((await rows.nth(i).locator('td').allInnerTexts())[1] ?? '').trim());
  ok(n2 === n - 1, `closing one row leaves the others open (${n} then ${n2})`);
  ok(!after.includes(firstTicket), `the position that closed is the one whose × was pressed (#${firstTicket} gone)`);
  console.log('   remaining:', JSON.stringify(after));
} else {
  ok(false, 'the row carries no close control');
}

// ── 3. the result panel does not cover the trade buttons ───────────────────────────────────
const buyBox = await page.locator('button', { hasText: /^Buy by Market$/ }).first().boundingBox();
const res = await page.locator('[data-order-result]').first();
if (await res.count()) {
  const rb = await res.boundingBox();
  const placement = await res.getAttribute('data-order-result-placement');
  ok(placement === 'inline', `the docked ticket renders the result inline (got ${placement})`);
  if (rb && buyBox) {
    const overlap = !(rb.y + rb.height <= buyBox.y || rb.y >= buyBox.y + buyBox.height);
    ok(!overlap, `the result panel does not overlap the Buy button (result ${rb.y.toFixed(0)}..${(rb.y + rb.height).toFixed(0)}, button ${buyBox.y.toFixed(0)}..${(buyBox.y + buyBox.height).toFixed(0)})`);
  }
}
// Whatever is on screen, the buttons must be pressable.
try {
  await page.locator('button', { hasText: /^Buy by Market$/ }).first().click({ timeout: 5000 });
  ok(true, 'the Buy button is clickable with positions open and a result showing');
} catch (e) {
  ok(false, `the Buy button is blocked: ${String(e).split('\n')[0].slice(0, 100)}`);
}
await page.waitForTimeout(2000);
await page.screenshot({ path: `${DIR}/m-final.png` });

await browser.close();
console.log(fails.length ? `\n${fails.length} failure(s):\n - ${fails.join('\n - ')}` : '\nMULTI-POSITION CLEAN');
