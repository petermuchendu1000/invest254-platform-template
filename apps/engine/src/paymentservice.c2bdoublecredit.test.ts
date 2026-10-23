import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPaymentRepository } from "./payments.js";
import { PaymentService } from "./paymentservice.js";

/**
 * A C2B payment may be credited AT MOST ONCE — by the deposit it was initiated for, or by a manual
 * claim, never both (migration 0213, BUGLOG #163).
 *
 * The hole these tests close was live in production. `reconcilePayHeroLedger` ingests every PayHero
 * ledger payment it cannot attribute to a deposit, and it could never attribute ANY of them: PayHero
 * echoes our `transactions.id` as the ledger row's `external_reference`, while `ownedDepositRefs`
 * and `fn_complete_deposit` both resolve by `transactions.checkout_request_id`. So each PayHero
 * deposit, already credited by its callback, also left a claimable shadow row whose code is the very
 * `mpesa_receipt` the player can read off their own M-Pesa SMS. Measured: 452 such rows, KES 152,306
 * double-claimable, zero claimed.
 *
 * These exercise the in-memory repository, which mirrors `fn_claim_c2b_deposit`; the RPC itself is
 * covered by the same scenarios in the pg test beside this file.
 */
function rig() {
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0);
  repo.seed("u2", 0);
  const svc = new PaymentService(repo, {
    stkPush: async () => ({ merchantRequestId: "m", checkoutRequestId: "c" }),
    stkPushQuery: async () => ({ resultCode: 0, processing: false }),
    b2cPayment: async () => ({ conversationId: "x" }),
  });
  return { repo, svc };
}

/** A PayHero deposit settled by its callback, plus the shadow row the ledger sweep leaves behind. */
async function depositThenShadow(repo: InMemoryPaymentRepository, svc: PaymentService, opts: {
  user: string; cents: number; providerRef: string; receipt: string; settle: boolean;
}): Promise<string> {
  const txId = await repo.createDepositProvider(opts.user, opts.cents, "254700000001", "payhero");
  await repo.attachStk(txId, "merchant", opts.providerRef);
  if (opts.settle) await repo.completeDeposit(opts.providerRef, 0, "", opts.receipt, {});
  // The ledger sweep's fallback: billRef is OUR txId, which is exactly what PayHero echoes back.
  await svc.ingestC2b({ transId: opts.receipt, amountCents: opts.cents, msisdn: "254700000001", billRef: txId, shortcode: "payhero" });
  return txId;
}

test("the production hole: a credited PayHero deposit's shadow row cannot be claimed again", async () => {
  const { repo, svc } = rig();
  await depositThenShadow(repo, svc, { user: "u1", cents: 20000, providerRef: "PAYHERO-REF-1", receipt: "UJ1SHADOW1", settle: true });

  assert.equal(await repo.getBalance("u1"), 20000, "precondition: the callback credited it once");
  await assert.rejects(() => svc.claimPaybillDeposit("u1", "UJ1SHADOW1"), /CODE_ALREADY_CREDITED/);
  assert.equal(await repo.getBalance("u1"), 20000, "and the balance did not move");
});

test("a payment whose deposit is still PROCESSING is refused too, not merely a settled one", async () => {
  /**
   * Refusing only on 'success' would just move the double credit later: the deposit is still live,
   * and once the ledger matcher is fixed it will be credited through fn_complete_deposit. Claiming
   * it now would make that the second credit instead of the first.
   */
  const { repo, svc } = rig();
  await depositThenShadow(repo, svc, { user: "u1", cents: 30000, providerRef: "PAYHERO-REF-3", receipt: "UJ3PROCESS", settle: false });

  assert.equal(await repo.getBalance("u1"), 0, "precondition: nothing credited yet");
  await assert.rejects(() => svc.claimPaybillDeposit("u1", "UJ3PROCESS"), /CODE_ALREADY_CREDITED/);
  assert.equal(await repo.getBalance("u1"), 0);
});

