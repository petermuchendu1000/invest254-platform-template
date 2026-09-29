/**
 * DEMO-3 e2e — the Real/Demo account switcher on a PHONE, against the production web build with the
 * API mocked at the network layer (the roles.e2e.mjs pattern: no API, engine or Postgres needed).
 *
 * It exists because the switcher's first version passed review by inspection and still shipped a
 * menu that was full-bleed on a phone and read as a slab dropped over the trade screen. These checks
 * are the ones inspection cannot make: that a TAP (not a click) on the Demo row actually reaches the
 * server, that the card lands inside the viewport anchored to its trigger, that every target clears
 * Apple's 44px minimum, that an outside tap dismisses, and that the Demo account offers no way out.
 *
 * Run:  build with NEXT_PUBLIC_API_BASE_URL=http://api.e2e.test/api/v1, `next start -p 3100`, then
 *       WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/accountswitcher.e2e.mjs
 *       (PROBE_PATH=/ drives the trade screen; the default /wallet drives the standard shell.
 *        MODE_LOCKED=1 drives a wallet the server reports as mode-locked — a phone registered as a
 *        marketer on that brand — which must REFUSE Real while saying why, never look like a broken
 *        button. That state shipped as a dead grey row and was reported as "not clickable".)
 */
import { chromium } from 'playwright-core';

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:3100';
const API = 'http://api.e2e.test/api/v1';
const SITE = '00000000-0000-0000-0000-000000000001';
const OUT = process.env.OUT ?? '/tmp/claude-0/-home-user/452c9309-f7cb-51b6-8e0c-13816b147fab/scratchpad';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (p) => `${b64u({ alg: 'HS256' })}.${b64u({ iat: 1, exp: 9999999999, ...p })}.sig`;
const TOKEN = jwt({ sub: 'u-player', role: 'player', site: SITE });

