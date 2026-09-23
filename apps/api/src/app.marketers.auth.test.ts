import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

const ADMIN = "u-admin:admin:00000000-0000-0000-0000-000000000001";
const PLAYER = "u-player:player";

/** Admin creates a marketer + sets a PIN; returns its id. */
async function onboard(api: TestApi, name: string, phone: string, pin = "1234"): Promise<string> {
  const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name, phone } }))).id as string;
  const p = await req(api, "POST", `/api/v1/admin/marketers/${id}/pin`, { token: ADMIN, body: { pin } });
  assert.equal(p.status, 200, "set pin");
  return id;
}
/** A stub marketer bearer token (harness verifier accepts "<id>:<role>"). */
const mtok = (id: string) => `${id}:marketer`;

test("marketer authenticates with phone + PIN, then reads own profile", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Peter Muchendu", "0722000001", "1234");

    const login = await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0722000001", pin: "1234" } });
    assert.equal(login.status, 200);
    const body = await json(login);
    assert.equal(typeof body.token, "string");
    assert.equal(body.marketer.id, id);
    assert.equal(body.marketer.first_name, "Peter");
    assert.equal(body.marketer.initials, "PM");

    const me = await json(await req(api, "GET", "/api/v1/marketers/me", { token: mtok(id) }));
    assert.equal(me.id, id);
    assert.equal(me.first_name, "Peter");
  } finally { await api.close(); }
});

test("wrong PIN and unknown phone both return a generic 401", async () => {
  const api = await startTestApi();
  try {
    await onboard(api, "Peter", "0722000001", "1234");
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0722000001", pin: "9999" } })).status, 401);
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0700000000", pin: "1234" } })).status, 401);
  } finally { await api.close(); }
});

test("a player installing the app cannot access marketer routes", async () => {
  const api = await startTestApi();
  try {
    // No token -> 401
    assert.equal((await req(api, "GET", "/api/v1/marketers/me")).status, 401);
    // A real player token (valid auth, but not a marketer) -> 403 NOT_MARKETER
    const res = await req(api, "GET", "/api/v1/marketers/me", { token: PLAYER });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, "NOT_MARKETER");
    // And they cannot log in via the marketer flow (no marketer account)
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0733000000", pin: "1234" } })).status, 401);
  } finally { await api.close(); }
});

test("demotion/suspension takes effect immediately: login blocked + /me 403", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Jane Doe", "0722000002", "4321");
    // works before demotion
    assert.equal((await req(api, "GET", "/api/v1/marketers/me", { token: mtok(id) })).status, 200);

    // admin demotes (disables) the marketer
    const dis = await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, { token: ADMIN, body: { status: "disabled" } });
    assert.equal((await json(dis)).status, "disabled");

    // existing token is now rejected at /me (live status check) ...
    const me = await req(api, "GET", "/api/v1/marketers/me", { token: mtok(id) });
    assert.equal(me.status, 403);
    assert.equal((await json(me)).error.code, "MARKETER_INACTIVE");
    // ... and they can no longer log in
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0722000002", pin: "4321" } })).status, 401);

    // reactivating restores access (data + PIN preserved)
    await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, { token: ADMIN, body: { status: "active" } });
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0722000002", pin: "4321" } })).status, 200);
  } finally { await api.close(); }
});

test("marketer changes own PIN; old PIN stops working", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Sam K", "0722000003", "1111");
    // wrong current -> 401
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/pin", { token: mtok(id), body: { currentPin: "0000", newPin: "2222" } })).status, 401);
    // correct change -> ok
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/pin", { token: mtok(id), body: { currentPin: "1111", newPin: "2222" } })).status, 200);
    // new works, old fails
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0722000003", pin: "2222" } })).status, 200);
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0722000003", pin: "1111" } })).status, 401);
  } finally { await api.close(); }
});

test("admin lifecycle endpoints are gated + validated", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Gated", "0722000004");
    // players cannot set pin or status
    assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${id}/pin`, { token: PLAYER, body: { pin: "1234" } })).status, 403);
    assert.equal((await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, { token: PLAYER, body: { status: "disabled" } })).status, 403);
    // invalid pin / status rejected
    assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${id}/pin`, { token: ADMIN, body: { pin: "12" } })).status, 400);
    assert.equal((await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, { token: ADMIN, body: { status: "nope" } })).status, 400);
  } finally { await api.close(); }
});
