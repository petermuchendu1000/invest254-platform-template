/**
 * ACTIVITY-NOTICE e2e — where the "someone just won" ribbon is allowed to be, measured in Chromium.
 *
 *   CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/web/e2e/activitynotice.e2e.mjs
 *
 * UNLIKE the other e2e scripts here this one needs NO database, API or engine: the brand falls back
 * to DEFAULT_BRAND when `/site/brand` is unreachable (lib/brand/currentBrand), and the one feed this
 * component reads is a client-side fetch, so Playwright can serve it. Start the web app alone:
 *
 *   (cd apps/web && npx next dev -p 3000) &
 *
 * `playwright-core` is not a workspace dependency — the other scripts in this directory assume it
 * too, and CI does not run any of them (there is no browser in the test job). `npm i -g
 * playwright-core` or run it from a directory that has one.
 *
 * WHY IT EXISTS. The ribbon used to be a 288x73 card floating in the middle of the chart. Measured
 * here before the change, it covered 42.7% of the whole chart at 320x568 and 30.6% at 360x640 —
 * over the curve a player reads to choose Higher or Lower, which is what the marketers
 * demonstrating the app were reporting. Every number below is the thing that stops it coming back,
 * and none of them is checkable from a unit test: they are all layout.
 */
import { chromium } from 'playwright-core';

const PORT = process.env.PORT || '3000';
const BASE = `http://localhost:${PORT}`;
const NOTICE = '[data-testid="activity-notice"]';

