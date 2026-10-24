import { test } from "node:test";
import assert from "node:assert/strict";
import { PaymentService } from "./paymentservice.js";
import { InMemoryPaymentRepository } from "./payments.js";
import { StubDarajaClient } from "./daraja.js";
import { StubPayHeroClient } from "./payhero.js";

/**
 * 0214 — the successive-failure breaker.
 *
 * PayHero blocks a phone number on our account for 24 hours after 10 SUCCESSIVE failed or cancelled
 * STK pushes to it, and restricts the whole account after 50 failures in a sliding 6-hour window.
 *
 * The gate from 0175 does NOT protect against either, which is the whole reason this exists: it
 * counts initiate REFUSALS, and every failure PayHero is counting here is a push that was accepted
 * (201 QUEUED) and then failed at the Safaricom end. On 2026-10-24 one number failed five times in a
 * row on ResultCode 2028 and nothing slowed it down.
 *
 * These tests drive a settable clock so the backoff can be observed without waiting on it.
 */

const MIN = 60_000;
const PHONE = "0712345678";
/** normalizeMsisdn's canonical form — the key the trigger writes and the gate reads. */
const CANON = "254712345678";

function rig() {
  let clock = Date.now();
  const repo = new InMemoryPaymentRepository(() => clock);
  repo.seed("u1", 0);
  repo.seed("u2", 0);
  const payhero = new StubPayHeroClient();
  const svc = new PaymentService(repo, new StubDarajaClient(), { payhero });
  return { repo, svc, advance: (ms: number) => { clock += ms; } };
}

/**
 * Push a deposit all the way to a terminal outcome, the way a callback or the sweep would.
 * Settlement keys on PayHero's `reference` (that is what attachStk stores as the checkout id on
 * this rail), not on the ws_CO CheckoutRequestID.
 */
async function depositThen(svc: PaymentService, repo: InMemoryPaymentRepository, outcome: "fail" | "ok", user = "u1") {
  const { reference } = await svc.initiatePayHeroDeposit(user, 100_000, PHONE);
  await repo.completeDeposit(reference, outcome === "ok" ? 0 : 1, "test", null, {});
}

test("three successive failures to one number stop the fourth STK push", async () => {
  const { repo, svc } = rig();

  for (let i = 0; i < 3; i += 1) await depositThen(svc, repo, "fail");

  await assert.rejects(
    () => svc.initiatePayHeroDeposit("u1", 100_000, PHONE),
    /DEPOSIT_PHONE_BLOCKED/,
    "the 4th push must never reach PayHero — their ceiling is 10 and we stop at 3",
  );
});

test("the first three attempts are not throttled — only the failures past the ceiling are", async () => {
  const { repo, svc } = rig();
  for (let i = 0; i < 2; i += 1) await depositThen(svc, repo, "fail");
  // Two failures is under the ceiling: a third attempt is still allowed through.
  await assert.doesNotReject(() => svc.initiatePayHeroDeposit("u1", 100_000, PHONE));
});

test("a success breaks the streak — 'successive' is PayHero's word and ours", async () => {
  const { repo, svc } = rig();
  await depositThen(svc, repo, "fail");
  await depositThen(svc, repo, "fail");
  await depositThen(svc, repo, "ok");       // streak broken
  await depositThen(svc, repo, "fail");
  await depositThen(svc, repo, "fail");
  // Only 2 failures since the success, so the number is still good for another attempt.
  await assert.doesNotReject(() => svc.initiatePayHeroDeposit("u1", 100_000, PHONE));
});

test("the block lifts on its own — it is never a deadlock the player cannot escape", async () => {
  const { repo, svc, advance } = rig();
  for (let i = 0; i < 3; i += 1) await depositThen(svc, repo, "fail");
  await assert.rejects(() => svc.initiatePayHeroDeposit("u1", 100_000, PHONE), /DEPOSIT_PHONE_BLOCKED/);

  // A block that only a success could clear would be unescapable: the player cannot produce a
  // success while they cannot attempt. The cooldown is what makes it recoverable.
  advance(31 * MIN);
  await assert.doesNotReject(() => svc.initiatePayHeroDeposit("u1", 100_000, PHONE));
});

