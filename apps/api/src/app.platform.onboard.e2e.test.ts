import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, type TestApi } from "./testutil.js";

/**
 * E2E for the instant client-onboarding endpoint (docs/21) via the real HTTP API + the in-memory
 * PlatformOnboardDeps. Asserts platform-superadmin gating, brand+economy creation, optional domain
 * provisioning, input validation, and the domain-status poll.
 */

const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const SUPER = `${TEST_ADMIN}:platform_superadmin`;

test("onboard: only platform_superadmin may call it", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "POST", "/api/v1/platform/onboard", { body: { slug: "x", name: "X" } })).status, 401);
    assert.equal((await req(api, "POST", "/api/v1/platform/onboard", { token: TEST_USER, body: { slug: "x", name: "X" } })).status, 403);
    assert.equal((await req(api, "POST", "/api/v1/platform/onboard", { token: `${TEST_ADMIN}:admin`, body: { slug: "x", name: "X" } })).status, 403);
  } finally { await api.close(); }
});

test("onboard: creates brand + economy and provisions the domain when requested", async () => {
  const api = await startTestApi();
  try {
    const r = await req(api, "POST", "/api/v1/platform/onboard", {
      token: SUPER,
      body: { slug: "tamutraders", name: "Tamu Traders", primaryDomain: "TamuTraders.com", currency: "KES", colors: { primary: "#eab308" }, provisionDomain: true },
    });
    assert.equal(r.status, 201);
    const b = await json(r);
    assert.equal(b.brand.slug, "tamutraders");
    assert.equal(b.brand.primaryDomain, "tamutraders.com"); // normalized
    assert.equal(b.brand.resolvesByHost, true);
    assert.ok(b.domain, "domain provisioned");
    assert.deepEqual(b.domain.nameServers, ["a.ns.cloudflare.com", "b.ns.cloudflare.com"]);
    assert.equal(b.domain.pages.length, 2);
    // input recorded
    assert.equal(api.onboard.calls.at(-1)!.slug, "tamutraders");
    assert.equal(api.onboard.calls.at(-1)!.provisionDomain, true);
  } finally { await api.close(); }
});

test("onboard: no domain provisioning when provisionDomain is falsey", async () => {
  const api = await startTestApi();
  try {
    const b = await json(await req(api, "POST", "/api/v1/platform/onboard", {
      token: SUPER, body: { slug: "brandx", name: "Brand X", primaryDomain: "brandx.com" },
    }));
    assert.equal(b.domain, null);
    assert.equal(b.brand.resolvesByHost, true);
  } finally { await api.close(); }
});

test("onboard: validates slug and name", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "POST", "/api/v1/platform/onboard", { token: SUPER, body: { slug: "Bad Slug!", name: "X" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/platform/onboard", { token: SUPER, body: { slug: "ok", name: "  " } })).status, 400);
  } finally { await api.close(); }
});

test("onboard: domain-status poll requires a domain and returns status", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "GET", "/api/v1/platform/onboard/domain-status", { token: SUPER })).status, 400);
    const s = await json(await req(api, "GET", "/api/v1/platform/onboard/domain-status?domain=tamutraders.com", { token: SUPER }));
    assert.equal(s.domain, "tamutraders.com");
    assert.equal(s.active, false);
    assert.ok(Array.isArray(s.pages));
  } finally { await api.close(); }
});

test("onboard: 503 when onboarding is not configured on the deployment", async () => {
  const api = await startTestApi({ depsOverrides: { platformOnboard: undefined } as unknown as Record<string, never> });
  try {
    assert.equal((await req(api, "POST", "/api/v1/platform/onboard", { token: SUPER, body: { slug: "x", name: "X" } })).status, 503);
  } finally { await api.close(); }
});
