import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, type TestApi } from "./testutil.js";

/**
 * Issue 1 #4 — the withdrawal-pool console is available to PLATFORM ADMINS (scoped to their platform)
 * and denied to lower roles. Cross-platform isolation of the distributor itself is proven at the DB
 * layer by e2e_platform_pool.py; here we verify the API surface is reachable/gated.
 * Token scheme: <userId>:<role>:<siteId>:<platformId>.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function reqf(api: TestApi, method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const PA1        = `${TEST_ADMIN}:platform_admin:${SITE_A}:plat-1`;
const SITE_ADMIN = `${TEST_ADMIN}:admin:${SITE_A}`;
const PLAYER     = `${TEST_ADMIN}:player:${SITE_A}`;

test("withdrawal-pool console: platform admin may read demand + distributions; lower roles denied", async () => {
  const api = await startTestApi();
  try {
    // Platform admin reaches the read endpoints (no active sites in the harness => empty, still 200).
    const dem = await reqf(api, "GET", "/api/v1/platform/pool/demand", PA1);
    assert.equal(dem.status, 200, "platform admin may preview demand");
    assert.ok(Array.isArray((await json(dem)).preview.rows), "demand returns rows array");

    const dist = await reqf(api, "GET", "/api/v1/platform/pool/distributions", PA1);
    assert.equal(dist.status, 200, "platform admin may list distributions");
    assert.ok(Array.isArray((await json(dist)).distributions), "distributions is an array");

    // Lower roles are denied the whole pool surface.
    for (const tok of [SITE_ADMIN, PLAYER]) {
      assert.equal((await reqf(api, "GET", "/api/v1/platform/pool/demand", tok)).status, 403, "demand denied");
      assert.equal((await reqf(api, "GET", "/api/v1/platform/pool/distributions", tok)).status, 403, "distributions denied");
      assert.equal((await reqf(api, "POST", "/api/v1/platform/pool/distribute", tok, { totalCents: 1000, mode: "equal" })).status, 403, "distribute denied");
    }
  } finally { await api.close(); }
});
