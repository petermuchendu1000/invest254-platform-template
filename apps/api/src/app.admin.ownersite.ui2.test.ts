import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A } from "./testutil.js";

/**
 * docs/42 UI-2 — the system owner's brand-config calls must NAME the brand. They used to fall back to
 * the default brand silently, so an owner "global" edit quietly changed brand #1 only. A site admin is
 * pinned to its token's brand and is unaffected.
 */
const OWNER = "root:platform_superadmin";
const ADMIN = `adm:admin:${SITE_A}`;
async function call(base: string, method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${base}/api/v1${path}`, init);
  let code = ""; try { code = ((await r.json()) as any).error?.code ?? ""; } catch { /* none */ }
  return { status: r.status, code };
}

test("UI-2: owner config calls without ?site= are refused (SITE_REQUIRED); with ?site= they work", async () => {
  const api = await startTestApi();
  try {
    const cases: Array<[string, string, unknown?]> = [
      ["GET", "/admin/game-config"],
      ["PATCH", "/admin/game-config", { poolMode: true }],
      ["GET", "/admin/withdrawal-pool"],
      ["PUT", "/admin/withdrawal-pool", { amountCents: 100_000 }],
      ["GET", "/admin/withdrawals-enabled"],
      ["PUT", "/admin/withdrawals-enabled", { enabled: true }],
      ["GET", "/admin/config-review"],
    ];
    for (const [m, p, b] of cases) {
      const bare = await call(api.baseUrl, m, p, OWNER, b);
      assert.deepEqual(bare, { status: 400, code: "SITE_REQUIRED" }, `${m} ${p} without a brand`);
      const bad = await call(api.baseUrl, m, `${p}?site=not-a-uuid`, OWNER, b);
      assert.equal(bad.code, "SITE_REQUIRED", `${m} ${p} with a malformed brand`);
      const named = await call(api.baseUrl, m, `${p}?site=${SITE_A}`, OWNER, b);
      assert.ok(named.status < 300, `${m} ${p}?site= -> ${named.status} ${named.code}`);
    }
  } finally { await api.close(); }
});

test("UI-2: a site admin is pinned to its own brand and needs no ?site= (unchanged)", async () => {
  const api = await startTestApi();
  try {
    assert.ok((await call(api.baseUrl, "GET", "/admin/game-config", ADMIN)).status < 300);
    assert.ok((await call(api.baseUrl, "GET", "/admin/withdrawals-enabled", ADMIN)).status < 300);
    assert.ok((await call(api.baseUrl, "GET", "/admin/config-review", ADMIN)).status < 300);
  } finally { await api.close(); }
});
