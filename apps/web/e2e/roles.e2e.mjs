// docs/42 role-matrix UI e2e — drives the PRODUCTION web build (`next start`) in headless Chromium as each
// operator tier (incl. impersonation and a second tab), with the API mocked at the network layer, and
// asserts what each tier SEES: nav entries, page gates and key controls. It proves the capability list
// (packages/shared/src/capabilities.ts) is what the screens actually render, on the token role.
//
// Run:  WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/roles.e2e.mjs
//   (build with NEXT_PUBLIC_API_BASE_URL=http://api.e2e.test/api/v1, then `next start -p 3100`;
//    needs `playwright-core` resolvable and Chromium at PLAYWRIGHT_BROWSERS_PATH / CHROMIUM_PATH.)
import { chromium } from 'playwright-core';

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:3100';
const API = 'http://api.e2e.test/api/v1';
const SITE = '00000000-0000-0000-0000-000000000001';
const PLATFORM = '10000000-0000-0000-0000-000000000001';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64u({ alg: 'HS256' })}.${b64u({ iat: 1, exp: 9999999999, ...payload })}.sig`;

const T = {
  admin: jwt({ sub: 'u-admin', role: 'admin', site: SITE }),
  owner: jwt({ sub: 'u-owner', role: 'platform_superadmin', site: SITE }),
  pa: jwt({ sub: 'u-pa', role: 'platform_admin', site: SITE, platform: PLATFORM }),
  ownerImp: jwt({ sub: 'u-owner', role: 'admin', site: SITE, act: { sub: 'u-owner', role: 'platform_superadmin', brand: 'Tamu Traders' } }),
  paImp: jwt({ sub: 'u-pa', role: 'admin', site: SITE, act: { sub: 'u-pa', role: 'platform_admin', brand: 'Tamu Traders' } }),
  player: jwt({ sub: 'u-player', role: 'player', site: SITE }),
};
const ME = {
  admin: { userId: 'u-admin', role: 'admin', username: 'siteadmin', phone: '254700000001', scope: { site: { id: SITE, name: 'Tamu Traders' }, platform: null } },
  owner: { userId: 'u-owner', role: 'platform_superadmin', username: 'owner', phone: '254700000002' },
  player: { userId: 'u-player', role: 'player', username: 'punter', phone: '254700000009' },
  pa: { userId: 'u-pa', role: 'platform_admin', username: 'platadmin', phone: '254700000003', scope: { site: { id: SITE, name: 'Tamu Traders' }, platform: { id: PLATFORM, name: 'Alpha Platform' } } },
};
const USER = {
  userId: 'u-target', username: 'target', phone: '254711111111', role: 'player', status: 'active', createdAtMs: 1,
  realBalanceCents: 0, bonusBalanceCents: 0, demoBalanceCents: 0, isMarketer: false, depositsCents: 0, withdrawalsCents: 0,
  netDepositsCents: 0, lastFundedCents: null, turnoverCents: 0, ggrCents: 0, betCount: 0, lastTxAtMs: null, lastTxKind: null,
  lastTxAmountCents: null, lastTxStatus: null, lastActiveAtMs: null, referredBy: null, isBrandDefaultMarketer: false,
};

const REFERRAL = { referralCode: 'K7PQ2MX', referralPath: '/r/K7PQ2MX', isMarketer: false, totalReferrals: 0, earnedCents: 0,
  heldCents: 0, paidCents: 0, availableCents: 0, minPayoutCents: 50000, marketerEarnedCents: 0 };

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? `  -- ${detail}` : ''}`); };

