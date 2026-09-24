import { test } from "node:test";
import assert from "node:assert/strict";
import { BillingService, mpesaAccountRef, type BillingRepository, type BillingSettleResult } from "./billing.js";
import type { DarajaClient, StkPushArgs, StkQueryResult } from "./daraja.js";

/** A repo that records calls; only the M-Pesa paths are exercised here (the SQL is proven in e2e_billing.py). */
function repo(over: Partial<BillingRepository> = {}) {
  const calls: unknown[][] = [];
  const pending = new Map<string, string>(); // checkout -> payment
  const base: Partial<BillingRepository> = {
    async startMpesa(a, r, inv, phone) { calls.push(["start", a, r, inv, phone]); return { paymentId: "pay1", amountCents: 100100, invoiceNumber: "TRIO-2026-00012" }; },
    async attachCheckout(p, c) { calls.push(["attach", p, c]); pending.set(c, p); },
    async failStart(p, reason) { calls.push(["fail", p, reason]); },
    async isBillingCheckout(c) { return pending.has(c) || c.startsWith("bill-"); },
    async settleMpesa(c, ok, receipt, reason): Promise<BillingSettleResult> { calls.push(["settle", c, ok, receipt, reason]); return { known: true, applied: ok, status: ok ? "succeeded" : "failed" }; },
    async pendingMpesa() { return []; },
  };
  return { r: { ...base, ...over } as BillingRepository, calls };
}
function daraja(q: StkQueryResult = { resultCode: 0, processing: false }, push?: (a: StkPushArgs) => Promise<{ merchantRequestId: string; checkoutRequestId: string }>) {
  const pushes: StkPushArgs[] = []; let queries = 0;
  const c: DarajaClient = {
    async stkPush(a) { pushes.push(a); return push ? push(a) : { merchantRequestId: "m1", checkoutRequestId: "ws_CO_9" }; },
    async stkPushQuery() { queries += 1; return q; },
    async b2cPayment() { throw new Error("no"); },
  };
  return { c, pushes, queries: () => queries };
}

test("BILL-1: the Daraja account reference fits 12 characters and stays recognisable", () => {
  assert.equal(mpesaAccountRef("TRIO-2026-00012"), "TRIO2600012");
  assert.equal(mpesaAccountRef("ABCDEFGH-2027-12345"), "ABCDE2712345");
  for (const x of ["INV-2026-00001", "ABCDEFGH-2026-99999"]) assert.ok(mpesaAccountRef(x).length <= 12);
});

test("BILL-1: Pay now pushes the whole balance from the System account and attaches the checkout", async () => {
  const { r, calls } = repo(); const d = daraja();
  const svc = new BillingService(r, { daraja: () => d.c });
  const out = await svc.payNow("pa", "platform_admin", "inv1", "0712 345 678");
  assert.equal(out.checkoutRequestId, "ws_CO_9");
  assert.deepEqual(calls[0], ["start", "pa", "platform_admin", "inv1", "0712345678"]);
  assert.equal(d.pushes[0]!.amountCents, 100100);
  assert.equal(d.pushes[0]!.accountRef, "TRIO2600012");
  assert.deepEqual(calls[1], ["attach", "pay1", "ws_CO_9"]);
});

test("BILL-1: a push that fails closes the reserved payment so the payer can retry", async () => {
  const { r, calls } = repo();
  const svc = new BillingService(r, { daraja: () => daraja(undefined, async () => { throw new Error("DARAJA_/mpesa/stkpush_500:{}"); }).c });
  await assert.rejects(() => svc.payNow("pa", "platform_admin", "inv1", "0712345678"), /MPESA_PUSH_FAILED/);
  assert.deepEqual(calls.at(-1), ["fail", "pay1", "The M-Pesa prompt could not be sent"]);
  const svc2 = new BillingService(r, { daraja: () => daraja(undefined, async () => { throw new Error("MPESA_NOT_CONFIGURED: key"); }).c });
  await assert.rejects(() => svc2.payNow("pa", "platform_admin", "inv1", "0712345678"), /MPESA_NOT_CONFIGURED/);
});

test("BILL-1: callbacks — deposits pass through; billing results are VERIFIED before settling", async () => {
  const { r, calls } = repo();
  const ok = daraja({ resultCode: 0, processing: false });
  const svc = new BillingService(r, { daraja: () => ok.c });
  assert.deepEqual(await svc.handleStkCallback("deposit-co", 0, "ok", "R1", {}), { handled: false }, "a deposit checkout is not billing's");
  const res = await svc.handleStkCallback("bill-1", 0, "ok", "QK1", {});
  assert.equal(res.handled, true); assert.equal(ok.queries(), 1);
  assert.deepEqual(calls.at(-1), ["settle", "bill-1", true, "QK1", null]);

  // a forged success for a prompt Safaricom says was cancelled
  const cancelled = daraja({ resultCode: 1032, processing: false });
  const svc2 = new BillingService(r, { daraja: () => cancelled.c });
  await svc2.handleStkCallback("bill-2", 0, "ok", "FAKE", {});
  assert.deepEqual(calls.at(-1), ["settle", "bill-2", false, null, "M-Pesa result 1032"], "the forged receipt is never stored as paid");

  // a forged "cancelled" for a prompt that was actually paid
  await svc.handleStkCallback("bill-3", 1032, "Request cancelled by user", null, {});
  assert.equal((calls.at(-1) as unknown[])[2], true, "Safaricom's answer wins over the callback body");

  // still processing -> throw so the callback is retried (or the sweep settles it)
  const busy = new BillingService(r, { daraja: () => daraja({ resultCode: null, processing: true }).c });
  await assert.rejects(() => busy.handleStkCallback("bill-4", 0, "ok", "R", {}), /STK_VERIFY_PENDING/);
});

test("BILL-1: the sweep settles from Safaricom's status, leaves processing ones, and closes never-sent ones", async () => {
  const old = Date.now() - 11 * 60_000;
  const { r, calls } = repo({
    async pendingMpesa() {
      return [
        { paymentId: "p1", checkoutRequestId: "bill-a", createdAtMs: old },
        { paymentId: "p2", checkoutRequestId: null, createdAtMs: old },
        { paymentId: "p3", checkoutRequestId: null, createdAtMs: Date.now() },
      ];
    },
  });
  const svc = new BillingService(r, { daraja: () => daraja({ resultCode: 0, processing: false }).c });
  const out = await svc.reconcile();
  assert.deepEqual(out, { scanned: 3, settled: 2, stillPending: 1, errors: 0 });
  assert.ok(calls.some((c) => c[0] === "settle" && c[1] === "bill-a" && c[2] === true));
  assert.ok(calls.some((c) => c[0] === "fail" && c[1] === "p2"));
});
