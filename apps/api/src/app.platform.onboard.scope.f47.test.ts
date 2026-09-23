import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, type TestApi } from "./testutil.js";
import type { PlatformOnboardDeps } from "./app.platform.js";

/**
 * Issue 1 / F-47 (BUGLOG #47) — the onboarding/domain routes hand the CALLER'S platform scope to the
 * deps (which enforce it via onboardscope.ts: SLUG_TAKEN / DOMAIN_TAKEN / DOMAIN_NOT_FOUND / filtered
 * health), and the new error codes map to proper HTTP statuses. A spy records every scope argument.
 * Before the fix the routes passed no scope at all, so the deps could not refuse another tenant's slug
 * or hide another tenant's domains.
 */
const PA1 = `${TEST_ADMIN}:platform_admin:${SITE_A}:plat-1`;
const OWNER = `${TEST_ADMIN}:platform_superadmin`;
const CLAIMLESS_PA = `${TEST_ADMIN}:platform_admin:${SITE_A}`;

type Seen = { fn: string; scope: string | null | undefined; platformId?: string | null };
function spyDeps(seen: Seen[], fail?: string): PlatformOnboardDeps {
  return {
    domainConfigured: true, registrarConfigured: true,
    async capabilities() { return { domainConfigured: true, registrarConfigured: true }; },
    async onboard(input, platformId, callerScope) {
      seen.push({ fn: "onboard", scope: callerScope, platformId });
      if (fail) throw new Error(`${fail}: refused`);
      return { siteId: "s1", brand: { siteId: "s1", slug: input.slug, name: input.name, primaryDomain: null, currency: "KES", status: "active", resolvesByHost: false }, domain: null };
    },
    async domainStatus(d, callerScope) {
      seen.push({ fn: "domainStatus", scope: callerScope });
      if (fail) throw new Error(`${fail}: refused`);
      return { domain: d, zoneStatus: "active", pages: [], active: true };
    },
    async listRegistrarDomains() { return { registrarConfigured: true, domains: [] }; },
    async domainHealth(callerScope) {
      seen.push({ fn: "domainHealth", scope: callerScope });
      return { configured: true, statuses: {} };
    },
  };
}
const call = (api: TestApi, method: string, path: string, token: string, body?: unknown) =>
  fetch(`${api.baseUrl}/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

test("F-47: a platform admin's routes carry ITS platform as the scope; the owner's carry null (unrestricted)", async () => {
  const seen: Seen[] = [];
  const api = await startTestApi({ depsOverrides: { platformOnboard: spyDeps(seen) } });
  try {
    for (const [tok, want] of [[PA1, "plat-1"], [OWNER, null]] as const) {
      seen.length = 0;
      const o = await call(api, "POST", "/platform/onboard", tok, { slug: "brandz", name: "Brand Z" });
      const s = await call(api, "GET", "/platform/onboard/domain-status?domain=x.com", tok);
      const h = await call(api, "GET", "/platform/domains/health", tok);
      assert.equal(o.status, 201, `${tok} onboard`);
      assert.deepEqual(seen.map((x) => [x.fn, x.scope]), [["onboard", want], ["domainStatus", want], ["domainHealth", want]]);
      // a platform admin's new brand is stamped into its own platform (unchanged behaviour)
      if (tok === PA1) assert.equal(seen[0]!.platformId, "plat-1");
      assert.equal(s.status, 200); assert.equal(h.status, 200);
    }
  } finally { await api.close(); }
});

test("F-47: a claimless platform admin is refused before any domain data is touched (fail closed)", async () => {
  const seen: Seen[] = [];
  const api = await startTestApi({ depsOverrides: { platformOnboard: spyDeps(seen) } });
  try {
    assert.equal((await call(api, "GET", "/platform/domains/health", CLAIMLESS_PA)).status, 403);
    assert.equal((await call(api, "GET", "/platform/onboard/domain-status?domain=x.com", CLAIMLESS_PA)).status, 403);
    assert.deepEqual(seen, [], "deps never reached");
  } finally { await api.close(); }
});

test("F-47: refusal codes map to HTTP statuses (DOMAIN_NOT_FOUND 404, DOMAIN_TAKEN 409, SLUG_TAKEN 409)", async () => {
  for (const [code, onboardStatus, statusStatus] of [["DOMAIN_NOT_FOUND", 404, 404], ["DOMAIN_TAKEN", 409, 409], ["SLUG_TAKEN", 409, 409]] as const) {
    const api = await startTestApi({ depsOverrides: { platformOnboard: spyDeps([], code) } });
    try {
      const o = await call(api, "POST", "/platform/onboard", OWNER, { slug: "brandz", name: "Brand Z" });
      assert.equal(o.status, onboardStatus, `${code} onboard`);
      assert.equal(((await o.json()) as { error?: { code?: string } }).error?.code ?? code, code);
      assert.equal((await call(api, "GET", "/platform/onboard/domain-status?domain=x.com", OWNER)).status, statusStatus, `${code} status`);
    } finally { await api.close(); }
  }
});
