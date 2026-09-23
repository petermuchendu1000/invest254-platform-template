import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlatformAuditQuery } from "@invest254/engine";
import { startTestApi, SITE_A, type TestApi } from "./testutil.js";

/**
 * docs/42 UI-10 — platform-admin console gaps (API half): a player's overrides can be READ in the console
 * (the write existed alone, and took the raw body — a typo became a DB 500), and there is ONE audit trail
 * across a platform's brands. Scope: a platform admin only ever reaches its own platform.
 */
const DEFAULT_PLATFORM = "10000000-0000-0000-0000-000000000001";
const OWNER = "own:platform_superadmin";
const PA = `pa1:platform_admin:${SITE_A}:${DEFAULT_PLATFORM}`;
async function call(api: TestApi, method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${api.baseUrl}/api/v1${path}`, init);
  const j = (await r.json().catch(() => ({}))) as any;
  return { status: r.status, body: j, code: j?.error?.code as string | undefined };
}
async function player(api: TestApi): Promise<string> {
  const r = await call(api, "POST", "/auth/register", "", { phone: "0711100200", username: "ui10player", password: "Password1", site: "invest254" });
  assert.equal(r.status, 201);
  return r.body.userId as string;
}
async function betaAdmin(api: TestApi): Promise<string> {
  const beta = (await call(api, "POST", "/platform/platforms", OWNER, { slug: "beta", name: "Beta" })).body.platformId as string;
  return `pa2:platform_admin:${SITE_A}:${beta}`;
}

test("UI-10: a platform admin reads a player's overrides in its platform; another platform is refused", async () => {
  const api = await startTestApi();
  try {
    const uid = await player(api);
    const mine = await call(api, "GET", `/platform/sites/${SITE_A}/users/${uid}/overrides`, PA);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.userId, uid);
    assert.equal(mine.body.winRate, null, "no override -> global values");
    const other = await call(api, "GET", `/platform/sites/${SITE_A}/users/${uid}/overrides`, await betaAdmin(api));
    assert.equal(other.status, 403);
    assert.equal((await call(api, "GET", `/platform/sites/${SITE_A}/users/${uid}/overrides`, `adm:admin:${SITE_A}`)).status, 403, "site admins never reach the console");
  } finally { await api.close(); }
});

test("UI-10: override writes from the console are validated like the back office (400, not a DB error)", async () => {
  const api = await startTestApi();
  try {
    const uid = await player(api);
    for (const body of [{ winRate: "abc" }, { winRate: 1.5 }, { houseEdge: 1 }, { tradeDurationS: 0 }, { minStakeCents: -5 }, {}]) {
      const r = await call(api, "PATCH", `/platform/sites/${SITE_A}/users/${uid}/overrides`, PA, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status} ${r.code}`);
      assert.equal(r.code, "VALIDATION");
    }
    const ok = await call(api, "PATCH", `/platform/sites/${SITE_A}/users/${uid}/overrides`, PA, { tradeDurationS: 30, notes: "vip" });
    assert.equal(ok.status, 200, `${ok.status} ${ok.code}`);
    const back = await call(api, "GET", `/platform/sites/${SITE_A}/users/${uid}/overrides`, PA);
    assert.equal(back.body.tradeDurationS, 30);
  } finally { await api.close(); }
});

test("UI-10: the platform-wide audit trail is pinned to the caller's platform; the owner may choose", async () => {
  const api = await startTestApi();
  const seen: PlatformAuditQuery[] = [];
  api.adminRepo.listPlatformAudit = async (q) => { seen.push(q); return { items: [], nextCursor: null }; };
  try {
    const OTHER = "20000000-0000-0000-0000-000000000002";
    assert.equal((await call(api, "GET", `/platform/audit-log?platform=${OTHER}`, PA)).status, 200);
    assert.equal((await call(api, "GET", `/platform/audit-log?platform=${OTHER}`, OWNER)).status, 200);
    assert.equal((await call(api, "GET", "/platform/audit-log", OWNER)).status, 200);
    assert.equal((await call(api, "GET", `/platform/audit-log?site=${SITE_A}`, PA)).status, 200);
    assert.deepEqual(seen.map((q) => [q.platformId, q.siteId]), [[DEFAULT_PLATFORM, null], [OTHER, null], [null, null], [DEFAULT_PLATFORM, SITE_A]]);
    const foreign = await call(api, "GET", `/platform/audit-log?site=${SITE_A}`, await betaAdmin(api));
    assert.equal(foreign.status, 403, "a brand of another platform is refused");
    assert.equal((await call(api, "GET", "/platform/audit-log?site=bad", PA)).status, 400);
    assert.equal((await call(api, "GET", "/platform/audit-log", `adm:admin:${SITE_A}`)).status, 403);
    assert.equal(seen.length, 4, "refused requests never query");
  } finally { await api.close(); }
});
