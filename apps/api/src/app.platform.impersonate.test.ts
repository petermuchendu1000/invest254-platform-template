import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, SITE_B, type TestApi } from "./testutil.js";

/**
 * Platform-owner / platform-admin IMPERSONATION — mint + gate + the brand fence it creates
 * (docs/24 §370, docs/38 Option B).
 *
 * Issue 1 / F1: the legacy site-fenced `superadmin` impersonation role was removed. Impersonation now
 * ALWAYS mints a day-to-day `admin` + `site` token — for BOTH the system owner and a platform admin.
 * Owner-tier brand config is no longer reachable via impersonation; it lives in the platform/system
 * console. This proves, end-to-end and across DIFFERENT brands:
 *   1. MINT   — POST /platform/sites/:id/impersonate returns role='admin' + `site` = the TARGET brand
 *               (subject stays the owner for audit). Tested for two distinct brands.
 *   2. GATE   — the route is platform_admin+; a per-brand admin is refused; anon is 401.
 *   3. FENCE  — a token of the exact shape impersonation mints (`owner:admin:<brand>`) can only WRITE
 *               (day-to-day ops) inside that brand; a cross-brand write is SITE_SCOPE_FORBIDDEN.
 *   4. EXIT   — the platform owner's own token (platform_superadmin, no `site` claim) is unrestricted
 *               on BOTH brands — leaving impersonation restores full cross-brand authority.
 */

const json = (r: Response): Promise<any> => r.json() as Promise<any>;
interface Opts { token?: string; body?: unknown }
function req(api: TestApi, method: string, path: string, o: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

const OWNER = TEST_ADMIN;
const PLATFORM = `${OWNER}:platform_superadmin`;              // the owner's own session (no site claim)
const ADMIN = `${OWNER}:admin:00000000-0000-0000-0000-000000000001`;
// A platform admin of SITE_A's platform (harness default platform owns SITE_A), and one of a DIFFERENT
// platform — used to prove scope + the leak fix (a platform admin is fenced, never escalated).
const DEFAULT_PLATFORM = "10000000-0000-0000-0000-000000000001";
const PLATFORM_ADMIN = `${OWNER}:platform_admin:${SITE_A}:${DEFAULT_PLATFORM}`;
const PLATFORM_ADMIN_OTHER = `${OWNER}:platform_admin:${SITE_A}:99999999-9999-9999-9999-999999999999`;

/** A user on each of the two brands, so cross-brand writes have a concrete, resolvable target. */
async function seedTwoBrandUsers(api: TestApi) {
  const uA = (await api.identity.register("254790000001", "impUserA", "hash_" + "a".repeat(24), undefined, SITE_A)).userId;
  const uB = (await api.identity.register("254790000001", "impUserB", "hash_" + "b".repeat(24), undefined, SITE_B)).userId;
  return { uA, uB };
}

// ── 2. GATE ──────────────────────────────────────────────────────────────────────────────────────
test("impersonate is platform_admin+ (per-brand admin refused; needs auth)", async () => {
  const api = await startTestApi();
  try {
    const path = `/api/v1/platform/sites/${SITE_A}/impersonate`;
    assert.equal((await req(api, "POST", path, { token: ADMIN })).status, 403, "site admin refused");
    assert.equal((await req(api, "POST", path)).status, 401, "anonymous refused");
  } finally { await api.close(); }
});

// ── LEAK FIX — a platform_admin is fenced to a day-to-day admin session, never escalated ───────────
test("platform_admin impersonation mints an 'admin' session, fenced to the brand", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", `/api/v1/platform/sites/${SITE_A}/impersonate`, { token: PLATFORM_ADMIN });
    assert.equal(res.status, 200, "a platform admin may impersonate a brand in its own platform");
    const b = await json(res);
    assert.equal(b.role, "admin", "platform admin gets a site-admin session — no escalation");
    assert.equal(b.site, SITE_A, "fenced to the target brand");
  } finally { await api.close(); }
});

test("platform_admin cannot impersonate a brand outside its own platform (403 PLATFORM_SCOPE_FORBIDDEN)", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", `/api/v1/platform/sites/${SITE_A}/impersonate`, { token: PLATFORM_ADMIN_OTHER });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, "PLATFORM_SCOPE_FORBIDDEN");
  } finally { await api.close(); }
});

