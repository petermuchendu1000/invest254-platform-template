/**
 * DIGITS-UI e2e — the digits trade screen against a REAL local stack (API + game engine + web).
 *
 *   HOST=tamu.test PLAYER=<uuid> SITE=<uuid> JWT_SECRET=<local secret> CHROMIUM_PATH=/opt/pw-browsers/chromium \
 *     node apps/web/e2e/digits.e2e.mjs
 *
 * The brand behind HOST must have trade_ui='digits' and the player must hold enough balance for a few
 * minimum-stake trades. Runs sequentially (the engine allows one open digit contract per instrument).
 */
import { chromium } from 'playwright-core';
import { createHmac } from 'node:crypto';

const { HOST = 'tamu.test', PLAYER, SITE, JWT_SECRET, PORT = '3100' } = process.env;
if (!PLAYER || !SITE || !JWT_SECRET) { console.error('PLAYER, SITE and JWT_SECRET are required'); process.exit(2); }
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub, c) => { const h = b64u({ alg: 'HS256', typ: 'JWT' }); const p = b64u({ sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...c }); return `${h}.${p}.${createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const TOKEN = jwt(PLAYER, { role: 'player', site: SITE });

const results = [];
const until = async (fn, ms = 10000, step = 250) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, step)); } return false; };
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !info ? '' : `  -- ${String(info).slice(0, 200)}`}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${PORT}`] });
async function session(viewport) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark', acceptDownloads: true });
  await ctx.addInitScript((t) => localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 })), TOKEN);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Pass-through socket so a test can make the engine "refuse" the next digit open (BUGLOG #85).
  const ws = { refuseNext: false, holdAuthMs: 0, opens: 0, kill: () => {} };
  await page.routeWebSocket(/:8791|\/ws/, (sock) => {
    const server = sock.connectToServer();
    ws.opens++;
    ws.kill = () => sock.close();
    sock.onMessage((m) => {
      if (ws.holdAuthMs && typeof m === 'string' && m.includes('"type":"auth"')) {
        const hold = ws.holdAuthMs; ws.holdAuthMs = 0;
        setTimeout(() => server.send(m), hold);                  // a slow auth after a reconnect
        return;
      }
      if (ws.refuseNext && typeof m === 'string' && m.includes('"open_digit"')) {
        ws.refuseNext = false;
        sock.send(JSON.stringify({ type: 'error', data: { code: 'ENGINE_ERROR', message: 'INSUFFICIENT_FUNDS' } }));
        return;
      }
      server.send(m);
    });
    server.onMessage((m) => sock.send(m));
  });
  page.ws = ws;
  await page.goto(`http://${HOST}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);
  return { ctx, page, errors };
}

try {
  // ── Desktop ──
  { const { ctx, page, errors } = await session({ width: 1440, height: 900 });
    const header = await page.locator('header').innerText();
    check('desktop: top bar has Trader’s Hub, Deposit, Withdraw, History, AI, How to Trade', ['Trader’s Hub', 'Deposit', 'Withdraw', 'History', 'AI', 'How to Trade'].every((x) => header.includes(x)), header);
    check('desktop: balance pill says REAL', /REAL/i.test(await page.locator('header button[aria-haspopup="dialog"]').first().innerText()));
    const rail = page.locator('aside').first();
    check('desktop: positions rail with Open / Closed / History', await rail.getByRole('tab', { name: /Open/ }).isVisible() && await rail.getByRole('tab', { name: /Closed/ }).isVisible() && await rail.getByRole('tab', { name: /History/ }).isVisible());
    check('desktop: empty state reads "No open positions"', await rail.getByText('No open positions').isVisible());
    check('desktop: the digit statistics row shows 0–9', (await page.getByLabel(/^Digit \d:/).count()) === 10);
    check('desktop: exactly one digit is marked latest', (await page.getByLabel(/, latest$/).count()) === 1);
    check('desktop: console shows TRADING MODE and the balance', await page.getByText('Trading mode').isVisible() && await page.getByText(/^Bal /).isVisible());
    check('desktop: market pills sit in the console', await page.getByRole('button', { name: 'Even / Odd' }).isVisible() && await page.getByRole('button', { name: 'Over / Under' }).isVisible());
    const even = await page.getByRole('button', { name: /^Buy Even/ }).getAttribute('aria-label');
    check('desktop: Even shows payout and 90.00% (engine factor 0.95 on a 1-in-2 side)', /90\.00%/.test(even), even);
    await page.getByRole('button', { name: 'Over / Under' }).click();
    check('desktop: Over / Under shows SELECT DIGIT', await page.getByText('Select digit').isVisible());
    await page.getByRole('button', { name: 'Barrier digit 7' }).click();
    const over = await page.getByRole('button', { name: /^Buy Over/ }).getAttribute('aria-label');
    check('desktop: Over 7 pays 375.00% (2 winning digits of 10)', /375\.00%/.test(over), over);
    await page.getByRole('button', { name: 'Even / Odd' }).click();

    // DERIV-UI: Markets picker (category rail, search, favourites) and the Trade types sheet
    await page.getByRole('button', { name: /Volatility \d+( \(1s\))?/ }).first().click();
    const mp = page.getByRole('dialog', { name: 'Markets' });
    check('markets: picker opens with Favorites + Synthetic indices and 12 indices', await mp.isVisible()
      && await mp.getByRole('navigation', { name: 'Market categories' }).getByText('Favorites').isVisible()
      && (await mp.getByRole('option').count()) === 12);
    await mp.getByLabel('Search markets').fill('250');
    check('markets: search narrows the list', (await mp.getByRole('option').count()) === 1);
    await mp.getByRole('button', { name: /Add Volatility 250 \(1s\) Index to favorites/ }).click();
    await mp.getByLabel('Search markets').fill('');
    await mp.getByRole('navigation', { name: 'Market categories' }).getByRole('button', { name: /Favorites/ }).click();
    check('markets: a starred index is listed under Favorites', (await mp.getByRole('option').count()) === 1 && /250/.test(await mp.getByRole('option').first().innerText()));
    await mp.getByRole('option').first().click();
    check('markets: picking an index switches the chart', await page.getByRole('button', { name: /Volatility 250 \(1s\)/ }).first().isVisible() && !(await mp.isVisible()));
    await page.getByRole('button', { name: 'All trade types' }).filter({ visible: true }).first().click();
    const tt = page.getByRole('dialog', { name: 'Trade types' });
    check('trade types: sheet lists Multipliers + the three Digits types', /Multipliers[\s\S]*Matches\/Differs[\s\S]*Even\/Odd[\s\S]*Over\/Under/.test(await tt.innerText()));
    check('trade types: Multipliers is Demo-only on a real account', await tt.getByRole('button', { name: /Multipliers/ }).isDisabled());
    await tt.getByRole('tab', { name: 'Options' }).click();
    check('trade types: the Options chip hides Multipliers', (await tt.getByRole('button', { name: /Multipliers/ }).count()) === 0);
    await tt.getByRole('button', { name: /Over\/Under/ }).click();
    check('trade types: picking Over/Under switches the console', await page.getByText('Select digit').isVisible());
    await page.getByRole('button', { name: 'Even / Odd' }).click();
    await page.getByRole('button', { name: /Volatility 250 \(1s\)/ }).first().click();
    await page.getByRole('dialog', { name: 'Markets' }).getByLabel('Search markets').fill('10 (1s)');
    await page.getByRole('dialog', { name: 'Markets' }).getByRole('option').first().click();

    // chart tools
    await page.getByRole('button', { name: 'Area chart' }).click();
    check('desktop: chart tool switches to area', (await page.getByRole('button', { name: 'Area chart' }).getAttribute('aria-pressed')) === 'true');
    const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await page.getByRole('button', { name: 'Download chart' }).click();
    check('desktop: chart downloads as PNG', !!(await dl)?.suggestedFilename().endsWith('.png'));
    const tag = await page.locator('div.border-accent.font-mono').first().innerText().catch(() => '');
    check('desktop: live price tag is shown', /^\d+\.\d{2}$/.test(tag.trim()), tag);

    // manual trade → open → result → closed
    await page.getByRole('button', { name: /^Buy Even/ }).click();
    // poll: the contract is open for ~1 tick, so sample every 50 ms rather than once
    let sawOpen = false, openTab = '';
    for (let t = 0; t < 60 && !sawOpen; t++) {
      openTab = await rail.getByRole('tab', { name: /Open/ }).innerText();
      sawOpen = /Open\s*1\b/.test(openTab) || (await rail.getByText('settling…').count()) > 0 || (await page.getByText(/Even · /).count()) > 0;
      if (!sawOpen) await page.waitForTimeout(50);
    }
    const modal = page.getByRole('dialog', { name: /You won|Trade lost/ });
    await modal.waitFor({ timeout: 10000 }).catch(() => {});
    check('desktop: a manual trade shows as open while it settles', sawOpen, openTab);
    const m = await modal.innerText().catch(() => '');
    check('desktop: result card shows P/L, stake, payout, result digit, duration and the contract', /\bP\/L\b/i.test(m) && /STAKE/i.test(m) && /PAYOUT/i.test(m) && /\bDIGIT\b/i.test(m) && /DURATION/i.test(m) && /EVEN/.test(m), m);
    await page.keyboard.press('Escape');
    await rail.getByRole('tab', { name: /Closed/ }).click();
    check('desktop: the settled trade is listed under Closed', /EVEN/i.test(await rail.innerText()));
    check('desktop: session footer counts the trade (1 · xW yL)', /^1 · \dW \dL$/.test((await rail.getByTestId('session-trades').innerText()).trim()), await rail.getByTestId('session-trades').innerText());
    await rail.getByRole('tab', { name: /History/ }).click();
    await page.waitForTimeout(800);
    check('desktop: History tab lists saved contracts', /EVEN/i.test(await rail.innerText()));

    // ── BUGLOG #91: another tab's settlement never lands on this screen ──
    const page2 = await ctx.newPage();
    await page2.goto(`http://${HOST}/`, { waitUntil: 'networkidle' });
    await page2.waitForTimeout(2500);
    const rail2 = page2.locator('aside').first();
    const t2before = (await rail2.getByTestId('session-trades').innerText()).trim();
    await page.getByRole('button', { name: /^Buy Even/ }).click();
    await page.getByRole('dialog', { name: /You won|Trade lost/ }).waitFor({ timeout: 10000 }).catch(() => {});
    await page2.waitForTimeout(1500);
    check('two tabs: the other tab shows no result card and keeps its own count', (await page2.getByRole('dialog', { name: /You won|Trade lost/ }).count()) === 0 && (await rail2.getByTestId('session-trades').innerText()).trim() === t2before, `${t2before} -> ${await rail2.getByTestId('session-trades').innerText()}`);
    await page2.close();
    await page.keyboard.press('Escape');

    // ── BUGLOG #85: a refused open never freezes the screen ──
    const closedCount = async () => Number((/^(\d+) ·/.exec((await rail.getByTestId('session-trades').innerText()).trim()) ?? [])[1] ?? 0);
    const toastText = () => page.locator('[role="status"], [role="alert"]').allInnerTexts().then((a) => a.join(' | '));
    page.ws.refuseNext = true;
    await page.getByRole('button', { name: /^Buy Even/ }).click();
    check('refused open: the reason is shown in plain words', await until(async () => /Insufficient balance/.test(await toastText()), 4000), await toastText());
    check('refused open: nothing stays "in play"', await until(async () => (await page.getByText(/Even · /).count()) === 0, 3000));
    const n0 = await closedCount();
    await page.getByRole('button', { name: /^Buy Even/ }).click();
    await page.getByRole('dialog', { name: /You won|Trade lost/ }).waitFor({ timeout: 10000 }).catch(() => {});
    check('refused open: the next trade goes through', await until(async () => (await closedCount()) === n0 + 1, 8000), String(await closedCount()));
    await page.keyboard.press('Escape');

    // ── BUGLOG #88: a trade tapped while a fresh socket is still signing in waits for it ──
    const opens0 = page.ws.opens;
    page.ws.holdAuthMs = 1500;
    page.ws.kill();
    await until(async () => page.ws.opens > opens0, 8000, 25);
    const n1 = await closedCount();
    await page.getByRole('button', { name: /^Buy Even/ }).click();
    await page.getByRole('dialog', { name: /You won|Trade lost/ }).waitFor({ timeout: 12000 }).catch(() => {});
    check('reconnect: a trade during sign-in goes through (no "Log in to trade")', await until(async () => (await closedCount()) === n1 + 1, 8000) && !/Log in to trade/.test(await toastText()), `${await closedCount()} ${await toastText()}`);
    await page.keyboard.press('Escape');

    // ── BUGLOG #116: sign-in that never answers in 8 s: the tap is dropped with a reason, nothing hangs ──
    const opens1 = page.ws.opens;
    page.ws.holdAuthMs = 10_000;
    page.ws.kill();
    await until(async () => page.ws.opens > opens1, 8000, 25);
    const n2 = await closedCount();
    await page.getByRole('button', { name: /^Buy Even/ }).click();
    check('slow sign-in: after 8 s the trade is dropped with "Not connected" and nothing stays in play',
      await until(async () => /Not connected/.test(await toastText()), 11000, 100) && await until(async () => (await page.getByText(/Even · /).count()) === 0, 2000), await toastText());
    await page.waitForTimeout(2500);   // the held sign-in now completes
    await page.getByRole('button', { name: /^Buy Even/ }).click();
    await page.getByRole('dialog', { name: /You won|Trade lost/ }).waitFor({ timeout: 12000 }).catch(() => {});
    check('slow sign-in: once signed in, the next trade goes through', await until(async () => (await closedCount()) === n2 + 1, 8000), String(await closedCount()));
    await page.keyboard.press('Escape');

    // ── AUTO: a finished run can be started again (BUGLOG #84) ──
    await page.getByRole('button', { name: 'auto', exact: true }).filter({ visible: true }).first().click();
    await page.getByLabel('Target').fill('1');
    await page.getByLabel('Stop loss').fill('1');
    const stopBtn = page.getByRole('button', { name: 'Stop auto trading' }).first();
    const runOnce = async (label) => {
      const before = await closedCount();
      await page.getByRole('button', { name: /^Buy Even/ }).click();
      const started = await until(() => stopBtn.isVisible(), 3000, 50);
      const ended = await until(async () => !(await stopBtn.isVisible()), 15000);
      const t = await toastText();
      check(`${label}: starts, trades, and stops at the target or stop loss`, started && ended && (await closedCount()) > before && /Target hit|Stop loss hit/.test(t), `${started} ${ended} ${t}`);
    };
    await runOnce('auto run 1');
    await page.waitForTimeout(600);
    await runOnce('auto run 2 (after a finished run)');
    check('auto: the summary shows the run P/L and trade count', /[+\-][\d.,]+ [A-Z]{3} · \d+/.test(await toastText()), await toastText());

    // ── AI Entry Scanner: scan, then Run trades the best entry on AUTO (BUGLOG #84) ──
    await page.locator('header').getByRole('button', { name: 'AI' }).click();
    const sc = page.getByRole('dialog', { name: 'AI Entry Scanner' });
    await sc.getByRole('button', { name: 'Scan' }).click();
    check('scanner: shows progress while scanning', await until(async () => /\d+%/.test(await sc.innerText()), 3000, 100));
    const runBtn = sc.getByRole('button', { name: 'Run' });
    check('scanner: finds a best entry with its share and edge', await until(() => runBtn.isVisible(), 15000) && /\d+%/.test(await sc.innerText()) && /[+-]\d+\.\d/.test(await sc.innerText()), await sc.innerText());
    const beforeAi = await closedCount();
    await runBtn.click();
    check('scanner: Run closes the sheet and starts AUTO', !(await sc.isVisible()) && await until(() => stopBtn.isVisible(), 3000, 50));
    check('scanner: the bot trades on its own and stops at the target', await until(async () => !(await stopBtn.isVisible()), 20000) && (await closedCount()) > beforeAi);
    // closing mid-scan must not leave the scanner stuck
    await page.locator('header').getByRole('button', { name: 'AI' }).click();
    await sc.getByRole('button', { name: /Scan|Rescan/ }).first().click();
    await page.waitForTimeout(700);
    await sc.getByRole('button', { name: 'Close' }).last().click();
    await page.locator('header').getByRole('button', { name: 'AI' }).click();
    check('scanner: reopening after closing mid-scan is usable again', await until(async () => !(await sc.getByRole('button', { name: /^(Scan|Rescan)$/ }).first().isDisabled()), 8000));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'manual', exact: true }).filter({ visible: true }).first().click();

    // history modal / how to / account menu
    await page.locator('header').getByRole('button', { name: 'History' }).click();
    await page.waitForTimeout(1200);
    const hist = await page.getByRole('dialog', { name: 'Transaction history' }).innerText().catch(() => '');
    check('desktop: Transaction History lists the trade stake', /Trade Stake/.test(hist) && /even/.test(hist), hist);
    await page.keyboard.press('Escape');
    await page.locator('header').getByRole('button', { name: 'How to Trade' }).click();
    const how = await page.getByRole('dialog', { name: 'How to trade' }).innerText().catch(() => '');
    check('desktop: How to Trade explains every contract type and Auto', ['Even / Odd', 'Match / Differ', 'Over / Under', 'Manual and Auto'].every((x) => how.includes(x)), how.slice(0, 120));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Account menu' }).click();
    const menu = await page.getByRole('menu').innerText();
    check('desktop: account menu has Profile, Change Password, Referrals, Sign Out', ['Profile', 'Change Password', 'Referrals', 'Sign Out'].every((x) => menu.includes(x)), menu);
    await page.getByRole('button', { name: 'Change Password' }).click();
    await page.getByPlaceholder('New password', { exact: true }).fill('abcdefg1');
    await page.getByPlaceholder('Repeat new password').fill('abcdefg2');
    check('desktop: change password catches a mismatch before sending', await page.getByText('The new passwords do not match.').isVisible());
    await page.keyboard.press('Escape');
    check('desktop: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close(); }

  // ── Phone ──
  { const { ctx, page, errors } = await session({ width: 390, height: 844 });
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    check('phone: no horizontal scroll', w <= 391, String(w));
    check('phone: market tabs above the chart', await page.getByRole('button', { name: 'Even/Odd', exact: true }).isVisible());
    const digits = await page.getByLabel(/^Digit 9:/).boundingBox();
    const toggle = await page.getByRole('button', { name: 'auto', exact: true }).boundingBox();
    check('phone: digit row never overlaps the AUTO/MANUAL toggle', !!digits && !!toggle && digits.y + digits.height <= toggle.y + 1, JSON.stringify({ digits, toggle }));
    check('phone: bottom nav has AI and Positions', await page.getByRole('button', { name: 'AI', exact: true }).isVisible() && await page.getByRole('button', { name: /Positions/ }).isVisible());
    const even = await page.getByRole('button', { name: /^Buy Even/ }).boundingBox();
    check('phone: buy buttons are side by side', !!even && even.width < 200);
    await page.getByRole('button', { name: 'auto', exact: true }).click();
    check('phone: AUTO shows Target / Stop loss / Mult', await page.getByLabel('Target').isVisible() && await page.getByLabel('Stop loss').isVisible() && await page.getByLabel('Mult').isVisible());
    await page.getByRole('button', { name: /^Buy Odd/ }).click();
    await page.waitForTimeout(600);
    check('phone: running AUTO puts STOP first and shows Auto · ODD in the header', await page.getByRole('button', { name: 'Stop auto trading' }).first().isVisible() && /Auto · ODD/.test(await page.locator('header').innerText()));
    await page.getByRole('button', { name: 'Stop auto trading' }).first().click();
    await page.waitForTimeout(4000);
    check('phone: STOP ends AUTO', !/Auto · ODD/.test(await page.locator('header').innerText()));
    await page.getByRole('button', { name: /Positions/ }).click();
    check('phone: Positions opens as a sheet', await page.getByRole('dialog', { name: 'Positions' }).isVisible());
    await page.keyboard.press('Escape');
    check('phone: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close(); }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
