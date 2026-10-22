import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPaymentRepository } from "./payments.js";
import { PaymentService } from "./paymentservice.js";
import type { PayHeroClient, PayHeroInboundPayment } from "./payhero.js";

const daraja = {
  stkPush: async () => ({ merchantRequestId: "m", checkoutRequestId: "c" }),
  stkPushQuery: async () => ({ resultCode: 0, processing: false }),
  b2cPayment: async () => ({ conversationId: "x" }),
};

/** A PayHero client whose ledger + lipwa link the test controls. `ledger` is a live ref so a test can
 *  set the rows AFTER it has minted a txId to reference. */
function fakePayHero(ledger: { rows: PayHeroInboundPayment[] }, lipwa: string | null = "https://app.payhero.africa/lipwa/12038"): PayHeroClient {
  return {
    async initiateStk() { return { reference: "R", checkoutRequestId: "ws_CO" }; },
    async queryStatus() { return { resultCode: null, processing: true, receipt: null }; },
    async listInboundPayments() { return ledger.rows; },
    async lipwaLink(o) { return lipwa ? `${lipwa}?amount=${o.amountKes ?? 0}&reference=${o.reference}` : null; },
    async withdraw() { return { reference: "ph-wd", checkoutRequestId: "ph-wd-co" }; },
    async payoutReady() { return false; },
  };
}
const inbound = (over: Partial<PayHeroInboundPayment>): PayHeroInboundPayment => ({
  mpesaCode: "CODE", amountCents: 20_000, msisdn: "0798661061", externalReference: null, reference: "phref", at: "2026-09-28T00:00:00Z", ...over,
});

function rig(ledger: { rows: PayHeroInboundPayment[] } = { rows: [] }, lipwa: string | null = "https://app.payhero.africa/lipwa/12038") {
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0); repo.seed("u2", 0);
  const svc = new PaymentService(repo, daraja, { payhero: fakePayHero(ledger, lipwa) });
  return { repo, svc, ledger };
}

// ── Lipwa initiate ──────────────────────────────────────────────────────────────────────────────

test("initiateLipwaDeposit mints a pending tx and a Lipwa URL referencing that txId", async () => {
  const { repo, svc } = rig();
  const out = await svc.initiateLipwaDeposit("u1", 20_000);
  assert.match(out.lipwaUrl, /app\.payhero\.africa\/lipwa\/12038\?amount=200&reference=/);
  assert.ok(out.lipwaUrl.endsWith(out.txId));      // reference === txId (the unambiguous ledger match key)
  assert.equal(out.reference, out.txId);
  assert.equal(await repo.getBalance("u1"), 0);    // nothing credited yet — money moves only on ledger settle
});

test("initiateLipwaDeposit enforces the same floors as STK and needs a configured Lipwa link", async () => {
  const { svc } = rig();
  await assert.rejects(() => svc.initiateLipwaDeposit("u1", 100), /BELOW_MIN/);        // < KES 200 default
  await assert.rejects(() => svc.initiateLipwaDeposit("u1", 0), /INVALID_AMOUNT/);
  const noLipwa = rig({ rows: [] }, null).svc;
  await assert.rejects(() => noLipwa.initiateLipwaDeposit("u1", 20_000), /PAYHERO_LIPWA_NOT_CONFIGURED/);
});

// ── Ledger reconcile: the settlement path for Lipwa/card AND manual paybill ───────────────────────

test("ledger reconcile AUTO-CREDITS a Lipwa payment to its own tx, exactly once, and never makes it claimable", async () => {
  const ledger = { rows: [] as PayHeroInboundPayment[] };
  const { repo, svc } = rig(ledger);
  const { txId } = await svc.initiateLipwaDeposit("u1", 20_000);       // pending tx, checkout_request_id === txId
  ledger.rows = [inbound({ mpesaCode: "MPESA1", amountCents: 20_000, externalReference: txId })];

  const r1 = await svc.reconcilePayHeroLedger();
  assert.equal(r1.settled, 1);
  assert.equal(r1.ingested, 0);
  assert.equal(await repo.getBalance("u1"), 20_000);
  // it must NOT also be claimable by code — that would double-credit
  assert.equal((await svc.claimPaybillDeposit("u1", "MPESA1")).status, "not_found");

  // idempotent: a second sweep of the same ledger row changes nothing (tx already terminal)
  const r2 = await svc.reconcilePayHeroLedger();
  assert.equal(r2.settled, 0);
  assert.equal(r2.ingested, 0);
  assert.equal(await repo.getBalance("u1"), 20_000);
});

test("ledger reconcile INGESTS a manual paybill payment (no external_reference) as claimable-by-code", async () => {
  const ledger = { rows: [inbound({ mpesaCode: "MANUAL1", amountCents: 30_000, externalReference: null })] };
  const { repo, svc } = rig(ledger);
  const r = await svc.reconcilePayHeroLedger();
  assert.equal(r.settled, 0);
  assert.equal(r.ingested, 1);
  assert.equal(await repo.getBalance("u1"), 0); // not credited until the player claims it
  const claim = await svc.claimPaybillDeposit("u1", "MANUAL1");
  assert.equal(claim.status, "credited");
  assert.equal(claim.amountCents, 30_000);
  assert.equal(await repo.getBalance("u1"), 30_000);
  // second sweep is idempotent (already ingested)
  assert.equal((await svc.reconcilePayHeroLedger()).ingested, 0);
});

