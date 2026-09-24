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
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !info ? '' : `  -- ${String(info).slice(0, 200)}`}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${PORT}`] });
async function session(viewport) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark', acceptDownloads: true });
  await ctx.addInitScript((t) => localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 })), TOKEN);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
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
    await page.waitForTimeout(300);
    const openTab = await rail.getByRole('tab', { name: /Open/ }).innerText();
    const sawOpen = /\(1\)/.test(openTab) || (await rail.getByText('settling…').count()) > 0;
    const modal = page.getByRole('dialog', { name: /You won|Trade lost/ });
    await modal.waitFor({ timeout: 10000 }).catch(() => {});
    check('desktop: a manual trade shows as open while it settles', sawOpen, openTab);
    const m = await modal.innerText().catch(() => '');
    check('desktop: result card shows P/L, stake, payout, result digit, duration and the contract', /PROFIT \/ LOSS/i.test(m) && /STAKE/i.test(m) && /PAYOUT/i.test(m) && /RESULT DIGIT/i.test(m) && /DURATION/i.test(m) && /EVEN/.test(m), m);
    await page.keyboard.press('Escape');
    await rail.getByRole('tab', { name: /Closed/ }).click();
    check('desktop: the settled trade is listed under Closed', /EVEN/i.test(await rail.innerText()));
    check('desktop: session footer counts the trade', /1 trades \(\dW \/ \dL\)/.test(await rail.locator('footer').innerText()));
    await rail.getByRole('tab', { name: /History/ }).click();
    await page.waitForTimeout(800);
    check('desktop: History tab lists saved contracts', /EVEN/i.test(await rail.innerText()));

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
    await page.getByPlaceholder('New password', { exact: true }).fill('abcdefgh');
    await page.getByPlaceholder('Repeat new password').fill('abcdefgX');
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
