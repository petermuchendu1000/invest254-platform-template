import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, type TestApi } from "./testutil.js";

/**
 * Admin "disable the app" capability — the SAME mechanism both the mpesa app and the truecaller
 * app rely on. An admin flips a marketer's status; every marketer-scoped route then returns 403,
 * so the apps sign the user out. Covers active -> disabled/suspended -> re-enable.
 *
 * The truecaller app enforces this by calling GET /marketers/me on launch (and on every poll):
 * a 403 clears the session and bounces to the sign-in screen.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
const ADMIN = `${TEST_ADMIN}:admin:00000000-0000-0000-0000-000000000001`;
const mtok = (id: string) => `${id}:marketer`;

function req(api: TestApi, method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

async function onboard(api: TestApi): Promise<string> {
  const r = await req(api, "POST", "/api/v1/admin/marketers", ADMIN, { name: "Peter Muchendu", phone: "0722000099" });
  assert.ok([200, 201].includes(r.status));
  return (await json(r)).id as string;
}

test("admin disable locks the truecaller app: /me and feed return 403 while disabled", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api);

    // Active: the app's launch check (/me) and feed both succeed.
    assert.equal((await req(api, "GET", "/api/v1/marketers/me", mtok(id))).status, 200);
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/transactions", mtok(id))).status, 200);

    // Admin disables the marketer.
    const dis = await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, ADMIN, { status: "disabled" });
    assert.equal(dis.status, 200);
    assert.equal((await json(dis)).status, "disabled");

    // Now every marketer-scoped route is blocked -> the app logs the user out.
    const me = await req(api, "GET", "/api/v1/marketers/me", mtok(id));
    assert.equal(me.status, 403);
    assert.equal((await json(me)).error.code, "MARKETER_INACTIVE");
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/transactions", mtok(id))).status, 403);
  } finally { await api.close(); }
});

test("admin suspend also blocks; re-activating restores access", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api);

    assert.equal((await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, ADMIN, { status: "suspended" })).status, 200);
    assert.equal((await req(api, "GET", "/api/v1/marketers/me", mtok(id))).status, 403);

    assert.equal((await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, ADMIN, { status: "active" })).status, 200);
    assert.equal((await req(api, "GET", "/api/v1/marketers/me", mtok(id))).status, 200);
  } finally { await api.close(); }
});

test("disabling requires admin; a marketer cannot disable anyone", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api);
    // No token -> 401; marketer token -> 403 (not an admin).
    assert.equal((await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, undefined, { status: "disabled" })).status, 401);
    assert.equal((await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, mtok(id), { status: "disabled" })).status, 403);
    // Still active.
    assert.equal((await req(api, "GET", "/api/v1/marketers/me", mtok(id))).status, 200);
  } finally { await api.close(); }
});
