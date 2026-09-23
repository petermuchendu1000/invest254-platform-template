import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A, SITE_B, type TestApi } from "./testutil.js";

/**
 * ISSUE 1 / F-43 — "every token carries its holder's scope" (invariant S1).
 *
 * The live escalation this suite reproduces END-TO-END:
 *   1. a brand-A account is promoted to site `admin` (role changes in the DB);
 *   2. the web notices token-role != live role and calls POST /auth/refresh (SessionBootstrap);
 *   3. the OLD refresh minted issueToken(userId, role) — NO `site` claim;
 *   4. adminScopeSite() read the missing claim as null == UNRESTRICTED, so the refreshed brand-A
 *      admin listed (and could act on) the users of EVERY brand on EVERY platform.
 * Here the refresh returns a REAL JWT; we decode its claims and replay exactly those claims through
 * the stub verifier (`<sub>:<role>:<site>:<platform>`), i.e. what the live verifier would see.
 * Every assertion below FAILS on the pre-fix code and PASSES on the fix.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
/** Decode a JWT payload (the harness verifier is a stub; the minted token is a real HS256 JWT). */
function claims(token: string): Record<string, any> {
  const seg = token.split(".")[1];
  assert.ok(seg, "a real JWT was minted");
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<string, any>;
}
/** Replay a real token's claims through the stub verifier. */
const asStub = (c: Record<string, any>): string => [c.sub, c.role, c.site ?? "", c.platform ?? ""].join(":");

async function register(api: TestApi, phone: string, username: string, site: string): Promise<string> {
  const r = await req(api, "POST", "/api/v1/auth/register", undefined, { phone, username, password: "Password1", site });
  assert.equal(r.status, 201, `register ${username}`);
  return (await json(r)).userId as string;
}

test("F-43: a refreshed site admin keeps its brand — it can NOT list another brand's users", async () => {
  const api = await startTestApi();
  try {
    const adminA = await register(api, "0711000001", "adminA", "invest254");   // brand A
    const playerA = await register(api, "0711000002", "playerA", "invest254");
    const playerB = await register(api, "0711000003", "playerB", "brandb");    // brand B
    api.identity._setRole(adminA, "admin");                                     // promotion in the DB

    // The web's stale-role heal: a player-role token for the now-admin account calls refresh.
    const r = await req(api, "POST", "/api/v1/auth/refresh", `${adminA}:player:${SITE_A}`);
    assert.equal(r.status, 200);
    const body = await json(r);
    const c = claims(body.token);
    assert.equal(c.role, "admin");
    assert.equal(c.site, SITE_A, "the refreshed token MUST keep the brand claim");
    assert.equal(body.site, SITE_A, "the response echoes the scope");

    // Replay the refreshed token: brand A's users only — never brand B's.
    const list = await json(await req(api, "GET", "/api/v1/admin/users?limit=100", asStub(c)));
    const ids = (list.items as Array<{ userId: string }>).map((u) => u.userId);
    assert.ok(ids.includes(playerA), "sees its own brand's player");
    assert.ok(!ids.includes(playerB), "must NOT see another brand's player (cross-tenant leak)");
  } finally { await api.close(); }
});

test("F-43: a site admin token WITHOUT a site claim is refused on every back-office surface (fail-closed)", async () => {
  const api = await startTestApi();
  try {
    const CLAIMLESS = "someadmin:admin";
    const surfaces = [
      "/api/v1/admin/overview", "/api/v1/admin/users", "/api/v1/admin/withdrawals", "/api/v1/admin/deposits",
      "/api/v1/admin/transactions", "/api/v1/admin/deposits/reconcile", "/api/v1/admin/reports/daily",
      "/api/v1/admin/reports/users", "/api/v1/admin/reports/day", "/api/v1/admin/rtp", "/api/v1/admin/real-cash-rtp",
      "/api/v1/admin/config-review", "/api/v1/admin/seeds", "/api/v1/admin/affiliate/payouts",
      "/api/v1/admin/game-config", "/api/v1/admin/withdrawal-pool", "/api/v1/admin/withdrawals-enabled",
      "/api/v1/admin/marketers", "/api/v1/admin/affiliate/advances", "/api/v1/admin/commission-payouts",
    ];
    for (const path of surfaces) {
      const res = await req(api, "GET", path, CLAIMLESS);
      assert.equal(res.status, 403, `${path} must refuse a claimless site admin (was: unrestricted, every brand)`);
      assert.equal((await json(res)).error.code, "SITE_CLAIM_MISSING", path);
    }
    // Writes resolve their brand the same way — refused too.
    const flip = await req(api, "PUT", "/api/v1/admin/withdrawals-enabled", CLAIMLESS, { enabled: false });
    assert.equal(flip.status, 403, "a claimless site admin must not flip any brand's withdrawal kill switch");
  } finally { await api.close(); }
});

