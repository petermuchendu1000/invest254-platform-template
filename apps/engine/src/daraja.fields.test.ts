import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpDarajaClient, type DarajaConfig } from "./daraja.js";

/**
 * Issue 2 — Daraja now honors Paybill/Till (+ till PartyB), a separate B2C shortcode (PartyA) and a
 * configurable B2C CommandID, all defaulting to the previous hardcoded behavior. We drive the client
 * with a mock fetch and assert the exact Safaricom request bodies.
 */
const BASE: DarajaConfig = {
  env: "production",
  consumerKey: "ck", consumerSecret: "cs", shortcode: "600000", passkey: "pk",
  stkCallbackUrl: "https://x/stk",
  b2cInitiator: "apiop", b2cSecurityCredential: "sec==", b2cResultUrl: "https://x/b2c/result", b2cTimeoutUrl: "https://x/b2c/timeout",
};
const jsonRes = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
function mockFetch(cap: { stk?: any; b2c?: any }): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/oauth/")) return jsonRes({ access_token: "tok", expires_in: 3600 });
    if (u.includes("/stkpush/")) { cap.stk = JSON.parse(String(init?.body)); return jsonRes({ MerchantRequestID: "m", CheckoutRequestID: "c" }); }
    if (u.includes("/b2c/")) { cap.b2c = JSON.parse(String(init?.body)); return jsonRes({ ConversationID: "x", OriginatorConversationID: "y", ResponseCode: "0" }); }
    return jsonRes({});
  }) as unknown as typeof fetch;
}

test("STK: Paybill is the default (CustomerPayBillOnline, PartyB=shortcode)", async () => {
  const cap: { stk?: any } = {};
  await new HttpDarajaClient(BASE, mockFetch(cap)).stkPush({ amountCents: 100000, msisdn: "0712345678", accountRef: "Ref", desc: "d" });
  assert.equal(cap.stk.TransactionType, "CustomerPayBillOnline");
  assert.equal(cap.stk.PartyB, "600000");
  assert.equal(cap.stk.BusinessShortCode, "600000");
});

test("STK: Till (Buy Goods) uses CustomerBuyGoodsOnline + till number as PartyB", async () => {
  const cap: { stk?: any } = {};
  const cfg: DarajaConfig = { ...BASE, transactionType: "till", tillNumber: "5555555" };
  await new HttpDarajaClient(cfg, mockFetch(cap)).stkPush({ amountCents: 100000, msisdn: "0712345678", accountRef: "Ref", desc: "d" });
  assert.equal(cap.stk.TransactionType, "CustomerBuyGoodsOnline");
  assert.equal(cap.stk.PartyB, "5555555");
});

test("B2C: defaults to BusinessPayment + PartyA=shortcode", async () => {
  const cap: { b2c?: any } = {};
  await new HttpDarajaClient(BASE, mockFetch(cap)).b2cPayment({ amountCents: 100000, msisdn: "0712345678", remarks: "w", resultId: "tx1" });
  assert.equal(cap.b2c.CommandID, "BusinessPayment");
  assert.equal(cap.b2c.PartyA, "600000");
});

test("B2C: honors a separate B2C shortcode (PartyA) and a configured CommandID", async () => {
  const cap: { b2c?: any } = {};
  const cfg: DarajaConfig = { ...BASE, b2cShortcode: "B2C777", b2cCommandId: "SalaryPayment" };
  await new HttpDarajaClient(cfg, mockFetch(cap)).b2cPayment({ amountCents: 100000, msisdn: "0712345678", remarks: "w", resultId: "tx1" });
  assert.equal(cap.b2c.CommandID, "SalaryPayment");
  assert.equal(cap.b2c.PartyA, "B2C777");
});