async function session(browser, { token, me, stash = null }) {
  const ctx = await browser.newContext();
  const calls = [];
  await ctx.route(`${API}/**`, async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    calls.push(`${req.method()} ${path}`);
    const body = path === '/auth/me' ? me
      : path === '/me/referral' ? REFERRAL
      : /^\/admin\/users\/[^/]+$/.test(path) ? USER
      : { items: [], sites: [], platforms: [], statuses: {}, configured: false, key: null, enabled: true };
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  await ctx.addInitScript(([tok, st]) => {
    localStorage.setItem('pp-session', JSON.stringify({ state: { token: tok }, version: 0 }));
    if (st) sessionStorage.setItem('pp-impersonating-brand', st);
  }, [token, stash]);
  const page = await ctx.newPage();
  return { ctx, page, calls };
}
async function navTexts(page) {
  await page.waitForTimeout(300);
  return (await page.locator('aside a, nav a').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
}
async function open(page, path) {
  await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  // 1) Site admin
  { const { ctx, page, calls } = await session(browser, { token: T.admin, me: ME.admin });
    await open(page, '/admin/tickets'); const nav = await navTexts(page);
    check('site admin: operations nav present', nav.includes('Withdrawals') && nav.includes('Users'), nav.join('|'));
    check('site admin: the shell names the brand (UI-8)', await page.getByText('Tamu Traders Admin').first().isVisible());
    check('site admin: NO Audit log / Governance / Platform nav', !nav.some((n) => /Audit log|Game config|M-Pesa|Fly\.io|All brands|System logs/.test(n)), nav.join('|'));
    await open(page, '/admin/audit');
    check('site admin: old /admin/audit forwards to the console, which reveals nothing (404)', page.url().endsWith('/platform/audit') && await page.getByText('This page could not be found.').isVisible(), page.url());
    check('site admin: no audit request was ever made', !calls.includes('GET /admin/audit'), calls.filter((c) => c.includes('audit')).join());
    await open(page, '/admin/game');
    check('site admin: old /admin/game forwards to the console (404 for a site admin)', await page.getByText('This page could not be found.').isVisible(), page.url());
    await open(page, '/admin/users/u-target');
    check('site admin: "Edit details" and "Role" sections visible', await page.getByText('Edit details', { exact: true }).isVisible().catch(() => false) && await page.getByText('Role', { exact: true }).first().isVisible().catch(() => false));
    check('site admin: overrides are read-only (no Save overrides)', !(await page.getByText('Save overrides').isVisible().catch(() => false)));
    await open(page, '/platform');
    check('site admin: /platform is a 404', await page.getByText('This page could not be found.').isVisible());
    await ctx.close(); }

  // 2) Owner, own session
  { const { ctx, page, calls } = await session(browser, { token: T.owner, me: ME.owner });
    await open(page, '/admin/tickets');
    check('owner (own session): /admin shows the brand picker, not an unscoped back office (UI-2)', await page.getByText('Choose a brand to open').isVisible());
    check('owner: no back-office data request was made without a brand', !calls.some((c) => /^GET \/(admin|tickets)/.test(c)), calls.join());
    await open(page, '/platform'); const pnav = await navTexts(page);
    check('owner console: system nav incl. moved governance (Audit log, System logs, M-Pesa, Engine)', ['Platforms', 'Payments', 'Global config', 'Audit log', 'System logs', 'M-Pesa (global)', 'Engine (Fly.io)'].every((x) => pnav.some((n) => n.includes(x))), pnav.join('|'));
    await open(page, '/admin/mpesa');
    check('owner: old /admin/mpesa forwards to /platform/mpesa', page.url().endsWith('/platform/mpesa'), page.url());
    await ctx.close(); }

  // 3) Owner impersonating, SECOND TAB (no sessionStorage stash — the pre-fix failure mode)
  { const { ctx, page, calls } = await session(browser, { token: T.ownerImp, me: ME.owner });
    await open(page, '/admin/tickets'); const nav = await navTexts(page);
    check('owner impersonating (new tab): brand admin nav only — no Audit/Governance/Platform', nav.includes('Withdrawals') && !nav.some((n) => /Audit log|Game config|All brands|System logs/.test(n)), nav.join('|'));
    check('owner impersonating (new tab): banner names the brand from the token', await page.getByText('Tamu Traders').first().isVisible());
    check('owner impersonating: token NOT re-minted by the session bootstrap', !calls.includes('POST /auth/refresh'), calls.join());
    await open(page, '/admin/users/u-target');
    check('owner impersonating: no admin-role option (API refuses it as admin)', !(await page.locator('option[value="admin"]').count()));
    await open(page, '/platform');
    check('owner impersonating: /platform offers "Exit brand" instead of the console', await page.getByRole('button', { name: 'Exit brand' }).isVisible());
    await ctx.close(); }

  // 4) Platform admin, own session
  { const { ctx, page, calls } = await session(browser, { token: T.pa, me: ME.pa });
    await open(page, '/platform'); const pnav = await navTexts(page);
    check('platform admin console: the shell names its platform (UI-8)', await page.getByText('Platform · Alpha Platform').first().isVisible());
    check('platform admin console: NO system nav', !pnav.some((n) => /Platforms|Payments|Global config|Add-ons|Audit log|System logs|M-Pesa|Engine/.test(n)), pnav.join('|'));
    await open(page, '/platform/audit');
    check('platform admin: /platform/audit is a 404', await page.getByText('This page could not be found.').isVisible());
    await open(page, '/platform/onboard');
    check('platform admin: onboarding never calls the owner-only platforms list', !calls.includes('GET /platform/platforms'), calls.filter((c) => c.includes('platforms')).join());
    await open(page, '/admin');
    check('platform admin (raw): /admin is a 404', await page.getByText('This page could not be found.').isVisible());
    await ctx.close(); }

  // 5) Platform admin impersonating (the pre-fix "hidden but allowed" case)
  { const { ctx, page } = await session(browser, { token: T.paImp, me: ME.pa, stash: JSON.stringify({ siteId: SITE, slug: 'tamu', name: 'Tamu Traders', primaryDomain: null }) });
    await open(page, '/admin/tickets'); const nav = await navTexts(page);
    check('platform admin impersonating: enters the brand back office', nav.includes('Withdrawals'), nav.join('|'));
    await open(page, '/admin/users/u-target');
    check('platform admin impersonating: "Edit details" section visible (API allows it as admin)', await page.getByText('Edit details', { exact: true }).isVisible().catch(() => false));
    check('platform admin impersonating: "Role" section visible (player<->marketer)', await page.getByText('Role', { exact: true }).first().isVisible().catch(() => false));
    await ctx.close(); }

  // 6) Deploy-order safety: an impersonation token minted BEFORE the API added `act` (tab stash only)
  { const legacy = jwt({ sub: 'u-owner', role: 'admin', site: SITE });
    const { ctx, page, calls } = await session(browser, { token: legacy, me: ME.owner, stash: JSON.stringify({ siteId: SITE, slug: 'tamu', name: 'Tamu Traders', primaryDomain: null }) });
    await open(page, '/admin/tickets');
    check('legacy impersonation (no act, tab stash): banner + exit still shown', await page.getByText('Tamu Traders').first().isVisible());
    check('legacy impersonation: token not re-minted', !calls.includes('POST /auth/refresh'), calls.join());
    await ctx.close(); }

  // 7) docs/42 UI-12: operators are never affiliates — no enrolment, no referral code, no requests
  for (const [who, token, me] of [['site admin', T.admin, ME.admin], ['owner', T.owner, ME.owner],
    ['platform admin', T.pa, ME.pa], ['owner impersonating', T.ownerImp, ME.owner]]) {
    const { ctx, page, calls } = await session(browser, { token, me });
    await open(page, '/affiliate');
    check(`${who}: /affiliate explains staff accounts can't join (UI-12)`, await page.getByText('Not available for staff accounts').isVisible());
    check(`${who}: /affiliate offers no "Apply to the programme"`, !(await page.getByText('Apply to the programme').isVisible().catch(() => false)));
    await open(page, '/account');
    check(`${who}: /account shows no referral invite card`, !(await page.getByText(/Invite & earn/).isVisible().catch(() => false)));
    check(`${who}: no affiliate/referral request was made`, !calls.some((c) => /\/(me\/referral|affiliate)/.test(c)), calls.join());
    await ctx.close();
  }
  { const { ctx, page } = await session(browser, { token: T.player, me: ME.player });
    await open(page, '/account');
    check('player: /account keeps the referral invite card', await page.getByText(/Invite & earn/).isVisible());
    await open(page, '/affiliate');
    check('player: /affiliate offers "Apply to the programme"', await page.getByText('Apply to the programme').isVisible());
    await ctx.close(); }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
