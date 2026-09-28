import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

/**
 * #10 geo-currency — the API surface for a per-user display currency and the geo/preference override
 * on the public brand route. Presentation only: nothing here moves money (always KES cents).
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;
interface ReqOpts { token?: string; body?: unknown }
function req(api: TestApi, method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

test("GET /site/brand: an unsupported/unknown geo or preference leaves the brand currency untouched (KES)", async () => {
  const api = await startTestApi();
  try {
    // Unknown country + unsupported preference → brand default stands, no override applied.
    const b1 = await json(await req(api, "GET", "/api/v1/site/brand?host=invest254.com&country=XX&currency=JPY"));
    assert.equal(b1.currency, "KES");
    // A KES preference on a KES brand is a no-op.
    const b2 = await json(await req(api, "GET", "/api/v1/site/brand?host=invest254.com&currency=KES"));
    assert.equal(b2.currency, "KES");
  } finally { await api.close(); }
});

test("GET /site/brand: a supported preference overrides the display currency with a live rate", async () => {
  const api = await startTestApi();
  try {
    const b = await json(await req(api, "GET", "/api/v1/site/brand?host=invest254.com&currency=USD"));
    assert.equal(b.currency, "USD");
    // The override MUST carry a usable KES→USD rate, else the web silently renders KES.
    assert.equal(typeof b.fxRateFromKes, "number");
    assert.ok(b.fxRateFromKes > 0 && Number.isFinite(b.fxRateFromKes), `expected a positive rate, got ${b.fxRateFromKes}`);
  } finally { await api.close(); }
});

test("GET /site/brand: geo country resolves a display currency when no preference is given", async () => {
  const api = await startTestApi();
  try {
    // A visitor in Great Britain, no explicit preference → GBP display on the KES brand.
    const b = await json(await req(api, "GET", "/api/v1/site/brand?host=invest254.com&country=GB"));
    assert.equal(b.currency, "GBP");
    assert.ok(b.fxRateFromKes > 0);
    // An explicit preference beats geo.
    const b2 = await json(await req(api, "GET", "/api/v1/site/brand?host=invest254.com&country=GB&currency=USD"));
    assert.equal(b2.currency, "USD");
  } finally { await api.close(); }
});
