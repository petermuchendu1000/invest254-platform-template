import pkg from '/home/user/invest254/node_modules/playwright-core/index.js';
const { chromium } = pkg;
import crypto from 'node:crypto';

const SECRET = 'harness-secret-0001';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const p = b64({ sub, iat: now, exp: now + 7200, role: 'player', site: '00000000-0000-0000-0000-000000000001' });
  const s = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
const uid = (n) => `e${n}-0000-0000-0000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const fails = [];
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails.push(m); };

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const id = uid(1);
await ctx.addInitScript(([t]) => {
  localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 }));
}, [jwt(id)]);
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 160)); });
await page.goto('http://127.0.0.1:3100/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

// Place a BUY from the docked ticket.
const buy = page.locator('button', { hasText: /^Buy/ }).first();
await buy.waitFor({ state: 'visible', timeout: 20000 });
await buy.click();
await page.waitForTimeout(4000);

// The docked Toolbox can start collapsed; its summary strip is the control that opens it.
async function openToolbox(p) {
  if (await p.locator('tr[title="Open the position menu"]').count()) return;
  const summary = p.locator('button', { hasText: /\d+ open/ }).first();
  if (await summary.count()) { await summary.click(); await p.waitForTimeout(900); }
  if (await p.locator('tr[title="Open the position menu"]').count()) return;
  const tab = p.locator('button', { hasText: /^Trade$/ }).first();
  if (await tab.count()) { await tab.click(); await p.waitForTimeout(900); }
}
await openToolbox(page);

// ── The Trade grid's Ticket cell ────────────────────────────────────────────────────────────────
const row = page.locator('tr[title="Open the position menu"]').first();
await row.waitFor({ state: 'visible', timeout: 20000 });
const cells = await row.locator('td').allInnerTexts();
console.log('  grid row:', JSON.stringify(cells));
const ticketCell = (cells[1] ?? '').trim();
ok(/^\d{6,}$/.test(ticketCell), `Trade grid Ticket is a MetaTrader integer, got ${JSON.stringify(ticketCell)}`);
ok(!/^[0-9a-f]{8}$/.test(ticketCell) || /^\d+$/.test(ticketCell), 'Trade grid Ticket is not a hex fragment');
const ticket = Number(ticketCell);
ok(ticket >= 100000, `the ticket starts in six figures (${ticket})`);

// ── The position menu's subtitle ────────────────────────────────────────────────────────────────
await row.click();
await page.waitForTimeout(800);
const body = await page.locator('body').innerText();
ok(body.includes(`#${ticket} at `), `the position menu names the deal "#${ticket} at <price>"`);

// ── The Close position form ─────────────────────────────────────────────────────────────────────
// Scoped to the MENU, not the whole page: the live-position card carries its own "Close position"
// button, which sits behind the menu's dismiss scrim while the menu is up.
const menu = page.locator('[role="dialog"], [role="menu"]').last();
const closeItem = (await menu.count() ? menu : page).locator('button', { hasText: /^Close position$/ }).last();
if (await closeItem.count()) {
  await closeItem.click();
  await page.waitForTimeout(900);
  const close = await page.locator('body').innerText();
  ok(close.includes(String(ticket)), `the Close position form carries ticket ${ticket}`);
  ok(!/#[0-9a-f]{8}\b/.test(close) || /#\d+/.test(close), 'the Close form shows no hex ticket');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

// ── A SECOND trade gets the NEXT ticket ─────────────────────────────────────────────────────────
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const id2 = uid(2);
await ctx2.addInitScript(([t]) => {
  localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 }));
}, [jwt(id2)]);
const p2 = await ctx2.newPage();
await p2.goto('http://127.0.0.1:3100/', { waitUntil: 'networkidle' });
await p2.waitForTimeout(3000);
await p2.locator('button', { hasText: /^Buy/ }).first().click();
await p2.waitForTimeout(4000);
await openToolbox(p2);
const row2 = p2.locator('tr[title="Open the position menu"]').first();
await row2.waitFor({ state: 'visible', timeout: 20000 });
const t2 = Number(((await row2.locator('td').allInnerTexts())[1] ?? '').trim());
ok(Number.isFinite(t2) && t2 > ticket, `the next trade gets a HIGHER ticket (${ticket} then ${t2})`);

// ── A RELOAD must not renumber the position ─────────────────────────────────────────────────────
await p2.reload({ waitUntil: 'networkidle' });
await p2.waitForTimeout(4000);
await openToolbox(p2);
const row2b = p2.locator('tr[title="Open the position menu"]').first();
await row2b.waitFor({ state: 'visible', timeout: 20000 });
const t2b = Number(((await row2b.locator('td').allInnerTexts())[1] ?? '').trim());
ok(t2b === t2, `a reload recovers the SAME ticket (${t2} then ${t2b})`);

await browser.close();
console.log(fails.length ? `\n${fails.length} failure(s)` : '\nTICKET CLEAN');
