/**
 * The six measured layout defects, re-measured.
 *
 * Every number here is read from the live DOM with `scrollWidth - clientWidth`,
 * `getBoundingClientRect` and `document.elementFromPoint` — never from a screenshot. Each case
 * prints the figure the audit recorded (BEFORE) beside the figure measured now (NOW), so a fix is
 * proved by the same instrument that found the defect.
 *
 *   1  Toolbox tab strip: per-label clipping, 11 tabs
 *   2  Order-ticket volume steppers: per-button clipping
 *   3  Market Watch `Ticks` tab: clipped by the panel, and not clickable
 *   4  Chart ⚙ Tools menu: (a) `Candlesticks` pill, (b) 38 indicator rows past the menu edge
 *   5  Toolbox Trade table with a position open: is `Profit` inside the pane
 *   6  Live-chat launcher over BUY in phone landscape: overlap and what owns the pixel
 *
 * Run: node sixdefects.mjs
 */
import pkg from '/home/user/invest254/node_modules/playwright-core/index.js';
import { createHmac } from 'node:crypto';
const { chromium } = pkg;

const WIDTHS = [1024, 1100, 1152, 1200, 1279, 1280, 1366, 1440];
const LANDSCAPE = [[800, 360], [844, 390]];

/** A fresh player per context: an open position from an earlier case would replace the ticket. */
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const RUN = Date.now().toString(16).padStart(12, '0').slice(-12);
let uid = 0;
const sign = () => {
  const sub = `e${String(++uid).padStart(7, '0')}-0000-0000-0000-${RUN}`;
  const h = b64u({ alg: 'HS256', typ: 'JWT' });
  const now = Date.now() / 1000 | 0;
  const p = b64u({ sub, iat: now, exp: now + 3600, role: 'player', site: '00000000-0000-0000-0000-000000000001' });
  return `${h}.${p}.${createHmac('sha256', 'harness-secret-0001').update(`${h}.${p}`).digest('base64url')}`;
};
const until = async (pg, fn, ms = 30000, step = 300) => {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return v; await pg.waitForTimeout(step); }
};

/* ── the measurements, run inside the page ─────────────────────────────────────────────── */

