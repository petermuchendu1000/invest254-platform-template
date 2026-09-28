import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi, SITE_A, SITE_B } from "./testutil.js";

/**
 * 0173 — the per-PLATFORM and per-BRAND bonuses switch, end to end.
 *
 * Scenarios are the ones an operator actually hits: a brand that overspends on sign-up bonuses, a
 * platform owner pausing every brand at once, two platforms that must not reach each other, and the
 * money question that matters most — switching the tap off must never claw back a bonus already
 * given. The composition under test is `system AND platform AND brand`: any level can stop a grant
 * and no lower level can re-enable what a higher one stopped.
 */

const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, o: { token?: string; body?: unknown; host?: string } = {}): Promise<Response> {
  const h: Record<string, string> = {};
  if (o.token) h["authorization"] = `Bearer ${o.token}`;
  if (o.host) h["x-forwarded-host"] = o.host;
  const init: RequestInit = { method, headers: h };
  if (o.body !== undefined) { h["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

const OWNER = "owner:platform_superadmin";                    // system owner — every platform
const BRAND_ADMIN = `u-admin:admin:${SITE_A}`;                // site admin of brand A
const PLATFORM_A = "10000000-0000-0000-0000-000000000001";    // the default platform (holds SITE_A)
const PLATFORM_B = "b0000000-0000-0000-0000-0000000000b0";

/** Register a fresh player on brand `site` and return the cents the welcome bonus credited (0 = none). */
async function signUp(api: TestApi, site: string, n: number, expectSiteId?: string): Promise<number> {
  const r = await json(await req(api, "POST", "/api/v1/auth/register", {
    body: { site, phone: `07120000${String(n).padStart(2, "0")}`, username: `p${site.split(".")[0]}${n}`, password: "Password1" },
  }));
  if (expectSiteId) assert.equal(r.site, expectSiteId, "the sign-up must land on the brand under test");
  return r.welcomeBonusCents ?? 0;
}

/** A second platform owning SITE_B, with its own appointed admin. Returns that admin's token. */
async function secondPlatform(api: TestApi): Promise<string> {
  api.platformRepo.seedSite(SITE_B, "brandb", "Brand B");
  await api.platformRepo.createPlatform("sys", "platform_superadmin", "beta", "Beta Platform");
  // createPlatform mints its own id; find it, then re-parent SITE_B and appoint an admin.
  const beta = (await api.platformRepo.listPlatforms()).find((p) => p.slug === "beta")!;
  await api.platformRepo.assignSiteToPlatform("sys", "platform_superadmin", SITE_B, beta.platformId);
  await api.platformRepo.appointPlatformAdmin("sys", "platform_superadmin", "u-beta", beta.platformId);
  return `u-beta:platform_admin:${SITE_B}:${beta.platformId}`;
}

test("a brand grants the welcome bonus while every switch is on", async () => {
  const api = await startTestApi();
  try {
    api.identity.welcomeBonusCents = 20_000;                 // KES 200, as in production
    assert.equal(await signUp(api, "invest254.com", 1), 20_000);

    const view = await json(await req(api, "GET", "/api/v1/admin/bonuses-enabled", { token: BRAND_ADMIN }));
    assert.deepEqual(
      { system: view.system, platform: view.platform, brand: view.brand, effective: view.effective },
      { system: true, platform: true, brand: true, effective: true });
  } finally { await api.close(); }
});

test("a brand admin switches its OWN brand off; the next sign-up gets nothing", async () => {
  const api = await startTestApi();
  try {
    api.identity.welcomeBonusCents = 20_000;
    assert.equal(await signUp(api, "invest254.com", 2), 20_000, "granted before the flip");

    const off = await req(api, "PUT", "/api/v1/admin/bonuses-enabled", { token: BRAND_ADMIN, body: { enabled: false } });
    assert.equal(off.status, 200);
    const s = await json(off);
    assert.equal(s.brand, false);
    assert.equal(s.effective, false);

    assert.equal(await signUp(api, "invest254.com", 3), 0, "no bonus once the brand switch is off");

    // …and back on again: the switch is not one-way.
    await req(api, "PUT", "/api/v1/admin/bonuses-enabled", { token: BRAND_ADMIN, body: { enabled: true } });
    assert.equal(await signUp(api, "invest254.com", 4), 20_000);
  } finally { await api.close(); }
});

test("switching bonuses off never touches a bonus already granted", async () => {
  const api = await startTestApi();
  try {
    api.identity.welcomeBonusCents = 20_000;
    const granted = await signUp(api, "invest254.com", 5);
    assert.equal(granted, 20_000);

    await req(api, "PUT", "/api/v1/admin/bonuses-enabled", { token: BRAND_ADMIN, body: { enabled: false } });

    // The switch governs FUTURE grants only — it is not a confiscation. The player who already
    // holds a restricted balance keeps it, wagering progress and all.
    const audit = await api.adminRepo.listAudit({ limit: 50 });
    const rows = audit.items.filter((a: any) => a.action === "bonuses.toggle");
    assert.equal(rows.length, 1, "the flip is audited");
    assert.deepEqual((rows[0] as any).detail, { bonuses_enabled: false });
    assert.equal(await signUp(api, "invest254.com", 6), 0, "only new grants stop");
  } finally { await api.close(); }
});

test("the platform switch stops every brand under it, and a brand cannot re-enable itself", async () => {
  const api = await startTestApi();
  try {
    api.identity.welcomeBonusCents = 20_000;

    const off = await req(api, "PUT", "/api/v1/platform/bonuses", { token: OWNER, body: { enabled: false } });
    assert.equal(off.status, 200);
    const v = await json(off);
    assert.equal(v.platformEnabled, false);
    assert.equal(v.platformId, PLATFORM_A);
    assert.ok(v.brands.every((b: any) => b.effective === false), "no brand under the platform grants");

    assert.equal(await signUp(api, "invest254.com", 7), 0);

    // A brand admin turning its own switch "on" must NOT override the platform above it.
    const s = await json(await req(api, "PUT", "/api/v1/admin/bonuses-enabled", { token: BRAND_ADMIN, body: { enabled: true } }));
    assert.equal(s.brand, true, "the brand's own switch is on…");
    assert.equal(s.platform, false, "…but its platform is off");
    assert.equal(s.effective, false, "so no bonus is granted");
    assert.equal(await signUp(api, "invest254.com", 8), 0);

    // The platform owner restores it and grants resume.
    await req(api, "PUT", "/api/v1/platform/bonuses", { token: OWNER, body: { enabled: true } });
    assert.equal(await signUp(api, "invest254.com", 9), 20_000);
  } finally { await api.close(); }
});

test("one platform's switch does not reach another platform's brands", async () => {
  const api = await startTestApi();
  try {
    api.identity.welcomeBonusCents = 20_000;
    const betaAdmin = await secondPlatform(api);
    const beta = (await api.platformRepo.listPlatforms()).find((p) => p.slug === "beta")!;

    // Beta's admin switches ITS platform off.
    const off = await json(await req(api, "PUT", "/api/v1/platform/bonuses", { token: betaAdmin, body: { enabled: false } }));
    assert.equal(off.platformId, beta.platformId);
    assert.equal(off.platformEnabled, false);

    assert.equal(await signUp(api, "brandb.example", 10, SITE_B), 0, "beta's brand stops");
    assert.equal(await signUp(api, "invest254.com", 11, SITE_A), 20_000, "the other platform is untouched");
  } finally { await api.close(); }
});

test("a platform admin cannot flip another platform's switch or another platform's brand", async () => {
  const api = await startTestApi();
  try {
    const betaAdmin = await secondPlatform(api);

    // ?platform= is IGNORED for a scoped admin (actingPlatform pins it to its own), so the flip
    // lands on beta — never on the default platform it named.
    const r = await json(await req(api, "PUT", `/api/v1/platform/bonuses?platform=${PLATFORM_A}`, { token: betaAdmin, body: { enabled: false } }));
    assert.notEqual(r.platformId, PLATFORM_A, "a scoped admin can never act on another platform");

    // The default platform is untouched by that attempt.
    const owner = await json(await req(api, "GET", `/api/v1/platform/bonuses?platform=${PLATFORM_A}`, { token: OWNER }));
    assert.equal(owner.platformEnabled, true);

    // A brand outside its platform is refused at the door.
    const cross = await req(api, "PUT", `/api/v1/platform/sites/${SITE_A}/bonuses`, { token: betaAdmin, body: { enabled: false } });
    assert.equal(cross.status, 403);
    assert.equal((await json(cross)).error?.code ?? (await Promise.resolve("")), "PLATFORM_SCOPE_FORBIDDEN");
  } finally { await api.close(); }
});

test("the system owner flips any brand from the console, and the view reports every brand", async () => {
  const api = await startTestApi();
  try {
    api.identity.welcomeBonusCents = 20_000;
    const set = await req(api, "PUT", `/api/v1/platform/sites/${SITE_A}/bonuses`, { token: OWNER, body: { enabled: false } });
    assert.equal(set.status, 200);
    assert.equal((await json(set)).brand, false);

    const view = await json(await req(api, "GET", "/api/v1/platform/bonuses", { token: OWNER }));
    const a = view.brands.find((b: any) => b.siteId === SITE_A);
    assert.equal(a.enabled, false);
    assert.equal(a.effective, false);
    assert.equal(view.systemEnabled, true);
    assert.equal(view.platformEnabled, true, "the platform itself is still on");
    assert.equal(await signUp(api, "invest254.com", 12), 0);
  } finally { await api.close(); }
});

test("a player can reach neither switch, and a non-boolean body is refused", async () => {
  const api = await startTestApi();
  try {
    const PLAYER = "u-test";
    for (const [method, path] of [["GET", "/api/v1/admin/bonuses-enabled"], ["PUT", "/api/v1/admin/bonuses-enabled"],
      ["GET", "/api/v1/platform/bonuses"], ["PUT", "/api/v1/platform/bonuses"]] as const) {
      const r = await req(api, method, path, { token: PLAYER, body: method === "PUT" ? { enabled: false } : undefined });
      assert.ok(r.status === 401 || r.status === 403, `${method} ${path} must refuse a player (got ${r.status})`);
    }
    // A site admin may not reach the PLATFORM switch — that is a tier above it.
    const esc = await req(api, "PUT", "/api/v1/platform/bonuses", { token: BRAND_ADMIN, body: { enabled: false } });
    assert.ok(esc.status === 401 || esc.status === 403, `a site admin must not flip a platform (got ${esc.status})`);

    for (const bad of [{}, { enabled: "false" }, { enabled: 0 }, { enabled: null }]) {
      assert.equal((await req(api, "PUT", "/api/v1/admin/bonuses-enabled", { token: BRAND_ADMIN, body: bad })).status, 400);
      assert.equal((await req(api, "PUT", "/api/v1/platform/bonuses", { token: OWNER, body: bad })).status, 400);
    }
  } finally { await api.close(); }
});

test("PLATFORM_B is unknown: naming a platform that does not exist is refused, not silently applied", async () => {
  const api = await startTestApi();
  try {
    const r = await req(api, "PUT", `/api/v1/platform/bonuses?platform=${PLATFORM_B}`, { token: OWNER, body: { enabled: false } });
    assert.notEqual(r.status, 200);
    // and nothing was changed on the real platform
    const view = await json(await req(api, "GET", "/api/v1/platform/bonuses", { token: OWNER }));
    assert.equal(view.platformEnabled, true);
  } finally { await api.close(); }
});