test("F-43: a refreshed platform_admin keeps its platform claim (no lock-out, no escalation)", async () => {
  const api = await startTestApi();
  try {
    const PLATFORM = "10000000-0000-0000-0000-000000000001";
    const pa = await register(api, "0711000010", "platAdmin", "invest254");
    api.identity._setRole(pa, "platform_admin");
    api.identity.setPlatformId(pa, PLATFORM);
    const body = await json(await req(api, "POST", "/api/v1/auth/refresh", `${pa}:player:${SITE_A}`));
    const c = claims(body.token);
    assert.equal(c.role, "platform_admin");
    assert.equal(c.platform, PLATFORM, "the refreshed platform_admin token MUST keep its platform claim");
    assert.equal(body.platform, PLATFORM);
    // The replayed token is a working, BOUNDED platform admin (not PLATFORM_CLAIM_MISSING).
    assert.equal((await req(api, "GET", "/api/v1/platform/sites", asStub(c))).status, 200);
  } finally { await api.close(); }
});

test("F-43: affiliate enrolment re-mints a token that keeps the brand claim", async () => {
  const api = await startTestApi();
  try {
    const u = await register(api, "0711000020", "promoterB", "brandb");
    const r = await req(api, "POST", "/api/v1/affiliate/enroll", `${u}:player:${SITE_B}`);
    assert.equal(r.status, 200);
    const tok = (await json(r)).token as string | undefined;
    assert.ok(tok, "enrolment returns a fresh token");
    const c = claims(tok);
    assert.equal(c.role, "marketer");
    assert.equal(c.site, SITE_B, "the enrolment token MUST stay bound to brand B (was: claimless -> default brand)");
  } finally { await api.close(); }
});

test("F-43: marketer-app PIN session is bound to the marketer's brand", async () => {
  const api = await startTestApi();
  try {
    // A brand-B marketer, provisioned by brand B's own admin.
    const ADMIN_B = `adm-b:admin:${SITE_B}`;
    const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", ADMIN_B, { name: "Mary B", phone: "0722555001" }))).id as string;
    assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${id}/pin`, ADMIN_B, { pin: "2468" })).status, 200);
    const pin = await req(api, "POST", "/api/v1/marketers/auth/login", undefined, { phone: "0722555001", pin: "2468" });
    assert.equal(pin.status, 200);
    const c = claims((await json(pin)).token);
    assert.equal(c.sub, id);
    assert.equal(c.role, "marketer");
    assert.equal(c.site, SITE_B, "PIN login token MUST carry the marketer's brand");
  } finally { await api.close(); }
});

test("F-43: marketer-app website-credential session is bound to the marketer's brand", async () => {
  const api = await startTestApi();
  try {
    // Website account on brand B (phone+password) + the brand-B marketer wallet for the same phone.
    await register(api, "0722555002", "webMarkB", "brandb");
    const ADMIN_B = `adm-b:admin:${SITE_B}`;
    const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", ADMIN_B, { name: "Web B", phone: "0722555002" }))).id as string;
    const r = await req(api, "POST", "/api/v1/marketers/auth/login-web", undefined, { phone: "0722555002", password: "Password1" });
    assert.equal(r.status, 200);
    const c = claims((await json(r)).token);
    assert.equal(c.sub, id);
    assert.equal(c.site, SITE_B, "login-web token MUST carry the marketer's brand");
  } finally { await api.close(); }
});

test("F-43 regression guard: the system owner and a correctly-scoped site admin are unaffected", async () => {
  const api = await startTestApi();
  try {
    const pA = await register(api, "0711000031", "ownA", "invest254");
    const pB = await register(api, "0711000032", "ownB", "brandb");
    const all = await json(await req(api, "GET", "/api/v1/admin/users?limit=100", "owner:platform_superadmin"));
    const ids = (all.items as Array<{ userId: string }>).map((u) => u.userId);
    assert.ok(ids.includes(pA) && ids.includes(pB), "the system owner (no site claim) still sees every brand");
    const onlyB = await json(await req(api, "GET", "/api/v1/admin/users?limit=100", `adm-b:admin:${SITE_B}`));
    const idsB = (onlyB.items as Array<{ userId: string }>).map((u) => u.userId);
    assert.ok(idsB.includes(pB) && !idsB.includes(pA), "a scoped site admin sees exactly its own brand");
  } finally { await api.close(); }
});
