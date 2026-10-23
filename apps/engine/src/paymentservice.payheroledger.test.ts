import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPaymentRepository } from "./payments.js";
import { PaymentService } from "./paymentservice.js";
import type { PayHeroClient, PayHeroInboundPayment } from "./payhero.js";

/**
 * `reconcilePayHeroLedger` must credit a payment to the deposit it belongs to, and ingest ONLY the
 * ones it does not own (BUGLOG #163 part 2).
 *
 * The bug: a PayHero **STK** deposit sends our `transactions.id` as PayHero's `external_reference`,
 * but stores PayHero's own reference in `checkout_request_id`. The matcher asked only "is this a
 * checkout_request_id we own?", so it never matched one — the auto-credit branch had never fired for
 * STK, and every payment was ingested as a claimable shadow of a deposit its callback had already
 * credited. 452 such rows in production, 0 matching a checkout_request_id.
 *
 * Lipwa is the control: it stores `checkout_request_id = txId`, so it always matched and must keep
 * working unchanged.
 */
function ledgerClient(rows: PayHeroInboundPayment[]): PayHeroClient {
  return {
    initiateStk: async () => ({ reference: "ph-ref", checkoutRequestId: "ws_CO_1" }),
    queryStatus: async () => ({ resultCode: null, processing: true, receipt: null }),
    listInboundPayments: async () => rows,
    lipwaLink: async () => "https://lipwa.test/pay",
    withdraw: async () => ({ reference: "wd", checkoutRequestId: "wd-co" }),
    payoutReady: async () => true,
  };
}

function rig(ledger: PayHeroInboundPayment[]) {
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0);
  const svc = new PaymentService(repo, {
    stkPush: async () => ({ merchantRequestId: "m", checkoutRequestId: "c" }),
    stkPushQuery: async () => ({ resultCode: 0, processing: false }),
    b2cPayment: async () => ({ conversationId: "x" }),
  }, { payhero: ledgerClient(ledger) });
  return { repo, svc };
}

const payment = (o: { code: string; cents: number; ref: string | null }): PayHeroInboundPayment => ({
  mpesaCode: o.code, amountCents: o.cents as never, msisdn: "254700000001",
  externalReference: o.ref, reference: "ph-txn", at: new Date().toISOString(),
});

test("THE FIX: an STK deposit's ledger payment is CREDITED, not ingested as a claimable shadow", async () => {
  // An STK deposit exactly as initiatePayHeroDeposit leaves it: checkout_request_id is PayHero's
  // reference, while the ledger echoes our txId back as external_reference.
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0);
  const txId = await repo.createDepositProvider("u1", 20000, "254700000001", "payhero");
  await repo.attachStk(txId, "ws_CO_1", "PAYHERO-REF-1");
  const svc = new PaymentService(repo, {
    stkPush: async () => ({ merchantRequestId: "m", checkoutRequestId: "c" }),
    stkPushQuery: async () => ({ resultCode: 0, processing: false }),
    b2cPayment: async () => ({ conversationId: "x" }),
  }, { payhero: ledgerClient([payment({ code: "UJ1STK", cents: 20000, ref: txId })]) });

  const r = await svc.reconcilePayHeroLedger();
  assert.equal(r.settled, 1, "the deposit was credited through its own transaction");
  assert.equal(r.ingested, 0, "and NOT left as a claimable shadow");
  assert.equal(await repo.getBalance("u1"), 20000);
});

test("crediting through the ledger is idempotent — a second sweep does not pay twice", async () => {
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0);
  const txId = await repo.createDepositProvider("u1", 20000, "254700000001", "payhero");
  await repo.attachStk(txId, "ws_CO_1", "PAYHERO-REF-1");
  const svc = new PaymentService(repo, {
    stkPush: async () => ({ merchantRequestId: "m", checkoutRequestId: "c" }),
    stkPushQuery: async () => ({ resultCode: 0, processing: false }),
    b2cPayment: async () => ({ conversationId: "x" }),
  }, { payhero: ledgerClient([payment({ code: "UJ1STK", cents: 20000, ref: txId })]) });

  await svc.reconcilePayHeroLedger();
  const second = await svc.reconcilePayHeroLedger();
  assert.equal(second.settled, 0, "already terminal -> applied false");
  assert.equal(second.ingested, 0, "and still never ingested");
  assert.equal(await repo.getBalance("u1"), 20000, "exactly one credit");
});