const M = {
  /** 1. Toolbox tab strip. Per-button `scrollWidth - clientWidth`, plus the strip's own. */
  toolboxTabs: () => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Code Base');
    if (!btns.length) return null;
    const strip = btns[0].parentElement;
    const tabs = [...strip.children].map((b) => ({ label: b.textContent.trim(), clip: b.scrollWidth - b.clientWidth }));
    return { stripOverflow: strip.scrollWidth - strip.clientWidth, scrollable: getComputedStyle(strip).overflowX, tabs };
  },

  /** 2. Volume steppers. The four `±0.010/±0.100` cells. */
  steppers: () => [...document.querySelectorAll('button[aria-label^="Decrease volume by"], button[aria-label^="Increase volume by"]')]
    .map((b) => ({ label: b.textContent.trim(), w: Math.round(b.getBoundingClientRect().width), clip: b.scrollWidth - b.clientWidth })),

  /** 3. Market Watch `Ticks`: clipped by the `aside`, and is the pixel its own? */
  mwTicks: () => {
    const strip = document.querySelector('[data-mw-tabs]');
    if (!strip) return null;
    const aside = strip.closest('aside');
    const ticks = [...strip.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Ticks');
    if (!ticks) return null;
    const r = ticks.getBoundingClientRect(); const a = aside.getBoundingClientRect();
    // The last pixel column of the tab: whoever owns it is who a click there reaches.
    const hitX = Math.min(r.right - 2, innerWidth - 1);
    const hit = document.elementFromPoint(hitX, r.top + r.height / 2);
    return {
      stripScroll: strip.scrollWidth, stripClient: strip.clientWidth,
      stripOverflow: strip.scrollWidth - strip.clientWidth,
      asideW: Math.round(a.width), tabLeft: Math.round(r.left), tabRight: Math.round(r.right),
      panelRight: Math.round(a.right), past: Math.round(r.right - a.right),
      hitIsTicks: hit === ticks || (hit !== null && ticks.contains(hit)),
    };
  },

  /** 4. The ⚙ Tools menu: the `Candlesticks` pill, and every indicator row. */
  toolsMenu: () => {
    const gear = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('⚙ Tools'));
    if (!gear) return null;
    const menu = gear.parentElement.querySelector('div.absolute');
    if (!menu) return { open: false };
    const types = [...menu.querySelectorAll('button')].filter((b) => ['Bar chart', 'Candlesticks', 'Line chart', 'Heikin Ashi'].includes(b.textContent.trim()));
    const rows = [...menu.querySelectorAll('button[aria-pressed]')].filter((b) => b.querySelector('span'));
    const mr = menu.getBoundingClientRect();
    const rowOver = rows.map((b) => {
      const inner = b.querySelector('span');
      return {
        text: inner.textContent.trim(),
        innerClip: inner.scrollWidth - inner.clientWidth,
        ellipsis: getComputedStyle(inner).textOverflow === 'ellipsis' && getComputedStyle(inner).overflow === 'hidden',
        pastMenu: Math.round(b.getBoundingClientRect().right - mr.right),
      };
    });
    return {
      open: true,
      menuScroll: menu.scrollWidth, menuClient: menu.clientWidth,
      menuOverflow: menu.scrollWidth - menu.clientWidth,
      types: types.map((b) => ({ label: b.textContent.trim(), clip: b.scrollWidth - b.clientWidth, h: Math.round(b.getBoundingClientRect().height) })),
      rows: rowOver.length,
      worstPastMenu: rowOver.reduce((m, r) => Math.max(m, r.pastMenu), -999),
      noEllipsisClipped: rowOver.filter((r) => r.innerClip > 1 && !r.ellipsis).length,
      sample: rowOver.filter((r) => /Average Directional/.test(r.text))[0] ?? rowOver[0],
    };
  },

  /** 5. The Trade table with a position open: where `Profit` sits relative to its pane. */
  tradeTable: () => {
    // A `2xl:block` wrapper is still in the DOM below 1536 with a zero box, so ask for a row that
    // is actually being drawn, not merely present.
    const row = [...document.querySelectorAll('tr[title="Open the position menu"]')]
      .find((r) => r.getBoundingClientRect().width > 0) ?? null;
    if (!row) {
      // No ten-column table: MetaTrader's narrow form, the two-line entry, should be carrying it.
      const entry = [...document.querySelectorAll('button')].find((b) => /^Position menu for /.test(b.getAttribute('aria-label') ?? ''));
      if (!entry) return null;
      const pane = entry.closest('div.overflow-auto') ?? entry.parentElement;
      const pr = pane.getBoundingClientRect(); const er = entry.getBoundingClientRect();
      // The profit figure is the last line of the right-hand column of the entry.
      const fig = [...entry.querySelectorAll('div')].map((d) => d.textContent.trim()).filter((t) => /\d/.test(t));
      // The right-hand column of the entry: the profit figure first, MetaTrader's note under it.
      const profit = entry.querySelector('div.text-right').firstElementChild;
      const prr = profit.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.min(prr.left + prr.width / 2, innerWidth - 1), prr.top + prr.height / 2);
      return {
        form: 'two-line entry', paneW: Math.round(pr.width), entryW: Math.round(er.width),
        paneOverflow: pane.scrollWidth - pane.clientWidth,
        profitText: profit.textContent.trim(),
        profitPast: Math.round(prr.right - pr.right),
        profitVisible: prr.right <= pr.right + 1 && prr.left >= pr.left - 1,
        closeReachable: entry.contains(hit),
        lines: fig.length,
      };
    }
    const table = row.closest('table');
    const pane = table.closest('div.overflow-auto') ?? table.parentElement;
    const pr = pane.getBoundingClientRect();
    const heads = [...table.querySelectorAll('thead th')].map((th, i) => ({
      i, label: th.textContent.trim(),
      // The audit's metric: how far the column's RIGHT edge sits past the right edge of the pane.
      past: Math.round(th.getBoundingClientRect().right - pr.right),
      visible: th.getBoundingClientRect().right <= pr.right + 1,
      clip: th.scrollWidth - th.clientWidth,
    }));
    const profit = heads[heads.length - 1];
    const profitCell = [...row.children][row.children.length - 1];
    const pc = profitCell.getBoundingClientRect();
    const hit = pc.width > 0 ? document.elementFromPoint(Math.min(pc.left + pc.width / 2, innerWidth - 1), pc.top + pc.height / 2) : null;
    return {
      form: 'ten-column table',
      paneW: Math.round(pr.width), tableW: Math.round(table.getBoundingClientRect().width),
      tableScroll: table.scrollWidth, paneOverflow: pane.scrollWidth - pane.clientWidth,
      cols: heads.length, order: heads.map((h) => h.label).join(' | '),
      profitPast: profit.past, profitVisible: profit.visible,
      offscreen: heads.filter((h) => !h.visible).map((h) => `${h.label}+${h.past}`),
      clipped: heads.filter((h) => h.clip > 1).map((h) => `${h.label} ${h.clip}px`),
      closeReachable: hit !== null && profitCell.contains(hit),
    };
  },

  /** 6. The live-chat launcher over BUY. Overlap in px² and in % of BUY, plus who owns the pixel. */
  chatOverBuy: () => {
    const chat = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Live chat'));
    const buy = [...document.querySelectorAll('button')].find((b) => /^Buy /.test(b.getAttribute('aria-label') ?? ''));
    if (!buy) return null;
    const br = buy.getBoundingClientRect();
    const out = { buy: [br.left, br.top, br.width, br.height].map(Math.round), chat: null, overlapPct: 0, buyRightOwner: null };
    // The right-hand end of BUY: on a laptop this is BUY, in landscape the audit found the launcher.
    const hx = Math.min(br.right - 6, innerWidth - 1), hy = br.top + br.height / 2;
    const hit = document.elementFromPoint(hx, hy);
    out.buyRightOwner = hit === null ? 'none' : (buy.contains(hit) ? 'BUY' : (chat && chat.contains(hit) ? 'live chat' : (hit.tagName.toLowerCase() + '.' + String(hit.className).slice(0, 24))));
    if (!chat || !chat.getClientRects().length) return out;
    const cr = chat.getBoundingClientRect();
    out.chat = [cr.left, cr.top, cr.width, cr.height].map(Math.round);
    // Moving it must not land it on some other control instead.
    out.hits = [...document.querySelectorAll('button, a, [role=\"button\"]')].filter((el) => {
      if (el === chat || chat.contains(el) || el.contains(chat) || !el.getClientRects().length) return false;
      const r = el.getBoundingClientRect();
      return Math.min(r.right, cr.right) - Math.max(r.left, cr.left) > 0 && Math.min(r.bottom, cr.bottom) - Math.max(r.top, cr.top) > 0;
    }).map((el) => (el.getAttribute('aria-label') ?? el.textContent.trim()).slice(0, 28));
    out.centreOwner = (() => { const h = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2); return h === null ? 'none' : (chat.contains(h) ? 'live chat' : h.tagName.toLowerCase()); })();
    const ow = Math.max(0, Math.min(br.right, cr.right) - Math.max(br.left, cr.left));
    const oh = Math.max(0, Math.min(br.bottom, cr.bottom) - Math.max(br.top, cr.top));
    out.overlapPct = Math.round((ow * oh) / (br.width * br.height) * 1000) / 10;
    return out;
  },
};

