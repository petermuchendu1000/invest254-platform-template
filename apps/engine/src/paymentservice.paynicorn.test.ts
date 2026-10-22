import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPaymentRepository } from "./payments.js";
import { PaymentService } from "./paymentservice.js";
import { StubPaynicornClient, STUB_PAYNICORN_SECRET, encodeContent, paynicornSign, type PaynicornMethod } from "./paynicorn.js";

const daraja = {
  stkPush: async () => ({ merchantRequestId: "m", checkoutRequestId: "c" }),
  stkPushQuery: async () => ({ resultCode: 0, processing: false }),
  b2cPayment: async () => ({ conversationId: "x" }),
};

const MPESA: PaynicornMethod = {
  code: "MPESA", name: "M-Pesa", methodType: "WALLET", minAmount: 1, maxAmount: null,
  inputs: [{ name: "Phone_KE", type: "Phone", pattern: "^[0]?\\d{9}$" }],
};
const CARD: PaynicornMethod = {
  code: "CARD", name: "Card", methodType: "CARD", minAmount: null, maxAmount: null,
  inputs: [{ name: "CardNo", type: "Text" }],
};

/** `country`/`rate` model a brand outside Kenya; `methods` models what that country offers. */
function rig(opts: { status?: "1" | "-1" | "0"; methods?: PaynicornMethod[]; country?: string; rate?: number } = {}) {
  const repo = new InMemoryPaymentRepository();
  repo.seed("u1", 0);
  const paynicorn = new StubPaynicornClient(opts.status ?? "1");
  paynicorn.methods = opts.methods ?? [MPESA];
  const sent: any[] = [];
  const pay = paynicorn.pay.bind(paynicorn);
  paynicorn.pay = async (a) => { sent.push(a); return pay(a); };
  const svc = new PaymentService(repo, daraja, {
    paynicorn,
    ...(opts.country ? { countryForSite: async () => opts.country! } : {}),
    fxRateFor: async () => opts.rate ?? 1,
  });
  return { repo, svc, paynicorn, sent };
}
/** A postback signed exactly as Paynicorn signs it (md5(content + merchant secret)). */
function postback(fields: Record<string, string>, secret = STUB_PAYNICORN_SECRET) {
  const content = encodeContent({ txnId: "PN1", amount: "200", currency: "KES", countryCode: "KE", status: "1", code: "0000", message: "ok", ...fields });
  return { content, sign: paynicornSign(content, secret) };
}

test("initiatePaynicornDeposit: a direct M-Pesa push keyed by our own tx id, never a cashier page", async () => {
  const { repo, svc, sent } = rig();
  const out = await svc.initiatePaynicornDeposit("u1", 20_000, undefined, { phone: "+254 798 661 061" });
  assert.equal(out.checkoutRequestId, out.txId);
  assert.equal(out.checkoutUrl, undefined, "a direct push has no page to open");
  assert.deepEqual(
    { amount: sent[0].amount, countryCode: sent[0].countryCode, currency: sent[0].currency, payMethod: sent[0].payMethod, phone: sent[0].phone },
    { amount: "200", countryCode: "KE", currency: "KES", payMethod: "MPESA", phone: "798661061" });
  const tx = await repo.getTransaction(out.txId);
  assert.equal(tx?.provider, "paynicorn");
  assert.equal(tx?.phone, "0798661061");
  assert.deepEqual((await repo.listUnsettledDeposits(0, 10, "paynicorn")).map((d) => d.checkoutRequestId), [out.txId]);
});

test("initiatePaynicornDeposit: a non-Kenyan brand collects in ITS country, currency and decimals", async () => {
  // Nigeria: NGN, two decimals. KES 200.00 at 12.5 NGN per KES -> 2500.00 NGN.
  const { svc, sent } = rig({ country: "NG", rate: 12.5, methods: [MPESA] });
  await svc.initiatePaynicornDeposit("u1", 20_000, undefined, { phone: "0798661061" });
  assert.deepEqual({ amount: sent[0].amount, countryCode: sent[0].countryCode, currency: sent[0].currency },
    { amount: "2500.00", countryCode: "NG", currency: "NGN" });

  // Tanzania: TZS, zero decimals — a converted amount rounds to the whole unit.
  const tz = rig({ country: "TZ", rate: 20.4, methods: [MPESA] });
  await tz.svc.initiatePaynicornDeposit("u1", 20_000, undefined, { phone: "0798661061" });
  assert.deepEqual({ amount: tz.sent[0].amount, currency: tz.sent[0].currency }, { amount: "4080", currency: "TZS" });

  // An unknown country falls back to Kenya rather than inventing a currency.
  const zz = rig({ country: "ZZ", methods: [MPESA] });
  await zz.svc.initiatePaynicornDeposit("u1", 20_000, undefined, { phone: "0798661061" });
  assert.equal(zz.sent[0].countryCode, "KE");
});

