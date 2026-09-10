import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, type TestApi } from "./testutil.js";

const json = (res: Response): Promise<any> => res.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const PLAYER = TEST_USER;
const PLATFORM = `${TEST_ADMIN}:platform_superadmin`;
const ADMIN = `${TEST_ADMIN}:admin`;

// ── player: provider discovery + Mega Pay deposit lifecycle ───────────────────────────────────────
test("GET /deposits/providers → lists the brand's enabled gateways", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "GET", "/api/v1/deposits/providers", { token: PLAYER });
    assert.equal(res.status, 200);
    const codes = (await json(res)).providers.map((p: any) => p.code).sort();
    assert.deepEqual(codes, ["megapay", "mpesa"]);
  } finally { await api.close(); }
});

test("deposit: POST /deposits/megapay → 202, webhook credits the wallet", async () => {
  const api = await startTestApi({ startingBalanceCents: 100_000 });
  try {
    const dep = await req(api, "POST", "/api/v1/deposits/megapay", { token: PLAYER, body: { amount: 50_000, phone: "0712345678" } });
    assert.equal(dep.status, 202);
    const { transactionId, transactionRequestId } = await json(dep);
    assert.ok(transactionId && transactionRequestId);

    // Mega Pay webhook (public, no auth). Handler re-queries status (stub → Completed) before crediting.
    const cb = await req(api, "POST", "/api/v1/deposits/megapay/callback", { body: { transaction_request_id: transactionRequestId, TransactionStatus: "Completed" } });
    assert.equal(cb.status, 200);

    const bal = await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }));
    assert.equal(bal.real, 150_000); // 100k + 50k credited exactly once
  } finally { await api.close(); }
});

test("deposit: Mega Pay honours the deposit floor + rejects junk", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "POST", "/api/v1/deposits/megapay", { token: PLAYER, body: { amount: 9_999, phone: "0712345678" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/deposits/megapay", { token: PLAYER, body: { amount: 50_000, phone: "nope" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/deposits/megapay", { token: PLAYER, body: {} })).status, 400);
  } finally { await api.close(); }
});

test("deposit: /deposits/megapay is refused when the gateway is switched off for the brand", async () => {
  const api = await startTestApi();
  try {
    api.payRepo.setProviders([{ code: "mpesa", displayName: "M-Pesa" }]); // superadmin turned Mega Pay off
    const res = await req(api, "POST", "/api/v1/deposits/megapay", { token: PLAYER, body: { amount: 50_000, phone: "0712345678" } });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, "PROVIDER_DISABLED");
  } finally { await api.close(); }
});

test("callback: missing transaction_request_id → 400", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", "/api/v1/deposits/megapay/callback", { body: { foo: "bar" } });
    assert.equal(res.status, 400);
  } finally { await api.close(); }
});

test("deposit: /deposits (Daraja STK) is refused when M-Pesa is switched off for the brand", async () => {
  const api = await startTestApi();
  try {
    api.payRepo.setProviders([{ code: 'megapay', displayName: 'Mega Pay' }]); // superadmin turned M-Pesa off
    const stk = await req(api, "POST", "/api/v1/deposits", { token: PLAYER, body: { amount: 50_000, phone: "0712345678" } });
    assert.equal(stk.status, 403);
    assert.equal((await json(stk)).error.code, "PROVIDER_DISABLED");
    const claim = await req(api, "POST", "/api/v1/deposits/paybill/claim", { token: PLAYER, body: { code: "ABC123" } });
    assert.equal(claim.status, 403);
    // Mega Pay still works in this state
    assert.equal((await req(api, "POST", "/api/v1/deposits/megapay", { token: PLAYER, body: { amount: 50_000, phone: "0712345678" } })).status, 202);
  } finally { await api.close(); }
});

// ── superadmin console: provider switches ───────────────────────────────────────────────────────
test("platform: payment-provider routes are platform_superadmin-only", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "GET", "/api/v1/platform/payment-providers", { token: ADMIN })).status, 403);
    assert.equal((await req(api, "GET", "/api/v1/platform/payment-providers", { token: PLAYER })).status, 403);
    assert.equal((await req(api, "GET", "/api/v1/platform/payment-providers", { token: PLATFORM })).status, 200);
  } finally { await api.close(); }
});

test("platform: flip global switch + set/clear per-site override", async () => {
  const api = await startTestApi();
  try {
    // global ON for megapay
    let res = await req(api, "POST", "/api/v1/platform/payment-providers/megapay/global", { token: PLATFORM, body: { enabled: true } });
    assert.equal(res.status, 200);
    let view = await json(res);
    assert.equal(view.providers.find((p: any) => p.code === "megapay").enabled_global ?? view.providers.find((p: any) => p.code === "megapay").enabledGlobal, true);

    // validation: enabled must be boolean
    assert.equal((await req(api, "POST", "/api/v1/platform/payment-providers/megapay/global", { token: PLATFORM, body: {} })).status, 400);

    // per-site override OFF for one brand
    const SITE = "00000000-0000-0000-0000-000000000001";
    res = await req(api, "POST", "/api/v1/platform/payment-providers/megapay/site", { token: PLATFORM, body: { siteId: SITE, enabled: false } });
    assert.equal(res.status, 200);
    view = await json(res);
    assert.ok(view.overrides.some((o: any) => o.provider_code === "megapay" && o.enabled === false || o.providerCode === "megapay" && o.enabled === false));

    // clear the override (enabled:null)
    res = await req(api, "POST", "/api/v1/platform/payment-providers/megapay/site", { token: PLATFORM, body: { siteId: SITE, enabled: null } });
    assert.equal(res.status, 200);
    view = await json(res);
    assert.equal(view.overrides.some((o: any) => (o.providerCode ?? o.provider_code) === "megapay"), false);

    // missing siteId → 400
    assert.equal((await req(api, "POST", "/api/v1/platform/payment-providers/megapay/site", { token: PLATFORM, body: { enabled: true } })).status, 400);
  } finally { await api.close(); }
});
