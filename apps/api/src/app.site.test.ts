import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi, SITE_A, SITE_B } from "./testutil.js";

/**
 * Task E — API site scoping + public brand route (docs/22).
 *   - GET /site/brand?host=  resolves a host/slug to the brand DTO the web layout renders.
 *   - GET /site/me           proves requireSite derives ctx.siteId from the JWT `site` claim.
 *   - register/login are brand-scoped (carry the site; isolated across brands).
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

test("GET /site/brand: resolves the default brand by host", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "GET", "/api/v1/site/brand?host=invest254.com");
    assert.equal(res.status, 200);
    const b = await json(res);
    assert.equal(b.siteId, SITE_A);
    assert.equal(b.slug, "invest254");
    assert.equal(b.name, "Invest254");
    assert.equal(b.theme, "dark");
    assert.equal(b.colorPrimary, "#22c55e");
    assert.equal(b.currency, "KES");
  } finally { await api.close(); }
});

test("GET /site/brand: resolves a second brand, and by slug (case-insensitive)", async () => {
  const api = await startTestApi();
  try {
    const byHost = await json(await req(api, "GET", "/api/v1/site/brand?host=brandb.example"));
    assert.equal(byHost.siteId, SITE_B);
    assert.equal(byHost.slug, "brandb");
    assert.equal(byHost.theme, "light");
    assert.equal(byHost.supportEmail, "support@brandb.example");
    // slug + different casing must resolve to the same brand
    const bySlug = await json(await req(api, "GET", "/api/v1/site/brand?host=BRANDB"));
    assert.equal(bySlug.siteId, SITE_B);
  } finally { await api.close(); }
});

test("GET /site/brand: missing host -> 400; unknown host -> 404", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "GET", "/api/v1/site/brand")).status, 400);
    assert.equal((await req(api, "GET", "/api/v1/site/brand?host=nope.example")).status, 404);
  } finally { await api.close(); }
});

test("GET /site/me: requireSite derives ctx.siteId from the token's site claim (default when absent)", async () => {
  const api = await startTestApi();
  try {
    // token "<user>:<role>:<site>" carries a site claim
    const scoped = await req(api, "GET", "/api/v1/site/me", { token: `u1:player:${SITE_B}` });
    assert.equal(scoped.status, 200);
    assert.equal((await json(scoped)).siteId, SITE_B);
    // legacy token with no site claim -> default site
    const legacy = await req(api, "GET", "/api/v1/site/me", { token: "u1:player" });
    assert.equal((await json(legacy)).siteId, SITE_A);
    // unauthenticated -> 401
    assert.equal((await req(api, "GET", "/api/v1/site/me")).status, 401);
  } finally { await api.close(); }
});

test("GET /site/me: a request naming a different brand than its token is rejected", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "GET", `/api/v1/site/me?site=${SITE_A}`, { token: `u1:player:${SITE_B}` });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, "AUTH_SITE_MISMATCH");
  } finally { await api.close(); }
});

test("register/login are brand-scoped: token carries the site and login is isolated per brand", async () => {
  const api = await startTestApi();
  try {
    // Register on Brand B (frontend passes its host).
    const reg = await req(api, "POST", "/api/v1/auth/register", {
      body: { phone: "0712345678", username: "bee", password: "Password1", host: "brandb.example" },
    });
    assert.equal(reg.status, 201);
    const rb = await json(reg);
    assert.equal(rb.site, SITE_B, "the issued session must carry the brand's site");
    assert.ok(rb.token);

    // Login under the SAME brand succeeds and carries the site.
    const ok = await req(api, "POST", "/api/v1/auth/login", {
      body: { phone: "0712345678", password: "Password1", host: "brandb.example" },
    });
    assert.equal(ok.status, 200);
    assert.equal((await json(ok)).site, SITE_B);

    // The same phone under the DEFAULT brand must NOT authenticate (per-brand identity isolation).
    const wrongBrand = await req(api, "POST", "/api/v1/auth/login", {
      body: { phone: "0712345678", password: "Password1" },
    });
    assert.notEqual(wrongBrand.status, 200, "an account registered on Brand B must not log in on the default brand");
  } finally { await api.close(); }
});