const fn = (name) => `(${M[name].toString()})()`;

/* ── drivers ──────────────────────────────────────────────────────────────────────────── */

const open = async (browser, w, h, mobile = false) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const pg = await ctx.newPage();
  await pg.addInitScript((t) => localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 })), sign());
  await pg.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded' });
  await until(pg, async () => (await pg.evaluate(() => document.body.innerText)).length > 400);
  await pg.waitForTimeout(2200);
  return { ctx, pg };
};

const BEFORE = {
  1: { 1024: 'Code Base 23, Exposure 16, Calendar 14, Mailbox 7, Articles 6, Experts 6, History 4, Journal 3 (8 of 11 clipped)', 1280: 'Code Base 8' },
  2: '4 buttons 49px wide, each clipping 5px (1024-1279); clean at 1280+',
  3: 'strip 248 vs 238 (overflow 10), Ticks 213->261 past panel 251 by 10, not clickable (<1280)',
  4: 'Candlesticks clip 13px; menu 309 vs 238 (overflow 70), 38 rows past the edge, no ellipsis',
  5: '1024: pane 446 table 720, Profit +274 | 1152 +165 | 1280 +126 | 1366 +36 | 1440 fits',
  6: '48x48 launcher at (736,288) covers 13% of BUY (462,289,330,51); right end opens live chat',
};

const pad = (s, n) => String(s).padEnd(n);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
let fails = 0;
const bad = (msg) => { fails += 1; console.log(`      FAIL  ${msg}`); };

