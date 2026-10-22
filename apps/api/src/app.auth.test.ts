import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, type TestApi } from "./testutil.js";

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return fetch(`${api.baseUrl}${path}`, init);
}

const REG = { phone: "0712345678", username: "alice", password: "Password1" };

// ───────────────────────────────────── register ──────────────────────────────────
test("POST /auth/register → 201 with token + player role", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", "/api/v1/auth/register", { body: REG });
    assert.equal(res.status, 201);
    const body = await json(res);
    assert.ok(body.token && typeof body.token === "string");
    assert.ok(body.userId);
    assert.equal(body.role, "player");
  } finally { await api.close(); }
});

test("POST /auth/register → 400 on missing field / too-short password / bad phone", async () => {
  const api = await startTestApi();
  try {
    let res = await req(api, "POST", "/api/v1/auth/register", { body: { phone: "0712345678", username: "alice" } });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "VALIDATION");

    // Four characters is the floor and there are no character classes, so "short" (5) registers
    // and only something under four is refused.
    res = await req(api, "POST", "/api/v1/auth/register", { body: { ...REG, password: "abc" } });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "PASSWORD_TOO_SHORT");

    res = await req(api, "POST", "/api/v1/auth/register", { body: { ...REG, phone: "not-a-phone" } });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "INVALID_PHONE");
  } finally { await api.close(); }
});

test("POST /auth/register → 409 on a duplicate PHONE; a duplicate username is fine", async () => {
  const api = await startTestApi();
  try {
    await req(api, "POST", "/api/v1/auth/register", { body: REG });
    let res = await req(api, "POST", "/api/v1/auth/register", { body: { ...REG, username: "bob" } });
    assert.equal(res.status, 409);
    assert.equal((await json(res)).error.code, "PHONE_TAKEN");

    // Same username, different phone: two people may share a display name (migration 0190).
    res = await req(api, "POST", "/api/v1/auth/register", { body: { ...REG, phone: "0722222222" } });
    assert.equal(res.status, 201);
  } finally { await api.close(); }
});

// ────────────────────────────────────── login ───────────────────────────────────
test("POST /auth/login → 200 after register; wrong/unknown creds → 401", async () => {
  const api = await startTestApi();
  try {
    const reg = await json(await req(api, "POST", "/api/v1/auth/register", { body: REG }));
    const ok = await req(api, "POST", "/api/v1/auth/login", { body: { phone: "+254712345678", password: "Password1" } });
    assert.equal(ok.status, 200);
    const body = await json(ok);
    assert.equal(body.userId, reg.userId);
    assert.ok(body.token);

    const bad = await req(api, "POST", "/api/v1/auth/login", { body: { phone: "0712345678", password: "WrongPass9" } });
    assert.equal(bad.status, 401);
    assert.equal((await json(bad)).error.code, "INVALID_CREDENTIALS");

    const unknown = await req(api, "POST", "/api/v1/auth/login", { body: { phone: "0700000000", password: "Password1" } });
    assert.equal(unknown.status, 401);
  } finally { await api.close(); }
});

// ─────────────────────────────────────── /me ────────────────────────────────────
test("GET /auth/me → 401 without token, identity echo with token", async () => {
  const api = await startTestApi();
  try {
    const anon = await fetch(`${api.baseUrl}/api/v1/auth/me`);
    assert.equal(anon.status, 401);

    const res = await req(api, "GET", "/api/v1/auth/me", { token: TEST_USER }); // stub token → player
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.userId, TEST_USER);
    assert.equal(body.role, "player");
    assert.equal(body.username, "tester"); // seeded in the harness
  } finally { await api.close(); }
});

// ────────────────────────────────── basic KYC / profile (H1) ────────────────────────────────
test("GET /auth/me → returns the registered identity (no KYC fields)", async () => {
  const api = await startTestApi();
  try {
    const reg = await json(await req(api, "POST", "/api/v1/auth/register", { body: REG }));
    const me = await json(await req(api, "GET", "/api/v1/auth/me", { token: reg.userId }));
    assert.equal(me.username, "alice");
    assert.equal(me.role, "player");
    assert.equal(me.kycStatus, undefined);
    assert.equal(me.ageVerified, undefined);
  } finally { await api.close(); }
});

// ───────────────────────────────────────── token refresh (role drift) ─────────────────────────────────────────
test("POST /auth/refresh → re-issues a token with the caller's current role, gating non-active accounts", async () => {
  const api = await startTestApi();
  try {
    const reg = await json(await req(api, "POST", "/api/v1/auth/register", { body: REG }));
    const uid = reg.userId as string;

    // Newly registered → player.
    const before = await json(await req(api, "GET", "/api/v1/auth/me", { token: uid }));
    assert.equal(before.role, "player");

    // Promote in the identity store (simulating an admin role change). The OLD token still
    // carries role=player; /auth/refresh must mint a fresh token reflecting the new role.
    api.identity.adminSetRole(uid, "admin");
    const refreshed = await req(api, "POST", "/api/v1/auth/refresh", { token: uid });
    assert.equal(refreshed.status, 200);
    const body = await json(refreshed);
    assert.equal(body.userId, uid);
    assert.equal(body.role, "admin");
    assert.equal(typeof body.token, "string");
    assert.ok(body.token.length > 0);

    // Anonymous refresh is rejected.
    assert.equal((await fetch(`${api.baseUrl}/api/v1/auth/refresh`, { method: "POST" })).status, 401);

    // A suspended account fail-closes (no token re-issued).
    api.identity.adminSetStatus(uid, "suspended");
    assert.equal((await req(api, "POST", "/api/v1/auth/refresh", { token: uid })).status, 403);
  } finally { await api.close(); }
});
