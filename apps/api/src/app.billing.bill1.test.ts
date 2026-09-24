import { test } from "node:test";
import assert from "node:assert/strict";
import { BillingService, type BillingRepository, type BillingSettings, type DarajaClient } from "@invest254/engine";
import { startTestApi, SITE_A, type TestApi } from "./testutil.js";

/**
 * BILL-1 (docs/47) — the billing API layer: who may call what, input shaping, plain error messages, and the
 * shared STK callback routing an invoice Pay-now to billing (never to the deposit ledger). The money logic is
 * proven against Postgres in packages/db/_testkit/e2e_billing.py and billing.pg.test.ts.
 */
const OWNER = "own:platform_superadmin";
const ADMIN = `adm:admin:${SITE_A}`;
const PA = `pa:platform_admin:${SITE_A}:10000000-0000-0000-0000-000000000001`;
const INV = "20000000-0000-0000-0000-000000000001";
const PLAT = "10000000-0000-0000-0000-000000000001";

const settings: BillingSettings = {
  businessName: "TrioCodes", businessAddress: "", taxPin: "", billingEmail: "", billingPhone: "", invoicePrefix: "TRIO", nextNumber: 1,
  daysUntilDue: 7, taxRateBp: 0, taxLabel: "VAT", paymentInstructions: "", mpesaPayEnabled: true, footerNote: "",
  trialDays: 3, pastDueDays: 3, graceDays: 5, updatedAt: null,
};

function mem() {
  const calls: unknown[][] = [];
  const owner = (r: string) => { if (r !== "platform_superadmin") throw new Error("NOT_AUTHORIZED"); };
  const invoice = { id: INV, number: "TRIO-2026-00001", platformId: PLAT, platformName: "P", kind: "renewal", status: "open", lines: [], payments: [] };
  const repo = {
    async overview(_a: string, r: string) { owner(r); return { mrrCents: 1 }; },
    async accounts(_a: string, r: string) { return r === "platform_superadmin" ? [{ platformId: "a" }, { platformId: "b" }] : [{ platformId: PLAT }]; },
    async invoices(a: string, r: string, f: unknown) { calls.push(["invoices", a, r, f]); return [invoice]; },
    async invoice() { return invoice; },
    async pendingCharges(_a: string, _r: string, p: string) { calls.push(["charges", p]); return []; },
    async settings() { return settings; },
    async saveSettings(_a: string, r: string, p: unknown) { owner(r); calls.push(["settings", p]); },
    async plans() { return [{ key: "starter", active: true, platforms: 3 }, { key: "legacy", active: false, platforms: 1 }]; },
    async upsertPlan(_a: string, r: string, p: unknown) { owner(r); calls.push(["plan", p]); },
    async createInvoice(_a: string, r: string, p: string, lines: unknown, inc: boolean, due: number | null, notes: string | null) {
      owner(r); calls.push(["create", p, lines, inc, due, notes]); if (!(lines as unknown[]).length && !inc) throw new Error("NOTHING_TO_INVOICE"); return INV;
    },
    async addCharge(_a: string, r: string, ...rest: unknown[]) { owner(r); calls.push(["charge", ...rest]); return "c1"; },
    async voidCharge(_a: string, r: string) { owner(r); throw new Error("CHARGE_NOT_PENDING"); },
    async recordPayment(_a: string, r: string, ...rest: unknown[]) { owner(r); calls.push(["pay", ...rest]); if ((rest[2] as number) > 1000) throw new Error("AMOUNT_EXCEEDS_BALANCE"); },
    async setInvoiceStatus(_a: string, r: string, ...rest: unknown[]) { owner(r); calls.push(["status", ...rest]); },
    async setExempt(_a: string, r: string) { owner(r); },
    async runNow(_a: string, r: string) { owner(r); return { issued: 1, transitions: 0, reminders: 0 }; },
    async startMpesa(a: string, r: string, inv: string, phone: string) {
      if (!/^(\+?254|0)?[17]\d{8}$/.test(phone)) throw new Error("INVALID_PHONE");   // as the RPC does, after scope
      calls.push(["start", a, r, inv, phone]); return { paymentId: "p1", amountCents: 100000, invoiceNumber: "TRIO-2026-00001" }; },
    async attachCheckout(p: string, c: string) { calls.push(["attach", p, c]); },
    async failStart() {},
    async isBillingCheckout(c: string) { return c === "ws_CO_BILL"; },
    async settleMpesa(c: string, ok: boolean, receipt: string | null) { calls.push(["settle", c, ok, receipt]); return { known: true, applied: true, status: "succeeded" }; },
    async pendingMpesa() { return []; },
  } as unknown as BillingRepository;
  const daraja: DarajaClient = {
    async stkPush() { return { merchantRequestId: "m", checkoutRequestId: "ws_CO_BILL" }; },
    async stkPushQuery() { return { resultCode: 0, processing: false }; },
    async b2cPayment() { throw new Error("no"); },
  };
  return { billing: new BillingService(repo, { daraja: () => daraja }), calls };
}

