import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPaymentRepository } from "./payments.js";
import { StubDarajaClient } from "./daraja.js";
import { PaymentService } from "./paymentservice.js";
import {
  StubMegaPayClient, HttpMegaPayClient, UnconfiguredMegaPayClient, mapMegaStatus,
  makeMegaPayClientFromConfig, resolveMegaPayConfig, missingMegaPayCredentials, type MegaPayClient,
} from "./megapay.js";

// ── mapMegaStatus: TransactionStatus -> {resultCode, processing, receipt} ─────────────────────────
test("mapMegaStatus: Completed -> paid(0), Pending -> processing, Failed -> failed(1)", () => {
  assert.deepEqual(mapMegaStatus("Completed", "RCPT01"), { resultCode: 0, processing: false, receipt: "RCPT01" });
  assert.deepEqual(mapMegaStatus("completed", "N/A"), { resultCode: 0, processing: false, receipt: null }); // N/A scrubbed
  assert.deepEqual(mapMegaStatus("Pending", "N/A"), { resultCode: null, processing: true, receipt: null });
  assert.deepEqual(mapMegaStatus("Failed", "x"), { resultCode: 1, processing: false, receipt: null });
  assert.deepEqual(mapMegaStatus("Cancelled", null), { resultCode: 1, processing: false, receipt: null });
  assert.deepEqual(mapMegaStatus("weird-unknown", null), { resultCode: null, processing: true, receipt: null }); // never auto-credit
});

// ── HttpMegaPayClient with a fake fetch (contract from the live sandbox) ─────────────────────────
function fakeFetch(handler: (url: string, body: any) => { status?: number; json: any }): typeof fetch {
  return (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const { status = 200, json } = handler(String(url), body);
    return { ok: status >= 200 && status < 300, status, json: async () => json } as any;
  }) as unknown as typeof fetch;
}

test("HttpMegaPayClient.initiateStk: sends whole KES + parses ids; rejects non-zero ResponseCode", async () => {
  let seen: any = null;
  const c = new HttpMegaPayClient(
    { env: "sandbox", apiKey: "K", email: "e@x", baseUrl: "https://megapay.co.ke/backend/v2" },
    fakeFetch((url, body) => {
      seen = { url, body };
      return { json: { ResponseCode: "0", success: "200", transaction_request_id: "SANDBOX123", CheckoutRequestID: "ws_CO_1", MerchantRequestID: "mr_1", environment: "sandbox" } };
    }));
  const r = await c.initiateStk({ amountCents: 5000, msisdn: "0712345678", reference: "Invest254" });
  assert.equal(seen.url, "https://megapay.co.ke/backend/v2/initiatestk");
  assert.equal(seen.body.amount, "50");          // 5000 cents -> KES 50 whole
  assert.equal(seen.body.api_key, "K");
  assert.equal(seen.body.msisdn, "0712345678");
  assert.deepEqual(r, { transactionRequestId: "SANDBOX123", checkoutRequestId: "ws_CO_1", merchantRequestId: "mr_1" });

  const bad = new HttpMegaPayClient({ env: "sandbox", apiKey: "K", email: "e@x", baseUrl: "https://x/v2" },
    fakeFetch(() => ({ json: { ResponseCode: "1", message: "bad key" } })));
  await assert.rejects(() => bad.initiateStk({ amountCents: 5000, msisdn: "0712345678", reference: "r" }), /MEGAPAY_INITIATE_REJECTED/);
});

test("HttpMegaPayClient.queryStatus: Completed credits, Pending waits, 102 not-found -> processing", async () => {
  const mk = (json: any) => new HttpMegaPayClient({ env: "sandbox", apiKey: "K", email: "e", baseUrl: "https://x/v2" }, fakeFetch(() => ({ json })));
  assert.deepEqual(await mk({ ResultCode: "200", TransactionStatus: "Completed", TransactionReceipt: "SANDBOXABC" }).queryStatus("t"),
    { resultCode: 0, processing: false, receipt: "SANDBOXABC" });
  assert.deepEqual(await mk({ ResultCode: "200", TransactionStatus: "Pending", TransactionReceipt: "N/A" }).queryStatus("t"),
    { resultCode: null, processing: true, receipt: null });
  assert.deepEqual(await mk({ ResultCode: "102", errorMessage: "Transaction not found" }).queryStatus("t"),
    { resultCode: null, processing: true, receipt: null });
});

// ── config resolution / fail-loud ────────────────────────────────────────────────────────────────
test("makeMegaPayClientFromConfig: prod + missing creds -> Unconfigured (never a phantom-crediting stub)", () => {
  assert.ok(makeMegaPayClientFromConfig({}, { MEGAPAY_ENV: "sandbox" } as any) instanceof StubMegaPayClient);
  assert.ok(makeMegaPayClientFromConfig({}, { MEGAPAY_ENV: "production" } as any) instanceof UnconfiguredMegaPayClient);
  assert.deepEqual(missingMegaPayCredentials(resolveMegaPayConfig({}, {} as any)), ["apiKey", "email"]);
});

