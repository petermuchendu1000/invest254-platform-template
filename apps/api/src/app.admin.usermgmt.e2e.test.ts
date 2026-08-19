import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, type TestApi } from "./testutil.js";

/** Admin user-management (item 6): edit details, promote player<->marketer, guardrails. */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
async function register(api: TestApi, phone: string, username: string): Promise<string> {
  const res = await req(api, "POST", "/api/v1/auth/register", undefined, { phone, username, password: "Password1" });
  assert.equal(res.status, 201, `register ${username}`);
  return (await json(res)).userId as string;
}
const ADMIN = `${TEST_ADMIN}:admin`;

test("admin edits a user's phone + username (item 6)", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712000201", "orig_name");
    const r = await req(api, "POST", `/api/v1/admin/users/${uid}/details`, ADMIN, { phone: "0733111222", username: "new_name" });
    assert.equal(r.status, 200);
    const out = await json(r);
    assert.equal(out.phone, "0733111222");
    assert.equal(out.username, "new_name");
    // reflected in the user detail read
    const detail = await json(await req(api, "GET", `/api/v1/admin/users/${uid}`, ADMIN));
    assert.equal(detail.phone, "0733111222");
    assert.equal(detail.username, "new_name");
  } finally { await api.close(); }
});

test("admin edit: duplicate phone/username rejected; bad phone rejected", async () => {
  const api = await startTestApi();
  try {
    const a = await register(api, "0712000202", "user_aa");
    await register(api, "0712000203", "user_bb");
    // phone already used by user_bb
    let r = await req(api, "POST", `/api/v1/admin/users/${a}/details`, ADMIN, { phone: "0712000203" });
    assert.equal(r.status, 409); assert.equal((await json(r)).error.code, "PHONE_TAKEN");
    // username already used by user_bb
    r = await req(api, "POST", `/api/v1/admin/users/${a}/details`, ADMIN, { username: "user_bb" });
    assert.equal(r.status, 409); assert.equal((await json(r)).error.code, "USERNAME_TAKEN");
    // malformed phone
    r = await req(api, "POST", `/api/v1/admin/users/${a}/details`, ADMIN, { phone: "123" });
    assert.equal(r.status, 400); assert.equal((await json(r)).error.code, "INVALID_PHONE");
  } finally { await api.close(); }
});

test("admin can promote player -> marketer, but cannot mint an admin", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712000204", "promote_me");
    const ok = await req(api, "POST", `/api/v1/admin/users/${uid}/role`, ADMIN, { role: "marketer" });
    assert.equal(ok.status, 200);
    assert.equal((await json(ok)).role, "marketer");

    const uid2 = await register(api, "0712000205", "no_admin");
    const bad = await req(api, "POST", `/api/v1/admin/users/${uid2}/role`, ADMIN, { role: "admin" });
    assert.equal(bad.status, 403, "a plain admin cannot mint an admin");
    assert.equal((await json(bad)).error.code, "NOT_AUTHORIZED");
  } finally { await api.close(); }
});
