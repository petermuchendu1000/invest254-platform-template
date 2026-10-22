import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeGatewayUrl, testConnection } from "./gatewaytest.js";

/**
 * Issue 3 — SSRF guard on the gateway "test connection" base URL. The probe attaches the live
 * provider secret to an outbound request, so a caller-chosen internal/metadata target would be
 * blind SSRF + credential exfiltration. Validate the host before any fetch.
 */

test("assertSafeGatewayUrl accepts public https and empty (provider default)", () => {
  assert.doesNotThrow(() => assertSafeGatewayUrl(undefined));
  assert.doesNotThrow(() => assertSafeGatewayUrl(""));
  assert.doesNotThrow(() => assertSafeGatewayUrl("https://api.paystack.co"));
  assert.doesNotThrow(() => assertSafeGatewayUrl("https://backend.payhero.co.ke/api/v2"));
});

test("assertSafeGatewayUrl rejects the SSRF vectors the audit demonstrated", () => {
  for (const bad of [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/", // cloud metadata (and http)
    "https://169.254.169.254/",             // metadata over https
    "https://127.0.0.1/",                   // loopback
    "https://localhost/balance",            // loopback name
    "https://10.0.0.5/",                    // private
    "https://172.16.9.9/",                  // private
    "https://192.168.1.1/",                 // private
    "https://db.internal/",                 // internal service
    "http://api.paystack.co/",              // plain http (secret would go in cleartext)
    "https://[::1]/",                       // ipv6 loopback
  ]) {
    assert.throws(() => assertSafeGatewayUrl(bad), new RegExp("GATEWAY_URL_"), `should reject ${bad}`);
  }
});

test("testConnection refuses an unsafe base_url before probing (no fetch)", async () => {
  let fetched = false;
  const spyFetch = (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch;
  const res = await testConnection("paystack", { secret_key: "sk_live_x", base_url: "http://169.254.169.254/" }, spyFetch);
  assert.equal(res.ok, false);
  assert.equal(res.status, "invalid");
  assert.equal(fetched, false, "must NOT issue any outbound request for an unsafe base URL");
});
