import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN } from "./testutil.js";
import { DEFAULT_CONFIG } from "@invest254/shared";

/** STAKE-1 (BUGLOG #87): stake limits in the brand currency → engine-enforced KES cents + public config. */
const SITE = "00000000-0000-0000-0000-000000000001";
const PLATFORM = `${TEST_ADMIN}:platform_superadmin`;
const ADMIN = `${TEST_ADMIN}:admin:${SITE}`;

test("PUT /platform/sites/:id/stake-limits validates, writes enforced cents, and stores the native values", async () => {
  let currency = "USD";
  const store = new Map<string, { min: number; max: number }>();
  const calls: Record<string, unknown>[] = [];
  const cur = { min: 25000, max: 5000000 };
  const api = await startTestApi({ depsOverrides: {
    stakeNative: {
      get: async (id) => store.get(id) ?? null,
      set: async (id, _u, min, max) => { store.set(id, { min, max }); },
      currency: async () => currency,
      clear: async (id) => { store.delete(id); },
    },
    fxRate: async (c) => (c === "USD" ? 0.0077226 : 0),
    // the live config reflects what was written (as site_game_config does in production)
    gameConfigForSite: async () => ({ ...DEFAULT_CONFIG, version: 1, minStakeCents: cur.min, maxStakeCents: cur.max }),
  } });
  const orig = api.deps.platform.setSiteConfig.bind(api.deps.platform);
  api.deps.platform.setSiteConfig = (async (u: string, r: string, id: string, p: Record<string, unknown>) => {
    calls.push(p); cur.min = Number(p.min_stake); cur.max = Number(p.max_stake); return orig(u, r, id, p);
  }) as typeof orig;
  const put = (body: unknown, token = PLATFORM) => fetch(`${api.baseUrl}/api/v1/platform/sites/${SITE}/stake-limits`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await put({ min: 5, max: 1000 }, ADMIN)).status, 403, "brand admins cannot");
    for (const bad of [{ min: 4, max: 100 }, { min: 7, max: 100 }, { min: 10, max: 5 }, { min: 5, max: 12 }]) {
      const r = await put(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(calls.length, 0, "nothing written on a refusal");
    const ok = await put({ min: 5, max: 1000 });
    assert.equal(ok.status, 200);
    const body = await ok.json() as { min: number; max: number; currency: string };
    assert.equal(body.min, 5); assert.equal(body.max, 1000); assert.equal(body.currency, "USD");
    assert.deepEqual(calls[0], { min_stake: Math.floor((5 / 0.0077226) * 100 * 0.9), max_stake: Math.ceil((1000 / 0.0077226) * 100 * 1.1) });
    currency = "KES";
    await put({ min: 300, max: 60000 });
    assert.deepEqual(calls[1], { min_stake: 30000, max_stake: 6000000 });
    assert.equal((await put({ min: 300, max: 60000 })).status, 200);
    assert.equal(calls.length, 2, "an unchanged pair is not re-written (economy guard: 6 changes/hour)");
    currency = "EUR";
    assert.equal((await put({ min: 5, max: 100 })).status, 503, "no rate → refused, nothing written");
    assert.equal(calls.length, 2);
  } finally { await api.close(); }
});
