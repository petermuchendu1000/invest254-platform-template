import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPlatformRepository, PlatformService, type PoolDemandOpts } from "@invest254/engine";
import { startTestApi, SITE_A } from "./testutil.js";

/**
 * docs/42 UI-9 — /platform/pool is the platform-scoped pool console. For the System owner it used to act
 * on EVERY brand of EVERY platform while saying "your brands". The owner now names a platform with
 * ?platform=<id> (the page asks); without one the owner keeps the global distributor (Global config).
 * A platform admin is always pinned to its own platform.
 */
const DEFAULT_PLATFORM = "10000000-0000-0000-0000-000000000001";
const OTHER = "20000000-0000-0000-0000-000000000002";
const OWNER = "u-owner:platform_superadmin";
const PA = `u-pa:platform_admin:${SITE_A}:${DEFAULT_PLATFORM}`;

class RecordingRepo extends InMemoryPlatformRepository {
  seen: Array<[string, string | null]> = [];
  override async distributePool(a: string, r: string, t: number | null, m: string, o?: Record<string, number> | null, pid?: string | null) {
    this.seen.push(["distribute", pid ?? null]); return super.distributePool(a, r, t, m, o, pid);
  }
  override async listPoolDistributions(limit?: number, pid?: string | null) { this.seen.push(["history", pid ?? null]); return super.listPoolDistributions(limit, pid); }
  override async poolDemand(o: PoolDemandOpts, pid?: string | null) { this.seen.push(["demand", pid ?? null]); return super.poolDemand(o, pid); }
  override async listSites(pid?: string | null) { this.seen.push(["sites", pid ?? null]); return super.listSites(pid); }
}
async function call(base: string, method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${base}/api/v1${path}`, init);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

test("UI-9: the owner's pool console acts for the platform it names; without one, globally", async () => {
  const repo = new RecordingRepo();
  const api = await startTestApi({ depsOverrides: { platform: new PlatformService(repo) } });
  try {
    const q = `?platform=${OTHER}`;
    await call(api.baseUrl, "GET", `/platform/sites${q}`, OWNER);
    await call(api.baseUrl, "GET", `/platform/pool/distributions${q}`, OWNER);
    await call(api.baseUrl, "GET", `/platform/pool/demand${q}`, OWNER);
    await call(api.baseUrl, "POST", `/platform/pool/distribute${q}`, OWNER, { mode: "equal", totalCents: 1000 });
    await call(api.baseUrl, "POST", "/platform/pool/distribute", OWNER, { mode: "equal", totalCents: 1000 });
    assert.deepEqual(repo.seen, [["sites", OTHER], ["history", OTHER], ["demand", OTHER], ["distribute", OTHER], ["distribute", null]]);
    assert.equal((await call(api.baseUrl, "GET", "/platform/pool/distributions?platform=x", OWNER)).status, 400);
  } finally { await api.close(); }
});

test("UI-9: a platform admin's pool console ignores ?platform= (always its own platform)", async () => {
  const repo = new RecordingRepo();
  const api = await startTestApi({ depsOverrides: { platform: new PlatformService(repo) } });
  try {
    await call(api.baseUrl, "POST", `/platform/pool/distribute?platform=${OTHER}`, PA, { mode: "equal", totalCents: 1000 });
    await call(api.baseUrl, "GET", `/platform/sites?platform=${OTHER}`, PA);
    assert.deepEqual(repo.seen, [["distribute", DEFAULT_PLATFORM], ["sites", DEFAULT_PLATFORM]]);
  } finally { await api.close(); }
});
