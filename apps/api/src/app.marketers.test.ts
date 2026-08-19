import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

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

const ADMIN = "u-admin:admin";     // stub verifier: "<userId>:<role>"
const PLAYER = "u-player:player";

test("admin routes are gated (401 no token, 403 for players)", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "GET", "/api/v1/admin/marketers")).status, 401);
    assert.equal((await req(api, "GET", "/api/v1/admin/marketers", { token: PLAYER })).status, 403);
    assert.equal((await req(api, "POST", "/api/v1/admin/marketers", { token: PLAYER, body: { name: "X", phone: "0700000000" } })).status, 403);
  } finally { await api.close(); }
});

test("create -> credit -> withdraw updates balance; initials/first name derived", async () => {
  const api = await startTestApi();
  try {
    // create
    const created = await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name: "Peter Muchendu", phone: "0722000001" } });
    assert.equal(created.status, 201);
    const m = await json(created);
    const id = m.id as string;
    assert.equal(m.name, "Peter Muchendu");

    // profile shows derived first name + initials, wallet at 0
    const prof0 = await json(await req(api, "GET", `/api/v1/admin/marketers/${id}`, { token: ADMIN }));
    assert.equal(prof0.first_name, "Peter");
    assert.equal(prof0.initials, "PM");
    assert.equal(prof0.balance_cents, 0);

    // credit (pay the marketer)
    const credited = await json(await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN, body: { amountCents: 500000, ref: "c1" } }));
    assert.equal(credited.balanceCents, 500000);

    // withdraw -> balance updates
    const w = await json(await req(api, "POST", `/api/v1/admin/marketers/${id}/withdraw`, { token: ADMIN, body: { amountCents: 200000, ref: "w1" } }));
    assert.equal(w.idempotent, false);
    assert.equal(w.balance_cents, 300000);

    const prof1 = await json(await req(api, "GET", `/api/v1/admin/marketers/${id}`, { token: ADMIN }));
    assert.equal(prof1.balance_cents, 300000);
  } finally { await api.close(); }
});

test("idempotent withdrawal replay does not double-deduct", async () => {
  const api = await startTestApi();
  try {
    const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name: "Jane Doe", phone: "0722000002" } }))).id;
    await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN, body: { amountCents: 100000, ref: "c" } });
    const first = await json(await req(api, "POST", `/api/v1/admin/marketers/${id}/withdraw`, { token: ADMIN, body: { amountCents: 40000, ref: "dup" } }));
    const replay = await json(await req(api, "POST", `/api/v1/admin/marketers/${id}/withdraw`, { token: ADMIN, body: { amountCents: 40000, ref: "dup" } }));
    assert.equal(first.balance_cents, 60000);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.balance_cents, 60000); // unchanged
  } finally { await api.close(); }
});

test("overdraw is rejected with 409; zero/negative amount is 400", async () => {
  const api = await startTestApi();
  try {
    const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name: "Sam", phone: "0722000003" } }))).id;
    await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN, body: { amountCents: 5000 } });
    const over = await req(api, "POST", `/api/v1/admin/marketers/${id}/withdraw`, { token: ADMIN, body: { amountCents: 999999 } });
    assert.equal(over.status, 409);
    const bad = await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN, body: { amountCents: 0 } });
    assert.equal(bad.status, 400);
  } finally { await api.close(); }
});

test("admin sets Available Fuliza and airtime; reflected in profile", async () => {
  const api = await startTestApi();
  try {
    const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name: "Peter Muchendu", phone: "0722000004" } }))).id;
    const f = await json(await req(api, "PATCH", `/api/v1/admin/marketers/${id}/fuliza`, { token: ADMIN, body: { amountCents: 30000 } }));
    assert.equal(f.availableFulizaCents, 30000);
    const a = await json(await req(api, "PATCH", `/api/v1/admin/marketers/${id}/airtime`, { token: ADMIN, body: { amountCents: 2000 } }));
    assert.equal(a.airtimeBalanceCents, 2000);
    const prof = await json(await req(api, "GET", `/api/v1/admin/marketers/${id}`, { token: ADMIN }));
    assert.equal(prof.available_fuliza_cents, 30000);
    assert.equal(prof.airtime_balance_cents, 2000);
    // negative rejected
    assert.equal((await req(api, "PATCH", `/api/v1/admin/marketers/${id}/fuliza`, { token: ADMIN, body: { amountCents: -1 } })).status, 400);
  } finally { await api.close(); }
});

test("statement lists ledger newest-first", async () => {
  const api = await startTestApi();
  try {
    const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name: "Ledger Guy", phone: "0722000005" } }))).id;
    await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN, body: { amountCents: 500000, ref: "c1" } });
    await req(api, "POST", `/api/v1/admin/marketers/${id}/withdraw`, { token: ADMIN, body: { amountCents: 200000, ref: "w1" } });
    const rows = await json(await req(api, "GET", `/api/v1/admin/marketers/${id}/statement`, { token: ADMIN }));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].entry_type, "withdrawal");
    assert.equal(rows[0].balance_after_cents, 300000);
    assert.equal(rows[1].entry_type, "credit");
  } finally { await api.close(); }
});

test("admin edits a marketer's name + phone; duplicate phone rejected; players gated", async () => {
  const api = await startTestApi();
  try {
    const a = await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name: "Alpha", phone: "0722000010" } }));
    await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name: "Beta", phone: "0722000011" } }));

    // edit name + phone
    const upd = await req(api, "PATCH", `/api/v1/admin/marketers/${a.id}`, { token: ADMIN, body: { name: "Alpha Renamed", phone: "0722000099" } });
    assert.equal(upd.status, 200);
    const um = await json(upd);
    assert.equal(um.name, "Alpha Renamed");
    assert.equal(um.phone, "0722000099");

    // duplicate phone (a -> b's phone) rejected
    const dup = await req(api, "PATCH", `/api/v1/admin/marketers/${a.id}`, { token: ADMIN, body: { phone: "0722000011" } });
    assert.equal(dup.status, 409);
    assert.equal((await json(dup)).error.code, "PHONE_TAKEN");

    // players cannot edit marketers
    assert.equal((await req(api, "PATCH", `/api/v1/admin/marketers/${a.id}`, { token: PLAYER, body: { name: "x" } })).status, 403);
  } finally { await api.close(); }
});
