import { test } from "node:test";
import assert from "node:assert/strict";
import { testConnection } from "./gatewaytest.js";
import {
  resolveMegaPayConfig, normalizeMegapayBase, MEGAPAY_PRODUCTION_BASE, MEGAPAY_SANDBOX_BASE,
} from "./megapay.js";

/**
 * BUGLOG #73 — Mega Pay's production host is /backend/v1; /backend/v2 is a sandbox that only accepts
 * Mega Pay's public test key. Responses below were recorded against the live API on 2026-09-24.
 */
function recorder(byHost: Record<string, unknown>) {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(String(url));
    const host = Object.keys(byHost).find((h) => String(url).startsWith(h));
    return new Response(JSON.stringify(host ? byHost[host] : {}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, urls };
}
const V1_OK = { ResultCode: "102", errorMessage: "Transaction request does not exist!" };
const V1_BAD_KEY = { ResultCode: "102", errorMessage: "Api Key does not exist!" };
const V1_BAD_EMAIL = { ResultCode: "102", errorMessage: "Email does not exist!" };
const V2_LIVE_KEY = { ResultCode: "102", errorMessage: "Invalid Api Key. Use Test Api Key: MGPY1EvRts3I" };
const V2_LIVE_EMAIL = { ResultCode: "102", errorMessage: "Invalid email. Use Test Email: megapaysandboxtest@gmail.com" };

test("test connection: production probes /backend/v1 and a right key + email is VALID", async () => {
  const { f, urls } = recorder({ [MEGAPAY_PRODUCTION_BASE]: V1_OK });
  const r = await testConnection("megapay", { env: "production", api_key: "MGPYlive", email: "owner@x.co" }, f);
  assert.equal(urls[0], `${MEGAPAY_PRODUCTION_BASE}/transactionstatus`);
  assert.equal(r.status, "valid", r.detail);
});

test("test connection: production with the OLD saved sandbox host still probes v1", async () => {
  const { f, urls } = recorder({ [MEGAPAY_PRODUCTION_BASE]: V1_OK });
  const r = await testConnection("megapay", { env: "production", api_key: "MGPYlive", email: "owner@x.co", api_base: MEGAPAY_SANDBOX_BASE }, f);
  assert.equal(urls[0], `${MEGAPAY_PRODUCTION_BASE}/transactionstatus`);
  assert.equal(r.status, "valid");
});

test("test connection: a wrong key or email on production is INVALID (was reported valid)", async () => {
  const k = await testConnection("megapay", { env: "production", api_key: "nope", email: "owner@x.co" }, recorder({ [MEGAPAY_PRODUCTION_BASE]: V1_BAD_KEY }).f);
  assert.equal(k.status, "invalid"); assert.match(k.detail, /does not recognise this API key/);
  const e = await testConnection("megapay", { env: "production", api_key: "MGPYlive", email: "typo@x.co" }, recorder({ [MEGAPAY_PRODUCTION_BASE]: V1_BAD_EMAIL }).f);
  assert.equal(e.status, "invalid"); assert.match(e.detail, /does not recognise this email/);
});

test("test connection: a live key tested as Sandbox says to switch to Production", async () => {
  const { f, urls } = recorder({ [MEGAPAY_SANDBOX_BASE]: V2_LIVE_KEY });
  const r = await testConnection("megapay", { env: "sandbox", api_key: "MGPYlive", email: "owner@x.co" }, f);
  assert.equal(urls[0], `${MEGAPAY_SANDBOX_BASE}/transactionstatus`);
  assert.equal(r.status, "invalid"); assert.match(r.detail, /set Environment to Production/);
  const e = await testConnection("megapay", { env: "sandbox", api_key: "MGPY1EvRts3I", email: "owner@x.co" }, recorder({ [MEGAPAY_SANDBOX_BASE]: V2_LIVE_EMAIL }).f);
  assert.match(e.detail, /set Environment to Production/);
});

test("test connection: the key is never echoed back in the detail", async () => {
  const key = "MGPYsecret99";
  const r = await testConnection("megapay", { env: "production", api_key: key, email: "o@x.co" },
    recorder({ [MEGAPAY_PRODUCTION_BASE]: { ResultCode: "102", errorMessage: `Something odd about ${key}` } }).f);
  assert.ok(!r.detail.includes(key), r.detail);
});

test("normalizeMegapayBase: blank follows env; production never uses the sandbox host; custom hosts kept", () => {
  assert.equal(normalizeMegapayBase("", "production"), MEGAPAY_PRODUCTION_BASE);
  assert.equal(normalizeMegapayBase(undefined, "sandbox"), MEGAPAY_SANDBOX_BASE);
  assert.equal(normalizeMegapayBase(`${MEGAPAY_SANDBOX_BASE}/`, "production"), MEGAPAY_PRODUCTION_BASE);
  assert.equal(normalizeMegapayBase(MEGAPAY_SANDBOX_BASE, "sandbox"), MEGAPAY_SANDBOX_BASE);
  assert.equal(normalizeMegapayBase("https://other.example/api/", "production"), "https://other.example/api");
});

test("resolveMegaPayConfig: the deployment's env config is used VERBATIM (live deposits unchanged)", () => {
  const env = { MEGAPAY_ENV: "production", MEGAPAY_API_KEY: "K", MEGAPAY_EMAIL: "e", MEGAPAY_API_BASE: "https://deploy.example/v9" } as NodeJS.ProcessEnv;
  assert.equal(resolveMegaPayConfig({}, env).baseUrl, "https://deploy.example/v9");
  // console config for the SAME environment without a base keeps the deployment host
  assert.equal(resolveMegaPayConfig({ env: "production", apiKey: "K2" }, env).baseUrl, "https://deploy.example/v9");
});

test("resolveMegaPayConfig: console config picks the right host for its environment", () => {
  const prodEnv = { MEGAPAY_ENV: "production", MEGAPAY_API_BASE: MEGAPAY_PRODUCTION_BASE } as NodeJS.ProcessEnv;
  // a saved production config that still carries the old v2 default is corrected
  assert.equal(resolveMegaPayConfig({ env: "production", baseUrl: MEGAPAY_SANDBOX_BASE }, prodEnv).baseUrl, MEGAPAY_PRODUCTION_BASE);
  // switching the console to Sandbox must not keep the deployment's production host
  assert.equal(resolveMegaPayConfig({ env: "sandbox" }, prodEnv).baseUrl, MEGAPAY_SANDBOX_BASE);
  // no env at all: production → v1, default (sandbox) → v2  (per-scope accounts resolve with env {})
  assert.equal(resolveMegaPayConfig({ env: "production" }, {}).baseUrl, MEGAPAY_PRODUCTION_BASE);
  assert.equal(resolveMegaPayConfig({}, {}).baseUrl, MEGAPAY_SANDBOX_BASE);
});
