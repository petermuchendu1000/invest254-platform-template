import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A } from "./testutil.js";

/** docs/42 UI-8 — /auth/me reports the brand/platform THIS session acts on (from the token), with names. */
const me = async (base: string, token: string) =>
  (await (await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as any;

test("UI-8: /auth/me scope — brand session names its brand; platform admin names its platform; owner neither", async () => {
  const api = await startTestApi();
  try {
    const beta = (await (await fetch(`${api.baseUrl}/api/v1/platform/platforms`, {
      method: "POST", headers: { authorization: "Bearer own:platform_superadmin", "content-type": "application/json" },
      body: JSON.stringify({ slug: "beta", name: "Beta Platform" }),
    })).json() as any).platformId as string;

    const brand = await me(api.baseUrl, `u1:admin:${SITE_A}`);
    assert.equal(brand.scope.site.id, SITE_A);
    assert.equal(typeof brand.scope.site.name, "string");
    assert.ok(brand.scope.site.name.length > 0, "brand name resolved");
    assert.equal(brand.scope.platform, null);

    const pa = await me(api.baseUrl, `u2:platform_admin:${SITE_A}:${beta}`);
    assert.deepEqual(pa.scope.platform, { id: beta, name: "Beta Platform" });

    const owner = await me(api.baseUrl, "u3:platform_superadmin");
    assert.deepEqual(owner.scope, { site: null, platform: null }, "the system owner is not confined to a brand or platform");
  } finally { await api.close(); }
});
