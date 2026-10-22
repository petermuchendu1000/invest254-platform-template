/**
 * The three features the terminated agents left behind, measured against the researched MT5 facts.
 *
 *   A. the desktop application chrome  (menu bar + Standard/Line Studies toolbars + Periodicity)
 *   B. the chart background context menu  (docs/mt5/08-chart-properties.md:482-531)
 *   C. the Toolbox tab strip, the History tab and the Alert Editor (docs/mt5/09-toolbox.md)
 *
 * On B the menu deliberately draws only rows that can ACT, each omission argued in the component
 * against the doc's own row numbers, so the assertion is not "27 rows" but "every row MetaTrader
 * has that this platform can honour, under MetaTrader's label, accelerator and grouping" — plus the
 * one defect the agent had named and not confirmed fixed: a submenu must stay inside the window.
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
let seq = 0;
const uid = () => `f${++seq}-0000-0000-0000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;

const fails = [];
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails.push(m); };

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});

async function fresh(w = 1440, h = 900) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(([t]) => {
    localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 }));
  }, [jwt(uid())]);
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:3100/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  return page;
}

/** The docked Toolbox collapses into the account strip; its caret is the expander. */
async function openToolbox(page) {
  const strip = page.locator('button').filter({ hasText: /Balance:/ }).first();
  await strip.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  for (let i = 0; i < 4; i++) {
    if (await page.locator('button', { hasText: /^Journal$/ }).count()) return;
    if (await strip.count()) { await strip.click({ force: true }).catch(() => {}); }
    await page.waitForTimeout(1200);
  }
  const seen = (await page.locator('button:visible').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  console.log('   [openToolbox gave up] visible buttons tail:', JSON.stringify(seen.slice(-14)));
}

// ─────────────────────────── A. the desktop application chrome ───────────────────────────
console.log('\n── A. desktop chrome');
{
  const page = await fresh();
  const bar = page.locator('[role="menubar"][aria-label="Terminal"]');
  ok(await bar.count() === 1, 'a single terminal menu bar');
  const titles = (await bar.locator('button').allInnerTexts()).map((t) => t.trim());
  for (const m of ['File', 'View', 'Insert', 'Charts']) ok(titles.includes(m), `the menu bar carries ${m}`);
  ok(await page.locator('[role="toolbar"][aria-label="Standard"]').count() === 1, 'the Standard toolbar');
  ok(await page.locator('[role="toolbar"][aria-label="Line Studies"]').count() === 1, 'the Line Studies toolbar');
  ok(await page.locator('[aria-label="Periodicity"]').count() >= 1, 'the Periodicity toolbar');
  await bar.locator('button', { hasText: /^File$/ }).first().click();
  await page.waitForTimeout(350);
  ok(await page.locator('[role="menu"][aria-label="File"]').count() === 1, 'File opens its menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  ok(await page.locator('[role="menu"][aria-label="File"]').count() === 0, 'Escape closes the File menu');
  await page.context().close();
}

// ─────────────────────── B. the chart background context menu ────────────────────────────
console.log('\n── B. chart context menu');
{
  const page = await fresh();
  const plot = page.locator('[role="img"][aria-label$="price chart"]').first();
  const pb = await plot.boundingBox();
  if (!pb) throw new Error('no chart plot found');

  async function openAt(fracY) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await page.mouse.move(pb.x + pb.width * 0.5, pb.y + pb.height * fracY);
    await page.mouse.click(pb.x + pb.width * 0.5, pb.y + pb.height * fracY, { button: 'right' });
    await page.waitForTimeout(500);
    return page.locator('[data-chart-menu]');
  }

  const menu = await openAt(0.4);
  ok(await menu.count() === 1, 'a right click on the chart opens the chart menu');
  const text = await menu.innerText();

  // Every row MetaTrader has that this platform can honour, with the accelerator MetaQuotes prints.
  for (const [label, accel] of [
    ['One Click Trading', 'Alt+T'], ['Indicator List', 'Ctrl+I'], ['Object List', 'Ctrl+B'],
    ['Bar Chart', 'Alt+1'], ['Candlesticks', 'Alt+2'], ['Line Chart', 'Alt+3'],
    ['Grid', 'Ctrl+G'], ['Zoom In', '+'], ['Zoom Out', '-'], ['Properties', 'F8'],
  ]) ok(text.includes(label) && text.includes(accel), `${label} carries ${accel}`);
  for (const label of ['Trading', 'Timeframes', 'Refresh', 'Auto Scroll', 'Chart Shift', 'Trade Levels', 'Save as Picture']) {
    ok(text.includes(label), `the menu carries ${label}`);
  }
  // The omitted rows are omitted, not drawn dead: a command that cannot act is the one failure a
  // menu cannot afford, and each absence is argued in the component against the doc's row number.
  for (const label of ['Depth Of Market', 'Expert List', 'Templates', 'Docked', 'Tick Volumes', 'Step by Step', 'Delete Indicators Window']) {
    ok(!text.includes(label), `${label} is absent rather than drawn dead`);
  }
  const seps = await menu.locator('[data-menu-separator]').count();
  ok(seps === 8, `the drawn groups keep MetaTrader's separators (got ${seps})`);

  // ── The Trading submenu: one row, carrying the price that was right-clicked ────────────────
  const trading = menu.locator('[role="menuitem"]', { hasText: /^Trading/ }).first();
  await trading.hover();
  await page.waitForTimeout(450);
  const tsub = page.locator('[role="menu"][aria-label="Trading"]');
  ok(await tsub.count() === 1, 'Trading opens its submenu');
  const alertRow = (await tsub.innerText()).trim();
  ok(/^Alert\s+[\d.]+$/.test(alertRow), `the submenu is MetaTrader's "Alert  <price>" row (got ${JSON.stringify(alertRow)})`);
  const alertPrice = Number(alertRow.replace(/^Alert\s+/, ''));
  ok(Number.isFinite(alertPrice) && alertPrice > 0, `the row carries a real price (${alertPrice})`);
  // A command row, not a permanently-unchecked radio.
  ok(await tsub.locator('[role="menuitem"]').count() === 1, 'the Alert row is announced as a command');
  ok(await tsub.locator('[role="menuitemradio"]').count() === 0, 'the Alert row is not a radio');
  const tb = await tsub.boundingBox();
  ok(tb !== null && tb.x + tb.width <= page.viewportSize().width, 'the Trading submenu is wide enough and still on screen');

  // ── The defect the agent named: Timeframes must stay inside the window ─────────────────────
  const tf = menu.locator('[role="menuitem"]', { hasText: /^Timeframes/ }).first();
  await tf.hover();
  await page.waitForTimeout(450);
  const sub = page.locator('[role="menu"][aria-label="Timeframes"]');
  const sb = await sub.boundingBox();
  const vh = page.viewportSize().height, vw = page.viewportSize().width;
  ok(sb !== null && sb.y >= 0 && sb.y + sb.height <= vh, `Timeframes fits vertically (bottom ${(sb ? sb.y + sb.height : 0).toFixed(0)} of ${vh})`);
  ok(sb !== null && sb.x >= 0 && sb.x + sb.width <= vw, 'Timeframes fits horizontally');
  const keys = (await sub.locator('button').allInnerTexts()).map((t) => t.trim());
  ok(keys.length === 21 && keys.includes('M1') && keys.includes('MN1'), `all 21 periods are listed (${keys.length})`);

  const low = await openAt(0.97);
  const lowBox = await low.boundingBox();
  ok(lowBox !== null && lowBox.y + lowBox.height <= vh, 'a menu opened at the bottom edge stays inside the window');
  await low.locator('[role="menuitem"]', { hasText: /^Timeframes/ }).first().hover();
  await page.waitForTimeout(450);
  const sb2 = await page.locator('[role="menu"][aria-label="Timeframes"]').boundingBox();
  ok(sb2 !== null && sb2.y >= 0 && sb2.y + sb2.height <= vh, `its submenu stays inside too (bottom ${(sb2 ? sb2.y + sb2.height : 0).toFixed(0)} of ${vh})`);

  // ── The Alert row must actually create the alert, at that price ────────────────────────────
  const m2 = await openAt(0.3);
  const t2 = m2.locator('[role="menuitem"]', { hasText: /^Trading/ }).first();
  await t2.hover();
  await page.waitForTimeout(450);
  const row2 = page.locator('[role="menu"][aria-label="Trading"] [role="menuitem"]').first();
  const wanted = Number((await row2.innerText()).replace(/^Alert\s+/, '').trim());
  await row2.click();
  await page.waitForTimeout(700);
  ok(await page.locator('[data-chart-menu]').count() === 0, 'choosing the Alert row closes the menu');

  // Read what was actually STORED rather than what a tab happens to render: this is the alert the
  // watcher will check, with the price and the condition it was created with.
  const stored = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('pp-price-alerts') || 'null'); } catch { return null; }
  });
  const made = stored?.state?.alerts?.[0] ?? null;
  ok(made !== null, 'the Alert row created an alert');
  if (made) {
    ok(Math.abs(made.price - wanted) < 1e-6, `the alert is at the price that was clicked (${made.price} vs ${wanted})`);
    ok(made.enabled === true, 'the alert is created enabled, as MetaTrader creates one');
    ok(made.symbol === 'XAUUSD', `the alert carries the chart's symbol (${made.symbol})`);
    // Above the market fires on a rise, below it on a fall. An alert that is already true the
    // moment it is created is not an alert.
    ok(made.condition === 'last>' || made.condition === 'last<', `the condition follows the cursor (${made.condition})`);
  }

  // And it reaches the Alerts tab, which is where a trader manages it. Through a RELOAD, which also
  // proves the alert is persisted rather than living only in the page that made it.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await openToolbox(page);
  const bTab = page.locator('button', { hasText: /^Alerts/ }).last();
  if (await bTab.count()) {
    await bTab.click();
    await page.waitForTimeout(900);
    const alertsText = await page.locator('[data-alerts-tab]').innerText();
    ok(alertsText.includes(String(wanted)), `the alert survives a reload and is listed at ${wanted}`);
    ok(/Last [<>]/.test(alertsText), 'the Alerts tab prints its Last condition');
  } else {
    ok(false, 'the Alerts tab could not be reached after the reload');
  }
  await page.context().close();
}

