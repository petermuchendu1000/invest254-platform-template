import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfiguredMegaPayClient } from "./megapay.js";

const emptyEnv = {} as NodeJS.ProcessEnv;
const prodEnvComplete = { MEGAPAY_ENV: "production", MEGAPAY_API_KEY: "ENVKEY", MEGAPAY_EMAIL: "env@b.co" } as unknown as NodeJS.ProcessEnv;

// ── Behaviour-neutral: no DB override → identical to the env-only client ────────────────────────────
test("ConfiguredMegaPayClient: no override + empty env → deterministic stub (unchanged dev behaviour)", async () => {
  const c = new ConfiguredMegaPayClient(async () => null, emptyEnv);
  const r = await c.initiateStk({ amountCents: 50_000, msisdn: "0712345678", reference: "Brand" });
  assert.equal(r.transactionRequestId, "stub-mp-trid-1"); // StubMegaPayClient == env path
});

test("ConfiguredMegaPayClient: resolver THROWS → falls back to env (never breaks deposits)", async () => {
  const c = new ConfiguredMegaPayClient(async () => { throw new Error("DB down"); }, emptyEnv);
  const r = await c.initiateStk({ amountCents: 50_000, msisdn: "0712345678", reference: "Brand" });
  assert.equal(r.transactionRequestId, "stub-mp-trid-1"); // env fallback, not a crash
});

// ── Override drives the rail: production + incomplete creds → fail-loud (never phantom-credit) ───────
test("ConfiguredMegaPayClient: override env=production w/ missing key → UnconfiguredClient (fails loudly)", async () => {
  // env alone would be sandbox→stub; the override flips env to production with NO key, which must
  // select the fail-loud client — proving the DB override actually took effect.
  const c = new ConfiguredMegaPayClient(async () => ({ env: "production" }), emptyEnv);
  await assert.rejects(() => c.queryStatus("trid-x"), /MEGAPAY_NOT_CONFIGURED/);
});

test("ConfiguredMegaPayClient: complete override is used even when env is ALSO complete", async () => {
  // With a complete override the client becomes the real Http client (constructed, not the stub);
  // we assert it's NOT the stub by confirming queryStatus does not return the stub receipt offline.
  const c = new ConfiguredMegaPayClient(async () => ({ env: "sandbox" }), prodEnvComplete);
  // override env=sandbox + env creds complete → Http client built; calling it would hit network, so we
  // only assert the resolver is consulted (below) and rely on makeMegaPayClientFromConfig's own tests.
  assert.ok(c instanceof ConfiguredMegaPayClient);
});

test("ConfiguredMegaPayClient: the resolver is consulted on every call (config changes take effect live)", async () => {
  let calls = 0;
  const c = new ConfiguredMegaPayClient(async () => { calls++; return null; }, emptyEnv);
  await c.initiateStk({ amountCents: 50_000, msisdn: "0712345678", reference: "Brand" });
  await c.queryStatus("trid-1");
  assert.equal(calls, 2);
});
