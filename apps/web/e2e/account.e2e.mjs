/**
 * DEMO-1 / SOUND-1 / CHAT-1 / ACCT-1 e2e — against a REAL local stack (API + game engine + web + Postgres).
 *
 *   HOST=tamu.test SITE=<brand uuid> ADMIN=<brand admin uuid> OWNER=<system owner uuid> JWT_SECRET=<local secret> \
 *   API=http://127.0.0.1:8790/api/v1 CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/web/e2e/account.e2e.mjs
 *
 * Registers a FRESH player on the brand every run (so it can be re-run), then walks:
 *   WhatsApp number set in the console → shown in the player's menu and chat greeting;
 *   Real/Demo switch (no banner, no disclaimer) → refresh demo balance → a demo trade moves only the demo balance → back to Real;
 *   sound toggle (state + persisted across reloads);
 *   live chat: player text + photo → agent inbox → agent reply ("Support") + unread badge → resolve;
 *   player two-factor is off (not in the menu, API refuses) → sign out → sign in with phone + password;
 *   Verify Identity submit → back office approves on Identity checks → player sees "verified".
 */
import { chromium } from 'playwright-core';
import { createHmac, randomInt } from 'node:crypto';

const { HOST = 'tamu.test', SITE, ADMIN, OWNER, JWT_SECRET, PORT = '3100', API = 'http://127.0.0.1:8790/api/v1' } = process.env;
if (!SITE || !ADMIN || !OWNER || !JWT_SECRET) { console.error('SITE, ADMIN, OWNER and JWT_SECRET are required'); process.exit(2); }
const CONSOLE = `http://127.0.0.1:${PORT}`;
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub, c) => { const h = b64u({ alg: 'HS256', typ: 'JWT' }); const p = b64u({ sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...c }); return `${h}.${p}.${createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const ADMIN_TOKEN = jwt(ADMIN, { role: 'admin', site: SITE });
const OWNER_TOKEN = jwt(OWNER, { role: 'platform_superadmin', site: '00000000-0000-0000-0000-000000000001' });

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !info ? '' : `  -- ${String(info).slice(0, 240)}`}`); };
const api = async (path, token, init = {}) => {
  const r = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ── a fresh player ──
const suffix = String(randomInt(10_000_000, 99_999_999));
const PHONE = `2547${suffix}`, USERNAME = `e2e${suffix}`, PASSWORD = `Pw-${suffix}-ok`;
const reg = await api('/auth/register', null, { method: 'POST', body: JSON.stringify({ phone: PHONE, username: USERNAME, password: PASSWORD, site: HOST }) });
if (reg.status !== 201) { console.error('register failed', reg.status, JSON.stringify(reg.body).slice(0, 200)); process.exit(1); }
const TOKEN = reg.body.token;
console.log(`player @${USERNAME}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${PORT}`] });
async function session(token, url, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark' });
  if (token) await ctx.addInitScript((t) => { if (!sessionStorage.getItem('e2e-init')) { localStorage.setItem('pp-session', JSON.stringify({ state: { token: t }, version: 0 })); sessionStorage.setItem('e2e-init', '1'); } }, token);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  return { ctx, page, errors };
}
const until = async (fn, ms = 10000, step = 250) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, step)); } return false; };

