import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HttpFinoqClient, StubFinoqClient, UnconfiguredFinoqClient, mapFinoqStatus, parseDiscovery, toE164,
  missingFinoqConfig, resolveFinoqConfig, makeFinoqClientFromConfig,
  FINOQ_MPESA, FINOQ_AIRTEL, type FinoqConfig,
} from "./finoq.js";
import type { Cents } from "@invest254/shared";

/**
 * FinoQ — the PayHero Africa "Global" rail.
 *
 * Everything asserted here was observed against the LIVE API on 2026-10-24, including the two traps
 * that make a naive integration lose money:
 *
 *   1. The create response's `success` field lies. A payment that settled came back
 *      {"success": false, "ResponseCode": "-1", "message": "Success"}. Reading it would have
 *      abandoned a deposit the customer had already paid.
 *   2. transaction-status keys on the MERCHANT reference. The checkout_request_id — the obvious
 *      choice, and the one the create response shows most prominently — returns a flat 404.
 *
 * And the pending case: ResultCode "-1" with "Transaction Pending" is NOT a failure. Treating any
 * non-zero code as failed would mark settling deposits failed and strand real customer money.
 */

const cfg: FinoqConfig = {
  baseUrl: "https://api.finoq.africa", basicAuthToken: "tok", vendorId: "12038",
  country: "KE", currency: "KES", callbackUrl: "https://api.test/cb",
};

/** The real discovery body, trimmed to the shape the parser reads. */
const DISCOVERY = {
  rails: { bank: true, card: false, crypto: false, momo: true },
  has_networks: true, country: "KE", currency: "KES",
  available_providers: { bank: ["viewtech"], momo: ["viewtech"] },
  provider_networks: {
    viewtech: [
      { channel_type: "momo", country: "KE", id: "63902-deposit", max_amount: 150000, min_amount: 1, name: "M-PESA", network_code: "63902", network_id: "63902", network_name: "M-PESA", provider: "viewtech", ramp_type: "deposit", status: "active" },
      { channel_type: "momo", country: "KE", id: "63902-withdraw", max_amount: 150000, min_amount: 1, name: "M-PESA", network_code: "63902", network_id: "63902", network_name: "M-PESA", provider: "viewtech", ramp_type: "withdraw", status: "active" },
      { channel_type: "momo", country: "KE", id: "63903-deposit", max_amount: 150000, min_amount: 1, name: "Airtel Money", network_code: "63903", network_id: "63903", network_name: "Airtel Money", provider: "viewtech", ramp_type: "deposit", status: "active" },
      { channel_type: "bank", country: "KE", id: "35-deposit", max_amount: 1000000, min_amount: 1, name: "ABC Bank", network_code: "35", network_id: "35", network_name: "ABC Bank", provider: "viewtech", ramp_type: "deposit", status: "active" },
      { channel_type: "momo", country: "KE", id: "63907-deposit", max_amount: 150000, min_amount: 1, name: "T-Kash", network_code: "63907", network_id: "63907", network_name: "T-Kash", provider: "viewtech", ramp_type: "deposit", status: "inactive" },
    ],
  },
};
/** Uganda, as the live API returns it for this account: reachable, but nothing enabled. */
const DISCOVERY_EMPTY = { rails: { bank: false, card: false, crypto: false, momo: false }, has_networks: false, country: "UG", currency: "UGX", available_providers: {}, provider_networks: {} };

