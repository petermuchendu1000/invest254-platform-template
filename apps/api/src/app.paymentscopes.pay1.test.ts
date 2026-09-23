import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { InMemoryPaymentScopeRepository, PaymentScopeService } from "@invest254/engine";
import { startTestApi, SITE_A, type TestApi } from "./testutil.js";

/**
 * PAY-1 (docs/43) — the console API for per-platform / per-brand payment accounts. A platform admin works
 * ONLY its own platform and brands; owner-only fields are refused; secrets never come back; go-live
 * needs a deposit rail + a payout path (or an explicit "deposits only"); site admins never get in.
 */
const P1 = "10000000-0000-0000-0000-000000000001";   // the harness's default platform (SITE_A lives here)
const P2 = "20000000-0000-0000-0000-000000000002";
const SITE_B = "30000000-0000-0000-0000-000000000003";
const PA1 = `pa1:platform_admin:${SITE_A}:${P1}`;
const PA2 = `pa2:platform_admin:${SITE_B}:${P2}`;
const OWNER = "own:platform_superadmin";
const ENV = { PAYMENTS_CONFIG_ENC_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;
const FULL = { environment: "production", shortcode: "600111", consumer_key: "CK", consumer_secret: "CS", passkey: "PK",
  b2c_initiator: "op", b2c_security_credential: "cred==" };

async function boot(): Promise<{ api: TestApi; repo: InMemoryPaymentScopeRepository }> {
  const repo = new InMemoryPaymentScopeRepository();
  repo.platforms.set(P1, "Default Platform"); repo.platforms.set(P2, "Beta");
  repo.sitePlatform.set(SITE_A, P1); repo.sitePlatform.set(SITE_B, P2);
  repo.actorPlatform.set("pa1", P1); repo.actorPlatform.set("pa2", P2);
  const fetchImpl = (async () => new Response(JSON.stringify({ access_token: "t", expires_in: 3599 }), { status: 200 })) as unknown as typeof fetch;
  const paymentScopes = new PaymentScopeService(repo, {
    env: ENV, fetchImpl,
    callbacks: async () => ({ stkCallbackUrl: "https://api/stk", b2cResultUrl: "https://api/b2c", b2cTimeoutUrl: "https://api/b2c/t" }),
  });
  return { api: await startTestApi({ depsOverrides: { paymentScopes } }), repo };
}
async function call(api: TestApi, method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${api.baseUrl}/api/v1${path}`, init);
  const j = (await r.json().catch(() => ({}))) as any;
  return { status: r.status, body: j, code: j?.error?.code as string | undefined };
}

test("PAY-1 API: a platform admin sees and edits ITS platform + brands only", async () => {
  const { api } = await boot();
  try {
    const list = await call(api, "GET", `/platform/payment-scopes?platform=${P2}`, PA1);
    assert.equal(list.status, 200); assert.equal(list.body.platformId, P1, "pinned to its own platform");
    assert.deepEqual(list.body.scopes.map((s: any) => s.scopeType).sort(), ["platform", "site"]);
    const detail = await call(api, "GET", `/platform/payment-scopes/platform/${P1}`, PA1);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.schemas.mpesa && detail.body.schemas.megapay, "M-Pesa + gateways");
    assert.ok(!detail.body.schemas.megapay.fields.some((f: any) => f.key === "api_base"), "owner-only fields hidden");
    for (const [m, p] of [["GET", `/platform/payment-scopes/platform/${P2}`], ["GET", `/platform/payment-scopes/site/${SITE_B}`],
                          ["PUT", `/platform/payment-scopes/platform/${P2}/gateways/mpesa`]] as const) {
      const r = await call(api, m, p, PA1, m === "PUT" ? FULL : undefined);
      assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`); assert.equal(r.code, "PLATFORM_SCOPE_FORBIDDEN");
    }
    assert.equal((await call(api, "GET", `/platform/payment-scopes/platform/${P2}`, PA2)).status, 200, "its own admin may");
    assert.equal((await call(api, "GET", `/platform/payment-scopes/platform/${P2}`, OWNER)).status, 200, "the owner may");
  } finally { await api.close(); }
});