async function call(api: TestApi, method: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${api.baseUrl}/api/v1${path}`, init);
  const j = (await r.json().catch(() => ({}))) as any;
  return { status: r.status, body: j, code: j?.error?.code as string | undefined, message: j?.error?.message as string | undefined };
}

test("BILL-1 API: owner-only money actions; platform admins read and pay; brand admins are refused", async () => {
  const { billing, calls } = mem();
  const api = await startTestApi({ depsOverrides: { billing } });
  try {
    assert.equal((await call(api, "GET", "/platform/billing/accounts", null)).status, 401);
    for (const [m, p, b] of [["GET", "/platform/billing/accounts"], ["GET", "/platform/billing/invoices"], ["POST", `/platform/billing/invoices/${INV}/pay`, { phone: "0712345678" }]] as const) {
      assert.equal((await call(api, m, p, ADMIN, b)).status, 403, `brand admin ${m} ${p}`);
    }
    for (const [m, p, b] of [
      ["GET", "/platform/billing/overview"], ["POST", "/platform/billing/invoices", { platformId: PLAT, lines: [] }],
      ["POST", `/platform/billing/invoices/${INV}/payments`, { method: "bank", amountCents: 100 }],
      ["POST", `/platform/billing/invoices/${INV}/status`, { status: "void", reason: "x" }],
      ["POST", "/platform/billing/charges", { platformId: PLAT, description: "x", amountCents: 100 }],
      ["PATCH", "/platform/billing/settings", { taxRateBp: 1600 }], ["PUT", "/platform/billing/plans/growth", { name: "Growth" }],
      ["POST", `/platform/billing/accounts/${PLAT}/exempt`, { exempt: true }], ["POST", "/platform/billing/run"],
    ] as const) {
      assert.equal((await call(api, m, p, PA, b)).status, 403, `platform admin ${m} ${p}`);
    }
    const acc = await call(api, "GET", "/platform/billing/accounts", PA);
    assert.equal(acc.status, 200); assert.equal(acc.body.accounts.length, 1);
    assert.equal((await call(api, "GET", `/platform/billing/invoices/${INV}`, PA)).status, 200);
    const plans = await call(api, "GET", "/platform/billing/plans", PA);
    assert.deepEqual(plans.body.plans.map((p: any) => [p.key, p.platforms]), [["starter", 0]], "platform admins see the active catalog, no tenant counts");
    assert.equal((await call(api, "GET", "/platform/billing/plans", OWNER)).body.plans.length, 2);
    await call(api, "GET", "/platform/billing/charges", PA);
    assert.deepEqual(calls.at(-1), ["charges", PLAT], "a platform admin's charges default to its own platform");
    await call(api, "GET", "/platform/billing/invoices?status=overdue&q=%20TRIO%20&limit=500", OWNER);
    assert.deepEqual((calls.at(-1) as unknown[])[3], { platformId: null, status: "overdue", search: "TRIO", limit: 200 });
    assert.equal((await call(api, "GET", "/platform/billing/invoices?status=weird", OWNER)).status, 400);
    assert.equal((await call(api, "GET", "/platform/billing/overview", OWNER)).body.mrrCents, 1);
  } finally { await api.close(); }
});

test("BILL-1 API: input is shaped and refused with plain messages", async () => {
  const { billing, calls } = mem();
  const api = await startTestApi({ depsOverrides: { billing } });
  try {
    const c = await call(api, "POST", "/platform/billing/invoices", OWNER,
      { platformId: PLAT, lines: [{ description: " Setup ", unitCents: "250000", quantity: 2 }], includePending: false, dueDays: 14, notes: " n " });
    assert.equal(c.status, 200);
    assert.deepEqual(calls.find((x) => x[0] === "create"), ["create", PLAT, [{ description: "Setup", unitCents: 250000, quantity: 2 }], false, 14, "n"]);
    const empty = await call(api, "POST", "/platform/billing/invoices", OWNER, { platformId: PLAT, lines: [], includePending: false });
    assert.equal(empty.status, 409); assert.match(empty.message ?? "", /Add at least one line/);
    assert.equal((await call(api, "POST", "/platform/billing/invoices", OWNER, { platformId: "nope", lines: [] })).status, 400);
    assert.equal((await call(api, "POST", "/platform/billing/invoices", OWNER, { platformId: PLAT, lines: [{ description: "", unitCents: 1 }] })).code, "INVALID_LINES");
    assert.equal((await call(api, "POST", "/platform/billing/invoices", OWNER, { platformId: PLAT, lines: [{ description: "x", unitCents: 1.5 }] })).status, 400);
    const over = await call(api, "POST", `/platform/billing/invoices/${INV}/payments`, OWNER, { method: "bank", amountCents: 5000, reference: "B1" });
    assert.equal(over.status, 409); assert.match(over.message ?? "", /more than the balance/);
    assert.equal((await call(api, "POST", `/platform/billing/invoices/${INV}/payments`, OWNER, { method: "cheque", amountCents: 5 })).code, "INVALID_METHOD");
    assert.equal((await call(api, "POST", `/platform/billing/invoices/${INV}/status`, OWNER, { status: "paid", reason: "x" })).code, "INVALID_STATUS");
    assert.equal((await call(api, "DELETE", "/platform/billing/charges/30000000-0000-0000-0000-000000000001", OWNER)).code, "CHARGE_NOT_PENDING");
    const s = await call(api, "PATCH", "/platform/billing/settings", OWNER, { invoicePrefix: " inv ", mpesaPayEnabled: false, graceDays: "10" });
    assert.equal(s.status, 200);
    assert.deepEqual(calls.find((x) => x[0] === "settings"), ["settings", { invoicePrefix: "INV", graceDays: 10, mpesaPayEnabled: false }]);
    assert.equal((await call(api, "PATCH", "/platform/billing/settings", OWNER, {})).status, 400);
    assert.equal((await call(api, "PATCH", "/platform/billing/settings", OWNER, { mpesaPayEnabled: "yes" })).status, 400);
    assert.equal((await call(api, "POST", `/platform/billing/invoices/${INV}/pay`, PA, { phone: "12" })).code, "INVALID_PHONE");
  } finally { await api.close(); }
});

test("BILL-1 API: Pay now sends a prompt, and its callback settles the INVOICE, not a deposit", async () => {
  const { billing, calls } = mem();
  const api = await startTestApi({ depsOverrides: { billing } });
  try {
    const p = await call(api, "POST", `/platform/billing/invoices/${INV}/pay`, PA, { phone: "0712 345 678" });
    assert.equal(p.status, 200); assert.equal(p.body.checkoutRequestId, "ws_CO_BILL"); assert.equal(p.body.amountCents, 100000);
    const cb = { Body: { stkCallback: { MerchantRequestID: "m", CheckoutRequestID: "ws_CO_BILL", ResultCode: 0, ResultDesc: "ok",
      CallbackMetadata: { Item: [{ Name: "MpesaReceiptNumber", Value: "QK77" }, { Name: "Amount", Value: 1000 }] } } } };
    const r = await fetch(`${api.baseUrl}/api/v1/deposits/mpesa/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cb) });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.at(-1), ["settle", "ws_CO_BILL", true, "QK77"]);
  } finally { await api.close(); }
});
