import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDarajaClientFromConfig, type DarajaConfig } from "./daraja.js";

/**
 * PAY-0 (BUGLOG #62) — the live client is built by makeDarajaClientFromConfig(DB row, env). It used to
 * rebuild the config WITHOUT transactionType / tillNumber / b2cShortcode / b2cCommandId, so a Till brand's
 * STK went out as CustomerPayBillOnline to the paybill shortcode and B2C always paid from the STK
 * shortcode. Drive the REAL factory (not HttpDarajaClient directly) and read the Safaricom bodies.
 */
const CREDS: Partial<DarajaConfig> = {
  env: "production", consumerKey: "ck", consumerSecret: "cs", shortcode: "600000", passkey: "pk",
  stkCallbackUrl: "https://x/stk", b2cInitiator: "apiop", b2cSecurityCredential: "sec==",
  b2cResultUrl: "https://x/b2c/result", b2cTimeoutUrl: "https://x/b2c/timeout",
};
const jsonRes = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });

async function capture(over: Partial<DarajaConfig>, env: NodeJS.ProcessEnv = {}) {
  const cap: { stk?: any; b2c?: any } = {};
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/oauth/")) return jsonRes({ access_token: "tok", expires_in: 3600 });
    if (u.includes("/stkpush/")) { cap.stk = JSON.parse(String(init?.body)); return jsonRes({ MerchantRequestID: "m", CheckoutRequestID: "c" }); }
    if (u.includes("/b2c/")) { cap.b2c = JSON.parse(String(init?.body)); return jsonRes({ ConversationID: "x", OriginatorConversationID: "y", ResponseCode: "0" }); }
    return jsonRes({});
  }) as typeof fetch;
  try {
    const client = makeDarajaClientFromConfig(over, env);
    await client.stkPush({ amountCents: 100000, msisdn: "0712345678", accountRef: "Ref", desc: "d" });
    await client.b2cPayment({ amountCents: 100000, msisdn: "0712345678", remarks: "w", resultId: "tx1" });
  } finally { globalThis.fetch = real; }
  return cap;
}

test("PAY-0: a Till + separate B2C shortcode + CommandID saved in the DB reach Safaricom", async () => {
  const cap = await capture({ ...CREDS, transactionType: "till", tillNumber: "5555555", b2cShortcode: "3000111", b2cCommandId: "SalaryPayment" });
  assert.equal(cap.stk.TransactionType, "CustomerBuyGoodsOnline");
  assert.equal(cap.stk.PartyB, "5555555");
  assert.equal(cap.b2c.PartyA, "3000111");
  assert.equal(cap.b2c.CommandID, "SalaryPayment");
});

test("PAY-0: the env provides them when the DB does not; the DB wins when both do", async () => {
  const env = { MPESA_TRANSACTION_TYPE: "till", MPESA_TILL_NUMBER: "4444444", MPESA_B2C_SHORTCODE: "3000222", MPESA_B2C_COMMAND_ID: "PromotionPayment" };
  const fromEnv = await capture(CREDS, env);
  assert.equal(fromEnv.stk.PartyB, "4444444"); assert.equal(fromEnv.b2c.PartyA, "3000222"); assert.equal(fromEnv.b2c.CommandID, "PromotionPayment");
  const dbWins = await capture({ ...CREDS, transactionType: "paybill", b2cShortcode: "3000333" }, env);
  assert.equal(dbWins.stk.TransactionType, "CustomerPayBillOnline"); assert.equal(dbWins.b2c.PartyA, "3000333");
});

test("PAY-0: unset fields keep the historic defaults (Paybill, PartyA = shortcode, BusinessPayment)", async () => {
  const cap = await capture(CREDS);
  assert.equal(cap.stk.TransactionType, "CustomerPayBillOnline");
  assert.equal(cap.stk.PartyB, "600000");
  assert.equal(cap.b2c.PartyA, "600000");
  assert.equal(cap.b2c.CommandID, "BusinessPayment");
});