// ── PaymentService: full Mega Pay deposit flow ─────────────────────────────────────────────────────
function rig(megapay: MegaPayClient = new StubMegaPayClient()) {
  const repo = new InMemoryPaymentRepository();
  repo.seed("u", 100_000);
  const svc = new PaymentService(repo, new StubDarajaClient(), { megapay });
  return { repo, svc };
}

test("PaymentService.initiateMegaPayDeposit -> callback credits; idempotent", async () => {
  const { repo, svc } = rig();
  const { txId, transactionRequestId } = await svc.initiateMegaPayDeposit("u", 50_000, "0712345678");
  assert.ok(txId && transactionRequestId);
  const c1 = await svc.handleMegaPayCallback(transactionRequestId, { environment: "sandbox" });
  assert.deepEqual(c1, { applied: true, status: "success", newBalance: 150_000 });
  const c2 = await svc.handleMegaPayCallback(transactionRequestId, {}); // retry must not double-credit
  assert.equal(c2.applied, false);
  assert.equal(await repo.getBalance("u"), 150_000);
});

test("PaymentService: Mega Pay honours the same deposit floors + phone validation", async () => {
  const { svc } = rig();
  await assert.rejects(() => svc.initiateMegaPayDeposit("u", 9_999, "0712345678"), /BELOW_MIN/);
  await assert.rejects(() => svc.initiateMegaPayDeposit("u", 0, "0712345678"), /INVALID_AMOUNT/);
  await assert.rejects(() => svc.initiateMegaPayDeposit("u", 50_000, "nope"), /INVALID_PHONE/);
});

test("PaymentService: callback NEVER trusts the wire — pending status leaves deposit uncredited", async () => {
  const pending: MegaPayClient = { async initiateStk() { return { transactionRequestId: "T1", checkoutRequestId: "C1", merchantRequestId: "M1" }; },
    async queryStatus() { return { resultCode: null, processing: true, receipt: null }; } };
  const { repo, svc } = rig(pending);
  const { transactionRequestId } = await svc.initiateMegaPayDeposit("u", 50_000, "0712345678");
  await assert.rejects(() => svc.handleMegaPayCallback(transactionRequestId, {}), /MEGAPAY_VERIFY_PENDING/);
  assert.equal(await repo.getBalance("u"), 100_000); // unchanged
});

test("PaymentService: rails are isolated — Daraja reconcile ignores Mega Pay deposits and vice-versa", async () => {
  // A Mega Pay deposit left pending (stub query says paid), plus a Daraja deposit left pending.
  const { repo, svc } = rig();
  await svc.initiateMegaPayDeposit("u", 50_000, "0712345678"); // provider megapay, pending
  await svc.initiateDeposit("u", 50_000, "0712345678");        // provider mpesa, pending
  const daraja = await svc.reconcileDeposits({ olderThanMs: 0 });   // Daraja sweep -> only the mpesa row
  assert.equal(daraja.scanned, 1);
  const mega = await svc.reconcileMegaPayDeposits({ olderThanMs: 0 }); // Mega Pay sweep -> only the megapay row
  assert.equal(mega.scanned, 1);
  assert.equal(mega.settled, 1); // stub says Completed -> credited
});

test("PaymentService.listDepositProviders: fail-open to M-Pesa when the lookup throws", async () => {
  const repo = new InMemoryPaymentRepository();
  (repo as any).listEffectiveProviders = async () => { throw new Error("db down"); };
  const svc = new PaymentService(repo, new StubDarajaClient(), { megapay: new StubMegaPayClient() });
  assert.deepEqual(await svc.listDepositProviders("site"), [{ code: "mpesa", displayName: "M-Pesa" }]);
});

test("PaymentService: Mega Pay methods refuse when no client is configured", async () => {
  const repo = new InMemoryPaymentRepository(); repo.seed("u", 100_000);
  const svc = new PaymentService(repo, new StubDarajaClient()); // no megapay
  await assert.rejects(() => svc.initiateMegaPayDeposit("u", 50_000, "0712345678"), /MEGAPAY_NOT_CONFIGURED/);
});

test("PaymentService: Mega Pay reference (Account no.) is the site name in UPPERCASE", async () => {
  const repo = new InMemoryPaymentRepository(); repo.seed("u", 100_000);
  let seenRef = "";
  const capturing: MegaPayClient = {
    async initiateStk(a) { seenRef = a.reference; return { transactionRequestId: "T", checkoutRequestId: "C", merchantRequestId: "M" }; },
    async queryStatus() { return { resultCode: 0, processing: false, receipt: "R" }; },
  };
  // Per-brand account ref resolves to a mixed-case site name; the prompt reference must be uppercased.
  const svc = new PaymentService(repo, new StubDarajaClient(), { megapay: capturing, accountRefForSite: () => "Tamu Traders" });
  await svc.initiateMegaPayDeposit("u", 50_000, "0712345678", "site-1");
  assert.equal(seenRef, "TAMUTRADERS"); // sanitised (alphanumeric, <=12) + uppercased
});
