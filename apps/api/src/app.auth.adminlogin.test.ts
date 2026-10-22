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

/**
 * BUGLOG #135 — AN OLDER PLAYER ACCOUNT ON THE SAME PHONE SHADOWED A REAL ADMIN.
 *
 * Reported from production: an admin "can't login anywhere, just 404". The phone held TWO accounts
 * (one person, one number): an older PLAYER on one brand and a newer ADMIN on another. The
 * identity-based operator login resolves candidates OLDEST FIRST and takes the first whose password
 * verifies — so when both accounts share a password, the player always won. The operator was handed
 * a perfectly valid PLAYER session, and every console surface then showed its wrong-tier 404. No
 * error, no bad-password message: just 404, exactly as reported.
 *
 * The old `order by created_at` was called a deterministic tie-break, and it is one — but
 * determinism is not correctness. At the OPERATOR entry point the account that can actually use the
 * console is the right answer, not the one that happens to be older.
 */
test("operator login: an OLDER same-phone PLAYER account must not shadow the ADMIN (BUGLOG #135)", async () => {
  const api = await startTestApi();
  try {
    const PH = "0100406758", PW = "SharedPass1";
    // 1) OLDER account, brand B, same phone + password: stays a player (the shadow).
    const older = await json(await post(api.baseUrl, "/api/v1/auth/register",
      { phone: PH, username: "joy", password: PW, site: "brandb" }));
    assert.ok(older.userId, "older player account registered");
    // 2) NEWER account on the default brand, promoted to site admin — the account they sign in for.
    const newer = await json(await post(api.baseUrl, "/api/v1/auth/register",
      { phone: PH, username: "joy_admin", password: PW, site: "invest254" }));
    api.identity._setRole(newer.userId, "admin");

    const res = await post(api.baseUrl, "/api/v1/auth/admin/login", { phone: PH, password: PW });
    assert.equal(res.status, 200, "the operator signs in");
    const body = await json(res);
    // The whole bug in one assertion: this returned "player" before the fix.
    assert.equal(body.role, "admin", "the ADMIN account wins, not the older player on the same phone");
    assert.equal(body.userId, newer.userId, "and it is the admin's own account");
  } finally {
    await api.close();
  }
});

test("operator login: with NO privileged account on the phone, the oldest match still wins (unchanged)", async () => {
  const api = await startTestApi();
  try {
    const PH = "0100406759", PW = "SharedPass2";
    const older = await json(await post(api.baseUrl, "/api/v1/auth/register",
      { phone: PH, username: "first", password: PW, site: "brandb" }));
    await post(api.baseUrl, "/api/v1/auth/register", { phone: PH, username: "second", password: PW, site: "invest254" });

    const res = await post(api.baseUrl, "/api/v1/auth/admin/login", { phone: PH, password: PW });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.userId, older.userId, "no operator among the matches: oldest-first is preserved");
    assert.equal(body.role, "player");
  } finally {
    await api.close();
  }
});

test("operator login: a WRONG password is still refused when the phone holds an admin (no bypass)", async () => {
  const api = await startTestApi();
  try {
    const PH = "0100406760", PW = "SharedPass3";
    const only = await json(await post(api.baseUrl, "/api/v1/auth/register",
      { phone: PH, username: "solo_admin", password: PW, site: "invest254" }));
    api.identity._setRole(only.userId, "admin");
    const res = await post(api.baseUrl, "/api/v1/auth/admin/login", { phone: PH, password: "NotTheOne9" });
    assert.equal(res.status, 401, "preferring an operator must never skip the password check");
  } finally {
    await api.close();
  }
});

/**
 * The escalation question, settled explicitly: the player's password must NOT open the admin.
 *
 * Preferring the operator only ever applies to a candidate whose OWN hash verified the submitted
 * password. When the two accounts have DIFFERENT passwords, the player's password matches only the
 * player, and that is what the caller gets — it can never be promoted into the admin's session.
 */
test("operator login: the player's own password resolves the PLAYER when the admin's differs", async () => {
  const api = await startTestApi();
  try {
    const PH = "0100406761";
    const player = await json(await post(api.baseUrl, "/api/v1/auth/register",
      { phone: PH, username: "p_only", password: "PlayerPass1", site: "brandb" }));
    const admin = await json(await post(api.baseUrl, "/api/v1/auth/register",
      { phone: PH, username: "a_only", password: "AdminPass1", site: "invest254" }));
    api.identity._setRole(admin.userId, "admin");

    const asPlayer = await json(await post(api.baseUrl, "/api/v1/auth/admin/login", { phone: PH, password: "PlayerPass1" }));
    assert.equal(asPlayer.userId, player.userId, "the player's password opens ONLY the player account");
    assert.equal(asPlayer.role, "player");

    const asAdmin = await json(await post(api.baseUrl, "/api/v1/auth/admin/login", { phone: PH, password: "AdminPass1" }));
    assert.equal(asAdmin.userId, admin.userId, "the admin's password opens the admin account");
    assert.equal(asAdmin.role, "admin");
  } finally {
    await api.close();
  }
});