// ──────────────────── C. the Toolbox tab strip, History and the Alert Editor ─────────────
console.log('\n── C. Toolbox, History and Alerts');
{
  const page = await fresh();
  await openToolbox(page);

  // docs/mt5/09-toolbox.md:192 — these eleven are in EVERY published tab strip.
  const visible = (await page.locator('button:visible').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  for (const tab of ['Trade', 'Exposure', 'History', 'News', 'Mailbox', 'Calendar', 'Alerts', 'Articles', 'Code Base', 'Experts', 'Journal']) {
    ok(visible.includes(tab), `the Toolbox strip carries ${tab}`);
  }

  await page.locator('button', { hasText: /^History/ }).last().click();
  await page.waitForTimeout(900);
  const grid = page.locator('[data-history-mode]').first();
  ok(await grid.count() >= 1, 'the History grid renders');
  ok(await page.locator('[data-history-strip]').count() >= 1, 'History carries its summary strip');
  // MetaTrader puts the view modes and the period presets in the tab's own RIGHT-CLICK menu, not in
  // a visible button row, which is where this one puts them too.
  const gb = await grid.boundingBox();
  await page.mouse.click(gb.x + gb.width / 2, gb.y + Math.min(40, gb.height / 2), { button: 'right' });
  await page.waitForTimeout(600);
  const hmenu = page.locator('[data-history-menu]');
  ok(await hmenu.count() === 1, 'right-clicking History opens its menu');
  const items = (await hmenu.locator('button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  console.log('   history menu:', JSON.stringify(items));
  for (const m of ['Positions', 'Deals', 'Orders', 'Orders & Deals']) {
    ok(items.some((i) => i.includes(m)), `the menu offers the ${m} view`);
  }
  // Switching view actually switches it, which is what `data-history-mode` reports.
  const before = await grid.getAttribute('data-history-mode');
  await hmenu.locator('button').filter({ hasText: /Positions/ }).first().click();
  await page.waitForTimeout(700);
  const after = await page.locator('[data-history-mode]').first().getAttribute('data-history-mode');
  ok(after === 'positions' && after !== before, `choosing a view switches the grid (${before} then ${after})`);

  await page.locator('button', { hasText: /^Alerts/ }).last().click();
  await page.waitForTimeout(800);
  const tab = page.locator('[data-alerts-tab]').first();
  ok(await tab.count() >= 1, 'the Alerts tab renders');
  // 09-toolbox.md:912-922 — Create / Modify / Delete / Enable live in the tab's context menu.
  const ab = await tab.boundingBox();
  await page.mouse.click(ab.x + ab.width / 2, ab.y + Math.min(30, ab.height / 2), { button: 'right' });
  await page.waitForTimeout(600);
  const amenu = page.locator('[data-alerts-menu]');
  ok(await amenu.count() === 1, 'right-clicking Alerts opens its menu');
  const aitems = (await amenu.locator('button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  for (const m of ['Create', 'Modify', 'Delete', 'Enable']) {
    ok(aitems.some((i) => i.includes(m)), `the Alerts menu offers ${m}`);
  }
  await amenu.locator('button').filter({ hasText: /Create/ }).first().click();
  await page.waitForTimeout(800);
  const editor = page.locator('[aria-label="Alert Editor"]');
  ok(await editor.count() >= 1, 'the Alert Editor opens');
  if (await editor.count()) {
    // 09-toolbox.md:924 — "The dialog is titled `Alert Editor`", field labels verified verbatim.
    for (const f of ['Symbol', 'Condition', 'Value', 'Expiration', 'Timeout', 'Source', 'Maximum iterations']) {
      ok(await editor.locator(`[aria-label="${f}"]`).count() >= 1, `the editor has MetaTrader's ${f} field`);
    }
  }
  await page.context().close();
}

await browser.close();
console.log(fails.length ? `\n${fails.length} failure(s):\n - ${fails.join('\n - ')}` : '\nTHREE FEATURES CLEAN');
