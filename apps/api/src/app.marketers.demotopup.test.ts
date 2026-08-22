import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

/**
 * Marketer SELF-SERVICE demo top-up (#2 autonomy). A marketer tops their OWN simulated (funny-money)
 * wallet up to the policy cap with NO admin — the RPC is capped + idempotent + touches no real cash.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const ADMIN = "u-admin:admin";
const PLAYER = "u-player:player";
const mtok = (id: string) => `${id}:marketer`;
const CAP = 10_000_000; // default MARKETER_DEMO_TOPUP_CAP_CENTS (KES 100,000)

async function newMarketer(api: TestApi, phone: string): Promise<string> {
  return (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name: "Demo Rep", phone } }))).id as string;
}

test("marketer self-tops-up demo wallet to the cap, with no admin", async () => {
  const api = await startTestApi();
  try {
    const id = await newMarketer(api, "0722100001");
    const r = await json(await req(api, "POST", "/api/v1/marketers/me/demo-topup", { token: mtok(id) }));
    assert.equal(r.balanceCents, CAP, "topped up to the policy cap");
    assert.equal(r.capCents, CAP);
    const me = await json(await req(api, "GET", "/api/v1/marketers/me", { token: mtok(id) }));
    assert.equal(me.balance_cents, CAP, "profile reflects the demo balance");
  } finally { await api.close(); }
});

test("top-up is idempotent — repeated presses never exceed the cap", async () => {
  const api = await startTestApi();
  try {
    const id = await newMarketer(api, "0722100002");
    const a = await json(await req(api, "POST", "/api/v1/marketers/me/demo-topup", { token: mtok(id) }));
    const b = await json(await req(api, "POST", "/api/v1/marketers/me/demo-topup", { token: mtok(id) }));
    assert.equal(a.balanceCents, CAP);
    assert.equal(b.balanceCents, CAP, "still exactly the cap after a second press");
  } finally { await api.close(); }
});

test("partial: tops UP from an existing balance to exactly the cap (never reduces)", async () => {
  const api = await startTestApi();
  try {
    const id = await newMarketer(api, "0722100003");
    await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN, body: { amountCents: 3_000_000, ref: "seed" } });
    const r = await json(await req(api, "POST", "/api/v1/marketers/me/demo-topup", { token: mtok(id) }));
    assert.equal(r.balanceCents, CAP, "3,000,000 -> topped up to the 10,000,000 cap");
  } finally { await api.close(); }
});

test("authorization: no token 401, player token 403", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "POST", "/api/v1/marketers/me/demo-topup")).status, 401);
    assert.equal((await req(api, "POST", "/api/v1/marketers/me/demo-topup", { token: PLAYER })).status, 403);
  } finally { await api.close(); }
});