test("a code already recorded as a receipt on a credited deposit is refused, even with an unrelated billRef", async () => {
  // Defence in depth: catches a payment the ledger ingested without a usable reference.
  const { repo, svc } = rig();
  const txId = await repo.createDepositProvider("u1", 40000, "254700000001", "mpesa");
  await repo.attachStk(txId, "merchant", "DARAJA-REF-4");
  await repo.completeDeposit("DARAJA-REF-4", 0, "", "UJ4RECEIPT", {});
  await svc.ingestC2b({ transId: "UJ4RECEIPT", amountCents: 40000, msisdn: "254700000001", billRef: "someaccount", shortcode: "174379" });

  await assert.rejects(() => svc.claimPaybillDeposit("u1", "UJ4RECEIPT"), /CODE_ALREADY_CREDITED/);
  assert.equal(await repo.getBalance("u1"), 40000, "still exactly one credit");
});

test("the GENUINE Pay Bill claim still works — the guard must not break the feature it protects", async () => {
  /**
   * The ordinary flow: a player pays the System Pay Bill directly, Safaricom's C2B confirmation is
   * ingested with billRef = whatever account number they typed, and nothing has credited it yet.
   */
  const { repo, svc } = rig();
  await svc.ingestC2b({ transId: "UJ2GENUINE", amountCents: 50000, msisdn: "254700000002", billRef: "johndoe", shortcode: "174379" });

  const r = await svc.claimPaybillDeposit("u1", "UJ2GENUINE");
  assert.equal(r.status, "credited");
  assert.equal(await repo.getBalance("u1"), 50000);
});

test("ordering is load-bearing: the same user re-claiming still gets already_claimed, not the new refusal", async () => {
  /**
   * The claim writes the code onto the transaction it creates, so after a legitimate claim the
   * receipt branch WOULD match. The guard therefore sits after the claimed check — otherwise an
   * impatient second tap turns a harmless idempotent reply into an error.
   */
  const { repo, svc } = rig();
  await svc.ingestC2b({ transId: "UJ2GENUINE", amountCents: 50000, msisdn: "254700000002", billRef: "johndoe", shortcode: "174379" });
  assert.equal((await svc.claimPaybillDeposit("u1", "UJ2GENUINE")).status, "credited");

  const again = await svc.claimPaybillDeposit("u1", "UJ2GENUINE");
  assert.equal(again.status, "already_claimed");
  assert.equal(await repo.getBalance("u1"), 50000, "no second credit");
});

test("a FAILED deposit's payment stays claimable — the claim is its only recovery path", async () => {
  /**
   * Found by mutation-testing the guard, not by the original design: `fn_complete_deposit` early-
   * returns on a transaction already in 'success' or 'failed', so a failed deposit can NEVER be
   * credited through its own rail. If the money nonetheless arrived — the provider reports failure
   * but M-Pesa moved it, which is exactly why the ledger sweep exists — the manual claim is the only
   * way the player ever sees it. Refusing on 'failed' too would have stranded that money
   * permanently, trading a double-credit bug for a lost-money one.
   */
  const { repo, svc } = rig();
  const txId = await repo.createDepositProvider("u1", 60000, "254700000001", "payhero");
  await repo.attachStk(txId, "merchant", "PAYHERO-REF-5");
  await repo.completeDeposit("PAYHERO-REF-5", 1, "cancelled", null, {});   // failed: no credit, no receipt
  await svc.ingestC2b({ transId: "UJ5FAILED", amountCents: 60000, msisdn: "254700000001", billRef: txId, shortcode: "payhero" });

  assert.equal(await repo.getBalance("u1"), 0, "precondition: the failed deposit credited nothing");
  const r = await svc.claimPaybillDeposit("u1", "UJ5FAILED");
  assert.equal(r.status, "credited", "the recovery path must remain open");
  assert.equal(await repo.getBalance("u1"), 60000);
});

test("the pre-existing guards are untouched: another user's code, and an unknown code", async () => {
  const { repo, svc } = rig();
  await svc.ingestC2b({ transId: "UJ2GENUINE", amountCents: 50000, msisdn: "254700000002", billRef: "johndoe", shortcode: "174379" });
  await svc.claimPaybillDeposit("u1", "UJ2GENUINE");

  await assert.rejects(() => svc.claimPaybillDeposit("u2", "UJ2GENUINE"), /CODE_ALREADY_USED/);
  assert.equal((await svc.claimPaybillDeposit("u2", "NOSUCHCODE")).status, "not_found");
  assert.equal(await repo.getBalance("u2"), 0);
});