// ── 1. MINT (two different brands) ─────────────────────────────────────────────────────────────────
test("impersonate mints an admin token fenced to the TARGET brand — for two distinct brands", async () => {
  const api = await startTestApi();
  try {
    // Default brand (SITE_A) is present out of the box; create a second brand to impersonate.
    const created = await req(api, "POST", "/api/v1/platform/sites", { token: PLATFORM, body: { slug: "brandb", name: "Brand B", primaryDomain: "brandb.example" } });
    assert.equal(created.status, 201);
    const brandBId = (await json(created)).siteId as string;

    // Impersonate brand A (the default).
    const impA = await req(api, "POST", `/api/v1/platform/sites/${SITE_A}/impersonate`, { token: PLATFORM });
    assert.equal(impA.status, 200);
    const a = await json(impA);
    assert.equal(a.role, "admin", "A: role is a brand-scoped admin");
    assert.equal(a.site, SITE_A, "A: token is fenced to brand A");
    assert.equal(a.brand.siteId, SITE_A);
    assert.ok(typeof a.token === "string" && a.token.length > 0, "A: a token is returned");

    // Impersonate brand B — must be fenced to B, not A.
    const impB = await req(api, "POST", `/api/v1/platform/sites/${brandBId}/impersonate`, { token: PLATFORM });
    assert.equal(impB.status, 200);
    const b = await json(impB);
    assert.equal(b.role, "admin", "B: role is a brand-scoped admin");
    assert.equal(b.site, brandBId, "B: token is fenced to brand B");
    assert.equal(b.brand.slug, "brandb");
    assert.notEqual(b.site, a.site, "the two impersonations are fenced to different brands");

    // Unknown brand -> 404.
    const missing = await req(api, "POST", `/api/v1/platform/sites/99999999-9999-9999-9999-999999999999/impersonate`, { token: PLATFORM });
    assert.equal(missing.status, 404);
  } finally { await api.close(); }
});

// ── 3. FENCE — an impersonation-shaped token only writes (day-to-day) inside its brand ──────────────
test("an impersonation admin token (site=B) can write to B but NOT to A", async () => {
  const api = await startTestApi();
  try {
    const { uA, uB } = await seedTwoBrandUsers(api);
    const IMP_B = `${OWNER}:admin:${SITE_B}`;   // exactly what /impersonate mints for brand B

    const cross = await req(api, "POST", `/api/v1/admin/wallets/${uA}/adjust`, { token: IMP_B, body: { amountCents: 1000, reason: "x" } });
    assert.equal(cross.status, 403, "B-fenced session cannot write a brand-A user");
    assert.equal((await json(cross)).error.code, "SITE_SCOPE_FORBIDDEN");

    const same = await req(api, "POST", `/api/v1/admin/wallets/${uB}/adjust`, { token: IMP_B, body: { amountCents: 1000, reason: "x" } });
    assert.notEqual(same.status, 403, "B-fenced session can write its own brand-B user");
  } finally { await api.close(); }
});

test("swapped: an impersonation admin token (site=A) can write to A but NOT to B", async () => {
  const api = await startTestApi();
  try {
    const { uA, uB } = await seedTwoBrandUsers(api);
    const IMP_A = `${OWNER}:admin:${SITE_A}`;   // impersonating the default brand

    const cross = await req(api, "POST", `/api/v1/admin/wallets/${uB}/adjust`, { token: IMP_A, body: { amountCents: 1000, reason: "x" } });
    assert.equal(cross.status, 403, "A-fenced session cannot write a brand-B user");
    assert.equal((await json(cross)).error.code, "SITE_SCOPE_FORBIDDEN");

    const same = await req(api, "POST", `/api/v1/admin/wallets/${uA}/adjust`, { token: IMP_A, body: { amountCents: 1000, reason: "x" } });
    assert.notEqual(same.status, 403, "A-fenced session can write its own brand-A user");
  } finally { await api.close(); }
});

