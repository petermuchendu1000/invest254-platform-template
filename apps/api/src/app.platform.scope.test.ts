import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, type TestApi } from "./testutil.js";

/**
 * PLATFORM-ADMIN console scoping (Issue 1, staged item #1). Drives the real HTTP app and proves a
 * platform_admin can operate ONLY its own platform's sites via /platform/*, is refused any site in
 * another platform (403 PLATFORM_SCOPE_FORBIDDEN), and cannot reach system-only tools (403).
 * Token scheme (stub verifier): `<userId>:<role>:<site>:<platform>`.
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

test("platform-admin console is bounded to its own platform", async () => {
  const api = await startTestApi();
  try {
    // System creates a second platform and a brand, then re-parents the brand into it.
    const beta = (await json(await req(api, "POST", "/api/v1/platform/platforms", SYSTEM, { slug: "beta", name: "Beta" }))).platformId as string;
    const b1 = (await json(await req(api, "POST", "/api/v1/platform/sites", SYSTEM, { slug: "b1site", name: "B1" }))).siteId as string;
    assert.equal((await req(api, "POST", `/api/v1/platform/sites/${b1}/assign`, SYSTEM, { platformId: beta })).status, 200);

    // A platform_admin scoped to the DEFAULT platform (SITE_A lives there).
    const PA = `pa1:platform_admin:${SITE_A}:${DEFAULT_PLATFORM}`;

    // 1. Sites list is platform-filtered: sees SITE_A (default), NOT the beta brand.
    const sites = (await json(await req(api, "GET", "/api/v1/platform/sites", PA))).sites as any[];
    const ids = new Set(sites.map((s) => s.siteId));
    assert.ok(ids.has(SITE_A), "sees its own platform's site");
    assert.ok(!ids.has(b1), "does NOT see another platform's site");

    // 2. Can edit a site in its platform.
    assert.equal((await req(api, "PATCH", `/api/v1/platform/sites/${SITE_A}`, PA, { name: "Renamed" })).status, 200);

    // 3. CANNOT touch a site in another platform (403 PLATFORM_SCOPE_FORBIDDEN).
    const crossEdit = await req(api, "PATCH", `/api/v1/platform/sites/${b1}`, PA, { name: "hax" });
    assert.equal(crossEdit.status, 403);
    assert.equal((await json(crossEdit)).error.code, "PLATFORM_SCOPE_FORBIDDEN");
    assert.equal((await req(api, "GET", `/api/v1/platform/sites/${b1}/users`, PA)).status, 403, "cross-platform user list blocked");
    assert.equal((await req(api, "POST", `/api/v1/platform/sites/${b1}/users/someuid/balance`, PA, { amountCents: 100, reason: "x" })).status, 403, "cross-platform balance adjust blocked");

    // 4. System-only tools are refused (403).
    assert.equal((await req(api, "GET", "/api/v1/platform/platforms", PA)).status, 403, "platforms CRUD is system-only");
    assert.equal((await req(api, "GET", "/api/v1/platform/global-config", PA)).status, 403, "global config is system-only");

    // 5. The system owner remains unrestricted (can edit the beta brand).
    assert.equal((await req(api, "PATCH", `/api/v1/platform/sites/${b1}`, SYSTEM, { name: "B1x" })).status, 200);
  } finally {
    await api.close();
  }
});