/** A feed wide enough that `selectCards` always has unshown rows to draw from. */
const ITEMS = Array.from({ length: 40 }, (_, i) => ({
  kind: i % 3 === 0 ? 'win' : i % 3 === 1 ? 'withdrawal' : 'deposit',
  name: ['wanj***', 'kipr***', 'omon***', 'mwan***', 'ochi***'][i % 5] + i,
  amountCents: 120_000 + i * 31_500,
  agoSeconds: 30 + i * 60,
}));

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !info ? '' : `  -- ${String(info).slice(0, 220)}`}`);
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });

/** A page on the trade screen with the activity feed served and nothing else stubbed. */
async function open(viewport, { ui = '', basic = false } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark' });
  if (basic) {
    await ctx.addInitScript(() =>
      localStorage.setItem('pp-interface-mode', JSON.stringify({ state: { mode: 'basic' }, version: 0 })));
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/site/activity*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: ITEMS }) }));
  await page.goto(`${BASE}/${ui ? `?ui=${ui}` : ''}`, { waitUntil: 'domcontentloaded' });
  return { ctx, page, errors };
}

/** The ribbon's own box, once it has finished sliding in (never mid-transition). */
async function settled(page, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const inner = page.locator(`${NOTICE} > div`).first();
    if (await inner.count()) {
      const o = Number(await inner.evaluate((n) => getComputedStyle(n).opacity).catch(() => 0));
      if (o > 0.99) {
        const b = await inner.boundingBox();
        // `boundingBox()` speaks width/height; the rest of this file speaks w/h. Normalise once.
        return b && { x: b.x, y: b.y, w: b.width, h: b.height };
      }
    }
    await page.waitForTimeout(80);
  }
  return null;
}

const rect = (el) => (el ? (({ x, y, width, height }) => ({ x, y, w: width, h: height }))(el.getBoundingClientRect()) : null);
const overlapPx = (a, b) => {
  if (!a || !b) return null;
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return Math.round(w * h);
};

/* ──────────────────────────────────────────────────────────────────────────────
   WAVE SHELL (trade_ui 'classic', the DEFAULT_BRAND this runs as)
   ────────────────────────────────────────────────────────────────────────────── */
console.log('\nWAVE SHELL — the ribbon rides the decorative ticker, the chart keeps every pixel');

/** Tall enough for the ticker row to render (the `max-height:640px` rule keeps it off short ones). */
const TALL = [
  { label: '360x780', width: 360, height: 780 },
  { label: '390x844', width: 390, height: 844 },
  { label: '768x1024', width: 768, height: 1024 },
  { label: '1440x900', width: 1440, height: 900 },
];

for (const vp of TALL) {
  const { ctx, page, errors } = await open({ width: vp.width, height: vp.height });
  const box = await settled(page);
  const geo = await page.evaluate(() => {
    const r = (el) => (el ? (({ x, y, width, height }) => ({ x, y, w: width, h: height }))(el.getBoundingClientRect()) : null);
    const marquee = document.querySelector('.animate-marquee');
    return {
      chart: r(document.querySelector('main [class*="min-h-[160px]"]')),
      ticker: r(marquee ? marquee.closest('div.flex.items-stretch') : null),
      mounts: document.querySelectorAll('[data-testid="activity-notice"]').length,
    };
  });

  check(`wave ${vp.label}: the ribbon is up`, !!box, JSON.stringify(box));
  check(`wave ${vp.label}: mounted exactly once`, geo.mounts === 1, `mounts=${geo.mounts}`);
  // THE FIX, as a number. Anything above zero is the old bug coming back.
  check(`wave ${vp.label}: ZERO overlap with the chart`, overlapPx(box, geo.chart) === 0,
    `overlap=${overlapPx(box, geo.chart)}px chart=${JSON.stringify(geo.chart)}`);
  const tickerArea = geo.ticker ? geo.ticker.w * geo.ticker.h : 0;
  const cover = tickerArea ? overlapPx(box, geo.ticker) / tickerArea : 0;
  check(`wave ${vp.label}: covers the ticker row it borrows (>=99%)`, cover >= 0.99, `cover=${(cover * 100).toFixed(1)}%`);
  // `pointer-events-none` is what keeps a tap on Higher/Lower a tap on Higher/Lower.
  if (box) {
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? !el.closest('[data-testid="activity-notice"]') : false;
    }, [Math.round(box.x + box.w / 2), Math.round(box.y + box.h / 2)]);
    check(`wave ${vp.label}: swallows no pointer events`, hit === true);
  }
  check(`wave ${vp.label}: no page errors`, errors.length === 0, errors.join('; '));
  await ctx.close();
}

/**
 * NO LAYOUT SHIFT FROM THE RIBBON, sampled across several show/hide cycles.
 *
 * This is the reason the ribbon is an overlay rather than a row of its own. `CurveCanvas` watches
 * its canvas with a `ResizeObserver`; a chart that changed height every ~6s would rescale the wave
 * every ~6s, which is a worse bug than the one being fixed.
 *
 * The assertion is CONDITIONED ON `PriceHeader`'s height rather than being "the chart never
 * changes", because the chart does change — and not because of this ribbon. `PriceHeader` is a
 * `flex-wrap` row whose content width moves at runtime (the stale label flips between "syncing" and
 * "last known", the price and the % pill gain and lose digits), so it wraps to a second line and
 * back, 36px <-> 59px, and the chart gains and loses the 23px underneath it. That is BUGLOG #139,
 * it reproduces identically on the commit before this one, and it is NOT what this test is for.
 * Holding the price strip still is what isolates the ribbon.
 */
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  await settled(page);
  /** chart height, the price strip's height, and whether the ribbon is up — sampled together. */
  const samples = [];
  for (let i = 0; i < 80; i++) {
    samples.push(await page.evaluate(() => {
      const strip = [...document.querySelectorAll('main div')]
        .find((d) => d.className.includes('shrink-0 rounded-xl border border-border bg-surface px-3 py-1.5'));
      const chart = document.querySelector('main [class*="min-h-[160px]"]');
      const ribbon = document.querySelector('[data-testid="activity-notice"] > div');
      return {
        chart: chart ? Math.round(chart.getBoundingClientRect().height) : -1,
        strip: strip ? Math.round(strip.getBoundingClientRect().height) : -1,
        up: !!ribbon && Number(getComputedStyle(ribbon).opacity) > 0.5,
      };
    }));
    await page.waitForTimeout(250);
  }

  const cycled = new Set(samples.map((s) => s.up)).size === 2;
  check('wave: the ribbon went up and down during the sample', cycled, `up=${samples.filter((s) => s.up).length}/${samples.length}`);

  // For each height the price strip settles at, the chart must measure the same whether the ribbon
  // is up or down. Anything else means the ribbon is taking space.
  const byStrip = new Map();
  for (const s of samples) {
    if (!byStrip.has(s.strip)) byStrip.set(s.strip, new Set());
    byStrip.get(s.strip).add(s.chart);
  }
  const moved = [...byStrip.entries()].filter(([, charts]) => charts.size > 1);
  check('wave: the ribbon never changes the chart height', moved.length === 0,
    moved.map(([strip, charts]) => `strip=${strip} -> chart ${[...charts].join('/')}`).join(', '));
  check('wave: no page errors over the cycle', errors.length === 0, errors.join('; '));
  await ctx.close();
}

/**
 * SHORT PHONES. The ticker row is hidden under 640px tall (BUGLOG #129, which fought the chart up
 * to a 160px floor at 320x568), so the ribbon it rides is hidden with it — deliberately, because
 * handing 30px back would push the screen past `h-dvh` inside an `overflow-hidden` shell.
 */
for (const vp of [{ label: '320x568', width: 320, height: 568 }, { label: '360x640', width: 360, height: 640 }]) {
  const { ctx, page, errors } = await open({ width: vp.width, height: vp.height });
  await page.waitForTimeout(12_000);
  const geo = await page.evaluate(() => {
    const el = document.querySelector('main [class*="min-h-[160px]"]');
    const n = document.querySelector('[data-testid="activity-notice"]');
    return { chartH: el ? Math.round(el.getBoundingClientRect().height) : -1, visible: !!n && n.getBoundingClientRect().height > 0 };
  });
  check(`wave ${vp.label}: no ribbon on a short phone`, geo.visible === false);
  check(`wave ${vp.label}: the chart keeps its 160px floor (#129)`, geo.chartH >= 157, `chart=${geo.chartH}px`);
  check(`wave ${vp.label}: no page errors`, errors.length === 0, errors.join('; '));
  await ctx.close();
}

