import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A, type TestApi } from "./testutil.js";
import type { WalletBalance } from "./app.js";

/** DEMO-1 — the Real / Demo account switch API (routes + error mapping). Money routing is proven in
 *  packages/db/_testkit/e2e_account_demo_mode.py and demo1.pg.test.ts. */
async function call(api: TestApi, method: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${api.baseUrl}/api/v1${path}`, init);
  const j = (await r.json().catch(() => ({}))) as any;
  return { status: r.status, body: j, code: j?.error?.code as string | undefined };
}
const P = `u-demo:player:${SITE_A}`;

test("DEMO-1 API: switch accounts, refresh demo, clear errors", async () => {
  let mode: "real" | "demo" = "real";
  let demoBal = 0;
  let open = false;
  const wallet = async (): Promise<WalletBalance> => ({
    real: mode === "demo" ? demoBal : 5000, bonus: mode === "demo" ? 0 : 100, currency: "KES",
    mode, modeLocked: false, realBalance: 5000, bonusBalance: 100, demoBalance: demoBal,
  });
  const api = await startTestApi({ depsOverrides: {
    walletBalance: wallet,
    setAccountMode: async (_u, _s, m) => { if (open) throw new Error("OPEN_POSITIONS"); mode = m; return m; },
    topupDemo: async () => { demoBal = Math.max(demoBal, 1_000_000); return demoBal; },
  } });
  try {
    assert.equal((await call(api, "POST", "/wallet/mode", null, { mode: "demo" })).status, 401);
    assert.equal((await call(api, "POST", "/wallet/mode", P, { mode: "fun" })).code, "INVALID_MODE");
    const r = await call(api, "POST", "/wallet/mode", P, { mode: "demo" });
    assert.equal(r.status, 200); assert.equal(r.body.mode, "demo");
    assert.equal(r.body.wallet.mode, "demo"); assert.equal(r.body.wallet.bonus, 0, "demo mode never spends the bonus");
    const t = await call(api, "POST", "/wallet/demo/topup", P);
    assert.equal(t.status, 200); assert.equal(t.body.demoBalance, 1_000_000); assert.equal(t.body.wallet.real, 1_000_000);
    open = true;
    const blocked = await call(api, "POST", "/wallet/mode", P, { mode: "real" });
    assert.equal(blocked.status, 409); assert.equal(blocked.code, "OPEN_POSITIONS");
    open = false;
    assert.equal((await call(api, "POST", "/wallet/mode", P, { mode: "real" })).body.wallet.real, 5000);
    const w = await call(api, "GET", "/wallet", P);
    assert.equal(w.body.mode, "real"); assert.equal(w.body.demoBalance, 1_000_000);
  } finally { await api.close(); }
});

test("DEMO-1 API: 501 when the deployment has no demo support", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await call(api, "POST", "/wallet/mode", P, { mode: "demo" })).status, 501);
    assert.equal((await call(api, "POST", "/wallet/demo/topup", P)).status, 501);
  } finally { await api.close(); }
});
