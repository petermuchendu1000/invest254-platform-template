import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A } from "./testutil.js";
import type { PlatformOnboardDeps } from "./app.platform.js";

/**
 * docs/42 UI-9 — the System owner's registrar tools were stuck on the default platform: onboarding
 * capabilities and the registrar domain import took no platform. The owner may now name one with
 * ?platform=<id>; a platform admin is always pinned to its own platform (any ?platform= is ignored).
 */
const DEFAULT_PLATFORM = "10000000-0000-0000-0000-000000000001";
const OTHER = "20000000-0000-0000-0000-000000000002";
const OWNER = "u-owner:platform_superadmin";
const PA = `u-pa:platform_admin:${SITE_A}:${DEFAULT_PLATFORM}`;

function recordingDeps(seen: Array<[string, string | null]>): PlatformOnboardDeps {
  return {
    domainConfigured: true, registrarConfigured: true,
    async capabilities(pid) { seen.push(["caps", pid]); return { domainConfigured: true, registrarConfigured: pid === OTHER }; },
    async onboard() { throw new Error("unused"); },
    async domainStatus(d) { return { domain: d, zoneStatus: "pending", pages: [], active: false }; },
    async listRegistrarDomains(pid) { seen.push(["domains", pid]); return { registrarConfigured: true, domains: [] }; },
    async domainHealth() { return { configured: true, statuses: {} }; },
  };
}
async function get(base: string, path: string, token: string) {
  const r = await fetch(`${base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

test("UI-9: the owner's onboarding capabilities and registrar import act for the platform it names", async () => {
  const seen: Array<[string, string | null]> = [];
  const api = await startTestApi({ depsOverrides: { platformOnboard: recordingDeps(seen) } });
  try {
    const caps = await get(api.baseUrl, `/platform/onboard/capabilities?platform=${OTHER}`, OWNER);
    assert.equal(caps.status, 200); assert.equal(caps.body.registrarConfigured, true, "that platform's registrar");
    assert.equal((await get(api.baseUrl, `/platform/domains/registrar?platform=${OTHER}`, OWNER)).status, 200);
    await get(api.baseUrl, "/platform/onboard/capabilities", OWNER);
    assert.deepEqual(seen, [["caps", OTHER], ["domains", OTHER], ["caps", null]], "named platform, else null (= default)");
    const bad = await get(api.baseUrl, "/platform/domains/registrar?platform=nope", OWNER);
    assert.equal(bad.status, 400);
  } finally { await api.close(); }
});

test("UI-9: a platform admin stays pinned to its own platform whatever ?platform= says", async () => {
  const seen: Array<[string, string | null]> = [];
  const api = await startTestApi({ depsOverrides: { platformOnboard: recordingDeps(seen) } });
  try {
    await get(api.baseUrl, `/platform/onboard/capabilities?platform=${OTHER}`, PA);
    await get(api.baseUrl, `/platform/domains/registrar?platform=${OTHER}`, PA);
    await get(api.baseUrl, "/platform/domains/registrar?platform=nope", PA);
    assert.deepEqual(seen, [["caps", DEFAULT_PLATFORM], ["domains", DEFAULT_PLATFORM], ["domains", DEFAULT_PLATFORM]]);
  } finally { await api.close(); }
});
