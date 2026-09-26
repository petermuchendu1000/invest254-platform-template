import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A } from "./testutil.js";

/** BUGLOG #111: the console reads a marketer's CURRENT commission rate (it always showed 20%). */
test("GET /admin/affiliates/:id/rate returns the stored rate, and is brand-scoped", async () => {
  let uid = "";
  const api = await startTestApi({ depsOverrides: { commissionRateOf: async (id) => (id === uid ? 0.25 : null) } });
  const get = (id: string, token = `${TEST_ADMIN}:admin:${SITE_A}`) =>
    fetch(`${api.baseUrl}/api/v1/admin/affiliates/${id}/rate`, { headers: { authorization: `Bearer ${token}` } });
  try {
    const reg = await fetch(`${api.baseUrl}/api/v1/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "0712000077", username: "mkt77", password: "Password1" }),
    });
    uid = ((await reg.json()) as { userId: string }).userId;
    const r = await get(uid);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { rate: 0.25 });
    assert.equal((await fetch(`${api.baseUrl}/api/v1/admin/affiliates/${uid}/rate`)).status, 401);
    // an id outside the admin's brand (here: unknown) is refused before anything is read
    assert.equal((await get("00000000-0000-0000-0000-00000000dead")).status, 404);
  } finally { await api.close(); }
});
