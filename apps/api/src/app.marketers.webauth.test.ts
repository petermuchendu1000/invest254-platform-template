import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_B, type TestApi } from "./testutil.js";

/**
 * E2E for the app's website-credential login (POST /marketers/auth/login-web): a marketer signs in
 * with the SAME phone + password they use on the invest254 website, and the app fetches the correct
 * marketer name + number (no hardcoded identity). Covers the real-life scenarios end to end.
 */

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

/** Create the invest254 website account (phone + password) the marketer will log in with. */
async function registerWebsiteAccount(api: TestApi, phone: string, username: string, password: string): Promise<void> {
  const r = await req(api, "POST", "/api/v1/auth/register", { body: { phone, username, password } });
  assert.equal(r.status, 201, `register ${phone}`);
}

/** Admin provisions the marketer wallet (same phone links it to the website identity). */
async function createMarketer(api: TestApi, name: string, phone: string): Promise<string> {
  const r = await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name, phone } });
  assert.equal(r.status, 201, `create marketer ${phone}`);
  return (await json(r)).id as string;
}

const loginWeb = (api: TestApi, phone: string, password: string) =>
  req(api, "POST", "/api/v1/marketers/auth/login-web", { body: { phone, password } });

test("anyBrand login-web: an OLDER soft-DELETED same-phone account never shadows the active marketer (BUGLOG #31, jake)", async () => {
  // jake: his oldest same-phone account (@dave, invest254) was soft-DELETED; auth.login matched it
  // first (oldest) and rejected it as deleted, 401-ing his active safitraders marketer login. The
  // marketer apps have no other non-PIN path, so he was locked out. Login must SKIP deleted candidates.
  const api = await startTestApi();
  try {
    const PHONE = "0113488568", PW = "sharedpass1";
    // 1) OLDER account on brand B, same phone + password -> will be soft-deleted (jake's '@dave').
    const reg = await req(api, "POST", "/api/v1/auth/register", { body: { phone: PHONE, username: "dave", password: PW, site: "brandb" } });
    assert.equal(reg.status, 201, "older brand-B account registered");
    const deletedUserId = (await json(reg)).userId as string;
    // 2) NEWER account on the default brand + a marketer wallet (jake's active identity).
    await registerWebsiteAccount(api, PHONE, "jake", PW);
    const marketerId = await createMarketer(api, "Jake Ochieng", PHONE);
    // 3) Soft-delete the older brand-B account (status='deleted').
    // Issue 1 / F-43: the deleted account lives on brand B, so brand B's own admin deletes it (a brand-A
    // admin is refused — cross-brand writes are out of scope).
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${deletedUserId}/delete`, { token: ADMIN })).status, 403,
      "a brand-A site admin must not delete a brand-B account");
    const del = await req(api, "POST", `/api/v1/admin/users/${deletedUserId}/delete`, { token: `u-admin:admin:${SITE_B}` });
    assert.equal(del.status, 200, "older account soft-deleted");
    // 4) login-web must skip the deleted shadow and resolve the active marketer (was 401 before the fix).
    const res = await loginWeb(api, PHONE, PW);
    assert.equal(res.status, 200, "login-web resolves past the deleted shadow account");
    const body = await json(res);
    assert.equal(body.marketer.id, marketerId, "resolves the active marketer identity");
    assert.equal(body.marketer.name, "Jake Ochieng");
  } finally { await api.close(); }
});

test("a phone whose ONLY account is deleted still cannot sign in (deleted is a hard block)", async () => {
  const api = await startTestApi();
  try {
    const PHONE = "0799000123", PW = "onlydeleted1";
    const reg = await req(api, "POST", "/api/v1/auth/register", { body: { phone: PHONE, username: "gone", password: PW } });
    const uid = (await json(reg)).userId as string;
    await createMarketer(api, "Gone", PHONE);
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${uid}/delete`, { token: ADMIN })).status, 200);
    // Even with a marketer wallet, a deleted-only identity must NOT authenticate.
    assert.equal((await loginWeb(api, PHONE, PW)).status, 401, "deleted-only phone is rejected");
  } finally { await api.close(); }
});

test("happy path: website login fetches the correct marketer name + number", async () => {
  const api = await startTestApi();
  try {
    await registerWebsiteAccount(api, "0722000001", "peterm", "wallet2pass");
    const id = await createMarketer(api, "Peter Muchendu", "0722000001");

    const res = await loginWeb(api, "0722000001", "wallet2pass");
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(typeof body.token, "string");
    assert.ok(body.token.length > 0);
    // The whole point: real identity is returned, not the hardcoded demo values.
    assert.equal(body.marketer.id, id);
    assert.equal(body.marketer.name, "Peter Muchendu");
    assert.equal(body.marketer.phone, "0722000001");
    assert.equal(body.marketer.first_name, "Peter");
    assert.equal(body.marketer.initials, "PM");
  } finally { await api.close(); }
});