try {
  // ── 1. Brand WhatsApp number (console, System owner) ──
  { const { ctx, page, errors } = await session(OWNER_TOKEN, `${CONSOLE}/platform/clients/${SITE}?tab=identity`);
    const wa = page.getByLabel('WhatsApp support number');
    await wa.fill('+254 712 345 678');
    await page.getByRole('button', { name: /^Save/ }).first().click();
    check('console: WhatsApp support number saves', await until(async () => (await api('/brand?host=' + HOST, null)).body?.supportWhatsapp === '+254712345678' || (await page.getByText('Identity saved').count()) > 0));
    check('console: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close(); }

  const player = await session(TOKEN, `http://${HOST}/`);
  const { page } = player;
  const header = page.locator('header');

  // ── 2. Real / Demo switch ──
  const pill = page.getByRole('button', { name: /account, .*Switch account$/ }).first();
  check('demo: the balance pill starts on Real', /^Real account/.test(await pill.getAttribute('aria-label')));
  await pill.click();
  const sw = page.getByRole('dialog', { name: 'Switch account' });
  check('demo: switch menu lists Real Account and Demo Account', await sw.getByRole('menuitemradio', { name: /Real Account/ }).isVisible() && await sw.getByRole('menuitemradio', { name: /Demo Account/ }).isVisible());
  await sw.getByRole('menuitemradio', { name: /Demo Account/ }).click();
  check('demo: the pill switches to Demo', await until(async () => /^Demo account/.test(await pill.getAttribute('aria-label'))));
  check('demo: no demo banner on the trade screen', await until(async () => (await page.getByRole('note').filter({ hasText: /play money/i }).count()) === 0));
  const w0 = (await api('/wallet', TOKEN)).body;
  check('demo: the API reports demo mode', w0.mode === 'demo', JSON.stringify(w0));
  await pill.click();
  check('demo: the switcher has no disclaimer paragraph', !/can.t be withdrawn|can differ/i.test(await sw.innerText()));
  await page.getByRole('button', { name: 'Refresh demo balance' }).click();
  const w1ok = await until(async () => (await api('/wallet', TOKEN)).body.demoBalance >= 1_000_000);
  const w1 = (await api('/wallet', TOKEN)).body;
  check('demo: Refresh demo balance tops up to KES 10,000', w1ok, JSON.stringify(w1));
  await pill.click(); // close the switcher
  await page.getByRole('button', { name: /^Buy Even/ }).click();
  const modal = page.getByRole('dialog', { name: /You won|Trade lost/ });
  check('demo: a trade settles in demo', await modal.waitFor({ timeout: 12000 }).then(() => true).catch(() => false));
  await page.keyboard.press('Escape');
  const w2 = (await api('/wallet', TOKEN)).body;
  check('demo: the trade moved only the demo balance', w2.realBalance === w1.realBalance && w2.demoBalance !== w1.demoBalance, `${JSON.stringify(w1)} -> ${JSON.stringify(w2)}`);
  const rail = page.locator('aside').first();
  await rail.getByRole('tab', { name: /Closed/ }).click();
  check('demo: the closed trade carries a DEMO tag', /DEMO/.test(await rail.innerText()));
  // Multipliers (demo only): open Up, close, only the demo balance moves
  await page.getByRole('button', { name: 'All trade types' }).filter({ visible: true }).first().click();
  await page.getByRole('dialog', { name: 'Trade types' }).getByRole('button', { name: /Multipliers/ }).click();
  const wm0 = (await api('/wallet', TOKEN)).body;
  await page.getByRole('button', { name: /^Up/ }).click();
  const mClose = page.getByRole('button', { name: /^Close [+-]/ });
  check('multipliers (demo): a contract opens', await until(() => mClose.isVisible(), 8000));
  await page.waitForTimeout(1500);
  await mClose.click();
  check('multipliers (demo): closing settles it', await until(async () => /Closed|Stopped out/.test(await page.locator('body').innerText()), 8000));
  const wm1 = (await api('/wallet', TOKEN)).body;
  check('multipliers (demo): only the demo balance moved', wm1.realBalance === wm0.realBalance && wm1.demoBalance !== wm0.demoBalance, `${JSON.stringify(wm0)} -> ${JSON.stringify(wm1)}`);
  await pill.click();
  await sw.getByRole('menuitemradio', { name: /Real Account/ }).click();
  check('demo: switching back returns to Real and closes the switcher', await until(async () => /^Real account/.test(await pill.getAttribute('aria-label'))) && (await api('/wallet', TOKEN)).body.mode === 'real' && !(await sw.isVisible()));

  // ── 3. Sound toggle ──
  const snd = header.getByRole('button', { name: /^Turn sound (on|off)$/ }).first();
  const before = await snd.getAttribute('aria-pressed');
  await snd.click();
  const after = await snd.getAttribute('aria-pressed');
  check('sound: the toggle flips its pressed state and label', before !== after && (after === 'false') === /Turn sound on/.test(await snd.getAttribute('aria-label')));
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1500);
  check('sound: the choice survives a reload', (await header.getByRole('button', { name: /^Turn sound (on|off)$/ }).first().getAttribute('aria-pressed')) === after);
  check('sound: the six sound files are served', (await Promise.all(['tap', 'place', 'win', 'loss', 'message', 'toggle'].map((n) => page.evaluate(async (u) => (await fetch(u)).headers.get('content-type'), `/sounds/${n}.mp3`)))).every((t) => /audio\/mpeg/.test(t ?? '')));
  if (after === 'false') await header.getByRole('button', { name: 'Turn sound on' }).first().click();

  // ── 4. Account menu shows the WhatsApp line ──
  await page.getByRole('button', { name: 'Account menu' }).click();
  const menu = page.getByRole('menu').last();
  const menuText = await menu.innerText();
  check('menu: Verify Identity, Live Chat and WhatsApp Care are listed', ['Verify Identity', 'Live Chat', 'WhatsApp Care · +254712345678'].every((x) => menuText.includes(x)), menuText);
  check('menu: WhatsApp opens wa.me in a new tab', (await menu.getByRole('link', { name: /WhatsApp Care/ }).getAttribute('href')) === 'https://wa.me/254712345678');
  await page.keyboard.press('Escape');

  // ── 5. Live chat ──
  await header.getByRole('button', { name: 'Live Chat' }).first().click();
  const chat = page.getByRole('dialog', { name: 'Customer care chat' });
  await chat.waitFor({ timeout: 5000 });
  check('chat: the greeting offers WhatsApp too', /\+254712345678|WhatsApp/.test(await chat.innerText()));
  await chat.getByRole('textbox', { name: 'Message' }).fill('Hello, my deposit is missing');
  await chat.getByRole('button', { name: 'Send' }).click();
  check('chat: the player message appears', await until(() => chat.getByText('Hello, my deposit is missing').isVisible()));
  const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 320, height: 200 } });
  await chat.locator('input[type=file]').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: shot });
  await page.waitForTimeout(600);
  await chat.getByRole('button', { name: 'Send' }).click();
  check('chat: the photo is sent and displayed', await until(async () => (await chat.getByRole('button', { name: 'Open photo' }).count()) > 0
    && await chat.locator('img').last().evaluate((i) => i.complete && i.naturalWidth > 0)));
  await chat.getByRole('button', { name: 'Close chat' }).click();

  const agent = await session(ADMIN_TOKEN, `${CONSOLE}/admin/support`);
  const inbox = agent.page.getByRole('complementary', { name: 'Conversations' });
  const row = inbox.getByRole('button', { name: new RegExp(`@${USERNAME}`) });
  check('agent: the conversation is in the inbox with the photo preview', await until(() => row.isVisible(), 10000) && /\[image\]|photo/i.test(await row.innerText()), await inbox.innerText().catch(() => ''));
  await row.click();
  const conv = agent.page.getByRole('region', { name: 'Conversation' });
  check('agent: the thread shows the text and the photo', await until(async () => await conv.getByText('Hello, my deposit is missing').isVisible() && (await conv.getByRole('button', { name: 'Open photo' }).count()) > 0));
  await conv.getByRole('textbox', { name: 'Message' }).fill('We are checking it now');
  await conv.getByRole('button', { name: 'Send' }).click();
  check('agent: the reply appears in the thread', await until(() => conv.getByText('We are checking it now').isVisible()));

  const badge = page.locator('header [data-badge="chat"]');
  check('chat: the player gets an unread badge on Live Chat', await until(async () => (await badge.count()) > 0 && /^\d+$/.test((await badge.first().innerText()).trim()), 30000));
  await header.getByRole('button', { name: 'Live Chat' }).first().click();
  check('chat: the reply shows from "Support" (agent name hidden)', await until(async () => await chat.getByText('We are checking it now').isVisible() && /Support/.test(await chat.innerText()) && !/siteadmin/.test(await chat.innerText())));
  check('chat: opening the chat clears the badge', await until(async () => (await badge.count()) === 0, 8000));

  await conv.getByRole('button', { name: 'Resolve' }).click();
  check('agent: Resolve moves the thread out of Open', await until(async () => (await conv.getByRole('button', { name: 'Reopen' }).count()) > 0));
  check('chat: the player sees the conversation marked resolved', await until(async () => /resolved/i.test(await chat.innerText()), 25000));
  check('agent: no page errors', agent.errors.length === 0, agent.errors.join(' | '));
  await chat.getByRole('button', { name: 'Close chat' }).click();

  // ── 6. Verify Identity ──
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menu').last().getByRole('button', { name: /^Verify Identity/ }).click();
  const kyc = page.getByRole('dialog', { name: 'Verify Identity' });
  await kyc.getByLabel('Full name, as on the document').fill('E2E Test Player');
  await kyc.getByLabel('Document number').fill(`ID${suffix}`);
  await kyc.getByLabel('Date of birth').fill('1990-05-01');
  const img = { mimeType: 'image/png', buffer: shot };
  await kyc.locator('input[type=file][aria-label="Front of the document"]').setInputFiles({ name: 'front.png', ...img });
  await kyc.locator('input[type=file][aria-label="Back of the document"]').setInputFiles({ name: 'back.png', ...img });
  await kyc.locator('input[type=file][aria-label="Selfie"]').setInputFiles({ name: 'selfie.png', ...img });
  await kyc.getByRole('button', { name: 'Send for review' }).click();
  check('kyc: submitting shows "Under review"', await until(() => kyc.getByText('Under review.').isVisible(), 15000));
  await kyc.getByRole('button', { name: 'Close' }).last().click();

  await agent.page.goto(`${CONSOLE}/admin/identity`, { waitUntil: 'networkidle' });
  const krow = agent.page.getByRole('row', { name: new RegExp(`@${USERNAME}`) });
  check('back office: the submission is in To review', await until(() => krow.isVisible()));
  await krow.getByRole('button', { name: 'Review' }).click();
  const rv = agent.page.getByRole('dialog', { name: 'Review identity' });
  check('back office: the review shows the name, number and the three images', await until(async () => /E2E Test Player/.test(await rv.innerText()) && new RegExp(`ID${suffix}`).test(await rv.innerText())
    && (await rv.locator('img').evaluateAll((els) => els.filter((i) => i.complete && i.naturalWidth > 0).length)) === 3));
  check('back office: Reject needs a note', await rv.getByRole('button', { name: /^Reject/ }).isDisabled());
  await rv.getByRole('button', { name: 'Approve' }).click();
  check('back office: approved', await until(async () => (await rv.count()) === 0 || !(await rv.isVisible())));
  await agent.page.goto(`${CONSOLE}/admin/users/${reg.body.userId}`, { waitUntil: 'networkidle' });
  check('back office: the player page shows Identity · Verified', await until(async () => /Verified/.test(await agent.page.getByText('Identity', { exact: true }).locator('..').locator('..').innerText())));
  await agent.ctx.close();

  await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Account menu' }).click();
  check('kyc: the player menu shows Verify Identity · verified', await until(async () => /Verify Identity · verified/.test(await page.getByRole('menu').last().innerText())));
  await page.keyboard.press('Escape');

  // ── 7. Two-factor is switched off for players (SMS codes come later); sign-in has no code step ──
  await page.getByRole('button', { name: 'Account menu' }).click();
  check('2fa off: Two-Factor Auth is not in the player menu', !/Two-Factor/.test(await page.getByRole('menu').last().innerText()));
  await page.keyboard.press('Escape');
  const enr = await api('/auth/mfa/enroll', TOKEN, { method: 'POST' });
  check('2fa off: the API refuses player enrolment', enr.status === 403 && enr.body?.error?.code === 'PLAYER_MFA_DISABLED', JSON.stringify(enr));
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menu').last().getByRole('button', { name: 'Sign Out' }).click();
  await until(() => header.getByRole('button', { name: 'Log in' }).first().isVisible());
  await header.getByRole('button', { name: 'Log in' }).first().click();
  check('sign-in: the window opens without crashing', await until(() => page.getByPlaceholder('07XX XXX XXX').isVisible()));
  const auth = page.locator('form', { has: page.getByPlaceholder('07XX XXX XXX') });
  await auth.getByPlaceholder('07XX XXX XXX').fill(`07${suffix}`);
  await auth.locator('input[type=password]').first().fill(PASSWORD);
  await auth.getByRole('button', { name: 'Log in', exact: true }).last().click();
  check('sign-in: phone + password signs the player straight in (no code step)', await until(() => page.getByRole('button', { name: 'Account menu' }).isVisible(), 10000)
    && (await page.getByLabel('Authentication code').count()) === 0);
  check('player: no page errors', player.errors.length === 0, player.errors.join(' | '));
  await player.ctx.close();

  // ── 8. Phone layout ──
  { const { ctx, page: p, errors } = await session(TOKEN, `http://${HOST}/`, { width: 390, height: 844 });
    check('phone: no horizontal scroll', (await p.evaluate(() => document.documentElement.scrollWidth)) <= 391);
    check('phone: sound toggle and account pill are in the top bar', await p.locator('header').getByRole('button', { name: /^Turn sound/ }).first().isVisible() && await p.getByRole('button', { name: /account, .*Switch account$/ }).first().isVisible());
    await p.getByRole('button', { name: /Live Chat/ }).last().click();
    const c = p.getByRole('dialog', { name: 'Customer care chat' });
    const box = await c.boundingBox().catch(() => null);
    check('phone: live chat opens full width', !!box && box.width >= 380, JSON.stringify(box));
    check('phone: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close(); }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
