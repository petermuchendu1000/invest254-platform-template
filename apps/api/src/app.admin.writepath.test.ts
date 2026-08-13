import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, SITE_B, type TestApi } from "./testutil.js";

/**
 * Admin write-path per-brand enforcement (docs/22 Task H) — the mutation counterpart to the
 * read-scoping in app.admin.sites.test.ts:
 *   - a SITE-scoped admin token (site claim) may only MUTATE resources in its own brand;
 *   - a PLATFORM admin token (no claim) and a platform_superadmin are unrestricted;
 *   - a known cross-brand target is refused with 403 SITE_SCOPE_FORBIDDEN;
 *   - single-tenant behaviour (no site claim) is unchanged.
 * Note SITE_A is the default brand, so a null/legacy-site row normalizes to SITE_A.
 */

const json = (r: Response): Promise<any> => r.json() as Promise<any>;
const post = (api: TestApi, path: string, token: string, body?: unknown) =>
  fetch(`${api.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const PLATFORM_ADMIN = `${TEST_ADMIN}:admin`;                 // no site claim -> all brands
const ADMIN_A = `${TEST_ADMIN}:admin:${SITE_A}`;              // scoped to brand A (the default brand)
const ADMIN_B = `${TEST_ADMIN}:admin:${SITE_B}`;             // scoped to brand B
const SUPERADMIN_B = `${TEST_ADMIN}:superadmin:${SITE_B}`;   // site-scoped superadmin (brand B)

async function seedTwoBrandUsers(api: TestApi) {
  const uA = (await api.identity.register("254790000001", "wpUserA", "hash_" + "a".repeat(24), undefined, SITE_A)).userId;
  const uB = (await api.identity.register("254790000001", "wpUserB", "hash_" + "b".repeat(24), undefined, SITE_B)).userId;
  api.payRepo.seed(uA, 500_000);
  api.payRepo.seed(uB, 500_000);
  return { uA, uB };
}

test("user status mutation: a site admin can only act on its own brand; platform admin is unrestricted", async () => {
  const api = await startTestApi();
  try {
    const { uA, uB } = await seedTwoBrandUsers(api);

    // brand-B admin -> brand-A user: refused.
    const crossBrand = await post(api, `/api/v1/admin/users/${uA}/suspend`, ADMIN_B, { reason: "x" });
    assert.equal(crossBrand.status, 403, "brand-B admin cannot suspend a brand-A user");
    assert.equal((await json(crossBrand)).error.code, "SITE_SCOPE_FORBIDDEN");

    // brand-B admin -> brand-B user: allowed.
    const sameBrand = await post(api, `/api/v1/admin/users/${uB}/suspend`, ADMIN_B, { reason: "x" });
    assert.equal(sameBrand.status, 200, "brand-B admin can suspend a brand-B user");

    // platform admin (no claim) -> brand-A user: allowed (unchanged single-tenant behaviour).
    const platform = await post(api, `/api/v1/admin/users/${uA}/suspend`, PLATFORM_ADMIN, { reason: "x" });
    assert.equal(platform.status, 200, "platform admin can suspend any brand's user");

    // brand-A admin (default brand) -> brand-A user: allowed.
    const brandA = await post(api, `/api/v1/admin/users/${uA}/reactivate`, ADMIN_A, { reason: "ok" });
    assert.equal(brandA.status, 200, "brand-A admin can act on a brand-A user");
  } finally { await api.close(); }
});

test("wallet adjust is brand-scoped for a site admin", async () => {
  const api = await startTestApi();
  try {
    const { uA, uB } = await seedTwoBrandUsers(api);

    const cross = await post(api, `/api/v1/admin/wallets/${uA}/adjust`, ADMIN_B, { amountCents: 1000, direction: "credit", reason: "test" });
    assert.equal(cross.status, 403, "brand-B admin cannot adjust a brand-A wallet");
    assert.equal((await json(cross)).error.code, "SITE_SCOPE_FORBIDDEN");

    const same = await post(api, `/api/v1/admin/wallets/${uB}/adjust`, ADMIN_B, { amountCents: 1000, direction: "credit", reason: "test" });
    assert.notEqual(same.status, 403, "brand-B admin can adjust a brand-B wallet");
  } finally { await api.close(); }
});

test("superadmin write paths (role, overrides) are still brand-scoped for a site superadmin", async () => {
  const api = await startTestApi();
  try {
    const { uA, uB } = await seedTwoBrandUsers(api);

    // Role mutation (superadmin-gated) — a site superadmin still can't reach across brands.
    const roleCross = await post(api, `/api/v1/admin/users/${uA}/role`, SUPERADMIN_B, { role: "marketer" });
    assert.equal(roleCross.status, 403);
    assert.equal((await json(roleCross)).error.code, "SITE_SCOPE_FORBIDDEN");

    // Override write (superadmin-gated) — cross-brand refused, same-brand allowed.
    const ovCross = await post(api, `/api/v1/admin/users/${uA}/overrides`, SUPERADMIN_B, { winRate: 0.5 });
    assert.equal(ovCross.status, 403);
    assert.equal((await json(ovCross)).error.code, "SITE_SCOPE_FORBIDDEN");

    const ovSame = await post(api, `/api/v1/admin/users/${uB}/overrides`, SUPERADMIN_B, { winRate: 0.5 });
    assert.notEqual(ovSame.status, 403, "site superadmin can override its own brand's user");
  } finally { await api.close(); }
});

test("bulk action: cross-brand targets fail per-row while same-brand targets succeed", async () => {
  const api = await startTestApi();
  try {
    const { uA, uB } = await seedTwoBrandUsers(api);

    const res = await post(api, `/api/v1/admin/users/bulk`, ADMIN_B, { action: "suspend", userIds: [uA, uB], reason: "bulk" });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.okCount, 1, "only the brand-B target succeeds");
    assert.equal(body.failCount, 1, "the brand-A target is refused");
    const failed = body.results.find((r: any) => r.userId === uA);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /SITE_SCOPE_FORBIDDEN/);
    const ok = body.results.find((r: any) => r.userId === uB);
    assert.equal(ok.ok, true);
  } finally { await api.close(); }
});

test("withdrawal approve is brand-scoped for a site finance admin", async () => {
  const api = await startTestApi();
  try {
    const { uA } = await seedTwoBrandUsers(api);
    // A pending withdrawal stamped to brand A.
    const w = await api.payRepo.createWithdrawal(uA, 40_000, "254790000001", 100, SITE_A);

    const cross = await post(api, `/api/v1/admin/withdrawals/${w.txId}/approve`, ADMIN_B);
    assert.equal(cross.status, 403, "brand-B finance admin cannot approve a brand-A withdrawal");
    assert.equal((await json(cross)).error.code, "SITE_SCOPE_FORBIDDEN");

    // Same-brand admin: not a scope rejection (the decision itself proceeds).
    const same = await post(api, `/api/v1/admin/withdrawals/${w.txId}/approve`, PLATFORM_ADMIN);
    assert.notEqual(same.status, 403, "platform admin can approve any brand's withdrawal");
  } finally { await api.close(); }
});
