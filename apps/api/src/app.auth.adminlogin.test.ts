import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi } from "./testutil.js";

/**
 * Issue 1 — the UNIFIED ADMIN ENTRY POINT.
 *
 * The player login (`/auth/login`) is per-brand: it scopes to the host's brand, so an account bound
 * to brand B cannot authenticate when the request resolves to brand A. That is correct for players
 * (per-brand identity isolation) but it is exactly what stopped a platform_admin — whose profile is
 * pinned to ONE brand — from signing in at the shared operator console served on any other host.
 *
 * `/auth/admin/login` is the fix: an identity-based entry point (anyBrand) that resolves the account
 * across every brand by phone+password and binds the session to the account's OWN brand. These tests
 * lock in that behaviour AND that the per-brand player login stays isolated (no regression).
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PHONE = "0712345678";
const PASSWORD = "Password1";

test("admin login resolves an account by identity even when the brand-scoped player login cannot", async () => {
  const api = await startTestApi();
  try {
    // Account created on brand B (slug 'brandb' -> SITE_B), mirroring an admin pinned to one brand.
    const reg = await json(await post(api.baseUrl, "/api/v1/auth/register",
      { phone: PHONE, username: "brandb_admin", password: PASSWORD, site: "brandb" }));
    assert.ok(reg.token, "registered on brand B");

    // Per-brand PLAYER login resolved to the OTHER brand (A) must fail — this is the isolation that
    // broke the platform admin at the shared console.
    const wrongBrand = await post(api.baseUrl, "/api/v1/auth/login",
      { phone: PHONE, password: PASSWORD, site: "invest254" });
    assert.equal(wrongBrand.status, 401, "brand-scoped login rejects a different brand");
    assert.equal((await json(wrongBrand)).error.code, "INVALID_CREDENTIALS");

    // The UNIFIED admin entry point (no brand hint) resolves by identity and admits the SAME account,
    // binding the session to the account's own brand (SITE_B).
    const admin = await post(api.baseUrl, "/api/v1/auth/admin/login", { phone: PHONE, password: PASSWORD });
    assert.equal(admin.status, 200, "identity-based admin login succeeds regardless of host brand");
    const body = await json(admin);
    assert.ok(body.token, "admin login returns a token");
    assert.equal(body.site, "22222222-2222-2222-2222-222222222222", "session binds to the account's own brand (SITE_B)");
  } finally {
    await api.close();
  }
});

test("admin login still requires the correct password (no auth bypass)", async () => {
  const api = await startTestApi();
  try {
    await post(api.baseUrl, "/api/v1/auth/register",
      { phone: PHONE, username: "brandb_admin", password: PASSWORD, site: "brandb" });

    const wrongPw = await post(api.baseUrl, "/api/v1/auth/admin/login", { phone: PHONE, password: "WrongPass9" });
    assert.equal(wrongPw.status, 401);
    assert.equal((await json(wrongPw)).error.code, "INVALID_CREDENTIALS");

    const unknown = await post(api.baseUrl, "/api/v1/auth/admin/login", { phone: "0700000000", password: PASSWORD });
    assert.equal(unknown.status, 401, "unknown phone is indistinguishable from a bad password (anti-enumeration)");
  } finally {
    await api.close();
  }
});

test("admin login validates input like the player login", async () => {
  const api = await startTestApi();
  try {
    const missing = await post(api.baseUrl, "/api/v1/auth/admin/login", { phone: PHONE });
    assert.equal(missing.status, 400);
    assert.equal((await json(missing)).error.code, "VALIDATION");
  } finally {
    await api.close();
  }
});
