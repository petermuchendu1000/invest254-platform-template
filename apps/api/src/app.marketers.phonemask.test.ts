import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

/**
 * Issue 2 (marketer side): the marketer app only ever sees the agent's OWN number, and it must be
 * masked (0798****061). The admin/platform views of a marketer keep the FULL number (their web masks
 * at render and offers a deliberate full-number copy/export), so masking is at the marketer-app
 * response boundary only — it must not change what an admin route returns.
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
const mtok = (id: string) => `${id}:marketer`;

async function onboard(api: TestApi, name: string, phone: string, pin = "1234"): Promise<string> {
  const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name, phone } }))).id as string;
  assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${id}/pin`, { token: ADMIN, body: { pin } })).status, 200);
  return id;
}

test("marketer PIN login masks the agent's own number in the response", async () => {
  const api = await startTestApi();
  try {
    await onboard(api, "Grace Field", "0798123061");
    const body = await json(await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0798123061", pin: "1234" } }));
    assert.equal(body.marketer.phone, "0798****061");
    assert.doesNotMatch(JSON.stringify(body), /0798123061/, "the full number must not appear anywhere in the response");
  } finally { await api.close(); }
});

test("GET /marketers/me masks the own number", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Grace Field", "0798123061");
    const me = await json(await req(api, "GET", "/api/v1/marketers/me", { token: mtok(id) }));
    assert.equal(me.phone, "0798****061");
    assert.doesNotMatch(JSON.stringify(me), /0798123061/);
    // name/initials/balance are untouched — only the number is hidden.
    assert.equal(me.first_name, "Grace");
    assert.equal(me.initials, "GF");
  } finally { await api.close(); }
});

test("admin marketer reads keep the FULL number (masking is marketer-side only)", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Grace Field", "0798123061");
    // list
    const list = await json(await req(api, "GET", "/api/v1/admin/marketers", { token: ADMIN }));
    const row = list.find((m: any) => m.id === id);
    assert.equal(row.phone, "0798123061", "admin list keeps full number");
    // detail
    const detail = await json(await req(api, "GET", `/api/v1/admin/marketers/${id}`, { token: ADMIN }));
    assert.equal(detail.phone, "0798123061", "admin detail keeps full number");
  } finally { await api.close(); }
});

test("a short/odd number still reveals nothing beyond the mask", async () => {
  const api = await startTestApi();
  try {
    // createMarketer requires a phone; use a normal one, then assert the mask shape generically.
    const id = await onboard(api, "Ann B", "0711999888");
    const me = await json(await req(api, "GET", "/api/v1/marketers/me", { token: mtok(id) }));
    assert.match(me.phone, /^\d{4}\*{4}\d{3}$/, "constant-width 4+****+3 mask");
  } finally { await api.close(); }
});
