import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, SITE_B, type TestApi } from "./testutil.js";

/**
 * Regression: a marketer must sign in with ONLY phone + PIN/password — no brand hint.
 *
 * The marketer apps (mpesa_2, truecaller) are a single generic build that cannot know which brand a
 * marketer belongs to; the sign-in screen collects only phone + secret. A marketer phone is unique
 * only WITHIN a brand, so two brands can each own an active marketer on the same number (the real
 * "0706597235" is on both the default brand and "33 Traders"). Before the fix the login ignored the
 * credential and fell back to the default brand, authenticating the wrong marketer — so a marketer
 * on any other brand ("Patricia Muthoni") could never sign in. These tests pin the corrected
 * behaviour: the CREDENTIAL (PIN for /login, password for /login-web) identifies which brand's
 * marketer is signing in, with the client sending no `site`.
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

const ADMIN_DEFAULT = `${TEST_ADMIN}:admin:${SITE_A}`;   // default brand (slug "invest254")
const ADMIN_BRANDB = `${TEST_ADMIN}:admin:${SITE_B}`;    // brand "brandb"

/** Create a marketer on the admin token's brand + set its PIN; return the marketer id. */
async function onboard(api: TestApi, adminToken: string, name: string, phone: string, pin: string): Promise<string> {
  const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { name, phone }, adminToken))).id as string;
  assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${id}/pin`, { pin }, adminToken)).status, 200, "set pin");
  return id;
}
/** Register a website account (phone + password) on a brand named by slug. */
async function register(api: TestApi, phone: string, username: string, password: string, siteSlug: string): Promise<void> {
  const res = await req(api, "POST", "/api/v1/auth/register", { phone, username, password, site: siteSlug });
  assert.equal(res.status, 201, `register ${username}`);
}

const PHONE = "0706597235"; // the colliding number owned on BOTH brands

test("PIN login (no brand hint) resolves the marketer by matching the PIN across brands", async () => {
  const api = await startTestApi();
  try {
    const gritel = await onboard(api, ADMIN_DEFAULT, "gritel", PHONE, "1111");            // default brand
    const patricia = await onboard(api, ADMIN_BRANDB, "Patricia Muthoni", PHONE, "2222"); // brand "brandb"
    assert.notEqual(gritel, patricia);

    // Patricia signs in with HER PIN and NO site -> the PIN picks her (brand B), not gritel.
    const ok = await req(api, "POST", "/api/v1/marketers/auth/login", { phone: PHONE, pin: "2222" });
    assert.equal(ok.status, 200);
    assert.equal((await json(ok)).marketer.id, patricia);

    // gritel's PIN (no site) picks gritel (default brand).
    const okA = await req(api, "POST", "/api/v1/marketers/auth/login", { phone: PHONE, pin: "1111" });
    assert.equal(okA.status, 200);
    assert.equal((await json(okA)).marketer.id, gritel);

    // A PIN that matches neither -> generic 401.
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { phone: PHONE, pin: "9999" })).status, 401);
  } finally { await api.close(); }
});

test("login-web (no brand hint) resolves the marketer by matching the PASSWORD across brands", async () => {
  const api = await startTestApi();
  try {
    // Website accounts: same phone on two brands, DIFFERENT passwords.
    await register(api, PHONE, "gritel254", "AlphaPass1", "invest254"); // default brand
    await register(api, PHONE, "muthoni", "BravoPass2", "brandb");      // brand "brandb"
    // Matching marketer wallets on each brand.
    const gritel = await onboard(api, ADMIN_DEFAULT, "gritel", PHONE, "1111");
    const patricia = await onboard(api, ADMIN_BRANDB, "Patricia Muthoni", PHONE, "2222");

    // Patricia's password (no site) -> resolves brand B's marketer.
    const okB = await req(api, "POST", "/api/v1/marketers/auth/login-web", { phone: PHONE, password: "BravoPass2" });
    assert.equal(okB.status, 200);
    assert.equal((await json(okB)).marketer.id, patricia);

    // The default-brand account's password (no site) -> resolves the default-brand marketer.
    const okA = await req(api, "POST", "/api/v1/marketers/auth/login-web", { phone: PHONE, password: "AlphaPass1" });
    assert.equal(okA.status, 200);
    assert.equal((await json(okA)).marketer.id, gritel);

    // Wrong password -> generic 401 (no enumeration).
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login-web", { phone: PHONE, password: "WrongPass9" })).status, 401);
  } finally { await api.close(); }
});