/**
 * THE BASIC SKIN gets no ribbon at all — it exists to remove exactly the win-and-payout language
 * the ribbon is made of, and it drops the ticker row the ribbon rides for the same reason.
 */
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, { basic: true });
  await page.waitForTimeout(12_000);
  const shown = await page.evaluate(() => {
    const n = document.querySelector('[data-testid="activity-notice"]');
    return !!n && n.getBoundingClientRect().height > 0;
  });
  check('wave basic skin: no win ribbon', shown === false);
  check('wave basic skin: no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

/* ──────────────────────────────────────────────────────────────────────────────
   CANDLESTICK SHELL (trade_ui 'candlestick' via the ?ui= preview override)
   ────────────────────────────────────────────────────────────────────────────── */
console.log('\nCANDLESTICK SHELL — the ribbon hangs off the quote band, inside the candle-free top band');

for (const vp of [{ label: '390x844', width: 390, height: 844 }, { label: '1440x900', width: 1440, height: 900 }]) {
  const { ctx, page, errors } = await open({ width: vp.width, height: vp.height }, { ui: 'candlestick' });
  const box = await settled(page);
  const geo = await page.evaluate(() => {
    const r = (el) => (el ? (({ x, y, width, height }) => ({ x, y, w: width, h: height }))(el.getBoundingClientRect()) : null);
    /**
     * BOTH trees are in the DOM at every width — the phone one is `md:hidden` and the desktop one
     * `hidden md:flex` — so anything picked by class alone finds the HIDDEN copy half the time and
     * measures a zero-sized box. Everything below is filtered to what is actually laid out.
     */
    const shown = (el) => !!el && el.getClientRects().length > 0;
    const divs = [...document.querySelectorAll('main div')].filter(shown);
    // The quote band: `h-10` on the phone tree, `h-16` on the desktop one, `shrink-0` on both.
    const quote = divs.find((d) => /(^|\s)h-1[06](\s|$)/.test(d.className) && /(^|\s)shrink-0(\s|$)/.test(d.className));
    // The chart pane is the `relative` box the Tape fills, directly under that band.
    const pane = divs.find((d) => d.className.includes('min-h-[110px]'))
      || divs.find((d) => /(^|\s)relative(\s|$)/.test(d.className) && d.className.includes('min-h-0')
            && d.className.includes('flex-1') && quote && Math.abs(d.getBoundingClientRect().y - (quote.getBoundingClientRect().y + quote.getBoundingClientRect().height)) < 2);
    return {
      pane: r(pane || null),
      quote: r(quote || null),
      mounts: document.querySelectorAll('[data-testid="activity-notice"]').length,
    };
  });

  check(`candlestick ${vp.label}: the ribbon is up`, !!box, JSON.stringify(box));
  check(`candlestick ${vp.label}: mounted exactly once`, geo.mounts === 1, `mounts=${geo.mounts}`);
  if (box && geo.quote) {
    // Flush: the ribbon hangs off the bottom edge of the quote band, it does not float below it.
    check(`candlestick ${vp.label}: flush under the quote band`, Math.abs(box.y - (geo.quote.y + geo.quote.h)) <= 1,
      `ribbon.y=${box.y} band.bottom=${geo.quote.y + geo.quote.h}`);
  }
  if (box && geo.pane) {
    // `CandlestickTape` sets `scaleMargins.top: 0.12`, so the top 12% of the plot holds no candle
    // body or wick at any zoom. The ribbon has to fit inside that or it is back on the bars.
    const frac = box.h / geo.pane.h;
    check(`candlestick ${vp.label}: inside the candle-free top band (<=12% of the pane)`, frac <= 0.12,
      `ribbon=${Math.round(box.h)}px pane=${Math.round(geo.pane.h)}px = ${(frac * 100).toFixed(1)}%`);
    // A gutter wide enough for the price axis, and nowhere near the live edge on the right.
    const gutter = (geo.pane.x + geo.pane.w) - (box.x + box.w);
    check(`candlestick ${vp.label}: clears the price axis (>=40px gutter)`, gutter >= 40, `gutter=${Math.round(gutter)}px`);
  }
  check(`candlestick ${vp.label}: no page errors`, errors.length === 0, errors.join('; '));
  await ctx.close();
}

/**
 * THE PHONE'S OTHER TABS. The ribbon is placed against `<main>`, so without this it hangs over
 * Chat, Top and Tours as well — and Chat carries these very rows as text, so it was covering its
 * own content with a duplicate. It is HIDDEN there, not unmounted: unmounting drops the queue and
 * the `seen` set, and every event already shown comes round again on the next poll.
 */
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, { ui: 'candlestick' });
  await settled(page);
  await page.getByRole('button', { name: 'chat' }).click();
  await page.waitForTimeout(500);
  const offTab = await page.evaluate(() => {
    const n = document.querySelector('[data-testid="activity-notice"]');
    return { mounted: !!n, visible: !!n && n.getBoundingClientRect().height > 0 };
  });
  check('candlestick phone: hidden on the Chat tab', offTab.visible === false);
  check('candlestick phone: still MOUNTED on the Chat tab (queue survives)', offTab.mounted === true);
  await page.getByRole('button', { name: 'trade' }).click();
  const back = await settled(page);
  check('candlestick phone: back on the Trade tab it is up again', !!back, JSON.stringify(back));
  check('candlestick phone: no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

/* ──────────────────────────────────────────────────────────────────────────────
   ACCESSIBILITY — the same promise the card made, on the new shape
   ────────────────────────────────────────────────────────────────────────────── */
console.log('\nACCESSIBILITY');
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  await settled(page);
  const aria = await page.evaluate(() => {
    const n = document.querySelector('[data-testid="activity-notice"]');
    return n && { role: n.getAttribute('role'), live: n.getAttribute('aria-live'), atomic: n.getAttribute('aria-atomic') };
  });
  check('a11y: polite atomic live region', !!aria && aria.role === 'status' && aria.live === 'polite' && aria.atomic === 'true', JSON.stringify(aria));

  // After MAX_ANNOUNCEMENTS (3) the ribbon goes `aria-hidden`: ambient social proof re-announced
  // every few seconds for as long as the screen is open is an obstruction, not information.
  let hidden = false;
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const b = await settled(page, 25_000);
    if (!b) break;
    if (await page.evaluate(() => document.querySelector('[data-testid="activity-notice"] > div')?.getAttribute('aria-hidden') === 'true')) { hidden = true; break; }
    await page.waitForTimeout(1500);
  }
  check('a11y: goes aria-hidden after the announcement cap', hidden === true);
  check('a11y: no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  - ${f.name}`); process.exit(1); }