test("distinct marketers get their own identity from the same endpoint", async () => {
  const api = await startTestApi();
  try {
    await registerWebsiteAccount(api, "0722000001", "peterm", "wallet2pass");
    await registerWebsiteAccount(api, "0733000002", "janew", "wallet3pass");
    await createMarketer(api, "Peter Muchendu", "0722000001");
    await createMarketer(api, "Jane Wanjiru", "0733000002");

    const a = await json(await loginWeb(api, "0722000001", "wallet2pass"));
    const b = await json(await loginWeb(api, "0733000002", "wallet3pass"));
    assert.equal(a.marketer.name, "Peter Muchendu");
    assert.equal(a.marketer.phone, "0722000001");
    assert.equal(b.marketer.name, "Jane Wanjiru");
    assert.equal(b.marketer.phone, "0733000002");
    assert.equal(b.marketer.initials, "JW");
    assert.notEqual(a.marketer.id, b.marketer.id);
  } finally { await api.close(); }
});

test("wrong password is a generic 401", async () => {
  const api = await startTestApi();
  try {
    await registerWebsiteAccount(api, "0722000001", "peterm", "wallet2pass");
    await createMarketer(api, "Peter Muchendu", "0722000001");
    const res = await loginWeb(api, "0722000001", "wrongpass9");
    assert.equal(res.status, 401);
    assert.equal((await json(res)).error.code, "INVALID_CREDENTIALS");
  } finally { await api.close(); }
});

test("unknown phone (no website account) is a generic 401", async () => {
  const api = await startTestApi();
  try {
    await createMarketer(api, "Peter Muchendu", "0722000001"); // marketer exists but no website login
    const res = await loginWeb(api, "0722000001", "wallet2pass");
    assert.equal(res.status, 401);
    assert.equal((await json(res)).error.code, "INVALID_CREDENTIALS");
  } finally { await api.close(); }
});

test("valid website account that is NOT a marketer is rejected with 403 NOT_MARKETER", async () => {
  const api = await startTestApi();
  try {
    await registerWebsiteAccount(api, "0700000009", "playa", "player9pass");
    const res = await loginWeb(api, "0700000009", "player9pass");
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, "NOT_MARKETER");
  } finally { await api.close(); }
});

test("suspended/disabled marketer cannot log in (403 MARKETER_INACTIVE)", async () => {
  const api = await startTestApi();
  try {
    await registerWebsiteAccount(api, "0722000001", "peterm", "wallet2pass");
    const id = await createMarketer(api, "Peter Muchendu", "0722000001");
    // works while active
    assert.equal((await loginWeb(api, "0722000001", "wallet2pass")).status, 200);
    // admin disables -> login blocked immediately
    await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, { token: ADMIN, body: { status: "disabled" } });
    const res = await loginWeb(api, "0722000001", "wallet2pass");
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, "MARKETER_INACTIVE");
    // reactivating restores access
    await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, { token: ADMIN, body: { status: "active" } });
    assert.equal((await loginWeb(api, "0722000001", "wallet2pass")).status, 200);
  } finally { await api.close(); }
});

test("missing phone or password is a 400", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login-web", { body: { phone: "0722000001" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login-web", { body: { password: "wallet2pass" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login-web", { body: {} })).status, 400);
  } finally { await api.close(); }
});

test("login-web accepts the phone in any valid format (sig9 match, not exact string)", async () => {
  // Regression for the production bug where profileByPhone did a raw `phone = $1` exact match while
  // auth.login normalizes: typing +254…/254…/bare/spaced passed the password check but returned
  // 403 NOT_MARKETER (the marketer apps send the phone exactly as typed). See docs/BUGLOG.md.
  const api = await startTestApi();
  try {
    await registerWebsiteAccount(api, "0706597235", "gritel254", "gritelpass1");
    const id = await createMarketer(api, "gritel", "0706597235");

    for (const typed of ["0706597235", "+254706597235", "254706597235", "706597235", "0706 597 235", "+254 706 597 235"]) {
      const res = await loginWeb(api, typed, "gritelpass1");
      assert.equal(res.status, 200, `login with ${typed}`);
      const body = await json(res);
      assert.equal(body.marketer.id, id, `marketer identity for ${typed}`);
      assert.equal(body.marketer.name, "gritel");
    }
  } finally { await api.close(); }
});