console.log('================ DEFECTS 1-4 (no position) ================');
for (const w of WIDTHS) {
  const { ctx, pg } = await open(browser, w, 800);
  console.log(`\n--- ${w}px ---`);

  // 1. Toolbox tabs. Ctrl+T opens the Toolbox (MetaTrader's own shortcut).
  await pg.keyboard.press('Control+t');
  await until(pg, async () => await pg.evaluate(fn('toolboxTabs')) !== null, 8000);
  await pg.waitForTimeout(200);
  const t1 = await pg.evaluate(fn('toolboxTabs'));
  if (!t1) bad('1: Toolbox tab strip not found');
  else {
    const clipped = t1.tabs.filter((t) => t.clip > 1);
    console.log(`  1 tabs      BEFORE ${BEFORE[1][w] ?? 'clean'}`);
    console.log(`              NOW    ${clipped.length}/${t1.tabs.length} clipped${clipped.length ? ': ' + clipped.map((c) => `${c.label} ${c.clip}px`).join(', ') : ''}; strip overflow ${t1.stripOverflow}px (${t1.scrollable})`);
    if (clipped.length) bad(`1: ${clipped.length} tab label(s) clipped at ${w}`);
    if (t1.tabs.length !== 11) bad(`1: ${t1.tabs.length} tabs drawn, expected 11`);
  }

  // 2. Volume steppers.
  const t2 = await pg.evaluate(fn('steppers'));
  const c2 = t2.filter((b) => b.clip > 1);
  console.log(`  2 steppers  BEFORE ${BEFORE[2]}`);
  console.log(`              NOW    ${t2.length} buttons [${t2.map((b) => `${b.label} ${b.w}px/${b.clip}`).join('  ')}]`);
  if (t2.length !== 4) bad(`2: ${t2.length} stepper buttons, expected 4`);
  if (c2.length) bad(`2: ${c2.length} stepper(s) clipping their label at ${w}`);

  // 3. Market Watch Ticks.
  const t3 = await pg.evaluate(fn('mwTicks'));
  if (!t3) bad('3: Market Watch tab strip not found');
  else {
    console.log(`  3 Ticks     BEFORE ${BEFORE[3]}`);
    console.log(`              NOW    strip ${t3.stripScroll} vs ${t3.stripClient} (overflow ${t3.stripOverflow}); Ticks ${t3.tabLeft}->${t3.tabRight}, panel ends ${t3.panelRight} (past ${t3.past}); clickable: ${t3.hitIsTicks}`);
    if (t3.past > 0) bad(`3: Ticks runs ${t3.past}px past the panel at ${w}`);
    if (!t3.hitIsTicks) bad(`3: the Ticks tab's own last pixel is not clickable at ${w}`);
  }

  // 4. ⚙ Tools menu.
  await pg.evaluate(() => { const g = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('⚙ Tools')); g.click(); });
  await pg.waitForTimeout(400);
  const t4 = await pg.evaluate(fn('toolsMenu'));
  if (!t4 || !t4.open) bad('4: ⚙ Tools menu did not open');
  else {
    const candles = t4.types.find((t) => t.label === 'Candlesticks');
    console.log(`  4 Tools     BEFORE ${BEFORE[4]}`);
    console.log(`              NOW    types [${t4.types.map((t) => `${t.label} clip ${t.clip} h${t.h}`).join(' | ')}]`);
    console.log(`                     menu ${t4.menuScroll} vs ${t4.menuClient} (overflow ${t4.menuOverflow}); ${t4.rows} rows, worst past edge ${t4.worstPastMenu}px, clipped-without-ellipsis ${t4.noEllipsisClipped}`);
    console.log(`                     sample "${t4.sample.text}" innerClip ${t4.sample.innerClip} ellipsis ${t4.sample.ellipsis}`);
    if (candles && candles.clip > 1) bad(`4a: Candlesticks clips ${candles.clip}px at ${w}`);
    if (t4.menuOverflow > 1) bad(`4b: menu content overflows ${t4.menuOverflow}px at ${w}`);
    if (t4.worstPastMenu > 0) bad(`4b: a row runs ${t4.worstPastMenu}px past the menu at ${w}`);
    if (t4.noEllipsisClipped > 0) bad(`4b: ${t4.noEllipsisClipped} row(s) cut with no ellipsis at ${w}`);
    if (t4.rows < 38) bad(`4b: ${t4.rows} indicator rows, expected 38+`);
  }
  await pg.screenshot({ path: `/tmp/claude-0/-home-user/452c9309-f7cb-51b6-8e0c-13816b147fab/scratchpad/six-${w}.png` });
  await ctx.close();
}