const ME = { userId: 'u-player', role: 'player', username: 'punter', phone: '254700000009' };
const LOCKED = process.env.MODE_LOCKED === '1';
// A MARKETER (0176) is a normal player with two accounts: Real = their funny money (demo_balance,
// withdrawn via the instant marketer transfer) and Demo = a SEPARATE practice bucket (practice_balance)
// that starts empty and is top-up-able. account_mode stays 'demo' server-side; the Real/Demo switch is
// the `marketerPractice` flag. A player instead switches `mode` between real_balance and demo_balance.
const MARKETER_FUNNY = 523_400;
const wallet = (st) => (LOCKED
  ? {
      real: st.practice ? st.practiceBal : MARKETER_FUNNY, bonus: 0, currency: 'KES',
      mode: 'demo', modeLocked: true, marketerPractice: st.practice,
      realBalance: 0, bonusBalance: 0, demoBalance: MARKETER_FUNNY, practiceBalance: st.practiceBal, bonuses: [],
    }
  : {
      real: st.mode === 'demo' ? 1_000_000 : 523_400, bonus: st.mode === 'demo' ? 0 : 20_000, currency: 'KES',
      mode: st.mode, modeLocked: false, realBalance: 523_400, bonusBalance: 20_000, demoBalance: 1_000_000,
      practiceBalance: 0, marketerPractice: false, bonuses: [],
    });

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${!ok && d ? ` -- ${d}` : ''}`); };

// `undefined` (not a hard-coded path) so playwright-core uses its own installed browser on CI, the
// same as roles.e2e.mjs. A literal fallback path only works on the machine that happens to have it.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

async function session({ width = 390, height = 844, mode = 'real', touch = true } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height }, colorScheme: 'dark',
    hasTouch: touch, isMobile: touch, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const calls = [];
  // Server-side state the mock mutates: a player toggles `mode`; a marketer toggles `practice` (their
  // account_mode stays 'demo') and tops up `practiceBal` (their Demo starts empty).
  const st = { mode, practice: false, practiceBal: 0 };
  await ctx.route(`${API}/**`, async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    calls.push(`${req.method()} ${path}`);
    let body;
    if (path === '/auth/me') body = ME;
    else if (path === '/wallet') body = wallet(st);
    else if (path === '/wallet/mode') {
      let b = {}; try { b = req.postDataJSON(); } catch {}
      if (LOCKED) {
        st.practice = b.mode === 'demo';
        // DEMO-2 parity: entering practice opens the Demo bucket funded to 10,000 (like a player's demo).
        if (st.practice && st.practiceBal < 25_000) st.practiceBal = 1_000_000;
      } else st.mode = b.mode ?? st.mode;
      body = { mode: LOCKED ? (st.practice ? 'demo' : 'real') : st.mode, wallet: wallet(st) };
    }
    else if (path === '/wallet/demo/topup') { if (LOCKED) st.practiceBal = 1_000_000; body = { wallet: wallet(st), demoBalance: LOCKED ? st.practiceBal : 1_000_000 }; }
    else if (path === '/game/config') body = { currency: 'KES', minStakeCents: 25_000, maxStakeCents: 1_000_000, minWithdrawalCents: 200_000, minWithdrawalNative: null };
    else if (path === '/me/referral') body = { referralCode: 'X', referralPath: '/r/X', isMarketer: false, totalReferrals: 0, earnedCents: 0, heldCents: 0, paidCents: 0, availableCents: 0, minPayoutCents: 50000, marketerEarnedCents: 0 };
    else body = { items: [], providers: [], methods: [], enabled: true };
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  await ctx.addInitScript((t) => localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 })), TOKEN);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, calls, errors };
}

const SHOTS = process.env.SHOTS !== '0';
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }) : Promise.resolve());

try {
  // ── 1. PHONE, real mode: open the account menu and tap Demo ──
  await (async () => {
    const { ctx, page, calls, errors } = await session({ mode: 'real' });
    await page.goto(`${WEB}${process.env.PROBE_PATH ?? '/wallet'}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await shot(page, 'phone-1-closed');

    const pill = page.locator('#balance-pill');
    check('phone: the account pill renders', (await pill.count()) === 1, `count=${await pill.count()}`);
    const box = await pill.boundingBox();
    check('phone: the pill meets the 44px Apple touch target', !!box && box.height >= 44, box ? `h=${box.height}` : 'no box');

    await pill.tap();
    await page.waitForTimeout(500);
    await shot(page, 'phone-2-open');

    const dialog = page.getByRole('dialog', { name: 'Switch account' });
    check('phone: the switcher opens', (await dialog.count()) === 1);
    if (await dialog.count()) {
      const db = await dialog.boundingBox();
      console.log('    dialog box:', JSON.stringify(db));
      check('phone: the switcher is inside the viewport', !!db && db.y >= 0 && db.y + db.height <= 844 && db.x >= 0 && db.x + db.width <= 390,
        db ? `y=${db.y} h=${db.height} x=${db.x} w=${db.width}` : 'no box');
    }

    // A MARKETER (0176) is a normal player with a Real account (funny money) and a separate Demo
    // practice bucket — the SAME two-row switcher a player sees. It starts on Real (accent), and the
    // panel must never NAME the account type ("marketer"), which would out it to a watching player.
    // "Demo" itself is fine — a player's menu shows it too, so it is indistinguishable. Everything
    // below (the Demo row exists, tapping it switches, the pill flips) then holds for a marketer too.
    if (LOCKED) {
      const mlabel = await pill.getAttribute('aria-label');
      check('marketer: the pill starts on Real (funny money), never the yellow Demo', /^Real account/.test(mlabel ?? ''), String(mlabel));
      if (await dialog.count()) {
        const dtext = (await dialog.innerText()).toLowerCase();
        check('marketer: the menu never names the account type', !dtext.includes('marketer'), dtext.slice(0, 160));
      }
    }
    const demoRow = page.getByRole('menuitemradio', { name: /Demo account/ });
    check('phone: the Demo row exists', (await demoRow.count()) === 1);
    if (await demoRow.count()) {
      const rb = await demoRow.boundingBox();
      check('phone: the Demo row meets the 44px touch target', !!rb && rb.height >= 44, rb ? `h=${rb.height}` : 'no box');
      // what is actually on top at the row's centre? (a cover would eat the tap)
      if (rb) {
        const hit = await page.evaluate(([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return el ? `${el.tagName}.${el.className}`.slice(0, 120) : 'none';
        }, [rb.x + rb.width / 2, rb.y + rb.height / 2]);
        console.log('    element at the Demo row centre:', hit);
      }
      await demoRow.tap();
      await page.waitForTimeout(900);
      const fired = calls.filter((c) => c === 'POST /wallet/mode');
      check('phone: tapping Demo fires POST /wallet/mode', fired.length === 1, `calls=${JSON.stringify(calls.filter((c) => c.includes('wallet')))}`);
      await shot(page, 'phone-3-after-demo');
      const label = await pill.getAttribute('aria-label');
      check('phone: the pill now reads Demo', /^Demo account/.test(label ?? ''), String(label));
    }
    // outside tap must dismiss immediately (pointerdown, not the delayed synthetic mousedown)
    await page.locator('#balance-pill').tap();
    await page.waitForTimeout(300);
    await page.tap('body', { position: { x: 195, y: 700 } });
    await page.waitForTimeout(250);
    check('phone: an outside tap dismisses the menu', (await page.getByRole('dialog', { name: 'Switch account' }).count()) === 0);
    check('phone: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  })();

  // ── 2. PHONE, demo mode: no withdrawal affordance anywhere ──
  {
    const { ctx, page, errors } = await session({ mode: 'demo' });
    await page.goto(`${WEB}${process.env.PROBE_PATH ?? '/wallet'}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await shot(page, 'phone-4-demo-wallet');
    const bodyText = (await page.locator('body').innerText()).toLowerCase();
    check(LOCKED ? 'demo-locked marketer: /wallet keeps Withdraw' : 'demo: the /wallet page offers no Withdraw button',
      LOCKED ? true : !(await page.getByRole('button', { name: /^withdraw$/i }).count()));
    console.log('    /wallet text mentions "withdraw":', bodyText.includes('withdraw'));

    await page.locator('#balance-pill').tap();
    await page.waitForTimeout(400);
    await shot(page, 'phone-5-demo-switcher');
    // A demo-LOCKED wallet is a marketer, whose payout IS the demo->M-Pesa transfer, so Withdraw is
    // correct for them (the deliberate carve-out in walletFigures). Only a player in demo loses it.
    const wd = await page.getByRole('button', { name: /^withdraw$/i }).count();
    check(LOCKED ? 'demo-locked marketer: keeps its own Withdraw' : 'demo: the switcher offers no Withdraw',
      LOCKED ? wd >= 1 : wd === 0, `withdraw buttons=${wd}`);
    check('demo: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ── 2b. PHONE, demo mode: can the player get BACK to Real? (reported as un-clickable) ──
  await (async () => {
    const { ctx, page, calls, errors } = await session({ mode: 'demo' });
    await page.goto(`${WEB}${process.env.PROBE_PATH ?? '/wallet'}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator('#balance-pill').tap();
    await page.waitForTimeout(400);

    const realRow = page.getByRole('menuitemradio', { name: /Real account/ });
    if (LOCKED) {
      // 0176 — a MARKETER starts on Real (funny money, withdrawable via the instant marketer transfer)
      // and can switch to a SEPARATE Demo practice bucket that is empty, top-up-able and NEVER
      // withdrawable — exactly like a player. Both rows are real, interactive switch controls.
      check('marketer: the Real row is a real switch control', (await realRow.count()) === 1, `rows=${await realRow.count()}`);
      check('marketer: on Real, keeps its own Withdraw', (await page.getByRole('button', { name: /^withdraw$/i }).count()) >= 1);
      const dtext0 = (await page.getByRole('dialog', { name: 'Switch account' }).innerText()).toLowerCase();
      check('marketer: on Real, not told its money is practice money', !dtext0.includes('practice money'), dtext0.slice(0, 120));
      check('marketer: the panel never names the account type', !dtext0.includes('marketer'), dtext0.slice(0, 120));
      // switch INTO the practice (Demo) bucket
      await page.getByRole('menuitemradio', { name: /Demo account/ }).tap();
      await page.waitForTimeout(900);
      check('marketer: tapping Demo fires POST /wallet/mode', calls.filter((c) => c === 'POST /wallet/mode').length === 1,
        JSON.stringify(calls.filter((c) => c.includes('wallet'))));
      const plabel = await page.locator('#balance-pill').getAttribute('aria-label');
      check('marketer: the pill now reads Demo (on the practice bucket)', /^Demo account/.test(plabel ?? ''), String(plabel));
      // DEMO-2 parity: the practice bucket opens FUNDED to 10,000, never an empty 0.
      check('marketer: the Demo (practice) bucket opens funded at 10,000', /10[,.]?000/.test(plabel ?? '') && !/\bKES 0\b/.test(plabel ?? ''), String(plabel));
      // The switch closes the menu (onSuccess), so re-open it to inspect the practice tab.
      await page.locator('#balance-pill').tap();
      await page.waitForTimeout(400);
      const panel = page.getByRole('dialog', { name: 'Switch account' });
      const dtext1 = (await panel.innerText()).toLowerCase();
      // Scope the Withdraw count to the PANEL: on /wallet the page has its own Withdraw button, so a
      // page-wide count is environment-dependent; the panel itself must offer none on practice.
      check('marketer: on practice, the panel offers NO Withdraw (practice is never withdrawable)',
        (await panel.getByRole('button', { name: /^withdraw$/i }).count()) === 0,
        `panel withdraw=${await panel.getByRole('button', { name: /^withdraw$/i }).count()}`);
      check('marketer: on practice, IS told it is practice money', dtext1.includes('practice money'), dtext1.slice(0, 120));
      // switch back to Real
      await page.getByRole('menuitemradio', { name: /Real account/ }).tap();
      await page.waitForTimeout(900);
      const rlabel = await page.locator('#balance-pill').getAttribute('aria-label');
      check('marketer: can switch back to Real', /^Real account/.test(rlabel ?? ''), String(rlabel));
      check('demo->real: no page errors', errors.length === 0, errors.join(' | '));
      await ctx.close();
      return;
    }
    check('demo->real: the Real row exists', (await realRow.count()) === 1);
    if (await realRow.count()) {
      const isDisabled = await realRow.isDisabled();
      const op = await realRow.evaluate((el) => getComputedStyle(el).opacity);
      check('demo->real: the Real row is NOT disabled', isDisabled === false, `disabled=${isDisabled}`);
      check('demo->real: the Real row does not LOOK disabled', Number(op) > 0.9, `opacity=${op}`);
      const pe = await realRow.evaluate((el) => getComputedStyle(el).pointerEvents);
      check('demo->real: the Real row accepts pointer events', pe !== 'none', `pointer-events=${pe}`);
      await realRow.tap();
      await page.waitForTimeout(900);
      const fired = calls.filter((c) => c === 'POST /wallet/mode');
      check('demo->real: tapping Real fires POST /wallet/mode', fired.length === 1, `wallet calls=${JSON.stringify(calls.filter((c) => c.includes('wallet')))}`);
      const label = await page.locator('#balance-pill').getAttribute('aria-label');
      check('demo->real: the pill now reads Real', /^Real account/.test(label ?? ''), String(label));
    }
    check('demo->real: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  })();

  // ── 3. DESKTOP, for comparison ──
  {
    const { ctx, page } = await session({ width: 1440, height: 900, touch: false });
    await page.goto(`${WEB}${process.env.PROBE_PATH ?? '/wallet'}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.locator('#balance-pill').click();
    await page.waitForTimeout(400);
    await shot(page, 'desktop-1-open');
    await ctx.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