test("ledger reconcile never STRANDS a referenced payment whose tx does not exist (falls back to claimable)", async () => {
  const ledger = { rows: [inbound({ mpesaCode: "ORPHAN1", amountCents: 15_000, externalReference: "no-such-tx" })] };
  const { svc, repo } = rig(ledger);
  const r = await svc.reconcilePayHeroLedger();
  assert.equal(r.settled, 0);
  assert.equal(r.ingested, 1);                    // TX_NOT_FOUND -> made claimable, not lost
  assert.equal((await svc.claimPaybillDeposit("u2", "ORPHAN1")).status, "credited");
  assert.equal(await repo.getBalance("u2"), 15_000);
});

test("a reference we do NOT own never reaches fn_complete_deposit (the sweep stopped raising per row)", async () => {
  /*
   * The regression this pins is a log, not a balance. PayHero's ledger is one shared account, so most
   * rows carry references written by something else; the sweep used to find that out by calling
   * fn_complete_deposit and catching TX_NOT_FOUND. Every miss raised a plpgsql exception that Postgres
   * records as an ERROR, once a minute, forever — 954 of them in 96 minutes of production logs, which
   * is every error line the database had. The outcome below (claimable, not stranded) is unchanged and
   * already covered above; what is asserted here is that we no longer ASK about a reference we know is
   * not ours.
   */
  const { repo, svc, ledger } = rig({ rows: [
    inbound({ mpesaCode: "FOREIGN1", amountCents: 15_000, externalReference: "someone-elses-ref" }),
    inbound({ mpesaCode: "FOREIGN2", amountCents: 25_000, externalReference: "another-foreign-ref" }),
  ] });
  const asked: string[] = [];
  const realComplete = repo.completeDeposit.bind(repo);
  repo.completeDeposit = async (ref, code, desc, receipt, raw) => { asked.push(ref); return realComplete(ref, code, desc, receipt, raw); };

  const r = await svc.reconcilePayHeroLedger();
  assert.deepEqual(asked, [], "a foreign reference must not be sent to the deposit RPC at all");
  assert.equal(r.settled, 0);
  assert.equal(r.ingested, 2);                     // still claimable-by-code, still not stranded
  assert.equal(r.errors, 0);
  assert.equal((await svc.claimPaybillDeposit("u2", "FOREIGN1")).status, "credited");

  // And the one that IS ours still goes through the RPC untouched.
  const { txId } = await svc.initiateLipwaDeposit("u1", 20_000);
  asked.length = 0;
  ledger.rows.push(inbound({ mpesaCode: "OURS1", amountCents: 20_000, externalReference: txId }));
  const r2 = await svc.reconcilePayHeroLedger();
  assert.deepEqual(asked, [txId], "our own reference must still be settled through fn_complete_deposit");
  assert.equal(r2.settled, 1);
  assert.equal(await repo.getBalance("u1"), 20_000);
});

test("ledger reconcile tolerates a transient ledger read failure without crediting anything", async () => {
  const repo = new InMemoryPaymentRepository(); repo.seed("u1", 0);
  const throwing: PayHeroClient = {
    async initiateStk() { return { reference: "R", checkoutRequestId: "c" }; },
    async queryStatus() { return { resultCode: null, processing: true, receipt: null }; },
    async listInboundPayments() { throw new Error("network"); },
    async lipwaLink() { return null; },
    async withdraw() { return { reference: "ph-wd", checkoutRequestId: "ph-wd-co" }; },
    async payoutReady() { return false; },
  };
  const svc = new PaymentService(repo, daraja, { payhero: throwing });
  const r = await svc.reconcilePayHeroLedger();
  assert.deepEqual(r, { scanned: 0, settled: 0, ingested: 0, errors: 1 });
  assert.equal(await repo.getBalance("u1"), 0);
});

test("a mixed ledger batch settles Lipwa rows and ingests manual rows in one pass", async () => {
  const ledger = { rows: [] as PayHeroInboundPayment[] };
  const { repo, svc } = rig(ledger);
  const a = await svc.initiateLipwaDeposit("u1", 20_000);
  const b = await svc.initiateLipwaDeposit("u2", 50_000);
  ledger.rows = [
    inbound({ mpesaCode: "L1", amountCents: 20_000, externalReference: a.txId }),   // -> credit u1
    inbound({ mpesaCode: "L2", amountCents: 50_000, externalReference: b.txId }),   // -> credit u2
    inbound({ mpesaCode: "M1", amountCents: 10_000, externalReference: null }),     // -> claimable
  ];
  const r = await svc.reconcilePayHeroLedger();
  assert.equal(r.settled, 2);
  assert.equal(r.ingested, 1);
  assert.equal(await repo.getBalance("u1"), 20_000);
  assert.equal(await repo.getBalance("u2"), 50_000);
});
