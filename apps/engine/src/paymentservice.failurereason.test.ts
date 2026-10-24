import { test } from "node:test";
import assert from "node:assert/strict";
import { PaymentService, payHeroResultDesc, payHeroCallbackRef } from "./paymentservice.js";
import { InMemoryPaymentRepository } from "./payments.js";
import { StubDarajaClient } from "./daraja.js";
import { StubPayHeroClient, mapPayHeroStatus, HttpPayHeroClient, type PayHeroStatusResult } from "./payhero.js";

/**
 * 0215 — record WHY a deposit failed.
 *
 * THE REPORTED SYMPTOM. Every PayHero failure in production was stored identically. Measured on the
 * live database, 7 days to 2026-10-24:
 *   180 rows, all result_code=1, result_desc='reconciled:payhero:1', provider payload absent.
 * So Safaricom's 2028 ("not permitted according to product assignment" — our channel, fixable) was
 * indistinguishable from a 1032 (customer cancelled, not fixable). PayHero limits us on a failure
 * RATE, which cannot be managed without that split.
 *
 * THE MONEY INVARIANT these tests exist to protect: `resultCode === 0` and nothing else decides a
 * credit. Everything 0215 adds is descriptive and must not be able to move that decision.
 */

const PHONE = "0712345678";

function rig(payhero = new StubPayHeroClient()) {
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0);
  const svc = new PaymentService(repo, new StubDarajaClient(), { payhero });
  return { repo, svc };
}

// ── The money invariant ───────────────────────────────────────────────────────────────────────────

test("MONEY INVARIANT: adding a reason never changes which statuses credit", () => {
  // Byte-for-byte the pre-0215 mapping. If any of these move, a deposit credits (or fails to) wrongly.
  const credits = ["SUCCESS", "COMPLETED", "SUCCESSFUL"];
  const fails = ["FAILED", "CANCELLED", "CANCELED", "REVERSED", "DECLINED"];
  const pending = ["QUEUED", "PENDING", "", "WAT", "success "];   // trailing space is trimmed -> credits
  for (const s of credits) assert.equal(mapPayHeroStatus(s, "RCPT").resultCode, 0, `${s} must credit`);
  for (const s of fails) assert.equal(mapPayHeroStatus(s, "RCPT").resultCode, 1, `${s} must fail`);
  for (const s of pending.slice(0, 4)) assert.equal(mapPayHeroStatus(s, "RCPT").resultCode, null, `${s} must stay pending`);
  // A receipt is still dropped on failure, and "N/A" is still not a receipt.
  assert.equal(mapPayHeroStatus("FAILED", "RCPT").receipt, null);
  assert.equal(mapPayHeroStatus("SUCCESS", "N/A").receipt, null);
});

test("MONEY INVARIANT: a detail string cannot turn a failure into a credit", () => {
  // The worst case: a provider sends a payload whose text says success while the status says failed.
  const q = mapPayHeroStatus("FAILED", "RCPT", "code=0 The service request has been accepted successfully");
  assert.equal(q.resultCode, 1, "the status word decides, never the prose");
  assert.equal(q.receipt, null);
});

// ── The reason actually survives ──────────────────────────────────────────────────────────────────

test("the provider's own status word survives the mapping", () => {
  assert.equal(mapPayHeroStatus("CANCELLED", null).providerStatus, "CANCELLED");
  assert.equal(mapPayHeroStatus("FAILED", null, "code=2028 The request is not permitted according to product assignment.").detail,
    "code=2028 The request is not permitted according to product assignment.");
});

test("result_desc now distinguishes the two failures that used to look identical", () => {
  const cancelled = payHeroResultDesc({ resultCode: 1, providerStatus: "CANCELLED", detail: "code=1032 Request cancelled by user" });
  const misconfigured = payHeroResultDesc({ resultCode: 1, providerStatus: "FAILED", detail: "code=2028 The request is not permitted according to product assignment." });
  assert.notEqual(cancelled, misconfigured, "this is the whole point: customer-cancelled vs our broken channel");
  assert.match(cancelled, /1032/);
  assert.match(misconfigured, /2028/);
});

test("a row is never LESS informative than before 0215", () => {
  // Provider told us nothing -> we still emit exactly the old string, so nothing regresses.
  assert.equal(payHeroResultDesc({ resultCode: 1 }), "reconciled:payhero:1");
  assert.equal(payHeroResultDesc({ resultCode: 0, providerStatus: null, detail: null }), "reconciled:payhero:0");
});

test("result_desc is capped — the column is unbounded text and fn_complete_deposit does not truncate", () => {
  const huge = payHeroResultDesc({ resultCode: 1, providerStatus: "FAILED", detail: "x".repeat(5000) });
  assert.equal(huge.length, 200);
});

// ── provider-never-responds ───────────────────────────────────────────────────────────────────────