test("PAY-1 API: saving an account — secrets write-only, owner-only fields refused, validated", async () => {
  const { api } = await boot();
  try {
    const saved = await call(api, "PUT", `/platform/payment-scopes/platform/${P1}/gateways/mpesa`, PA1, FULL);
    assert.equal(saved.status, 200, `${saved.status} ${saved.code}`);
    assert.equal(saved.body.config.settings.shortcode, "600111");
    assert.ok(!JSON.stringify(saved.body).includes('"CK"') && saved.body.config.secretMeta.consumer_key.set, "secrets masked");
    const bad = await call(api, "PUT", `/platform/payment-scopes/platform/${P1}/gateways/megapay`, PA1, { email: "a@b.co", api_key: "k", api_base: "https://evil.test" });
    assert.equal(bad.status, 403); assert.equal(bad.code, "OWNER_ONLY_FIELD");
    const sandbox = await call(api, "PUT", `/platform/payment-scopes/platform/${P1}/gateways/mpesa`, PA1, { environment: "sandbox" });
    assert.equal(sandbox.status, 403);
    const invalid = await call(api, "PUT", `/platform/payment-scopes/site/${SITE_A}/gateways/mpesa`, PA1, { ...FULL, shortcode: "12" });
    assert.equal(invalid.status, 400); assert.equal(invalid.code, "VALIDATION");
    const probe = await call(api, "POST", `/platform/payment-scopes/platform/${P1}/gateways/mpesa/test`, PA1, {});
    assert.equal(probe.status, 200); assert.equal(probe.body.result.status, "valid");
    const probeElsewhere = await call(api, "POST", `/platform/payment-scopes/platform/${P1}/gateways/megapay/test`, PA1, { api_base: "https://evil.test" });
    assert.equal(probeElsewhere.status, 403, "a draft cannot point the probe elsewhere either");
    assert.equal((await call(api, "POST", `/platform/payment-scopes/platform/${P1}/gateways/mpesa/remove`, PA1)).body.removed, true);
  } finally { await api.close(); }
});

test("PAY-1 API: go-live needs a deposit rail and a payout path (or an explicit 'deposits only')", async () => {
  const { api } = await boot();
  try {
    const none = await call(api, "POST", `/platform/payment-scopes/platform/${P1}/activate`, PA1, {});
    assert.equal(none.status, 409); assert.equal(none.code, "NO_DEPOSIT_RAIL_READY");
    await call(api, "PUT", `/platform/payment-scopes/platform/${P1}/gateways/mpesa`, PA1, { environment: "production", shortcode: "600111", consumer_key: "CK", consumer_secret: "CS", passkey: "PK" });
    const noPayout = await call(api, "POST", `/platform/payment-scopes/platform/${P1}/activate`, PA1, {});
    assert.equal(noPayout.status, 409); assert.equal(noPayout.code, "PAYOUTS_NOT_CONFIGURED");
    const depositsOnly = await call(api, "POST", `/platform/payment-scopes/platform/${P1}/activate`, PA1, { payoutsEnabled: false });
    assert.equal(depositsOnly.status, 200); assert.equal(depositsOnly.body.payoutsEnabled, false);
    const state = (await call(api, "GET", `/platform/payment-scopes?platform=${P1}`, PA1)).body.scopes.find((s: any) => s.scopeType === "platform");
    assert.deepEqual([state.active, state.payoutsEnabled], [true, false]);
    assert.equal((await call(api, "POST", `/platform/payment-scopes/platform/${P1}/deactivate`, PA1)).status, 200);
    assert.equal((await call(api, "POST", `/platform/payment-scopes/platform/${P1}/activate`, PA1, { payoutsEnabled: "no" })).status, 400);
  } finally { await api.close(); }
});

test("PAY-1 API: site admins and players never reach payment accounts; bad scopes are 400", async () => {
  const { api } = await boot();
  try {
    for (const tok of [`adm:admin:${SITE_A}`, `p:player:${SITE_A}`]) {
      assert.equal((await call(api, "GET", "/platform/payment-scopes", tok)).status, 403);
      assert.equal((await call(api, "PUT", `/platform/payment-scopes/site/${SITE_A}/gateways/mpesa`, tok, FULL)).status, 403);
    }
    assert.equal((await call(api, "GET", "/platform/payment-scopes/world/x", OWNER)).status, 400);
    assert.equal((await call(api, "GET", `/platform/payment-scopes/site/not-a-uuid`, OWNER)).status, 400);
  } finally { await api.close(); }
});

test("PAY-1 API: a platform admin switches gateways on ITS brands only", async () => {
  const { api } = await boot();
  try {
    const own = await call(api, "POST", `/platform/payment-scopes/site/${SITE_A}/switches/megapay`, PA1, { enabled: false });
    assert.equal(own.status, 200, `${own.status} ${own.code}`);
    assert.equal((await call(api, "POST", `/platform/payment-scopes/site/${SITE_A}/switches/megapay`, PA1, { enabled: null })).status, 200, "inherit");
    const other = await call(api, "POST", `/platform/payment-scopes/site/${SITE_B}/switches/megapay`, PA1, { enabled: false });
    assert.equal(other.status, 403);
    assert.equal((await call(api, "POST", `/platform/payment-scopes/site/${SITE_A}/switches/megapay`, PA1, { enabled: "yes" })).status, 400);
  } finally { await api.close(); }
});
