import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, type TestApi } from "./testutil.js";

/**
 * ISSUE 1 — cross-tenant data leak (BUGLOG-0001). Reproduces the exact mechanism by which a
 * platform_admin reached another platform's brands: a MISSING `platform` claim was read as
 * "unrestricted" (system-wide), and an UNRESOLVED target platform was deferred instead of refused.
 *
 * These tests assert the SECURE (fail-closed) behaviour, so they FAIL on the pre-fix guard
 * (which returns 200 and even mints a cross-platform admin token) and PASS once the guard fails
 * closed. Token scheme (stub verifier): `<userId>:<role>:<site>:<platform>` — omitting the 4th
 * segment models a platform_admin whose token carries NO platform claim (the live latent hole:
 * profiles.platform_id NULL ⇒ no claim minted at login).
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const DEFAULT_PLATFORM = "10000000-0000-0000-0000-000000000001";
const SYSTEM = `${TEST_ADMIN}:platform_superadmin`;

/** Stand up a second platform (beta) with one brand (b1) re-parented into it. Returns b1's id. */
async function seedBeta(api: TestApi): Promise<string> {
  const beta = (await json(await req(api, "POST", "/api/v1/platform/platforms", SYSTEM, { slug: "beta", name: "Beta" }))).platformId as string;
  const b1 = (await json(await req(api, "POST", "/api/v1/platform/sites", SYSTEM, { slug: "b1site", name: "B1" }))).siteId as string;
  assert.equal((await req(api, "POST", `/api/v1/platform/sites/${b1}/assign`, SYSTEM, { platformId: beta })).status, 200);
  return b1;
}

test("Issue 1: a platform_admin with NO platform claim is refused, not treated as system-wide", async () => {
  const api = await startTestApi();
  try {
    const b1 = await seedBeta(api);
    // platform_admin bound to a brand (SITE_A) but WITHOUT a platform claim (4th segment omitted).
    const CLAIMLESS = `attacker:platform_admin:${SITE_A}`;

    // 1) It must NOT be able to enumerate every platform's brands (the "opens all brands" leak).
    const listRes = await req(api, "GET", "/api/v1/platform/sites", CLAIMLESS);
    assert.equal(listRes.status, 403, "claimless platform_admin must be refused the brand list, not shown all platforms");

    // 2) THE DATA LEAK: it must NOT mint a working admin token for another platform's brand.
    const imp = await req(api, "POST", `/api/v1/platform/sites/${b1}/impersonate`, CLAIMLESS, {});
    assert.equal(imp.status, 403, "claimless platform_admin must NOT impersonate a cross-platform brand");
    const impBody = await json(imp);
    assert.equal(impBody.token, undefined, "no admin token may be minted for a claimless platform_admin");

    // 3) It must NOT mutate a cross-platform brand.
    const edit = await req(api, "PATCH", `/api/v1/platform/sites/${b1}`, CLAIMLESS, { name: "hax" });
    assert.equal(edit.status, 403, "claimless platform_admin must NOT edit a cross-platform brand");
  } finally {
    await api.close();
  }
});

test("Issue 1: a bounded platform_admin acting on an UNRESOLVED target is refused (fail closed)", async () => {
  const api = await startTestApi();
  try {
    // Correctly-claimed platform_admin on the DEFAULT platform.
    const PA = `pa:platform_admin:${SITE_A}:${DEFAULT_PLATFORM}`;
    // A target site that does not exist -> platformOfSite() is unresolved. The guard must REFUSE,
    // not defer to a downstream check.
    const ghost = "99999999-9999-9999-9999-999999999999";
    const imp = await req(api, "POST", `/api/v1/platform/sites/${ghost}/impersonate`, PA, {});
    assert.equal(imp.status, 403, "unresolved target must be refused by the scope guard");
    assert.equal((await json(imp)).error.code, "PLATFORM_SCOPE_FORBIDDEN");
  } finally {
    await api.close();
  }
});

test("Issue 1 regression guard: legitimate platform_admin + system owner keep working", async () => {
  const api = await startTestApi();
  try {
    const b1 = await seedBeta(api);
    const PA = `pa:platform_admin:${SITE_A}:${DEFAULT_PLATFORM}`;

    // Its own platform's brand (SITE_A) is visible and editable.
    const sites = (await json(await req(api, "GET", "/api/v1/platform/sites", PA))).sites as any[];
    assert.ok(sites.some((s) => s.siteId === SITE_A), "claimed platform_admin still sees its own brand");
    assert.ok(!sites.some((s) => s.siteId === b1), "claimed platform_admin still does NOT see another platform's brand");
    assert.equal((await req(api, "PATCH", `/api/v1/platform/sites/${SITE_A}`, PA, { name: "Renamed" })).status, 200);
    // Impersonating its OWN brand still works (mints a token).
    const okImp = await req(api, "POST", `/api/v1/platform/sites/${SITE_A}/impersonate`, PA, {});
    assert.equal(okImp.status, 200, "claimed platform_admin can still impersonate its own brand");
    assert.ok((await json(okImp)).token, "own-brand impersonation still mints a token");

    // System owner remains unrestricted across platforms.
    assert.equal((await req(api, "PATCH", `/api/v1/platform/sites/${b1}`, SYSTEM, { name: "B1x" })).status, 200);
    assert.equal((await req(api, "POST", `/api/v1/platform/sites/${b1}/impersonate`, SYSTEM, {})).status, 200);
  } finally {
    await api.close();
  }
});
