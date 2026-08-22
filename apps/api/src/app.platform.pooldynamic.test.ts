import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, type TestApi } from "./testutil.js";

/**
 * Dynamic (demand-based) pool distribution API (docs/25 §15). The in-memory platform service has no
 * turnover history, so demand forecasts are 0 ⇒ nothing is suggested and the whole total is reserved —
 * which exercises the plumbing, the auth gate, and the "no demand ⇒ no allocation" safety property.
 * (The allocation MATH is exhaustively covered in packages/shared/src/pooldistribution.test.ts.)
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const PLATFORM = `${TEST_ADMIN}:platform_superadmin`;
const ADMIN = `${TEST_ADMIN}:admin`;

test("pool demand preview: returns per-brand rows; zero demand ⇒ nothing suggested, all reserved", async () => {
  const api = await startTestApi();
  try {
    const p = (await json(await req(api, "GET", "/api/v1/platform/pool/demand?totalCents=1000000", { token: PLATFORM }))).preview;
    assert.ok(Array.isArray(p.rows), "rows array present");
    assert.equal(p.totalCents, 1_000_000);
    assert.equal(p.suggestedTotalCents, 0, "no turnover history ⇒ demand 0 ⇒ nothing allocated");
    assert.equal(p.reserveCents, 1_000_000, "entire total stays reserved when there is no demand");
    for (const r of p.rows) assert.equal(r.suggestedCents, 0);
  } finally { await api.close(); }
});

test("pool distribute-dynamic: applies via the per-site distributor and echoes the preview", async () => {
  const api = await startTestApi();
  try {
    const res = (await json(await req(api, "POST", "/api/v1/platform/pool/distribute-dynamic", { token: PLATFORM, body: { totalCents: 500_000 } }))).result;
    assert.ok(res.preview, "preview echoed back");
    assert.equal(res.mode, "per_site", "applied through the audited per-site distributor");
    for (const v of Object.values(res.perSite as Record<string, number>)) assert.equal(v, 0, "zero demand ⇒ each brand set to 0");
  } finally { await api.close(); }
});

test("pool dynamic: authorization — admin 403, unauth 401", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "GET", "/api/v1/platform/pool/demand", { token: ADMIN })).status, 403);
    assert.equal((await req(api, "POST", "/api/v1/platform/pool/distribute-dynamic", { token: ADMIN, body: { totalCents: 1 } })).status, 403);
    assert.equal((await req(api, "GET", "/api/v1/platform/pool/demand")).status, 401);
  } finally { await api.close(); }
});

test("pool distribute-dynamic: negative totalCents ⇒ 400", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "POST", "/api/v1/platform/pool/distribute-dynamic", { token: PLATFORM, body: { totalCents: -1 } })).status, 400);
  } finally { await api.close(); }
});
