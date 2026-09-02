import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, type TestApi } from "./testutil.js";

/**
 * Delete flows (Issue): soft-delete a user/admin (status='deleted', hidden, login-blocked, guarded)
 * and HARD-delete a demo marketer (removes the social-proof account). E2E over HTTP.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
async function register(api: TestApi, phone: string, username: string, password = "Password1"): Promise<string> {
  const res = await req(api, "POST", "/api/v1/auth/register", undefined, { phone, username, password });
  assert.equal(res.status, 201, `register ${username}`);
  return (await json(res)).userId as string;
}
const ADMIN = `${TEST_ADMIN}:admin`;
const SUPER = `${TEST_ADMIN}:superadmin`;

test("soft-delete user: marks deleted, hides from list, blocks login", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712009001", "todelete");
    // login works before deletion
    assert.equal((await req(api, "POST", "/api/v1/auth/login", undefined, { phone: "0712009001", password: "Password1" })).status, 200);

    const del = await req(api, "POST", `/api/v1/admin/users/${uid}/delete`, ADMIN);
    assert.equal(del.status, 200);
    assert.equal((await json(del)).status, "deleted");

    // hidden from the default user list
    const list = await json(await req(api, "GET", "/api/v1/admin/users", ADMIN));
    assert.ok(!list.items.some((u: any) => u.userId === uid), "deleted user hidden from list");

    // login now blocked (same error as bad credentials — anti-enumeration)
    const login = await req(api, "POST", "/api/v1/auth/login", undefined, { phone: "0712009001", password: "Password1" });
    assert.equal(login.status, 401, "deleted account cannot log in");
  } finally { await api.close(); }
});

test("soft-delete user: cannot delete yourself", async () => {
  const api = await startTestApi();
  try {
    const r = await req(api, "POST", `/api/v1/admin/users/${TEST_ADMIN}/delete`, ADMIN);
    assert.equal(r.status, 409);
    assert.equal((await json(r)).error.code, "NO_SELF_ACTION");
  } finally { await api.close(); }
});

test("soft-delete: a plain admin cannot delete an admin; a superadmin can", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712009002", "an_admin");
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${uid}/role`, SUPER, { role: "admin" })).status, 200);
    // plain admin blocked
    const blocked = await req(api, "POST", `/api/v1/admin/users/${uid}/delete`, ADMIN);
    assert.equal(blocked.status, 403);
    assert.equal((await json(blocked)).error.code, "INSUFFICIENT_PRIVILEGE");
    // superadmin allowed
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${uid}/delete`, SUPER)).status, 200);
  } finally { await api.close(); }
});

test("delete demo marketer: removes it; second delete is 404", async () => {
  const api = await startTestApi();
  try {
    const created = await json(await req(api, "POST", "/api/v1/admin/marketers", ADMIN, { name: "Temp Marketer", phone: "0799008007" }));
    const id = created.id as string;
    // present in the list
    let list = await json(await req(api, "GET", "/api/v1/admin/marketers", ADMIN));
    assert.ok(list.some((m: any) => m.id === id), "marketer present before delete");
    // delete
    const del = await req(api, "POST", `/api/v1/admin/marketers/${id}/delete`, ADMIN);
    assert.equal(del.status, 200);
    assert.equal((await json(del)).deleted, true);
    // gone
    list = await json(await req(api, "GET", "/api/v1/admin/marketers", ADMIN));
    assert.ok(!list.some((m: any) => m.id === id), "marketer gone after delete");
    // deleting again -> 404
    assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${id}/delete`, ADMIN)).status, 404);
  } finally { await api.close(); }
});