test("the backoff doubles, so a dead number cannot drip its way to PayHero's 10", async () => {
  const { repo, svc, advance } = rig();
  for (let i = 0; i < 3; i += 1) await depositThen(svc, repo, "fail");

  advance(31 * MIN);                       // base cooldown spent: one attempt gets through
  await depositThen(svc, repo, "fail");    // ...and fails. That is failure #4.

  // A FIXED cooldown would let this repeat every 30 minutes until PayHero's own ceiling is hit.
  // Doubling means the 5th attempt is still held off well after the base cooldown has passed.
  advance(31 * MIN);
  await assert.rejects(() => svc.initiatePayHeroDeposit("u1", 100_000, PHONE), /DEPOSIT_PHONE_BLOCKED/);
  advance(31 * MIN);                       // 62 min total > the doubled 60 min
  await assert.doesNotReject(() => svc.initiatePayHeroDeposit("u1", 100_000, PHONE));
});

test("the breaker is per NUMBER, not per player — another number is unaffected", async () => {
  const { repo, svc } = rig();
  for (let i = 0; i < 3; i += 1) await depositThen(svc, repo, "fail");
  await assert.rejects(() => svc.initiatePayHeroDeposit("u1", 100_000, PHONE), /DEPOSIT_PHONE_BLOCKED/);

  // PayHero blocks the NUMBER, not the account, so this is the boundary that matters: a different
  // number on the same account keeps working.
  await assert.doesNotReject(() => svc.initiatePayHeroDeposit("u1", 100_000, "0799000111"));
});

test("a blocked number blocks every player who tries it, not just the one who broke it", async () => {
  const { repo, svc } = rig();
  for (let i = 0; i < 3; i += 1) await depositThen(svc, repo, "fail", "u1");
  // PayHero's block attaches to the number on OUR account, so a second player sending to the same
  // number would spend the same budget. The counter is keyed by number for exactly this reason.
  await assert.rejects(() => svc.initiatePayHeroDeposit("u2", 100_000, PHONE), /DEPOSIT_PHONE_BLOCKED/);
});

test("a deposit that never reached the gateway does not count against the number", async () => {
  const { repo, svc } = rig();
  // fn_abandon_deposit closes rows that the gateway REFUSED — no checkout id, so no STK prompt ever
  // went out and none of PayHero's budget was spent. The trigger's `checkout_request_id is not null`
  // guard is what keeps these out; the in-memory mirror must agree, or the counts diverge.
  const txId = await repo.createDepositProvider("u1", 100_000, CANON, "payhero");
  await repo.abandonDeposit(txId, "abandoned:PAYHERO_INITIATE_REJECTED_400");
  for (let i = 0; i < 2; i += 1) await depositThen(svc, repo, "fail");
  await assert.doesNotReject(() => svc.initiatePayHeroDeposit("u1", 100_000, PHONE));
});

test("the Lipwa checkout is exempt — it sends no STK and is the fallback when STK is broken", async () => {
  const { repo, svc } = rig();
  for (let i = 0; i < 3; i += 1) await depositThen(svc, repo, "fail");
  await assert.rejects(() => svc.initiatePayHeroDeposit("u1", 100_000, PHONE), /DEPOSIT_PHONE_BLOCKED/);

  // Holding off the hosted checkout on an STK failure count would take away the one route still
  // working when the STK channel itself is the broken thing.
  await assert.doesNotReject(() => svc.initiateLipwaDeposit("u1", 100_000));
});

test("the gate still fails CLOSED when it cannot be consulted", async () => {
  class BrokenGateRepo extends InMemoryPaymentRepository {
    override async depositGate(): Promise<never> { throw new Error("connection terminated unexpectedly"); }
  }
  const repo = new BrokenGateRepo();
  repo.seed("u1", 0);
  const svc = new PaymentService(repo, new StubDarajaClient(), { payhero: new StubPayHeroClient() });
  // 0175's rule, unchanged by the new checks: no request reaches a provider without a granted slot.
  await assert.rejects(() => svc.initiatePayHeroDeposit("u1", 100_000, PHONE), /PROVIDER_BUSY/);
});
