import { test } from "node:test";
import assert from "node:assert/strict";
import { testConnection, binancePaySignature } from "./gatewaytest.js";

/** Build a fake fetch that returns one recorded response (or throws to simulate a network error). */
function fakeFetch(spec: { status?: number; body?: unknown; throwErr?: string; capture?: (url: string, init: any) => void }): typeof fetch {
  return (async (url: string, init: any) => {
    spec.capture?.(String(url), init);
    if (spec.throwErr) throw new Error(spec.throwErr);
    return new Response(JSON.stringify(spec.body ?? {}), { status: spec.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

// ── Mega Pay ────────────────────────────────────────────────────────────────────────────────────
test("megapay: valid key (status endpoint reachable, no 'Invalid Api Key')", async () => {
  const r = await testConnection("megapay", { api_key: "MGPYok", email: "a@b.co" }, fakeFetch({ body: { ResultCode: "102", TransactionStatus: "" } }));
  assert.equal(r.status, "valid"); assert.equal(r.ok, true);
});
test("megapay: invalid key surfaced from errorMessage", async () => {
  const r = await testConnection("megapay", { api_key: "bad", email: "a@b.co" }, fakeFetch({ body: { ResultCode: "102", errorMessage: "Invalid Api Key. Use Test Api Key: X" } }));
  assert.equal(r.status, "invalid"); assert.equal(r.ok, false);
});
test("megapay: missing creds -> not_configured (no network call)", async () => {
  let called = false;
  const r = await testConnection("megapay", { email: "a@b.co" }, fakeFetch({ capture: () => { called = true; } }));
  assert.equal(r.status, "not_configured"); assert.equal(called, false);
});
test("megapay: network error -> unreachable", async () => {
  const r = await testConnection("megapay", { api_key: "x", email: "a@b.co" }, fakeFetch({ throwErr: "ECONNREFUSED" }));
  assert.equal(r.status, "unreachable");
});

// ── Paystack ────────────────────────────────────────────────────────────────────────────────────
test("paystack: 200 status:true -> valid; sends Bearer secret", async () => {
  let seen: any = {};
  const r = await testConnection("paystack", { secret_key: "sk_test_abc" }, fakeFetch({ status: 200, body: { status: true, data: { balance: 0 } }, capture: (_u, i) => (seen = i) }));
  assert.equal(r.status, "valid");
  assert.equal(seen.headers.Authorization, "Bearer sk_test_abc");
});
test("paystack: 401 -> invalid", async () => {
  const r = await testConnection("paystack", { secret_key: "sk_bad" }, fakeFetch({ status: 401, body: { status: false, message: "Invalid key" } }));
  assert.equal(r.status, "invalid");
});

// ── PayHero ─────────────────────────────────────────────────────────────────────────────────────
test("payhero: 200 -> valid; strips a leading 'Basic ' if present", async () => {
  let seen: any = {};
  const r = await testConnection("payhero", { basic_auth_token: "Basic dXNlcjpwYXNz" }, fakeFetch({ status: 200, body: { payment_channels: [] }, capture: (_u, i) => (seen = i) }));
  assert.equal(r.status, "valid");
  assert.equal(seen.headers.Authorization, "Basic dXNlcjpwYXNz"); // exactly one 'Basic ' prefix
});
test("payhero: derives the Basic token from api_username + api_password when no token is given", async () => {
  let seen: any = {};
  const r = await testConnection("payhero", { api_username: "user", api_password: "pass" }, fakeFetch({ status: 200, body: { payment_channels: [] }, capture: (_u, i) => (seen = i) }));
  assert.equal(r.status, "valid");
  assert.equal(seen.headers.Authorization, `Basic ${Buffer.from("user:pass").toString("base64")}`);
});
test("payhero: 401 -> invalid", async () => {
  const r = await testConnection("payhero", { basic_auth_token: "dXNlcjpwYXNz" }, fakeFetch({ status: 401 }));
  assert.equal(r.status, "invalid");
});

// ── Binance Pay ─────────────────────────────────────────────────────────────────────────────────
test("binance signature is deterministic HMAC-SHA512 (upper hex)", () => {
  const sig = binancePaySignature("mysecret", "1700000000000", "abc123", "{\"merchantTradeNo\":\"x\"}");
  assert.match(sig, /^[0-9A-F]+$/);
  assert.equal(sig, binancePaySignature("mysecret", "1700000000000", "abc123", "{\"merchantTradeNo\":\"x\"}"));
});
test("binance: order-not-found (non-auth code) -> valid signature accepted", async () => {
  let seen: any = {};
  const r = await testConnection("binance", { api_key: "K", api_secret: "S" }, fakeFetch({ status: 200, body: { status: "FAIL", code: "400204", errorMessage: "order not found" }, capture: (_u, i) => (seen = i) }));
  assert.equal(r.status, "valid");
  assert.ok(seen.headers["BinancePay-Signature"]);
  assert.equal(seen.headers["BinancePay-Certificate-SN"], "K");
});
test("binance: signature error code -> invalid", async () => {
  const r = await testConnection("binance", { api_key: "K", api_secret: "S" }, fakeFetch({ status: 200, body: { status: "FAIL", code: "400201", errorMessage: "signature verify failed" } }));
  assert.equal(r.status, "invalid");
});

test("testConnection throws on an unknown provider", async () => {
  await assert.rejects(() => testConnection("nope", {}, fakeFetch({})), /PROVIDER_NOT_CONFIGURABLE/);
});