test("a deposit already credited by its callback is not credited again, and leaves no shadow", async () => {
  // The exact production shape: the callback settled it first, then the ledger sweep sees the payment.
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0);
  const txId = await repo.createDepositProvider("u1", 20000, "254700000001", "payhero");
  await repo.attachStk(txId, "ws_CO_1", "PAYHERO-REF-1");
  await repo.completeDeposit("PAYHERO-REF-1", 0, "", "UJ1STK", {});
  assert.equal(await repo.getBalance("u1"), 20000, "precondition: callback credited it once");

  const svc = new PaymentService(repo, {
    stkPush: async () => ({ merchantRequestId: "m", checkoutRequestId: "c" }),
    stkPushQuery: async () => ({ resultCode: 0, processing: false }),
    b2cPayment: async () => ({ conversationId: "x" }),
  }, { payhero: ledgerClient([payment({ code: "UJ1STK", cents: 20000, ref: txId })]) });

  const r = await svc.reconcilePayHeroLedger();
  assert.equal(r.settled, 0);
  assert.equal(r.ingested, 0, "no shadow row — this is what minted 452 of them");
  assert.equal(await repo.getBalance("u1"), 20000);
});

test("the Lipwa control still works: its reference IS the checkout_request_id", async () => {
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0);
  const txId = await repo.createDepositProvider("u1", 50000, "", "payhero");
  await repo.attachStk(txId, `lipwa:${txId}`, txId);   // exactly what initiateLipwaDeposit does
  const svc = new PaymentService(repo, {
    stkPush: async () => ({ merchantRequestId: "m", checkoutRequestId: "c" }),
    stkPushQuery: async () => ({ resultCode: 0, processing: false }),
    b2cPayment: async () => ({ conversationId: "x" }),
  }, { payhero: ledgerClient([payment({ code: "UJ2LIPWA", cents: 50000, ref: txId })]) });

  const r = await svc.reconcilePayHeroLedger();
  assert.equal(r.settled, 1);
  assert.equal(r.ingested, 0);
  assert.equal(await repo.getBalance("u1"), 50000);
});

test("a FOREIGN reference is still ingested as claimable — the shared account's other traffic", async () => {
  /**
   * PayHero's ledger is one shared account, so most rows are not ours. Those must still reach
   * c2b_payments or the payment is stranded: that fallback is the whole reason ingest exists.
   */
  const { repo, svc } = rig([payment({ code: "UJ3FOREIGN", cents: 10000, ref: "someone-elses-ref" })]);
  const r = await svc.reconcilePayHeroLedger();
  assert.equal(r.settled, 0);
  assert.equal(r.ingested, 1, "still claimable by code");
  assert.equal(await repo.getBalance("u1"), 0);
});

test("a payment with NO external reference is ingested, never guessed at", async () => {
  const { repo, svc } = rig([payment({ code: "UJ4NOREF", cents: 10000, ref: null })]);
  const r = await svc.reconcilePayHeroLedger();
  assert.equal(r.settled, 0);
  assert.equal(r.ingested, 1);
  assert.equal(await repo.getBalance("u1"), 0);
});

test("a WITHDRAWAL's id is never treated as a deposit reference", async () => {
  // resolveDepositRefs filters on kind='deposit'; a payout reference must not credit anything.
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 100000);
  const wd = await repo.createWithdrawal("u1", 20000, "254700000001", 0);
  const svc = new PaymentService(repo, {
    stkPush: async () => ({ merchantRequestId: "m", checkoutRequestId: "c" }),
    stkPushQuery: async () => ({ resultCode: 0, processing: false }),
    b2cPayment: async () => ({ conversationId: "x" }),
  }, { payhero: ledgerClient([payment({ code: "UJ5WD", cents: 20000, ref: wd.txId })]) });

  const r = await svc.reconcilePayHeroLedger();
  assert.equal(r.settled, 0, "a withdrawal is not a deposit");
  assert.equal(r.ingested, 1, "treated as foreign, so nothing is lost");
});
