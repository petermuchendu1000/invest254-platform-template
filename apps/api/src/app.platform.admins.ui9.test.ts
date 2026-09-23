import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A } from "./testutil.js";

/**
 * docs/42 UI-9 — the System console appointed/revoked platform admins by pasting a raw uuid and only
 * ever saw a COUNT of them. Now: a list of the current platform admins (who, which platform, home
 * brand) and a cross-brand user search to appoint from — System owner only — and the governance RPC
 * refusals map to 4xx instead of a 500.
 */
const PLATFORM = "10000000-0000-0000-0000-000000000001";
const OWNER = "u-owner:platform_superadmin";
const PA = `u-pa:platform_admin:${SITE_A}:${PLATFORM}`;
const ADMIN = `u-admin:admin:${SITE_A}`;

async function call(base: string, method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${base}/api/v1${path}`, init);
  const j = (await r.json().catch(() => ({}))) as any;
  return { status: r.status, body: j, code: j?.error?.code as string | undefined };
}

test("UI-9: the owner lists current platform admins by name, platform and home brand", async () => {
  const api = await startTestApi();
  try {
    api.platformRepo.directory.set("u-alice", { username: "alice", phone: "254711000001", role: "admin", siteId: SITE_A });
    assert.equal((await call(api.baseUrl, "POST", "/platform/platform-admins", OWNER, { userId: "u-alice", platformId: PLATFORM })).status, 201);
    const all = await call(api.baseUrl, "GET", "/platform/platform-admins", OWNER);
    assert.equal(all.status, 200);
    const alice = all.body.admins.find((a: any) => a.userId === "u-alice");
    assert.ok(alice, "appointed admin is listed");
    assert.equal(alice.username, "alice");
    assert.equal(alice.platformId, PLATFORM);
    assert.equal(alice.platformName, "Default Platform");
    const one = await call(api.baseUrl, "GET", `/platform/platform-admins?platform=${PLATFORM}`, OWNER);
    assert.deepEqual(one.body.admins.map((a: any) => a.userId), ["u-alice"]);
    const other = await call(api.baseUrl, "GET", "/platform/platform-admins?platform=20000000-0000-0000-0000-000000000009", OWNER);
    assert.deepEqual(other.body.admins, [], "filtered by platform");
    const bad = await call(api.baseUrl, "GET", "/platform/platform-admins?platform=not-a-uuid", OWNER);
    assert.equal(bad.status, 400);
    // after revoke they disappear
    assert.equal((await call(api.baseUrl, "POST", "/platform/platform-admins/u-alice/revoke", OWNER, {})).status, 200);
    assert.deepEqual((await call(api.baseUrl, "GET", "/platform/platform-admins", OWNER)).body.admins, []);
  } finally { await api.close(); }
});

test("UI-9: the owner finds people across brands by username or phone (>= 2 chars)", async () => {
  const api = await startTestApi();
  try {
    api.platformRepo.directory.set("u-bob", { username: "bobkamau", phone: "254722333444", role: "admin", siteId: SITE_A });
    api.platformRepo.directory.set("u-carol", { username: "carol", phone: "254733000000", role: "player", siteId: SITE_A });
    const byName = await call(api.baseUrl, "GET", "/platform/users/search?q=kamau", OWNER);
    assert.equal(byName.status, 200);
    assert.deepEqual(byName.body.users.map((u: any) => u.userId), ["u-bob"]);
    assert.equal(byName.body.users[0].siteId, SITE_A);
    const byPhone = await call(api.baseUrl, "GET", "/platform/users/search?q=0000", OWNER);
    assert.deepEqual(byPhone.body.users.map((u: any) => u.userId), ["u-carol"]);
    const tooShort = await call(api.baseUrl, "GET", "/platform/users/search?q=a", OWNER);
    assert.equal(tooShort.status, 400); assert.equal(tooShort.code, "INVALID_QUERY");
    const empty = await call(api.baseUrl, "GET", "/platform/users/search", OWNER);
    assert.equal(empty.status, 400, "no 'list everyone' by empty query");
  } finally { await api.close(); }
});

test("UI-9: platform admins and site admins can neither list platform admins nor search the directory", async () => {
  const api = await startTestApi();
  try {
    for (const tok of [PA, ADMIN]) {
      for (const path of ["/platform/platform-admins", "/platform/users/search?q=bob"]) {
        const r = await call(api.baseUrl, "GET", path, tok);
        assert.equal(r.status, 403, `${tok.split(":")[1]} ${path} -> ${r.status}`);
      }
    }
  } finally { await api.close(); }
});

test("UI-9: governance refusals are 4xx with their code, not a 500", async () => {
  const api = await startTestApi();
  try {
    const nf = await call(api.baseUrl, "POST", "/platform/platform-admins", OWNER, { userId: "u-x", platformId: "20000000-0000-0000-0000-000000000009" });
    assert.equal(nf.status, 404); assert.equal(nf.code, "PLATFORM_NOT_FOUND");
    const notPa = await call(api.baseUrl, "POST", "/platform/platform-admins/u-nobody/revoke", OWNER, {});
    assert.equal(notPa.status, 409); assert.equal(notPa.code, "NOT_A_PLATFORM_ADMIN");
    const badRole = await call(api.baseUrl, "POST", "/platform/platform-admins/u-nobody/revoke", OWNER, { newRole: "platform_superadmin" });
    assert.equal(badRole.status, 400); assert.equal(badRole.code, "INVALID_ROLE");
  } finally { await api.close(); }
});
