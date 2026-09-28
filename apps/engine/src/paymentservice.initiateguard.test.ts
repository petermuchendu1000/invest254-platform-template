import { test } from "node:test";
import assert from "node:assert/strict";
import { PaymentService } from "./paymentservice.js";
import { InMemoryPaymentRepository } from "./payments.js";
import { StubDarajaClient } from "./daraja.js";

/**
 * 0174 / docs/52 — what a REFUSED deposit must leave behind, and what must stop provoking the refusal.
 *
 * The incident: PayHero answered bursts of `initiateStk` with
 *   400 {"error_code":"BAD_REQUEST","error_message":"The merchant has been blocked for spamming"}
 * Their block is merchant-wide and transient. Two things were wrong on our side:
 *   1. every rejection minted a `pending` row with no `checkout_request_id` — a ghost nothing could
 *      ever settle, because both the callback and the reconcile sweep key on that id (199 had piled up);
 *   2. nothing stopped a retry loop from provoking the block in the first place — the route's limit is
 *      per user (20/min) and the observed loop ran at ~4s intervals, comfortably under it.
 */

/** A repository whose shared gate is unreachable — the case the service must FAIL CLOSED on. */
class BrokenGateRepo extends InMemoryPaymentRepository {
  override async depositGate(): Promise<never> { throw new Error("connection terminated unexpectedly"); }
}

/** A Daraja stub whose STK push always fails, the way a blocked merchant behaves. */
class RejectingDaraja extends StubDarajaClient {
  calls = 0;
  override async stkPush(): Promise<{ merchantRequestId: string; checkoutRequestId: string }> {
    this.calls += 1;
    throw new Error('DARAJA_INITIATE_REJECTED_400:{"error_message":"The merchant has been blocked for spamming"}');
  }
}

function rig(daraja = new StubDarajaClient()) {
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0);
  repo.seed("u2", 0);
  const svc = new PaymentService(repo, daraja);
  return { repo, svc };
}

test("a gateway refusal closes the deposit out instead of stranding it as pending", async () => {
  const daraja = new RejectingDaraja();
  const { repo, svc } = rig(daraja);

  await assert.rejects(() => svc.initiateDeposit("u1", 100_000, "0712345678"), /DARAJA_INITIATE_REJECTED_400/);
  assert.equal(daraja.calls, 1, "the gateway was actually called");

  const txs = await repo.listTransactions("u1", {});
  assert.equal(txs.items.length, 1, "the row still exists — it is evidence, not swept away");
  const tx = txs.items[0]!;
  assert.equal(tx.status, "failed", "a refused deposit must not linger as pending");
  // Terminal: a second clean-up is a no-op, so nothing can re-open or re-write it. (That the REASON
  // is recorded is asserted where it is stored — fn_abandon_deposit, exercised against production in
  // the rolled-back dry run for 0174; the in-memory DTO does not carry result_desc.)
  assert.equal(await repo.abandonDeposit(tx.id, "again"), false, "closing out is terminal");
});

test("the provider's error is rethrown unchanged — the clean-up never masks it", async () => {
  const { svc } = rig(new RejectingDaraja());
  await assert.rejects(
    () => svc.initiateDeposit("u1", 100_000, "0712345678"),
    (e: Error) => e.message.startsWith("DARAJA_INITIATE_REJECTED_400"),
  );
});

test("no money moves when a deposit is refused", async () => {
  const { repo, svc } = rig(new RejectingDaraja());
  const before = await repo.getBalance("u1");
  await assert.rejects(() => svc.initiateDeposit("u1", 100_000, "0712345678"));
  assert.equal(await repo.getBalance("u1"), before, "a refusal is money-neutral");
  assert.equal(repo.ledger.length, 0, "and writes no ledger entry");
});

test("a burst from one player is refused before it reaches the gateway", async () => {
  const daraja = new RejectingDaraja();
  const { svc } = rig(daraja);

  await assert.rejects(() => svc.initiateDeposit("u1", 100_000, "0712345678"), /DARAJA_INITIATE_REJECTED_400/);
  assert.equal(daraja.calls, 1);

  // The retry, seconds after a rejection, must not become a second provider call — this is exactly
  // the pattern that escalated one refusal into a merchant-wide block (six requests in 27 seconds).
  await assert.rejects(() => svc.initiateDeposit("u1", 100_000, "0712345678"), /DEPOSIT_TOO_SOON/);
  await assert.rejects(() => svc.initiateDeposit("u1", 100_000, "0712345678"), /DEPOSIT_TOO_SOON/);
  assert.equal(daraja.calls, 1, "the gateway was spared every retry");
});

