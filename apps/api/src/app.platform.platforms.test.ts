import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, type TestApi } from "./testutil.js";

/**
 * Platform-tier GOVERNANCE API (Issue 1). Drives the real HTTP app over the in-memory platform repo
 * and asserts: the system owner (platform_superadmin) can manage platforms + appoint/revoke platform
 * admins; a site admin is refused (403). Token scheme (testutil stub verifier): `<userId>:<role>:<site>`.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const SYSTEM = `${TEST_ADMIN}:platform_superadmin`;
const SITE_ADMIN = `${TEST_ADMIN}:admin:${SITE_A}`;

test("platform governance: system owner manages platforms + platform admins; site admin is refused", async () => {
  const api = await startTestApi();
  try {
    // default platform is listed
    let r = await req(api, "GET", "/api/v1/platform/platforms", SYSTEM);
    assert.equal(r.status, 200);
    const list0 = (await json(r)).platforms as any[];
    assert.ok(list0.some((p) => p.slug === "default"), "default platform present");

    // create a platform
    r = await req(api, "POST", "/api/v1/platform/platforms", SYSTEM, { slug: "acme", name: "Acme Group" });
    assert.equal(r.status, 201);
    const platformId = (await json(r)).platformId as string;
    assert.ok(platformId);

    // it appears in the list + overview
    r = await req(api, "GET", "/api/v1/platform/platforms/overview", SYSTEM);
    const ov = (await json(r)).platforms as any[];
    assert.ok(ov.some((p) => p.platformId === platformId && p.slug === "acme"), "new platform in overview");

    // update it
    r = await req(api, "PATCH", `/api/v1/platform/platforms/${platformId}`, SYSTEM, { name: "Acme Holdings", status: "suspended" });
    assert.equal(r.status, 200);
    assert.equal((await json(r)).name, "Acme Holdings");

    // assign the default site into it
    r = await req(api, "POST", `/api/v1/platform/sites/${SITE_A}/assign`, SYSTEM, { platformId });
    assert.equal(r.status, 200);
    assert.equal((await json(r)).platformId, platformId);

    // appoint + revoke a platform admin
    r = await req(api, "POST", "/api/v1/platform/platform-admins", SYSTEM, { userId: "u-appointee", platformId });
    assert.equal(r.status, 201);
    const appointed = await json(r);
    assert.equal(appointed.role, "platform_admin");
    assert.equal(appointed.platformId, platformId);

    r = await req(api, "POST", "/api/v1/platform/platform-admins/u-appointee/revoke", SYSTEM, { newRole: "admin" });
    assert.equal(r.status, 200);
    assert.equal((await json(r)).role, "admin");

    // ── a SITE admin is refused every governance route (403) ──
    for (const [m, p, b] of [
      ["GET", "/api/v1/platform/platforms", undefined],
      ["POST", "/api/v1/platform/platforms", { slug: "x", name: "X" }],
      ["POST", "/api/v1/platform/platform-admins", { userId: "z", platformId }],
    ] as const) {
      const rr = await req(api, m, p, SITE_ADMIN, b as unknown);
      assert.equal(rr.status, 403, `${m} ${p} must be 403 for a site admin`);
    }

    // validation: bad slug rejected
    r = await req(api, "POST", "/api/v1/platform/platforms", SYSTEM, { slug: "Bad Slug!", name: "x" });
    assert.equal(r.status, 400);
  } finally {
    await api.close();
  }
});
