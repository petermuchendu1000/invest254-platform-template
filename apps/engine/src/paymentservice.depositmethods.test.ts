import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPaymentRepository } from "./payments.js";
import { PaymentService } from "./paymentservice.js";
import type { PayHeroClient } from "./payhero.js";

/**
 * listDepositMethods — the deposit sheet's single source of truth.
 *
 * These cases are the REAL brand configurations in production, not hypotheticals. The one that
 * matters most is the first: the 12 MUCHENDU brands run PayHero as their only gateway with
 * `lipwa_url` UNSET, and the sheet used to offer a "Card & Bank" tab that threw
 * PAYHERO_LIPWA_NOT_CONFIGURED the moment a player submitted it.
 */

const daraja = {
  stkPush: async () => ({ merchantRequestId: "m", checkoutRequestId: "c" }),
  stkPushQuery: async () => ({ resultCode: 0, processing: false }),
  b2cPayment: async () => ({ conversationId: "x" }),
};

const LIPWA = "https://app.payhero.africa/lipwa/12038";

/** `lipwa: null` models a PayHero account with no `lipwa_url` configured — the live production state. */
function fakePayHero(lipwa: string | null = LIPWA): PayHeroClient {
  return {
    async initiateStk() { return { reference: "R", checkoutRequestId: "ws_CO" }; },
    async queryStatus() { return { resultCode: null, processing: true, receipt: null }; },
    async listInboundPayments() { return []; },
    async lipwaLink(o) { return lipwa ? `${lipwa}?reference=${o.reference}` : null; },
  };
}

// `payhero: null` means the gateway is switched on but NO client/credentials are configured.
function rig(providers: Array<{ code: string; displayName: string }>, payhero: PayHeroClient | null = fakePayHero()) {
  const repo = new InMemoryPaymentRepository();
  repo.setProviders(providers);
  const svc = new PaymentService(repo, daraja, payhero ? { payhero } : {});
  return { repo, svc };
}

const PAYHERO = { code: "payhero", displayName: "PayHero" };
const MPESA = { code: "mpesa", displayName: "M-Pesa" };
const MEGAPAY = { code: "megapay", displayName: "Mega Pay" };

const ids = (m: Array<{ id: string }>) => m.map((x) => x.id);
const labels = (m: Array<{ label: string }>) => m.map((x) => x.label);

// ── The production regression ────────────────────────────────────────────────────────────────────

test("PayHero-only brand with NO lipwa_url offers ONLY M-Pesa — never a Card & Bank tab that would fail", async () => {
  const { svc } = rig([PAYHERO], fakePayHero(null));      // exactly the live MUCHENDU configuration
  const methods = await svc.listDepositMethods();
  assert.deepEqual(ids(methods), ["payhero-stk"]);
  assert.deepEqual(labels(methods), ["M-Pesa"]);          // single rail → unnumbered, gateway brand hidden
  assert.equal(methods.some((m) => m.channel === "lipwa"), false);
  // Proof the tab would genuinely have failed: the initiate path rejects for this same brand.
  await assert.rejects(() => svc.initiateLipwaDeposit("u1", 20_000), /PAYHERO_LIPWA_NOT_CONFIGURED/);
});

test("PayHero-only brand WITH lipwa_url offers M-Pesa + Card & Bank", async () => {
  const { svc } = rig([PAYHERO], fakePayHero(LIPWA));
  const methods = await svc.listDepositMethods();
  assert.deepEqual(ids(methods), ["payhero-stk", "payhero-lipwa"]);
  assert.deepEqual(labels(methods), ["M-Pesa", "Card & Bank"]);
  assert.equal(methods.find((m) => m.channel === "lipwa")?.provider, "payhero");
});

// ── The other live shapes ────────────────────────────────────────────────────────────────────────

test("M-Pesa-only brand offers M-Pesa + Pay Bill", async () => {
  const { svc } = rig([MPESA]);
  const methods = await svc.listDepositMethods();
  assert.deepEqual(ids(methods), ["mpesa-stk", "mpesa-paybill"]);
  assert.deepEqual(labels(methods), ["M-Pesa", "Pay Bill"]);
});

test("Pay Bill is never offered without M-Pesa — a PayHero brand gets no System-owner paybill", async () => {
  const { svc } = rig([PAYHERO], fakePayHero(LIPWA));
  const methods = await svc.listDepositMethods();
  assert.equal(methods.some((m) => m.channel === "paybill"), false);
});

test("several STK gateways are numbered, and the gateway brand is never leaked into a label", async () => {
  const { svc } = rig([MPESA, MEGAPAY, PAYHERO], fakePayHero(LIPWA));
  const methods = await svc.listDepositMethods();
  assert.deepEqual(ids(methods), ["mpesa-stk", "megapay-stk", "payhero-stk", "payhero-lipwa", "mpesa-paybill"]);
  assert.deepEqual(labels(methods), ["M-Pesa (1)", "M-Pesa (2)", "M-Pesa (3)", "Card & Bank", "Pay Bill"]);
  // No player-visible label may name a gateway (docs/35).
  for (const l of labels(methods)) assert.doesNotMatch(l, /payhero|mega\s*pay|lipwa|daraja/i);
});

// ── Failure modes must degrade, never break the sheet ────────────────────────────────────────────

test("a PayHero client whose lipwa probe THROWS omits Card & Bank instead of breaking the sheet", async () => {
  const exploding: PayHeroClient = {
    ...fakePayHero(LIPWA),
    async lipwaLink() { throw new Error("PAYHERO_UNREACHABLE"); },
  };
  const { svc } = rig([PAYHERO], exploding);
  const methods = await svc.listDepositMethods();
  assert.deepEqual(ids(methods), ["payhero-stk"]);        // STK still offered — the rail that works
});

test("PayHero enabled but no PayHero client configured at all offers no Card & Bank", async () => {
  const { svc } = rig([PAYHERO], null);                   // gateway switched on, credentials absent
  const methods = await svc.listDepositMethods();
  assert.equal(methods.some((m) => m.channel === "lipwa"), false);
});

test("no gateways enabled falls back to the always-present M-Pesa rail rather than an empty sheet", async () => {
  const { svc } = rig([]);
  const methods = await svc.listDepositMethods();
  assert.deepEqual(ids(methods), ["mpesa-stk", "mpesa-paybill"]);
});

test("every method carries a stable id, a real channel and an internal provider code", async () => {
  const { svc } = rig([MPESA, PAYHERO], fakePayHero(LIPWA));
  for (const m of await svc.listDepositMethods()) {
    assert.match(m.id, /^[a-z]+-(stk|lipwa|paybill)$/);
    assert.ok(["stk", "lipwa", "paybill"].includes(m.channel));
    assert.ok(["mpesa", "megapay", "payhero"].includes(m.provider));
    assert.ok(m.label.length > 0);
  }
});