test("PROVIDER NEVER RESPONDS: an HTTP error stays pending and credits nothing, but says so", async () => {
  const c = new HttpPayHeroClient(
    { baseUrl: "https://x/api/v2", basicAuthToken: "t", channelId: "1" },
    (async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch);
  const q = await c.queryStatus("ref-1");
  assert.equal(q.resultCode, null, "a provider we cannot reach must never settle a deposit");
  assert.equal(q.processing, true);
  assert.equal(q.detail, "http_502", "a run of these must be visible as an outage, not as 'still queued'");
});

test("a provider that returns junk JSON still does not credit", async () => {
  const c = new HttpPayHeroClient(
    { baseUrl: "https://x/api/v2", basicAuthToken: "t", channelId: "1" },
    (async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })) as unknown as typeof fetch);
  const q = await c.queryStatus("ref-1");
  assert.equal(q.resultCode, null);
});

// ── finding the row the callback is about ─────────────────────────────────────────────────────────

test("the callback reference is found under every name PayHero uses", () => {
  // The real production body (from the 2026-10-24 incident) names the row by its ws_CO id, which our
  // rail stores in merchant_request_id — not checkout_request_id. Reading only one would miss it.
  assert.equal(payHeroCallbackRef({
    CheckoutRequestID: "ws_CO_24102026132400828712370430",
    MerchantRequestID: "1068-411a-9c70-14d35a8b2d7c175118",
    ResultCode: "2028",
  }), "ws_CO_24102026132400828712370430");
  assert.equal(payHeroCallbackRef({ external_reference: "tx-1" }), "tx-1");
  assert.equal(payHeroCallbackRef({ response: { ExternalReference: "tx-2" } }), "tx-2");
  assert.equal(payHeroCallbackRef({ reference: "E8UWT7CLUW" }), "E8UWT7CLUW");
});

test("a body naming nothing we own resolves to null rather than guessing", () => {
  assert.equal(payHeroCallbackRef({}), null);
  assert.equal(payHeroCallbackRef(null), null);
  assert.equal(payHeroCallbackRef({ CheckoutRequestID: "   " }), null);
  assert.equal(payHeroCallbackRef("not an object"), null);
});

// ── end to end, through the service ───────────────────────────────────────────────────────────────

test("THE SYMPTOM: the 2028 body is stored against its deposit, where it used to vanish", async () => {
  const { repo, svc } = rig();
  const { txId, reference } = await svc.initiatePayHeroDeposit("u1", 100_000, PHONE);
  const body = {
    CheckoutRequestID: reference, MerchantRequestID: "1068-411a", ResponseCode: "0",
    ResultCode: "2028", ResultDesc: "The request is not permitted according to product assignment.",
  };
  await svc.handlePayHeroCallback(body);
  const stored = await repo.recordProviderCallback(reference, body);
  assert.equal(stored, true, "the reference must resolve to a real deposit row");
  assert.ok(txId);
});

test("DUPLICATE/CONCURRENT: a replayed callback is idempotent and credits nothing twice", async () => {
  const { repo, svc } = rig();
  const { reference } = await svc.initiatePayHeroDeposit("u1", 100_000, PHONE);
  const body = { CheckoutRequestID: reference, ResultCode: "2028" };
  const before = await repo.getBalance("u1");
  await Promise.all([svc.handlePayHeroCallback(body), svc.handlePayHeroCallback(body), svc.handlePayHeroCallback(body)]);
  // The stub reports SUCCESS, so the sweep settles once; three callbacks must not credit three times.
  const after = await repo.getBalance("u1");
  assert.equal(after - before, 100_000, "exactly one credit for one deposit, however many callbacks arrive");
});

test("a callback that names nothing we own never throws and never settles", async () => {
  const { repo, svc } = rig();
  const before = await repo.getBalance("u1");
  await assert.doesNotReject(() => svc.handlePayHeroCallback({ nothing: "useful" }));
  assert.equal(await repo.getBalance("u1"), before);
});

test("recording the body is not trusting it: a forged success body credits nothing on its own", async () => {
  // The client never reaches a terminal state, so the authoritative sweep says 'still processing'.
  class NeverSettles extends StubPayHeroClient {
    override async queryStatus(): Promise<PayHeroStatusResult> {
      return { resultCode: null, processing: true, receipt: null, providerStatus: "QUEUED", detail: null };
    }
  }
  const { repo, svc } = rig(new NeverSettles());
  const { reference } = await svc.initiatePayHeroDeposit("u1", 100_000, PHONE);
  const before = await repo.getBalance("u1");
  await svc.handlePayHeroCallback({ CheckoutRequestID: reference, ResultCode: "0", ResultDesc: "Success", amount: 999999 });
  assert.equal(await repo.getBalance("u1"), before, "a forged callback must not mint balance");
});