console.log('\n================ DEFECT 5 (position open) ================');
console.log(`  BEFORE ${BEFORE[5]}`);
// 1536 is not one of the audit's widths; it is here to prove the ten-column grid still renders,
// in MetaTrader's order, where the pane is wide enough for it.
for (const w of [...WIDTHS, 1536]) {
  const { ctx, pg } = await open(browser, w, 800);
  await pg.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Buy by Market'); b.click(); });
  await pg.keyboard.press('Control+t');
  const got = await until(pg, async () => await pg.evaluate(fn('tradeTable')) !== null, 25000);
  const t5 = await pg.evaluate(fn('tradeTable'));
  if (!t5) { bad(`5: no open position at ${w} (got ${got})`); await ctx.close(); continue; }
  await pg.waitForTimeout(300);
  const r = await pg.evaluate(fn('tradeTable'));
  console.log(`\n--- ${w}px ---  form: ${r.form}`);
  if (r.form === 'ten-column table') {
    console.log(`  pane ${r.paneW}  table ${r.tableW} (scroll ${r.tableScroll}, pane overflow ${r.paneOverflow})`);
    console.log(`  columns ${r.cols}: ${r.order}`);
    if (r.offscreen.length) console.log(`  off the pane: ${r.offscreen.join(', ')}`);
    if (r.clipped.length) console.log(`  header truncation: ${r.clipped.join(', ')}`);
    if (r.order !== 'Symbol | Ticket | Time | Type | Volume | Price | S / L | T / P | Price | Profit') bad(`5: column order changed at ${w}: ${r.order}`);
  } else {
    console.log(`  pane ${r.paneW}  entry ${r.entryW} (pane overflow ${r.paneOverflow}); profit figure "${r.profitText}"`);
  }
  console.log(`  Profit ${r.profitVisible ? 'ON SCREEN' : `OFF SCREEN by ${r.profitPast}px`}; its own pixel reaches the close route: ${r.closeReachable}`);
  if (!r.profitVisible) bad(`5: Profit is ${r.profitPast}px off the pane at ${w}`);
  if (!r.closeReachable) bad(`5: the Profit figure's row is not clickable at ${w}`);
  await pg.screenshot({ path: `/tmp/claude-0/-home-user/452c9309-f7cb-51b6-8e0c-13816b147fab/scratchpad/six-trade-${w}.png` });
  await ctx.close();
}

console.log('\n================ DEFECT 6 (phone landscape) ================');
console.log(`  BEFORE ${BEFORE[6]}`);
for (const [w, h] of LANDSCAPE) {
  const { ctx, pg } = await open(browser, w, h, true);
  // The one-click panel is restored from the store after mount, so wait for BUY to exist.
  await until(pg, async () => await pg.evaluate(() => [...document.querySelectorAll('button')].some((b) => /^Buy /.test(b.getAttribute('aria-label') ?? ''))), 20000);
  await pg.waitForTimeout(600);
  const r = await pg.evaluate(fn('chatOverBuy'));
  console.log(`\n--- ${w}x${h} ---`);
  if (!r) { bad(`6: no BUY button at ${w}x${h}`); await ctx.close(); continue; }
  console.log(`  BUY ${JSON.stringify(r.buy)}  launcher ${r.chat ? JSON.stringify(r.chat) : 'not rendered'}`);
  console.log(`  overlap ${r.overlapPct}% of BUY; the pixel 6px inside BUY's right edge belongs to: ${r.buyRightOwner}`);
  if (r.chat) console.log(`  launcher centre owned by: ${r.centreOwner}; controls under the launcher: ${r.hits.length ? r.hits.join(', ') : 'none'}`);
  if (r.chat && r.hits.length) bad(`6: the launcher now sits on ${r.hits.join(', ')} at ${w}x${h}`);
  if (r.overlapPct > 0) bad(`6: the launcher covers ${r.overlapPct}% of BUY at ${w}x${h}`);
  if (r.buyRightOwner !== 'BUY') bad(`6: BUY's right end is owned by ${r.buyRightOwner} at ${w}x${h}`);
  if (!r.chat) bad(`6: the live-chat launcher is gone at ${w}x${h} (it must stay, just move)`);
  await pg.screenshot({ path: `/tmp/claude-0/-home-user/452c9309-f7cb-51b6-8e0c-13816b147fab/scratchpad/six-ls-${w}x${h}.png` });
  await ctx.close();
}

await browser.close();
console.log(`\n${fails === 0 ? 'ALL SIX CLEAN' : `${fails} measured failure(s)`}`);
process.exit(fails === 0 ? 0 : 1);
