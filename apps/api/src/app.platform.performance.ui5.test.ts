import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A, type TestApi } from "./testutil.js";

/**
 * docs/42 UI-5 — a platform admin's Overview used to call an OWNER-only performance endpoint and render
 * zeros. Performance is now open to platform admins, scoped to THEIR platform's brands; the owner still
 * sees every brand; a claimless platform admin fails closed; a site admin never reaches the console.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}/api/v1${path}`, init);
}
const OWNER = "own:platform_superadmin";
const DEFAULT_PLATFORM = "10000000-0000-0000-0000-000000000001";

test("UI-5: /platform/performance — owner: every brand; platform admin: only its platform's brands", async () => {
  const api = await startTestApi();
  try {
    const beta = (await json(await req(api, "POST", "/platform/platforms", OWNER, { slug: "beta", name: "Beta" }))).platformId as string;
    const created = await req(api, "POST", "/platform/sites", OWNER, { slug: "betabrand", name: "Beta Brand", currency: "KES" });
    assert.equal(created.status, 201, "second brand created");
    const SITE_B = (await json(created)).siteId as string;
    assert.equal((await req(api, "POST", `/platform/sites/${SITE_B}/assign`, OWNER, { platformId: beta })).status, 200, "brand moved to platform beta");

    const all = await json(await req(api, "GET", "/platform/performance", OWNER));
    const allIds = all.sites.map((s: any) => s.siteId);
    assert.ok(allIds.includes(SITE_A) && allIds.includes(SITE_B), "owner sees every brand");

    const paDefault = await req(api, "GET", "/platform/performance", `pa1:platform_admin:${SITE_A}:${DEFAULT_PLATFORM}`);
    assert.equal(paDefault.status, 200, "platform admins may read performance now");
    const ids = (await json(paDefault)).sites.map((s: any) => s.siteId);
    assert.ok(ids.includes(SITE_A) && !ids.includes(SITE_B), `default-platform admin sees only its brands: ${ids}`);

    const paBeta = (await json(await req(api, "GET", "/platform/performance", `pa2:platform_admin:${SITE_B}:${beta}`))).sites.map((s: any) => s.siteId);
    assert.deepEqual(paBeta, [SITE_B], "beta admin sees only brand B");

    assert.equal((await req(api, "GET", "/platform/performance", `pa3:platform_admin:${SITE_A}`)).status, 403, "claimless platform admin fails closed");
    assert.equal((await req(api, "GET", "/platform/performance", `adm:admin:${SITE_A}`)).status, 403, "site admin never reaches the console");
  } finally { await api.close(); }
});