test("initiatePaynicornDeposit: a method needing fields we cannot supply returns a checkout URL", async () => {
  const { svc, sent } = rig({ methods: [CARD] });
  const out = await svc.initiatePaynicornDeposit("u1", 20_000, undefined, { method: "CARD" });
  assert.match(out.checkoutUrl ?? "", /^https:\/\//, "a hosted method hands back its page");
  assert.equal(sent[0].phone, undefined, "no payer field is invented for a method we cannot push");
  assert.equal(sent[0].payMethod, "CARD");
});

test("initiatePaynicornDeposit: only a method this country actually offers is accepted", async () => {
  const { svc } = rig({ methods: [MPESA] });
  await assert.rejects(svc.initiatePaynicornDeposit("u1", 20_000, undefined, { method: "CARD", phone: "0798661061" }), /METHOD_UNAVAILABLE/);
  const none = rig({ methods: [] });
  await assert.rejects(none.svc.initiatePaynicornDeposit("u1", 20_000, undefined, { phone: "0798661061" }), /NO_METHODS/);
});

test("initiatePaynicornDeposit: floor, whole units, phone and a missing client are refused", async () => {
  const { svc } = rig();
  await assert.rejects(svc.initiatePaynicornDeposit("u1", 9_900, undefined, { phone: "0798661061" }), /BELOW_MIN/);
  await assert.rejects(svc.initiatePaynicornDeposit("u1", 20_050, undefined, { phone: "0798661061" }), /INVALID_AMOUNT/);
  await assert.rejects(svc.initiatePaynicornDeposit("u1", 20_000, undefined, { phone: "nope" }), /INVALID_PHONE/);
  await assert.rejects(svc.initiatePaynicornDeposit("u1", 20_000), /INVALID_PHONE/);
  const bare = new PaymentService(new InMemoryPaymentRepository(), daraja);
  await assert.rejects(bare.initiatePaynicornDeposit("u1", 20_000, undefined, { phone: "0798661061" }), /PAYNICORN_NOT_CONFIGURED/);
});

test("paynicorn callback: a verified postback re-queries, credits exactly once, and returns the txnId", async () => {
  const { repo, svc } = rig({ status: "1" });
  const { txId } = await svc.initiatePaynicornDeposit("u1", 20_000, undefined, { phone: "0798661061" });
  assert.deepEqual(await svc.handlePaynicornCallback(postback({ orderId: txId })), { txnId: "PN1", settled: true });
  assert.equal(await repo.getBalance("u1"), 20_000);
  assert.equal((await svc.handlePaynicornCallback(postback({ orderId: txId }))).settled, false, "a retry never credits twice");
  assert.equal(await repo.getBalance("u1"), 20_000);
});

test("paynicorn callback: forged signature is refused; the body's status never credits", async () => {
  const { repo, svc } = rig({ status: "-1" });
  const { txId } = await svc.initiatePaynicornDeposit("u1", 20_000, undefined, { phone: "0798661061" });
  await assert.rejects(svc.handlePaynicornCallback(postback({ orderId: txId }, "attacker-secret")), /BAD_SIGNATURE/);
  await assert.rejects(svc.handlePaynicornCallback({ orderId: txId, status: "1" }), /BAD_SIGNATURE/);
  assert.deepEqual(await svc.handlePaynicornCallback(postback({ orderId: txId, status: "1" })), { txnId: "PN1", settled: false });
  assert.equal(await repo.getBalance("u1"), 0);
});

test("paynicorn callback: a KES mismatch is refused; a converted currency is left to the query", async () => {
  const { repo, svc } = rig({ status: "1" });
  const { txId } = await svc.initiatePaynicornDeposit("u1", 20_000, undefined, { phone: "0798661061" });
  await assert.rejects(svc.handlePaynicornCallback(postback({ orderId: txId, amount: "50000" })), /AMOUNT_MISMATCH/);
  assert.equal(await repo.getBalance("u1"), 0);
  // A foreign collection was rounded at a rate that has since moved, so the amounts cannot be compared;
  // the authoritative query still decides, and here it says paid.
  assert.equal((await svc.handlePaynicornCallback(postback({ orderId: txId, amount: "2500.00", currency: "NGN" }))).settled, true);
  assert.equal(await repo.getBalance("u1"), 20_000);
});

test("paynicorn callback: unknown orders are acknowledged and ignored", async () => {
  const { svc } = rig({ status: "1" });
  assert.deepEqual(await svc.handlePaynicornCallback(postback({ orderId: "console-check", txnId: "T0" })), { txnId: "T0", settled: false });
  assert.deepEqual(await svc.handlePaynicornCallback(postback({ orderId: "00000000-0000-0000-0000-000000000000", txnId: "T1" })), { txnId: "T1", settled: false });
});

test("paynicorn callback: a failed order is closed without credit", async () => {
  const { repo, svc } = rig({ status: "0" });
  const { txId } = await svc.initiatePaynicornDeposit("u1", 20_000, undefined, { phone: "0798661061" });
  assert.equal((await svc.handlePaynicornCallback(postback({ orderId: txId, status: "0" }))).settled, true);
  assert.equal((await repo.getTransaction(txId))?.status, "failed");
  assert.equal(await repo.getBalance("u1"), 0);
});

test("reconcilePaynicornDeposits settles a deposit whose postback never arrived", async () => {
  const { repo, svc, paynicorn } = rig({ status: "-1" });
  await svc.initiatePaynicornDeposit("u1", 30_000, undefined, { phone: "0798661061" });
  assert.deepEqual(await svc.reconcilePaynicornDeposits({ olderThanMs: 0 }), { scanned: 1, settled: 0, stillPending: 1, errors: 0 });
  paynicorn.queryStatus = "1";
  assert.equal((await svc.reconcilePaynicornDeposits({ olderThanMs: 0 })).settled, 1);
  assert.equal(await repo.getBalance("u1"), 30_000);
});

test("deposit methods: one tab per method the country offers, each on the right channel", async () => {
  const { repo, svc } = rig({ methods: [MPESA, CARD] });
  repo.setProviders([{ code: "paynicorn", displayName: "PayX" }]);
  assert.deepEqual((await svc.listDepositMethods()).map((m) => [m.id, m.channel, m.label, m.methodCode]), [
    ["paynicorn-mpesa", "stk", "M-Pesa", "MPESA"],       // we can collect a phone -> our own form
    ["paynicorn-card", "checkout", "Card", "CARD"],       // we cannot -> the gateway's page
  ]);
  // A country offering a single method shows exactly that one.
  const only = rig({ methods: [CARD] });
  only.repo.setProviders([{ code: "paynicorn", displayName: "PayX" }]);
  assert.deepEqual((await only.svc.listDepositMethods()).map((m) => [m.id, m.label]), [["paynicorn-card", "Card"]]);
  // A country Paynicorn does not serve offers nothing at all, rather than a dead tab.
  const none = rig({ methods: [] });
  none.repo.setProviders([{ code: "paynicorn", displayName: "PayX" }]);
  assert.deepEqual(await none.svc.listDepositMethods(), []);
  const bare = new PaymentService(repo, daraja);
  assert.ok(!(await bare.listDepositMethods()).some((m) => m.provider === "paynicorn"), "no client => not offered");
});

test("deposit methods: the field descriptors reach the sheet so it can render the right control", async () => {
  const { repo, svc } = rig({ methods: [MPESA] });
  repo.setProviders([{ code: "paynicorn", displayName: "PayX" }]);
  const m = (await svc.listDepositMethods())[0]!;
  assert.deepEqual(m.fields, [{ name: "Phone_KE", type: "Phone", pattern: "^[0]?\\d{9}$" }]);
});
