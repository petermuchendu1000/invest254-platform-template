import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, type TestApi } from "./testutil.js";

// A fixed 32-byte AES key (bytes 0x00..0x1f) so the engine's encryption is configured under test.
process.env.PAYMENTS_CONFIG_ENC_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64");

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
const MEGAPAY_KEY = "MGPYtestSECRETkey1234";

test("gateway config: GET /config is platform_superadmin-only", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "GET", "/api/v1/platform/payment-providers/config", { token: ADMIN })).status, 403);
    assert.equal((await req(api, "GET", "/api/v1/platform/payment-providers/config", { token: PLAYER })).status, 403);
    assert.equal((await req(api, "GET", "/api/v1/platform/payment-providers/config", { token: PLATFORM })).status, 200);
  } finally { await api.close(); }
});

test("gateway config: GET returns schema + empty masked config for all four configurable gateways", async () => {
  const api = await startTestApi();
  try {
    const body = await json(await req(api, "GET", "/api/v1/platform/payment-providers/config", { token: PLATFORM }));
    const codes = body.providers.map((p: any) => p.code).sort();
    assert.deepEqual(codes, ["binance", "megapay", "payhero", "paystack"]);
    const mp = body.providers.find((p: any) => p.code === "megapay");
    assert.ok(mp.schema.fields.some((f: any) => f.key === "api_key" && f.secret === true));
    assert.equal(mp.config.exists, false);
    assert.equal(mp.config.hasSecret, false);
  } finally { await api.close(); }
});

test("gateway config: PUT saves megapay, encrypts the secret, returns only a masked hint (no plaintext)", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "PUT", "/api/v1/platform/payment-providers/megapay/config", {
      token: PLATFORM, body: { env: "production", email: "acct@brand.co.ke", api_key: MEGAPAY_KEY },
    });
    assert.equal(res.status, 200);
    const { config } = await json(res);
    assert.equal(config.hasSecret, true);
    assert.equal(config.settings.env, "production");
    assert.equal(config.settings.email, "acct@brand.co.ke");
    assert.equal(config.secretMeta.api_key.last4, MEGAPAY_KEY.slice(-4));
    // the plaintext secret must NEVER appear anywhere in the response
    assert.equal(JSON.stringify(config).includes(MEGAPAY_KEY), false);

    // persisted: a follow-up GET shows exists=true
    const body = await json(await req(api, "GET", "/api/v1/platform/payment-providers/config", { token: PLATFORM }));
    assert.equal(body.providers.find((p: any) => p.code === "megapay").config.exists, true);
  } finally { await api.close(); }
});

test("gateway config: settings-only PUT keeps the stored secret (no re-entry needed)", async () => {
  const api = await startTestApi();
  try {
    await req(api, "PUT", "/api/v1/platform/payment-providers/megapay/config", { token: PLATFORM, body: { env: "production", email: "a@b.co", api_key: MEGAPAY_KEY } });
    const res = await req(api, "PUT", "/api/v1/platform/payment-providers/megapay/config", { token: PLATFORM, body: { env: "sandbox", email: "a@b.co" } });
    assert.equal(res.status, 200);
    const { config } = await json(res);
    assert.equal(config.settings.env, "sandbox");
    assert.equal(config.hasSecret, true); // secret preserved
  } finally { await api.close(); }
});

test("gateway config: invalid input -> 400 VALIDATION", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "PUT", "/api/v1/platform/payment-providers/megapay/config", { token: PLATFORM, body: { env: "production", email: "not-an-email", api_key: MEGAPAY_KEY } });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "VALIDATION");
  } finally { await api.close(); }
});

test("gateway config: partial secret edit on binance keeps the untouched secret (merge, not replace)", async () => {
  const api = await startTestApi();
  try {
    await req(api, "PUT", "/api/v1/platform/payment-providers/binance/config", { token: PLATFORM, body: { env: "production", api_key: "BINkey123456", api_secret: "BINsecret7890" } });
    // update ONLY api_secret
    const res = await req(api, "PUT", "/api/v1/platform/payment-providers/binance/config", { token: PLATFORM, body: { api_secret: "BINsecretNEW999" } });
    assert.equal(res.status, 200);
    const { config } = await json(res);
    // both secret fields still present in the masked meta -> api_key was NOT dropped
    assert.equal(config.secretMeta.api_key.last4, "3456");
    assert.equal(config.secretMeta.api_secret.last4, "W999");
  } finally { await api.close(); }
});

test("gateway config: non-configurable provider (mpesa) -> 400 PROVIDER_NOT_CONFIGURABLE", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "PUT", "/api/v1/platform/payment-providers/mpesa/config", { token: PLATFORM, body: { env: "sandbox" } });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "PROVIDER_NOT_CONFIGURABLE");
  } finally { await api.close(); }
});

test("gateway config: test-connection is gated + returns not_configured with no creds (no network)", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "POST", "/api/v1/platform/payment-providers/binance/config/test", { token: ADMIN, body: {} })).status, 403);
    const res = await req(api, "POST", "/api/v1/platform/payment-providers/binance/config/test", { token: PLATFORM, body: {} });
    assert.equal(res.status, 200);
    const { result } = await json(res);
    assert.equal(result.status, "not_configured"); // missing api_key/api_secret -> never hits the network
    assert.equal(result.ok, false);
  } finally { await api.close(); }
});

test("gateway availability: a config-only gateway CANNOT be switched live for players", async () => {
  const api = await startTestApi();
  try {
    // payhero has no player deposit rail -> enabling it must be refused (no misleading 'Live' state)
    const on = await req(api, "POST", "/api/v1/platform/payment-providers/payhero/global", { token: PLATFORM, body: { enabled: true } });
    assert.equal(on.status, 422);
    assert.equal((await json(on)).error.code, "PROVIDER_NOT_PLAYER_READY");
    // disabling is always allowed (idempotent safety)
    assert.equal((await req(api, "POST", "/api/v1/platform/payment-providers/payhero/global", { token: PLATFORM, body: { enabled: false } })).status, 200);
    // a rail-ready gateway (megapay) can still be enabled
    assert.equal((await req(api, "POST", "/api/v1/platform/payment-providers/megapay/global", { token: PLATFORM, body: { enabled: true } })).status, 200);
    // and a config-only gateway can't be force-enabled per-brand either
    const SITE = "00000000-0000-0000-0000-000000000001";
    assert.equal((await req(api, "POST", "/api/v1/platform/payment-providers/payhero/site", { token: PLATFORM, body: { siteId: SITE, enabled: true } })).status, 422);
  } finally { await api.close(); }
});
