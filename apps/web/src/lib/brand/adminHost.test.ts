import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdminHost, operatorSurfaceAllowed, ADMIN_HOSTS } from './adminHost.js';

/**
 * Which hosts are the OPERATOR console rather than a player brand.
 *
 * Two things depend on this agreeing with itself: the middleware's `/` → `/console` redirect, and
 * the brand path's decision not to ask the API about a host that has no brand. They used to be
 * separate pieces of code, which is how the brand path came to spend a failed cross-continent round
 * trip on every single request to the admin domain.
 */

test('the admin host matches with or without www, and with a port', () => {
  assert.equal(isAdminHost('triocodes.com'), true);
  assert.equal(isAdminHost('www.triocodes.com'), true);
  assert.equal(isAdminHost('TrioCodes.COM'), true, 'Host headers are not case-normalised for us');
  assert.equal(isAdminHost('triocodes.com:3000'), true, 'a dev port must not change the answer');
});

test('a player brand is NOT an admin host — this is the half that must never be wrong', () => {
  for (const h of ['invest254.com', 'cpfmarket.com', 'mpesapap.com', '1000wins.com', 'www.invest254.com']) {
    assert.equal(isAdminHost(h), false, h);
  }
  // A lookalike must not match: only the exact host or its www form.
  assert.equal(isAdminHost('nottriocodes.com'), false);
  assert.equal(isAdminHost('triocodes.com.evil.test'), false);
  assert.equal(isAdminHost('admin.triocodes.com'), false, 'a subdomain is not configured as one');
});

test('a missing or empty Host is not an admin host', () => {
  assert.equal(isAdminHost(''), false);
  assert.equal(isAdminHost(null), false);
  assert.equal(isAdminHost(undefined), false);
});

test('the default is the literal production runs on — ADMIN_HOST is set in no deploy config', () => {
  assert.ok(ADMIN_HOSTS.includes('triocodes.com'), ADMIN_HOSTS.join(','));
});

/**
 * The host gate on `/console`, `/admin/**` and `/platform/**`.
 *
 * Before it, every brand domain we serve answered all three with 200 and showed the operator
 * sign-in form (measured against production: cpfmarket.com/console, /admin, /platform → 200).
 */
test('a client brand domain does not serve the operator surfaces', () => {
  for (const h of ['invest254.com', 'cpfmarket.com', 'mpesapap.com', '1000wins.com', 'www.cpfmarket.com']) {
    assert.equal(operatorSurfaceAllowed(h), false, h);
  }
  // The lookalikes that must not buy their way in through either branch of the predicate. Note
  // which shapes are checked: a SUFFIX earns the allowance, so every one of these is a public
  // domain someone could register, and none of them may pass.
  assert.equal(operatorSurfaceAllowed('nottriocodes.com'), false);
  assert.equal(operatorSurfaceAllowed('localhost.cpfmarket.com'), false, 'the suffix is what counts, not the prefix');
  assert.equal(operatorSurfaceAllowed('pages.dev.cpfmarket.com'), false);
  assert.equal(operatorSurfaceAllowed('127.0.0.1.cpfmarket.com'), false, 'a loopback-shaped PREFIX is a public domain');
});

test('the operator domain serves them, with or without www and with a port', () => {
  for (const h of ['triocodes.com', 'www.triocodes.com', 'TRIOCODES.COM', 'triocodes.com:3000']) {
    assert.equal(operatorSurfaceAllowed(h), true, h);
  }
});

test('local and test hosts serve them — the e2e suite drives the console at 127.0.0.1', () => {
  // apps/web/e2e/roles.e2e.mjs: WEB_URL=http://127.0.0.1:3100 → /console, /admin, /platform.
  // apps/web/e2e/account.e2e.mjs: `${CONSOLE}/admin/identity` on the same loopback address.
  // Break this and the `web roles e2e` CI job stops testing the console and starts testing a 404.
  for (const h of ['127.0.0.1:3100', '127.0.0.1', 'localhost', 'localhost:3100', 'tamu.test', 'api.e2e.test', 'foo.localhost']) {
    assert.equal(operatorSurfaceAllowed(h), true, h);
  }
  // `.test` is reserved by RFC 2606: it cannot be registered or resolved on the public internet,
  // and Cloudflare serves only the hosts attached to the project — so a `.test` suffix cannot be
  // claimed by anyone, however it is spelled.
  assert.equal(operatorSurfaceAllowed('triocodes.com.anything.test'), true);
  // The IPv6 loopback, which is only legal in a Host header in its bracketed form. Splitting this
  // on the first colon yields `[` — the bug that makes an IPv6 loopback read as a public host.
  assert.equal(operatorSurfaceAllowed('[::1]:3100'), true);
  assert.equal(operatorSurfaceAllowed('[::1]'), true);
  assert.equal(operatorSurfaceAllowed('[2606:4700::1111]'), false, 'a routable IPv6 address is not loopback');
});

test('the Pages deployment URL serves them, so a deploy can be checked before DNS points at it', () => {
  assert.equal(operatorSurfaceAllowed('invest254-web.pages.dev'), true);
  assert.equal(operatorSurfaceAllowed('abc123.invest254-web.pages.dev'), true);
});

test('no Host at all fails closed', () => {
  assert.equal(operatorSurfaceAllowed(''), false);
  assert.equal(operatorSurfaceAllowed(null), false);
  assert.equal(operatorSurfaceAllowed(undefined), false);
  assert.equal(operatorSurfaceAllowed(':3000'), false, 'a port with no host is no host');
});
