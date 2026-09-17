import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpDarajaClient, makeDarajaClientFromConfig, missingB2cCredentials, missingDarajaCredentials, type DarajaConfig } from "./daraja.js";

const STK_ONLY: DarajaConfig = {
  env: "production",
  consumerKey: "ck", consumerSecret: "cs", shortcode: "600000", passkey: "pk",
  stkCallbackUrl: "https://x/stk",
  // B2C intentionally unset (the live mpesa_config state that stranded withdrawals).
  b2cInitiator: "", b2cSecurityCredential: "", b2cResultUrl: "https://x/b2c/result", b2cTimeoutUrl: "https://x/b2c/timeout",
};
const FULL: DarajaConfig = { ...STK_ONLY, b2cInitiator: "apiop", b2cSecurityCredential: "sec==" };

test("missingB2cCredentials flags the empty B2C fields (independent of STK)", () => {
  assert.deepEqual(missingDarajaCredentials(STK_ONLY), [], "STK creds are complete");
  assert.deepEqual(missingB2cCredentials(STK_ONLY), ["b2cInitiator", "b2cSecurityCredential"]);
  assert.deepEqual(missingB2cCredentials(FULL), []);
});

test("b2cPayment FAILS LOUD (no network) when B2C creds are missing", async () => {
  const client = new HttpDarajaClient(STK_ONLY);
  await assert.rejects(
    () => client.b2cPayment({ amountCents: 100000, msisdn: "0712345678", remarks: "Withdrawal", resultId: "tx1" }),
    /MPESA_B2C_NOT_CONFIGURED:b2cInitiator,b2cSecurityCredential/,
  );
});

test("makeDarajaClientFromConfig: STK-only config still yields a usable HttpDarajaClient (deposits work), B2C guarded", async () => {
  const client = makeDarajaClientFromConfig(STK_ONLY, {});
  assert.equal(client.constructor.name, "HttpDarajaClient", "STK creds present -> real client (deposits/STK usable)");
  await assert.rejects(() => client.b2cPayment({ amountCents: 1, msisdn: "0712345678", remarks: "w" }), /MPESA_B2C_NOT_CONFIGURED/);
});