function fakeFetch(handler: (url: string, init: any) => { status: number; body: unknown }) {
  return (async (url: string, init: any) => {
    const r = handler(String(url), init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
}

// ── status mapping: the money decision ────────────────────────────────────────────────────────────

test("MONEY: only ResultCode 0 credits", () => {
  assert.equal(mapFinoqStatus({ ResultCode: "0", ResultDesc: "Transaction Successful" }).resultCode, 0);
  assert.equal(mapFinoqStatus({ ResultCode: "1", ResultDesc: "Insufficient" }).resultCode, 1);
  assert.equal(mapFinoqStatus({ ResultCode: "2035", ResultDesc: "The customer does not exist." }).resultCode, 1);
});

test("MONEY: ResultCode -1 'Transaction Pending' must NOT settle — it is the live pending signal", () => {
  // Observed verbatim: {"ResponseCode":"1","ResultCode":"-1","ResultDesc":"Transaction Pending"}
  const q = mapFinoqStatus({ ResponseCode: "1", ResultCode: "-1", ResultDesc: "Transaction Pending", ErrorMessage: "Transaction Pending" });
  assert.equal(q.resultCode, null, "treating -1 as failed would strand money the customer already paid");
  assert.equal(q.processing, true);
});

test("MONEY: an empty or absent ResultCode leaves the deposit pending, never failed", () => {
  assert.equal(mapFinoqStatus({}).resultCode, null);
  assert.equal(mapFinoqStatus({ ResultDesc: "who knows" }).resultCode, null);
  assert.equal(mapFinoqStatus({ ResultCode: "" }).resultCode, null);
});

test("MONEY: a receipt is kept on success and dropped on failure", () => {
  assert.equal(mapFinoqStatus({ ResultCode: "0", provider_reference: "UJOJGBAN1J" }).receipt, "UJOJGBAN1J");
  assert.equal(mapFinoqStatus({ ResultCode: "1", provider_reference: "UJOJGBAN1J" }).receipt, null);
  assert.equal(mapFinoqStatus({ ResultCode: "0", provider_reference: "N/A" }).receipt, null);
});

test("the provider's reason rides along for result_desc", () => {
  const q = mapFinoqStatus({ ResultCode: "2035", ResultDesc: "The customer does not exist." });
  assert.equal(q.providerStatus, "2035");
  assert.equal(q.detail, "The customer does not exist.");
});

// ── discovery ─────────────────────────────────────────────────────────────────────────────────────

test("discovery keeps active deposit networks only, deduped", () => {
  const nets = parseDiscovery(DISCOVERY);
  const codes = nets.map((n) => n.networkCode).sort();
  assert.deepEqual(codes, ["35", "63902", "63903"], "withdraw duplicates and inactive networks are excluded");
  const airtel = nets.find((n) => n.networkCode === FINOQ_AIRTEL)!;
  assert.equal(airtel.networkName, "Airtel Money");
  assert.equal(airtel.accountType, "momo");
  assert.equal(airtel.provider, "viewtech");
});

test("a country with nothing enabled yields no networks, so the rail is simply not offered", () => {
  assert.deepEqual(parseDiscovery(DISCOVERY_EMPTY), [], "Uganda on this account: has_networks false");
});

// ── initiate ──────────────────────────────────────────────────────────────────────────────────────

test("TRAP 1: a settled payment reporting success:false must still be accepted", async () => {
  // The exact live response: success false, ResponseCode -1, yet the payment went on to settle.
  let seen: any = null;
  const c = new HttpFinoqClient(cfg, fakeFetch((url, init) => {
    if (url.includes("discover-rails")) return { status: 200, body: DISCOVERY };
    seen = JSON.parse(init.body);
    return { status: 200, body: {
      status_code: "200", merchant_reference: "OJD135721115.iI", transaction_type: "payin",
      success: false, message: "Success", checkout_request_id: "32f2016a-99d0-4943-82f1-555c8de328e6",
      gateway: "sasapay", provider_response: { ResponseCode: "-1" } } };
  }));
  const r = await c.initiate({ amountCents: 1000 as Cents, msisdn: "0713572703", externalReference: "tx-1" });
  assert.equal(r.reference, "OJD135721115.iI", "the MERCHANT reference is what status queries accept");
  assert.equal(r.checkoutRequestId, "32f2016a-99d0-4943-82f1-555c8de328e6");
  assert.equal(r.gateway, "sasapay");
  // ...and the body we sent matches the documented schema.
  assert.equal(seen.request_type, "payment");
  assert.equal(seen.amount, 10, "cents -> whole KES");
  assert.equal(seen.currency, "KES");
  assert.equal(seen.vendor_config.vendor_id, 12038, "vendor_id is numeric");
  assert.equal(seen.provider_config.network_code, FINOQ_MPESA, "defaults to M-Pesa");
  assert.equal(seen.provider_config.account_type, "momo");
  assert.equal(seen.payment_config.reference, "tx-1", "our txId is the reference FinoQ echoes back");
  assert.equal(seen.payment_config.account_number, "+254713572703", "E.164 with the plus");
  assert.equal(seen.customer.phone, "+254713572703");
  assert.equal(seen.payment_config.callback_url, "https://api.test/cb");
});

test("Airtel Money routes on its own network code", async () => {
  let seen: any = null;
  const c = new HttpFinoqClient(cfg, fakeFetch((url, init) => {
    if (url.includes("discover-rails")) return { status: 200, body: DISCOVERY };
    seen = JSON.parse(init.body);
    return { status: 200, body: { merchant_reference: "AIRTEL1", checkout_request_id: "co-1" } };
  }));
  await c.initiate({ amountCents: 5000 as Cents, msisdn: "0730000000", externalReference: "tx-a", networkCode: FINOQ_AIRTEL });
  assert.equal(seen.provider_config.network_code, FINOQ_AIRTEL);
  assert.equal(seen.provider_config.network_name, "Airtel Money");
  assert.equal(seen.transaction_channel, "momo");
});

test("a network that discovery does not offer is refused BEFORE any money moves", async () => {
  const c = new HttpFinoqClient(cfg, fakeFetch((url) =>
    url.includes("discover-rails") ? { status: 200, body: DISCOVERY } : { status: 200, body: { merchant_reference: "X" } }));
  // 63907 T-Kash is present but inactive in the live body, so it must not be chargeable.
  await assert.rejects(() => c.initiate({ amountCents: 1000 as Cents, msisdn: "0770000000", externalReference: "t", networkCode: "63907" }),
    /FINOQ_NETWORK_UNAVAILABLE:63907/);
  await assert.rejects(() => c.initiate({ amountCents: 1000 as Cents, msisdn: "0700000000", externalReference: "t", networkCode: "99999" }),
    /FINOQ_NETWORK_UNAVAILABLE/);
});

test("the network's own min/max are enforced before the call", async () => {
  const c = new HttpFinoqClient(cfg, fakeFetch((url) =>
    url.includes("discover-rails") ? { status: 200, body: DISCOVERY } : { status: 200, body: { merchant_reference: "X" } }));
  await assert.rejects(() => c.initiate({ amountCents: 20_000_000 as Cents, msisdn: "0712345678", externalReference: "t" }),
    /FINOQ_ABOVE_NETWORK_MAX:150000/);
});

test("a rejected initiate throws and never invents a reference", async () => {
  const c = new HttpFinoqClient(cfg, fakeFetch((url) =>
    url.includes("discover-rails") ? { status: 200, body: DISCOVERY }
      : { status: 400, body: { error_message: "Failed to perform request" } }));
  await assert.rejects(() => c.initiate({ amountCents: 1000 as Cents, msisdn: "0712345678", externalReference: "t" }),
    /FINOQ_INITIATE_REJECTED_400/);
});

test("a 200 with no usable reference is still a rejection", async () => {
  const c = new HttpFinoqClient(cfg, fakeFetch((url) =>
    url.includes("discover-rails") ? { status: 200, body: DISCOVERY } : { status: 200, body: { success: true } }));
  await assert.rejects(() => c.initiate({ amountCents: 1000 as Cents, msisdn: "0712345678", externalReference: "t" }),
    /FINOQ_INITIATE_REJECTED/);
});

// ── status query ──────────────────────────────────────────────────────────────────────────────────

test("TRAP 2: the status query posts request_id — the merchant reference", async () => {
  let seen: any = null; let seenUrl = "";
  const c = new HttpFinoqClient(cfg, fakeFetch((url, init) => {
    seenUrl = url; seen = JSON.parse(init.body);
    return { status: 200, body: { ResultCode: "0", ResultDesc: "Transaction Successful" } };
  }));
  const q = await c.queryStatus("OJD135721115.iI");
  assert.match(seenUrl, /\/api\/global\/transaction-status$/);
  assert.deepEqual(seen, { request_id: "OJD135721115.iI" });
  assert.equal(q.resultCode, 0);
});

test("PROVIDER NEVER RESPONDS: a transport error leaves it pending and credits nothing", async () => {
  const c = new HttpFinoqClient(cfg, fakeFetch(() => ({ status: 502, body: {} })));
  const q = await c.queryStatus("ref");
  assert.equal(q.resultCode, null);
  assert.equal(q.processing, true);
  assert.equal(q.detail, "http_502");
});

test("a 404 from the status query is lag, not failure — it must never settle the deposit", async () => {
  const c = new HttpFinoqClient(cfg, fakeFetch(() => ({ status: 404, body: { error_code: "resource_not_found" } })));
  const q = await c.queryStatus("ref");
  assert.equal(q.resultCode, null, "a reference we just stored is ours; 404 means not-yet, not failed");
  assert.equal(q.processing, true);
});

// ── phone + config ────────────────────────────────────────────────────────────────────────────────

test("phones become E.164 with the plus, from every local form", () => {
  for (const given of ["0713572703", "254713572703", "+254713572703", "713572703", "0713 572 703"]) {
    assert.equal(toE164(given), "+254713572703", given);
  }
});

test("config: the Global rail reuses the PayHero credentials and account id", () => {
  const c = resolveFinoqConfig({}, { PAYHERO_BASIC_AUTH_TOKEN: "tok", PAYHERO_ACCOUNT_ID: "12038" } as never);
  assert.equal(c.basicAuthToken, "tok", "their docs: both hosts accept the same API key");
  assert.equal(c.vendorId, "12038");
  assert.equal(c.baseUrl, "https://api.finoq.africa");
  assert.deepEqual(missingFinoqConfig(c), []);
});

test("config: incomplete config names exactly what is missing", () => {
  assert.deepEqual(missingFinoqConfig(resolveFinoqConfig({}, {} as never)), ["basic_auth_token", "vendor_id"]);
});

test("unconfigured in production fails loudly and offers no networks — never a phantom credit", async () => {
  const c = makeFinoqClientFromConfig({}, { NODE_ENV: "production" } as never);
  assert.ok(c instanceof UnconfiguredFinoqClient);
  await assert.rejects(() => c.initiate({ amountCents: 1000 as Cents, msisdn: "0712345678", externalReference: "t" }), /FINOQ_NOT_CONFIGURED/);
  await assert.rejects(() => c.queryStatus("x"), /FINOQ_NOT_CONFIGURED/);
  assert.deepEqual(await c.discoverNetworks("KE"), [], "no networks => the rail is not offered at all");
});

test("the stub refuses a network it does not have, like the real client", async () => {
  const s = new StubFinoqClient();
  await assert.rejects(() => s.initiate({ amountCents: 1000 as Cents, msisdn: "0712345678", externalReference: "t", networkCode: "99999" }),
    /FINOQ_NETWORK_UNAVAILABLE/);
});

test("discovery is cached, so it stays off the deposit hot path", async () => {
  let calls = 0;
  let clock = 0;
  const c = new HttpFinoqClient(cfg, fakeFetch((url) => {
    if (url.includes("discover-rails")) { calls += 1; return { status: 200, body: DISCOVERY }; }
    return { status: 200, body: { merchant_reference: "R" } };
  }), () => clock);
  await c.discoverNetworks("KE");
  await c.discoverNetworks("KE");
  assert.equal(calls, 1, "second call served from cache");
  clock += 300_001;
  await c.discoverNetworks("KE");
  assert.equal(calls, 2, "and refreshed once the cache expires");
});