test("a normal sequence of SUCCESSFUL deposits is never throttled", async () => {
  // The guard must not break the real contract: a player whose deposit just succeeded may make
  // another straight away. Throttling every attempt broke six existing e2e tests that do exactly
  // this — the incident was a retry-after-REJECTION loop, and that is all this may stop.
  const { svc } = rig();
  for (let i = 0; i < 5; i += 1) {
    const r = await svc.initiateDeposit("u1", 100_000, "0712345678");
    assert.ok(r.checkoutRequestId, `deposit ${i + 1} of 5 went through`);
  }
});

test("the guard never blocks a player's FIRST attempt, and is per player", async () => {
  const daraja = new RejectingDaraja();
  const { svc } = rig(daraja);
  await assert.rejects(() => svc.initiateDeposit("u1", 100_000, "0712345678"), /DARAJA_INITIATE_REJECTED_400/);
  // a different player is unaffected by u1's cooldown
  await assert.rejects(() => svc.initiateDeposit("u2", 100_000, "0712345679"), /DARAJA_INITIATE_REJECTED_400/);
  assert.equal(daraja.calls, 2, "each player got their own first attempt");
});

test("a throttled attempt creates no transaction row at all", async () => {
  const { repo, svc } = rig(new RejectingDaraja());
  await assert.rejects(() => svc.initiateDeposit("u1", 100_000, "0712345678"));
  await assert.rejects(() => svc.initiateDeposit("u1", 100_000, "0712345678"), /DEPOSIT_TOO_SOON/);
  const txs = await repo.listTransactions("u1", {});
  assert.equal(txs.items.length, 1, "the guard runs BEFORE the row is created, so it leaves no trace");
});

test("a successful deposit still attaches its checkout id and stays pending", async () => {
  const { repo, svc } = rig();          // the default stub succeeds
  const { txId, checkoutRequestId } = await svc.initiateDeposit("u1", 100_000, "0712345678");
  assert.ok(checkoutRequestId, "the gateway accepted it");
  const txs = await repo.listTransactions("u1", {});
  const tx = txs.items.find((t) => t.id === txId)!;
  assert.notEqual(tx.status, "failed", "a live deposit is never abandoned");
});

test("abandonDeposit refuses a deposit that reached the gateway", async () => {
  const { repo, svc } = rig();
  const { txId } = await svc.initiateDeposit("u1", 100_000, "0712345678");
  // It carries a checkout id, so it is in flight: the reconcile sweep owns it, not the clean-up.
  assert.equal(await repo.abandonDeposit(txId, "should not happen"), false);
});


// ── 0175: the gate is SHARED (Postgres), and the service fails closed ────────────────────────────

test("an unreachable gate refuses the deposit — it is never sent to the gateway", async () => {
  // Fail closed is the whole point of the guarantee: there must be no path to a provider without a
  // granted slot. An in-process counter could be bypassed by restarting a machine; this cannot.
  const repo = new BrokenGateRepo();
  repo.seed("u1", 0);
  const daraja = new RejectingDaraja();
  const svc = new PaymentService(repo, daraja);

  await assert.rejects(() => svc.initiateDeposit("u1", 100_000, "0712345678"), /PROVIDER_BUSY/);
  assert.equal(daraja.calls, 0, "the gateway was never called");
  const txs = await repo.listTransactions("u1", {});
  assert.equal(txs.items.length, 0, "and no row was created");
});

test("the merchant ceiling is enforced across players, not per player", async () => {
  // PayHero's block is merchant-wide, so the ceiling must count every player's initiations together.
  const repo = new InMemoryPaymentRepository();
  const svc = new PaymentService(repo, new StubDarajaClient());
  const merchantKey = "dep:merchant:mpesa:global";
  // consume the window through the repo the service shares
  for (let i = 0; i < 60; i += 1) {
    assert.equal(await repo.depositGate(`dep:reject:mpesa:filler${i}`, merchantKey, 60, 60_000), "ok");
  }
  assert.equal(await repo.depositGate("dep:reject:mpesa:u-new", merchantKey, 60, 60_000), "busy",
    "a different player still hits the merchant's ceiling");
});

test("the post-rejection hold is recorded in the shared gate, so every machine honours it", async () => {
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0);
  const svc = new PaymentService(repo, new RejectingDaraja());
  await assert.rejects(() => svc.initiateDeposit("u1", 100_000, "0712345678"), /DARAJA_INITIATE_REJECTED_400/);
  // The hold lives in the repository, not in the service instance — a second service (a second API
  // machine) sharing the same store sees it too.
  const other = new PaymentService(repo, new StubDarajaClient());
  await assert.rejects(() => other.initiateDeposit("u1", 100_000, "0712345678"), /DEPOSIT_TOO_SOON/);
});

test("a rejection never shortens an existing hold", async () => {
  const repo = new InMemoryPaymentRepository();
  await repo.depositGateReject("k", 60_000);
  await repo.depositGateReject("k", 1);          // a second rejection must not buy a shorter wait
  assert.equal(await repo.depositGate("k", "m", 60, 60_000), "too_soon");
});
