import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, SITE_B, type TestApi } from "./testutil.js";

/**
 * Admin list reads are site-scoped by the admin token's optional `site` claim (docs/22 Task E):
 *   - a PLATFORM admin token (no site claim) sees every brand's rows (unchanged behaviour);
 *   - a SITE-scoped admin token (site claim = brand id) sees ONLY that brand's rows.
 * Forward-compatible with the platform-superadmin / site-admin role model (Task H).
 */

const json = (r: Response): Promise<any> => r.json() as Promise<any>;
const get = (api: TestApi, path: string, token: string) =>
  fetch(`${api.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

const PLATFORM_ADMIN = `${TEST_ADMIN}:admin`;               // no site claim -> all brands
const ADMIN_A = `${TEST_ADMIN}:admin:${SITE_A}`;            // scoped to brand A
const ADMIN_B = `${TEST_ADMIN}:admin:${SITE_B}`;            // scoped to brand B

async function seedTwoBrandUsers(api: TestApi) {
  // A registered player + a pending deposit (site-stamped) on each brand.
  const uA = (await api.identity.register("254790000001", "brandUserA", "hash_"+"a".repeat(24), undefined, SITE_A)).userId;
  const uB = (await api.identity.register("254790000001", "brandUserB", "hash_"+"b".repeat(24), undefined, SITE_B)).userId;
  api.payRepo.seed(uA, 500_000); api.payRepo.seed(uB, 500_000);
  await api.payRepo.createDeposit(uA, 40_000, "254790000001", SITE_A);
  await api.payRepo.createDeposit(uB, 25_000, "254790000001", SITE_B);
  return { uA, uB };
}

test("admin users list: platform admin sees both brands; a site admin sees only its own", async () => {
  const api = await startTestApi();
  try {
    const { uA, uB } = await seedTwoBrandUsers(api);

    const all = await json(await get(api, "/api/v1/admin/users", PLATFORM_ADMIN));
    const allIds = all.items.map((u: any) => u.userId);
    assert.ok(allIds.includes(uA) && allIds.includes(uB), "platform admin sees both brands' users");

    const aOnly = await json(await get(api, "/api/v1/admin/users", ADMIN_A));
    const aIds = aOnly.items.map((u: any) => u.userId);
    assert.ok(aIds.includes(uA), "brand-A admin sees brand-A user");
    assert.ok(!aIds.includes(uB), "brand-A admin does NOT see brand-B user");

    const bOnly = await json(await get(api, "/api/v1/admin/users", ADMIN_B));
    const bIds = bOnly.items.map((u: any) => u.userId);
    assert.ok(bIds.includes(uB) && !bIds.includes(uA), "brand-B admin sees only brand-B user");
  } finally { await api.close(); }
});

test("admin transactions/deposits list: scoped to the admin's brand claim", async () => {
  const api = await startTestApi();
  try {
    await seedTwoBrandUsers(api);

    const all = await json(await get(api, "/api/v1/admin/transactions", PLATFORM_ADMIN));
    assert.equal(all.items.length, 2, "platform admin sees both brands' transactions");

    const aTx = await json(await get(api, "/api/v1/admin/transactions", ADMIN_A));
    assert.deepEqual(aTx.items.map((t: any) => t.amountCents).sort(), [40_000], "brand-A admin sees only A's tx");

    const bDep = await json(await get(api, "/api/v1/admin/deposits", ADMIN_B));
    assert.deepEqual(bDep.items.map((t: any) => t.amountCents).sort(), [25_000], "brand-B admin sees only B's deposit");
  } finally { await api.close(); }
});
