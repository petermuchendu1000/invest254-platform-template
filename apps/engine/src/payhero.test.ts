import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StubPayHeroClient, HttpPayHeroClient, UnconfiguredPayHeroClient, ConfiguredPayHeroClient,
  mapPayHeroStatus, toLocalMsisdn, resolvePayHeroConfig, missingPayHeroCredentials, type PayHeroConfig,
  parsePayerMsisdn, toInboundPayment, buildLipwaUrl,
  missingPayHeroPayoutConfig, payHeroPayoutReady,
} from "./payhero.js";

function fakeFetch(spec: { status?: number; body?: unknown; capture?: (url: string, init: any) => void }): typeof fetch {
  return (async (url: string, init: any) => {
    spec.capture?.(String(url), init);
    return new Response(JSON.stringify(spec.body ?? {}), { status: spec.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}
const cfg: PayHeroConfig = { baseUrl: "https://backend.payhero.co.ke/api/v2", basicAuthToken: "dXNlcjpwYXNz", channelId: "1487", callbackUrl: "https://x/cb" };

test("toLocalMsisdn normalizes every Kenyan form to 07XXXXXXXX", () => {
  assert.equal(toLocalMsisdn("254712345678"), "0712345678");
  assert.equal(toLocalMsisdn("+254712345678"), "0712345678");
  assert.equal(toLocalMsisdn("0712345678"), "0712345678");
  assert.equal(toLocalMsisdn("712345678"), "0712345678");
});

test("mapPayHeroStatus: SUCCESS->paid(0), FAILED->failed(1), QUEUED->processing", () => {
  // Still an EXACT shape check, now including the 0215 diagnostic fields. Kept exact on purpose:
  // the money fields (resultCode/receipt) must not drift, and a loosened assertion would not notice.
  assert.deepEqual(mapPayHeroStatus("SUCCESS", "RCPT01"), { resultCode: 0, processing: false, receipt: "RCPT01", providerStatus: "SUCCESS", detail: null });
  assert.deepEqual(mapPayHeroStatus("FAILED", null), { resultCode: 1, processing: false, receipt: null, providerStatus: "FAILED", detail: null });
  assert.deepEqual(mapPayHeroStatus("QUEUED", null), { resultCode: null, processing: true, receipt: null, providerStatus: "QUEUED", detail: null });
  // 0215: the reason rides along without touching the verdict.
  assert.deepEqual(mapPayHeroStatus("FAILED", null, "code=2028 not permitted"),
    { resultCode: 1, processing: false, receipt: null, providerStatus: "FAILED", detail: "code=2028 not permitted" });
});

test("HttpPayHeroClient.initiateStk posts the exact PayHero contract + parses reference", async () => {
  let seen: any = {};
  const c = new HttpPayHeroClient(cfg, fakeFetch({ status: 201, body: { success: true, status: "QUEUED", reference: "E8UWT7CLUW", CheckoutRequestID: "ws_CO_1" }, capture: (_u, i) => (seen = i) }));
  const r = await c.initiateStk({ amountCents: 20_000, msisdn: "254798123061", externalReference: "tx-1", customerName: "Jo" });
  assert.deepEqual(r, { reference: "E8UWT7CLUW", checkoutRequestId: "ws_CO_1" });
  const body = JSON.parse(seen.body);
  assert.equal(body.amount, 200);            // cents -> whole KES
  assert.equal(body.phone_number, "0798123061"); // local form
  assert.equal(body.channel_id, 1487);       // integer
  assert.equal(body.provider, "m-pesa");
  assert.equal(body.external_reference, "tx-1");
  assert.equal(body.callback_url, "https://x/cb");
  assert.equal(seen.headers.Authorization, "Basic dXNlcjpwYXNz");
});

test("HttpPayHeroClient.initiateStk throws on rejection (success:false / no reference)", async () => {
  const c = new HttpPayHeroClient(cfg, fakeFetch({ status: 400, body: { error_message: "bad" } }));
  await assert.rejects(() => c.initiateStk({ amountCents: 20_000, msisdn: "0798123061", externalReference: "tx-1" }), /PAYHERO_INITIATE_REJECTED/);
});

test("HttpPayHeroClient.queryStatus maps SUCCESS + provider_reference; !ok -> processing", async () => {
  const ok = new HttpPayHeroClient(cfg, fakeFetch({ status: 200, body: { status: "SUCCESS", success: true, provider_reference: "SKQ96C7K7H" } }));
  assert.deepEqual(await ok.queryStatus("E8U"), { resultCode: 0, processing: false, receipt: "SKQ96C7K7H", providerStatus: "SUCCESS", detail: null });
  const down = new HttpPayHeroClient(cfg, fakeFetch({ status: 500, body: {} }));
  // Never credit on transient. 0215 adds the HTTP status so a run of these reads as an outage
  // rather than being indistinguishable from "still queued".
  assert.deepEqual(await down.queryStatus("E8U"), { resultCode: null, processing: true, receipt: null, providerStatus: null, detail: "http_500" });
});

test("missingPayHeroCredentials requires basic_auth_token + channel_id", () => {
  assert.deepEqual(missingPayHeroCredentials(resolvePayHeroConfig({}, {} as any)), ["basic_auth_token", "channel_id"]);
  assert.deepEqual(missingPayHeroCredentials(resolvePayHeroConfig({ basicAuthToken: "t", channelId: "1" }, {} as any)), []);
});

test("UnconfiguredPayHeroClient fails loudly (never a phantom credit)", async () => {
  const c = new UnconfiguredPayHeroClient(["basic_auth_token"]);
  await assert.rejects(() => c.queryStatus("x"), /PAYHERO_NOT_CONFIGURED/);
});

test("ConfiguredPayHeroClient: no override / resolver throw -> env (behaviour-neutral stub in dev)", async () => {
  const noEnv = {} as NodeJS.ProcessEnv;
  const a = new ConfiguredPayHeroClient(async () => null, noEnv);
  assert.equal((await a.initiateStk({ amountCents: 20_000, msisdn: "0712345678", externalReference: "t" })).reference, "stub-ph-ref-1");
  const b = new ConfiguredPayHeroClient(async () => { throw new Error("db down"); }, noEnv);
  assert.equal((await b.initiateStk({ amountCents: 20_000, msisdn: "0712345678", externalReference: "t" })).reference, "stub-ph-ref-1");
});

test("ConfiguredPayHeroClient: complete override w/ prod env + missing channel -> fails loudly", async () => {
  const prod = { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
  const c = new ConfiguredPayHeroClient(async () => ({ basicAuthToken: "t" }), prod); // channel_id missing
  await assert.rejects(() => c.queryStatus("x"), /PAYHERO_NOT_CONFIGURED/);
});

// ── C2B ledger ingest (GET /transactions) — the authoritative source for manual paybill deposits ──

test("parsePayerMsisdn extracts the payer phone from PayHero's inbound description", () => {
  assert.equal(parsePayerMsisdn("Received KES 200 from 0798661061"), "0798661061");
  assert.equal(parsePayerMsisdn("Received KES 10 from 254712345678"), "254712345678");
  assert.equal(parsePayerMsisdn("Received KES 5 from +254712345678"), "+254712345678");
  assert.equal(parsePayerMsisdn("no phone here"), null);
  assert.equal(parsePayerMsisdn(null), null);
});

test("toInboundPayment maps a real inbound_payment row and rejects non-payments", () => {
  const row = {
    id: 5605294, account_id: 12038, transaction_type: "inbound_payment",
    description: "Received KES 200 from 0798661061", amount: 200,
    transaction_reference: "a9e7-44b5-968c-d43e11ff8d4f1118113", provider_reference: "UISMX7V2JV",
    external_reference: "0ff6dc63-48a4-4be5-82bc-0bb1b4a8cdf5", channel_id: 12226,
    created_at: "2026-09-28T09:12:19.620043Z",
  };
  const p = toInboundPayment(row);
  assert.ok(p);
  assert.equal(p!.mpesaCode, "UISMX7V2JV");
  assert.equal(p!.amountCents, 20_000);           // 200 KES -> 20000 cents
  assert.equal(p!.msisdn, "0798661061");
  assert.equal(p!.externalReference, "0ff6dc63-48a4-4be5-82bc-0bb1b4a8cdf5");
  // a fee row / non-inbound / zero / missing code are all skipped
  assert.equal(toInboundPayment({ ...row, transaction_type: "service_charge", amount: -8.9 }), null);
  assert.equal(toInboundPayment({ ...row, amount: 0 }), null);
  assert.equal(toInboundPayment({ ...row, provider_reference: "" }), null);
  assert.equal(toInboundPayment(null), null);
});

test("HttpPayHeroClient.listInboundPayments filters to inbound payments on our channel", async () => {
  const body = { transactions: [
    { transaction_type: "inbound_payment", amount: 200, provider_reference: "CODE200", description: "Received KES 200 from 0798661061", channel_id: 1487, transaction_reference: "r1", external_reference: "tx1", created_at: "t" },
    { transaction_type: "service_charge",  amount: -8.9, provider_reference: "cost_X",  description: "fee", channel_id: 1487, created_at: "t" },
    { transaction_type: "inbound_payment", amount: 50,  provider_reference: "OTHERCHAN", description: "Received KES 50 from 0711111111", channel_id: 9999, transaction_reference: "r2", external_reference: null, created_at: "t" },
  ] };
  const client = new HttpPayHeroClient(cfg, fakeFetch({ body })); // cfg.channelId = "1487"
  const out = await client.listInboundPayments();
  assert.equal(out.length, 1);
  assert.equal(out[0]!.mpesaCode, "CODE200");
  assert.equal(out[0]!.amountCents, 20_000);
});

test("HttpPayHeroClient.listInboundPayments returns [] on a transient error (never invents money)", async () => {
  const client = new HttpPayHeroClient(cfg, fakeFetch({ status: 502, body: {} }));
  assert.deepEqual(await client.listInboundPayments(), []);
});

test("initiateStk defaults provider m-pesa and forwards provider/network_code when given", async () => {
  let sent: any = null;
  const c1 = new HttpPayHeroClient(cfg, fakeFetch({ status: 201, body: { success: true, reference: "R", CheckoutRequestID: "ws" }, capture: (_u, i) => { sent = JSON.parse(i.body); } }));
  await c1.initiateStk({ amountCents: 20_000, msisdn: "0712345678", externalReference: "t" });
  assert.equal(sent.provider, "m-pesa");
  assert.equal("network_code" in sent, false);
  await c1.initiateStk({ amountCents: 20_000, msisdn: "0712345678", externalReference: "t", provider: "sasapay", networkCode: "63902" });
  assert.equal(sent.provider, "sasapay");
  assert.equal(sent.network_code, "63902");
});

test("StubPayHeroClient.listInboundPayments is empty (no network in dev/tests)", async () => {
  assert.deepEqual(await new StubPayHeroClient().listInboundPayments(), []);
});

test("buildLipwaUrl composes amount + reference and is robust to a messy base", () => {
  assert.equal(buildLipwaUrl("https://app.payhero.africa/lipwa/12038", { amountKes: 200, reference: "tx-1" }),
    "https://app.payhero.africa/lipwa/12038?amount=200&reference=tx-1");
  // trailing slash / stray query on the base are stripped; amount omitted when absent/invalid
  assert.equal(buildLipwaUrl("https://app.payhero.africa/lipwa/12038/?x=1", { reference: "tx-2" }),
    "https://app.payhero.africa/lipwa/12038?reference=tx-2");
  assert.equal(buildLipwaUrl("https://app.payhero.africa/lipwa/12038", { amountKes: 0, reference: "t" }),
    "https://app.payhero.africa/lipwa/12038?reference=t");
});

test("HttpPayHeroClient.lipwaLink returns null unless a Lipwa URL is configured", async () => {
  const withLipwa = new HttpPayHeroClient({ ...cfg, lipwaUrl: "https://app.payhero.africa/lipwa/12038" }, fakeFetch({}));
  assert.match((await withLipwa.lipwaLink({ amountKes: 200, reference: "r" }))!, /reference=r/);
  const noLipwa = new HttpPayHeroClient(cfg, fakeFetch({}));
  assert.equal(await noLipwa.lipwaLink({ reference: "r" }), null);
});

// ── Payout (withdraw) rail ────────────────────────────────────────────────────────────────────
const payoutCfg: PayHeroConfig = { ...cfg, accountId: "12038", withdrawChannelId: "1523" };

test("payHeroPayoutReady: needs creds + account_id + withdraw_channel_id", () => {
  assert.equal(payHeroPayoutReady(cfg), false);                                    // no account_id / withdraw channel
  assert.deepEqual(missingPayHeroPayoutConfig(cfg), ["account_id", "withdraw_channel_id"]);
  assert.equal(payHeroPayoutReady(payoutCfg), true);
  assert.deepEqual(missingPayHeroPayoutConfig(payoutCfg), []);
});

test("HttpPayHeroClient.withdraw posts the exact /withdraw contract + parses merchant_reference", async () => {
  let seen: any = {};
  const c = new HttpPayHeroClient(payoutCfg, fakeFetch({ status: 200, body: { status: "QUEUED", merchant_reference: "VAD145207801.eO", checkout_request_id: "VAD145207801.eO" }, capture: (_u, i) => (seen = i) }));
  const r = await c.withdraw({ amountCents: 2_100, msisdn: "254708344101", externalReference: "wd-1" });
  assert.deepEqual(r, { reference: "VAD145207801.eO", checkoutRequestId: "VAD145207801.eO" });
  const body = JSON.parse(seen.body);
  assert.equal(body.amount, 21);                 // cents -> whole KES
  assert.equal(body.phone_number, "0708344101"); // local form
  assert.equal(body.account_id, 12038);
  assert.equal(body.channel_id, 1523);           // the WITHDRAW channel, not the STK channel
  assert.equal(body.channel, "mobile");
  assert.equal(body.external_reference, "wd-1");
  assert.equal(seen.headers.Authorization, "Basic dXNlcjpwYXNz");
});

test("HttpPayHeroClient.withdraw refuses when the payout config is missing (never a blind payout)", async () => {
  const noChan = new HttpPayHeroClient(cfg, fakeFetch({ status: 200, body: {} }));
  await assert.rejects(() => noChan.withdraw({ amountCents: 2_100, msisdn: "0708344101", externalReference: "wd-1" }), /PAYHERO_WITHDRAW_NOT_CONFIGURED/);
  // bank channel requires an account number
  const bank = new HttpPayHeroClient(payoutCfg, fakeFetch({ status: 200, body: { merchant_reference: "x" } }));
  await assert.rejects(() => bank.withdraw({ amountCents: 2_100, msisdn: "0708344101", externalReference: "wd-1", channel: "bank" }), /PAYHERO_WITHDRAW_BANK_ACCOUNT_REQUIRED/);
});

test("HttpPayHeroClient.withdraw throws on rejection (no reference / !ok)", async () => {
  const c = new HttpPayHeroClient(payoutCfg, fakeFetch({ status: 400, body: { error_message: "bad" } }));
  await assert.rejects(() => c.withdraw({ amountCents: 2_100, msisdn: "0708344101", externalReference: "wd-1" }), /PAYHERO_WITHDRAW_REJECTED/);
});

test("payoutReady: Http reflects config; Unconfigured false; Configured delegates", async () => {
  assert.equal(await new HttpPayHeroClient(payoutCfg).payoutReady(), true);
  assert.equal(await new HttpPayHeroClient(cfg).payoutReady(), false);
  assert.equal(await new UnconfiguredPayHeroClient(["basic_auth_token"]).payoutReady(), false);
});
