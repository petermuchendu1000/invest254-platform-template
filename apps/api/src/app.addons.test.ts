import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, type TestApi } from "./testutil.js";

/**
 * Issue 2 — add-on API surface: reads/requests open to operators (admin+), and price/decide/grant/
 * revoke SYSTEM-owner-only. Plus the chart/UI assignment guard on the platform site-patch. Real
 * catalog/entitlement/scope logic is proven at the DB layer by e2e_addon_entitlements.py.
 * Token scheme: <userId>:<role>:<siteId>:<platformId>.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function reqf(api: TestApi, method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const SITE_ADMIN = `${TEST_ADMIN}:admin:${SITE_A}`;
const PA         = `${TEST_ADMIN}:platform_admin:${SITE_A}:plat-1`;
const SYS        = `${TEST_ADMIN}:platform_superadmin`;
const PLAYER     = `${TEST_ADMIN}:player:${SITE_A}`;

test("addons API: reads/requests are admin+, writes are system-only, chart assignment is guarded", async () => {
  const api = await startTestApi();
  try {
    // Catalog: any operator; player denied.
    assert.equal((await reqf(api, "GET", "/api/v1/addons/catalog", SITE_ADMIN)).status, 200, "site admin reads catalog");
    assert.equal((await reqf(api, "GET", "/api/v1/addons/catalog", PA)).status, 200, "platform admin reads catalog");
    assert.equal((await reqf(api, "GET", "/api/v1/addons/catalog", PLAYER)).status, 403, "player denied catalog");
    assert.ok((await json(await reqf(api, "GET", "/api/v1/addons/catalog", SITE_ADMIN))).items.length > 0, "catalog has items");

    // Brand view: site admin uses its own site claim; player denied.
    assert.equal((await reqf(api, "GET", "/api/v1/addons/brand", SITE_ADMIN)).status, 200, "site admin brand view");
    assert.equal((await reqf(api, "GET", "/api/v1/addons/brand", PLAYER)).status, 403, "player denied brand view");

    // Request: operator may request; player denied.
    assert.equal((await reqf(api, "POST", "/api/v1/addons/request", SITE_ADMIN, { category: "chart", key: "candlestick" })).status, 200, "site admin requests");
    assert.equal((await reqf(api, "POST", "/api/v1/addons/request", PLAYER, { category: "chart", key: "candlestick" })).status, 403, "player denied request");

    // Price: system only.
    assert.equal((await reqf(api, "PUT", "/api/v1/addons/price", SYS, { category: "payment_gateway", key: "paystack", priceCents: 1200000 })).status, 200, "system sets price");
    assert.equal((await reqf(api, "PUT", "/api/v1/addons/price", PA, { category: "payment_gateway", key: "paystack", priceCents: 1 })).status, 403, "platform admin denied price");
    assert.equal((await reqf(api, "PUT", "/api/v1/addons/price", SITE_ADMIN, { category: "payment_gateway", key: "paystack", priceCents: 1 })).status, 403, "site admin denied price");

    // Decide + grant + revoke: system only.
    assert.equal((await reqf(api, "POST", "/api/v1/addons/requests/1/decide", SYS, { decision: "approve" })).status, 200, "system decides");
    assert.equal((await reqf(api, "POST", "/api/v1/addons/requests/1/decide", PA, { decision: "approve" })).status, 403, "platform admin denied decide");
    assert.equal((await reqf(api, "POST", "/api/v1/addons/grant", SYS, { site: SITE_A, category: "payment_gateway", key: "paystack" })).status, 200, "system grants");
    assert.equal((await reqf(api, "POST", "/api/v1/addons/grant", PA, { site: SITE_A, category: "payment_gateway", key: "paystack" })).status, 403, "platform admin denied grant");

    // Chart/UI assignment guard: a platform admin cannot set chart_style via the site patch (must request).
    const guarded = await reqf(api, "PATCH", `/api/v1/platform/sites/${SITE_A}`, PA, { chart_style: "candlestick" });
    assert.equal(guarded.status, 403, "platform admin blocked from assigning chart_style");
  } finally { await api.close(); }
});
