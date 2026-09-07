import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPaymentRepository } from "./payments.js";
import { PaymentService } from "./paymentservice.js";

function rig() {
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0);   // wallet exists, empty
  repo.seed("u2", 0);
  const svc = new PaymentService(repo, { stkPush: async () => ({ merchantRequestId: "m", checkoutRequestId: "c" }), stkPushQuery: async () => ({ resultCode: 0, processing: false }), b2cPayment: async () => ({ conversationId: "x" }) });
  return { repo, svc };
}

test("ingestC2b stores a confirmation and is idempotent", async () => {
  const { svc } = rig();
  assert.equal(await svc.ingestC2b({ transId: "QGH1ABC", amountCents: 20000, msisdn: "254712345678", billRef: "7719580265", shortcode: "625625" }), true);
  assert.equal(await svc.ingestC2b({ transId: "qgh1abc", amountCents: 20000, msisdn: "254712345678", billRef: "7719580265", shortcode: "625625" }), false);
});

test("ingestC2b rejects empty code / non-positive amount", async () => {
  const { svc } = rig();
  await assert.rejects(() => svc.ingestC2b({ transId: "  ", amountCents: 100, msisdn: null, billRef: null, shortcode: null }), /INVALID_C2B/);
  await assert.rejects(() => svc.ingestC2b({ transId: "X", amountCents: 0, msisdn: null, billRef: null, shortcode: null }), /INVALID_C2B/);
});

test("claimPaybillDeposit credits the EXACT recorded amount, once", async () => {
  const { repo, svc } = rig();
  await svc.ingestC2b({ transId: "QGH1ABC", amountCents: 20000, msisdn: "254712345678", billRef: "7719580265", shortcode: "625625" });
  const r = await svc.claimPaybillDeposit("u1", "qgh1abc"); // lowercase → normalized
  assert.equal(r.status, "credited");
  assert.equal(r.amountCents, 20000);
  assert.equal(r.newBalance, 20000);
  assert.equal(await repo.getBalance("u1"), 20000);
  // same user re-claims → idempotent, no double credit
  const r2 = await svc.claimPaybillDeposit("u1", "QGH1ABC");
  assert.equal(r2.status, "already_claimed");
  assert.equal(await repo.getBalance("u1"), 20000);
});

test("a code claimed by one user cannot be claimed by another", async () => {
  const { svc } = rig();
  await svc.ingestC2b({ transId: "CODE9", amountCents: 50000, msisdn: null, billRef: null, shortcode: "625625" });
  await svc.claimPaybillDeposit("u1", "CODE9");
  await assert.rejects(() => svc.claimPaybillDeposit("u2", "CODE9"), /CODE_ALREADY_USED/);
});

test("claiming an unknown code returns not_found (no credit)", async () => {
  const { repo, svc } = rig();
  const r = await svc.claimPaybillDeposit("u1", "NOPE123");
  assert.equal(r.status, "not_found");
  assert.equal(await repo.getBalance("u1"), 0);
});

test("empty claim code is rejected", async () => {
  const { svc } = rig();
  await assert.rejects(() => svc.claimPaybillDeposit("u1", "   "), /INVALID_CODE/);
});

test("paybillConfig exposes the non-secret display config", async () => {
  const { svc } = rig();
  const cfg = await svc.paybillConfig();
  assert.equal(cfg.shortcode, "625625");
  assert.equal(cfg.accountNumber, "7719580265");
  assert.equal(cfg.businessName, "BETWOIN LTD");
});
