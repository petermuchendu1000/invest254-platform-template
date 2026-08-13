import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, type TestApi } from "./testutil.js";

/**
 * Platform-superadmin console API (docs/22 Task H): the /platform/* routes are gated to
 * `platform_superadmin`; a per-brand admin/superadmin is rejected. Covers onboarding a brand,
 * tuning its economy, listing brands + KPIs, and the superadmin gate on the override write.
 */

const json = (r: Response): Promise<any> => r.json() as Promise<any>;
interface Opts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, o: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

const PLATFORM = `${TEST_ADMIN}:platform_superadmin`;
const ADMIN = `${TEST_ADMIN}:admin`;
const SUPERADMIN = `${TEST_ADMIN}:superadmin`;

test("every /platform route rejects a per-brand admin/superadmin (platform_superadmin only)", async () => {
  const api = await startTestApi();
  try {
    for (const [m, p, b] of [
      ["GET", "/api/v1/platform/overview", undefined],
      ["GET", "/api/v1/platform/sites", undefined],
      ["POST", "/api/v1/platform/sites", { slug: "x", name: "X" }],
    ] as const) {
      assert.equal((await req(api, m, p, { token: ADMIN, body: b })).status, 403, `${p} rejects admin`);
      assert.equal((await req(api, m, p, { token: SUPERADMIN, body: b })).status, 403, `${p} rejects superadmin`);
      assert.equal((await req(api, m, p, { body: b })).status, 401, `${p} needs auth`);
    }
  } finally { await api.close(); }
});

test("onboard a brand → create, list, and see it in the KPI overview", async () => {
  const api = await startTestApi();
  try {
    // seed default brand is present
    const before = await json(await req(api, "GET", "/api/v1/platform/sites", { token: PLATFORM }));
    const beforeCount = before.sites.length;

    const created = await req(api, "POST", "/api/v1/platform/sites", { token: PLATFORM, body: { slug: "brandb", name: "Brand B", primaryDomain: "brandb.example" } });
    assert.equal(created.status, 201);
    const { siteId } = await json(created);
    assert.ok(siteId);

    const sites = (await json(await req(api, "GET", "/api/v1/platform/sites", { token: PLATFORM }))).sites;
    assert.equal(sites.length, beforeCount + 1);
    const b = sites.find((s: any) => s.slug === "brandb");
    assert.ok(b, "new brand listed");
    assert.equal(b.config.minStakeCents, 25000, "seeded with default economy");

    const overview = (await json(await req(api, "GET", "/api/v1/platform/overview", { token: PLATFORM }))).sites;
    assert.ok(overview.find((s: any) => s.siteId === siteId), "new brand appears in KPI overview");
  } finally { await api.close(); }
});

test("tune a brand: update branding + economy; validation is enforced", async () => {
  const api = await startTestApi();
  try {
    const { siteId } = await json(await req(api, "POST", "/api/v1/platform/sites", { token: PLATFORM, body: { slug: "brandc", name: "Brand C" } }));

    const upd = await req(api, "PATCH", `/api/v1/platform/sites/${siteId}`, { token: PLATFORM, body: { name: "Brand Charlie", status: "paused", color_primary: "#ff0000" } });
    assert.equal(upd.status, 200);
    const site = await json(upd);
    assert.equal(site.name, "Brand Charlie");
    assert.equal(site.status, "paused");
    assert.equal(site.colorPrimary, "#ff0000");

    const cfg = await req(api, "PATCH", `/api/v1/platform/sites/${siteId}/config`, { token: PLATFORM, body: { min_stake: 50000, target_win_rate: 0.2 } });
    assert.equal(cfg.status, 200);
    const c = await json(cfg);
    assert.equal(c.minStakeCents, 50000);
    assert.equal(c.version, 2, "economy version bumped");

    // missing slug/name on create → 400
    assert.equal((await req(api, "POST", "/api/v1/platform/sites", { token: PLATFORM, body: { slug: "only-slug" } })).status, 400);
    // non-object patch → 400
    assert.equal((await req(api, "PATCH", `/api/v1/platform/sites/${siteId}`, { token: PLATFORM, body: [1, 2] })).status, 400);
  } finally { await api.close(); }
});

test("set a brand palette (theme tokens) is platform_superadmin-gated", async () => {
  const api = await startTestApi();
  try {
    const site = "00000000-0000-0000-0000-000000000001"; // default brand seeded in-memory
    const tokens = { bg: "#0c100d", brand: "#2cdd6d", accent: "#67e997", up: "#2cdd6d", down: "#8fa396" };
    assert.equal((await req(api, "PATCH", `/api/v1/platform/sites/${site}/theme`, { token: ADMIN, body: { tokens } })).status, 403, "admin rejected");
    assert.equal((await req(api, "PATCH", `/api/v1/platform/sites/${site}/theme`, { body: { tokens } })).status, 401, "auth required");
    assert.equal((await req(api, "PATCH", `/api/v1/platform/sites/${site}/theme`, { token: PLATFORM, body: { tokens } })).status, 200, "platform superadmin can set the palette");
    assert.equal((await req(api, "PATCH", `/api/v1/platform/sites/${site}/theme`, { token: PLATFORM, body: { tokens: [1, 2] } })).status, 400, "non-object tokens rejected");
  } finally { await api.close(); }
});

test("the per-user override write is superadmin-gated (docs/22 Task H)", async () => {
  const api = await startTestApi();
  try {
    // requireRole runs before the handler, so the gate is provable without a real target user.
    const asAdmin = await req(api, "POST", "/api/v1/admin/users/00000000-0000-0000-0000-0000000000aa/overrides", { token: ADMIN, body: { win_rate: "0.5" } });
    assert.equal(asAdmin.status, 403, "plain admin cannot write an override");
    const asSuper = await req(api, "POST", "/api/v1/admin/users/00000000-0000-0000-0000-0000000000aa/overrides", { token: SUPERADMIN, body: { win_rate: "0.5" } });
    assert.notEqual(asSuper.status, 403, "superadmin passes the gate (handler then runs)");
  } finally { await api.close(); }
});