// ── FENCE also covers the default-marketer controls (Issue 1 routes) ───────────────────────────────
test("an impersonation admin token cannot set/clear a default marketer in another brand", async () => {
  const api = await startTestApi();
  try {
    // A marketer on brand B; a session fenced to brand A must not touch it.
    const mB = (await api.identity.register("254790000009", "mktB", "hash_" + "m".repeat(24), undefined, SITE_B)).userId;
    api.identity.adminSetRole(mB, "marketer");
    const IMP_A = `${OWNER}:admin:${SITE_A}`;

    const mk = await req(api, "POST", `/api/v1/admin/marketers/${mB}/make-default`, { token: IMP_A });
    assert.equal(mk.status, 403, "A-fenced session cannot make a brand-B marketer the default");
    assert.equal((await json(mk)).error.code, "SITE_SCOPE_FORBIDDEN");

    const clr = await req(api, "POST", `/api/v1/admin/marketers/${mB}/clear-default`, { token: IMP_A });
    assert.equal(clr.status, 403, "A-fenced session cannot clear a brand-B default");
  } finally { await api.close(); }
});

// ── 4. EXIT — the platform owner (platform_superadmin, no site claim) is unrestricted on BOTH brands ─
/** The scope error code for a response, or null when the request was not scope-blocked. */
async function scopeBlock(r: Response): Promise<string | null> {
  if (r.status !== 403) return null;
  try { return ((await r.json()) as any).error?.code ?? null; } catch { return null; }
}

test("the platform owner (no site claim) is NEVER brand-fenced — no SITE_SCOPE_FORBIDDEN on either brand", async () => {
  const api = await startTestApi();
  try {
    const { uA, uB } = await seedTwoBrandUsers(api);
    const onA = await req(api, "POST", `/api/v1/admin/wallets/${uA}/adjust`, { token: PLATFORM, body: { amountCents: 1000, reason: "x" } });
    const onB = await req(api, "POST", `/api/v1/admin/wallets/${uB}/adjust`, { token: PLATFORM, body: { amountCents: 1000, reason: "x" } });
    assert.notEqual(await scopeBlock(onA), "SITE_SCOPE_FORBIDDEN", "owner not fenced on brand A");
    assert.notEqual(await scopeBlock(onB), "SITE_SCOPE_FORBIDDEN", "owner not fenced on brand B");
  } finally { await api.close(); }
});

test("the platform owner (no site claim) can write to EITHER brand (200) — the exit state", async () => {
  const api = await startTestApi();
  try {
    const { uA, uB } = await seedTwoBrandUsers(api);
    const onA = await req(api, "POST", `/api/v1/admin/wallets/${uA}/adjust`, { token: PLATFORM, body: { amountCents: 1000, reason: "x" } });
    const onB = await req(api, "POST", `/api/v1/admin/wallets/${uB}/adjust`, { token: PLATFORM, body: { amountCents: 1000, reason: "x" } });
    assert.equal(onA.status, 200, "owner writes brand A");
    assert.equal(onB.status, 200, "owner writes brand B");
  } finally { await api.close(); }
});

// ── docs/42 UI-3: the impersonation is recorded IN the token (RFC 8693-style `act` claim) ──────────
const payloadOf = (jwt: string): Record<string, any> =>
  JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as Record<string, any>;

test("UI-3: an impersonation token carries act {sub, role, brand}; the authorised role stays 'admin'", async () => {
  const api = await startTestApi();
  try {
    for (const [token, actorRole] of [[PLATFORM_ADMIN, "platform_admin"], [PLATFORM, "platform_superadmin"]] as const) {
      const b = await json(await req(api, "POST", `/api/v1/platform/sites/${SITE_A}/impersonate`, { token }));
      const p = payloadOf(b.token);
      assert.equal(p.role, "admin", "authorisation role unchanged");
      assert.equal(p.site, SITE_A);
      assert.equal(p.sub, OWNER);
      assert.deepEqual({ sub: p.act?.sub, role: p.act?.role }, { sub: OWNER, role: actorRole }, "actor recorded");
      assert.equal(typeof p.act?.brand, "string", "brand name recorded for the banner in any tab");
    }
  } finally { await api.close(); }
});

test("UI-3: an ordinary session token has NO act claim", async () => {
  const api = await startTestApi();
  try {
    const r = await req(api, "POST", "/api/v1/auth/register", { body: { phone: "0711555001", username: "noact", password: "Password1" } });
    const t = (await json(r)).token as string;
    assert.equal(payloadOf(t).act, undefined);
  } finally { await api.close(); }
});
