import type { Querier } from "./wallet.js";
import type { DarajaClient } from "./daraja.js";

/**
 * BILL-1 (docs/47, migration 0165): invoices, payments, charges, dunning and revenue for the platform tier.
 *
 * Authorization, validation, money arithmetic and audit all live in the SECURITY DEFINER fn_billing_* RPCs; the
 * reads return camelCase JSON straight from Postgres. This layer adds the one thing SQL cannot do — M-Pesa "Pay
 * now": an STK push from the SYSTEM Daraja account, verification of every result with STKPushQuery (a forged
 * callback can never pay an invoice), and a sweep that settles payments whose callback never arrived.
 */
export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";
export interface InvoiceSummary {
  id: string; number: string; platformId: string; platformName: string; kind: "renewal" | "manual"; status: InvoiceStatus;
  issuedAt: string; dueAt: string; periodStart: string | null; periodEnd: string | null;
  totalCents: number; amountPaidCents: number; amountDueCents: number; overdue: boolean; paidAt: string | null;
}
export interface InvoiceLine {
  id: string; kind: string; description: string; siteId: string | null; siteName: string | null;
  quantity: number; unitCents: number; amountCents: number; periodStart: string | null; periodEnd: string | null;
}
export interface InvoicePayment {
  id: string; method: "mpesa" | "bank" | "cash" | "other"; status: "pending" | "succeeded" | "failed"; amountCents: number;
  reference: string | null; phone: string | null; note: string | null; failureReason: string | null; createdAt: string; settledAt: string | null;
}
export interface Seller {
  name: string; address: string; taxPin: string; email: string; phone: string; taxLabel: string;
  paymentInstructions: string; footerNote: string; mpesaPayEnabled: boolean;
}
export interface Invoice extends InvoiceSummary {
  currency: string; planKey: string | null; subtotalCents: number; taxRateBp: number; taxCents: number;
  voidedAt: string | null; statusReason: string | null; notes: string | null;
  lines: InvoiceLine[]; payments: InvoicePayment[]; seller: Seller;
}
export interface BillingAccount {
  platformId: string; platformName: string; platformSlug: string; planKey: string; planName: string | null;
  priceCents: number | null; customPrice: boolean; billingPeriod: string | null; status: string; billingExempt: boolean;
  trialEndsAt: string | null; currentPeriodStart: string | null; currentPeriodEnd: string | null; graceEndsAt: string | null;
  lastPaymentAt: string | null; nextInvoiceAt: string | null; monthlyAddonsCents: number; pendingChargesCents: number;
  balanceDueCents: number; overdueCents: number; openInvoices: number;
  maxSites: number | null; maxUsers: number | null; sites: number; users: number;
}
export interface PendingCharge { id: string; kind: string; description: string; siteId: string | null; siteName: string | null; amountCents: number; createdAt: string; }
export interface BillingOverview {
  mrrCents: number; arrCents: number; outstandingCents: number; overdueCents: number;
  collectedThisMonthCents: number; collectedLastMonthCents: number;
  aging: { current: number; d1_30: number; d31_60: number; d61_90: number; d90p: number };
  statusCounts: Record<string, number>;
  upcoming: { platformId: string; platformName: string; at: string; amountCents: number }[];
  recentPayments: { id: string; invoiceId: string; number: string; platformName: string; method: string; amountCents: number; reference: string | null; settledAt: string }[];
}
export interface BillingSettings {
  businessName: string; businessAddress: string; taxPin: string; billingEmail: string; billingPhone: string;
  invoicePrefix: string; nextNumber: number; daysUntilDue: number; taxRateBp: number; taxLabel: string;
  paymentInstructions: string; mpesaPayEnabled: boolean; footerNote: string;
  trialDays: number; pastDueDays: number; graceDays: number; updatedAt: string | null;
}
export type BillingSettingsPatch = Partial<Omit<BillingSettings, "nextNumber" | "updatedAt">>;
export interface BillingPlan {
  key: string; name: string; priceCents: number | null; maxSites: number | null; maxUsers: number | null;
  billingPeriod: string; isCustom: boolean; active: boolean; sort: number; platforms: number;
}
export interface NewInvoiceLine { description: string; unitCents: number; quantity?: number; siteId?: string | null; kind?: "adjustment" | "credit" | "addon_one_off" | "addon_setup"; }
export type ManualMethod = "bank" | "cash" | "mpesa" | "other";
export interface BillingSettleResult { known: boolean; applied?: boolean; status?: string; invoiceId?: string; invoiceStatus?: string }

export interface BillingRepository {
  overview(actor: string, role: string): Promise<BillingOverview>;
  accounts(actor: string, role: string): Promise<BillingAccount[]>;
  invoices(actor: string, role: string, f: { platformId: string | null; status: string | null; search: string | null; limit: number }): Promise<InvoiceSummary[]>;
  invoice(actor: string, role: string, id: string): Promise<Invoice>;
  pendingCharges(actor: string, role: string, platformId: string): Promise<PendingCharge[]>;
  settings(actor: string, role: string): Promise<BillingSettings>;
  saveSettings(actor: string, role: string, patch: BillingSettingsPatch): Promise<void>;
  plans(): Promise<BillingPlan[]>;
  upsertPlan(actor: string, role: string, p: { key: string; name: string; priceCents: number | null; maxSites: number | null; maxUsers: number | null; active: boolean }): Promise<void>;
  createInvoice(actor: string, role: string, platformId: string, lines: NewInvoiceLine[], includePending: boolean, dueDays: number | null, notes: string | null): Promise<string>;
  addCharge(actor: string, role: string, platformId: string, siteId: string | null, description: string, amountCents: number): Promise<string>;
  voidCharge(actor: string, role: string, id: string): Promise<void>;
  recordPayment(actor: string, role: string, invoiceId: string, method: ManualMethod, amountCents: number, reference: string | null, note: string | null): Promise<void>;
  setInvoiceStatus(actor: string, role: string, invoiceId: string, status: "void" | "uncollectible", reason: string): Promise<void>;
  setExempt(actor: string, role: string, platformId: string, exempt: boolean): Promise<void>;
  runNow(actor: string, role: string): Promise<{ issued: number; transitions: number; reminders: number }>;
  startMpesa(actor: string, role: string, invoiceId: string, phone: string): Promise<{ paymentId: string; amountCents: number; invoiceNumber: string }>;
  attachCheckout(paymentId: string, checkoutRequestId: string): Promise<void>;
  failStart(paymentId: string, reason: string): Promise<void>;
  isBillingCheckout(checkoutRequestId: string): Promise<boolean>;
  settleMpesa(checkoutRequestId: string, ok: boolean, receipt: string | null, reason: string | null, raw: unknown): Promise<BillingSettleResult>;
  pendingMpesa(olderThanSecs: number, limit: number): Promise<{ paymentId: string; checkoutRequestId: string | null; createdAtMs: number }[]>;
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const nOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

export class PgBillingRepository implements BillingRepository {
  constructor(private readonly q: Querier) {}
  private async one<T>(sql: string, args: unknown[]): Promise<T> {
    const r = await this.q.query(sql, args);
    return (r.rows[0] as { v: T }).v;
  }
  private async many<T>(sql: string, args: unknown[]): Promise<T[]> {
    const r = await this.q.query(sql, args);
    return r.rows.map((x: { v: T }) => x.v);
  }
  overview(a: string, r: string) { return this.one<BillingOverview>("select fn_billing_overview($1,$2) as v", [a, r]); }
  accounts(a: string, r: string) { return this.many<BillingAccount>("select j as v from fn_billing_accounts($1,$2) j", [a, r]); }
  invoices(a: string, r: string, f: { platformId: string | null; status: string | null; search: string | null; limit: number }) {
    return this.many<InvoiceSummary>("select j as v from fn_billing_invoices($1,$2,$3,$4,$5,$6) j", [a, r, f.platformId, f.status, f.search, f.limit]);
  }
  invoice(a: string, r: string, id: string) { return this.one<Invoice>("select fn_billing_invoice($1,$2,$3) as v", [a, r, id]); }
  pendingCharges(a: string, r: string, p: string) { return this.many<PendingCharge>("select j as v from fn_billing_pending_charges($1,$2,$3) j", [a, r, p]); }
  settings(a: string, r: string) { return this.one<BillingSettings>("select fn_billing_settings_get($1,$2) as v", [a, r]); }
  async saveSettings(a: string, r: string, patch: BillingSettingsPatch) { await this.q.query("select fn_billing_settings_set($1,$2,$3::jsonb)", [a, r, JSON.stringify(patch)]); }
  async plans(): Promise<BillingPlan[]> {
    const r = await this.q.query(
      `select sp.*, (select count(*) from platform_subscriptions ps where ps.plan_key = sp.key) as platforms
         from subscription_plans sp order by sp.sort, sp.key`, []);
    return r.rows.map((x: Record<string, unknown>) => ({
      key: String(x.key), name: String(x.name), priceCents: nOrNull(x.price_cents), maxSites: nOrNull(x.max_sites), maxUsers: nOrNull(x.max_users),
      billingPeriod: String(x.billing_period), isCustom: Boolean(x.is_custom), active: Boolean(x.active), sort: n(x.sort), platforms: n(x.platforms),
    }));
  }
  async upsertPlan(a: string, r: string, p: { key: string; name: string; priceCents: number | null; maxSites: number | null; maxUsers: number | null; active: boolean }) {
    await this.q.query("select fn_billing_upsert_plan($1,$2,$3,$4,$5,$6,$7,$8)", [a, r, p.key, p.name, p.priceCents, p.maxSites, p.maxUsers, p.active]);
  }
  createInvoice(a: string, r: string, p: string, lines: NewInvoiceLine[], inc: boolean, due: number | null, notes: string | null) {
    return this.one<string>("select fn_billing_create_invoice($1,$2,$3,$4::jsonb,$5,$6,$7) as v", [a, r, p, JSON.stringify(lines), inc, due, notes]);
  }
  addCharge(a: string, r: string, p: string, s: string | null, d: string, amt: number) {
    return this.one<string>("select fn_billing_add_charge($1,$2,$3,$4,$5,$6) as v", [a, r, p, s, d, amt]);
  }
  async voidCharge(a: string, r: string, id: string) { await this.q.query("select fn_billing_void_charge($1,$2,$3)", [a, r, id]); }
  async recordPayment(a: string, r: string, inv: string, m: ManualMethod, amt: number, ref: string | null, note: string | null) {
    await this.q.query("select fn_billing_record_payment($1,$2,$3,$4,$5,$6,$7)", [a, r, inv, m, amt, ref, note]);
  }
  async setInvoiceStatus(a: string, r: string, inv: string, s: "void" | "uncollectible", reason: string) {
    await this.q.query("select fn_billing_set_invoice_status($1,$2,$3,$4,$5)", [a, r, inv, s, reason]);
  }
  async setExempt(a: string, r: string, p: string, e: boolean) { await this.q.query("select fn_billing_set_exempt($1,$2,$3,$4)", [a, r, p, e]); }
  runNow(a: string, r: string) { return this.one<{ issued: number; transitions: number; reminders: number }>("select fn_billing_run_now($1,$2) as v", [a, r]); }
  async startMpesa(a: string, r: string, inv: string, phone: string) {
    const res = await this.q.query("select * from fn_billing_start_mpesa($1,$2,$3,$4)", [a, r, inv, phone]);
    const x = res.rows[0] as Record<string, unknown>;
    return { paymentId: String(x.payment_id), amountCents: n(x.amount_cents), invoiceNumber: String(x.invoice_number) };
  }
  async attachCheckout(p: string, c: string) { await this.q.query("select fn_billing_attach_checkout($1,$2)", [p, c]); }
  async failStart(p: string, reason: string) { await this.q.query("select fn_billing_fail_start($1,$2)", [p, reason]); }
  async isBillingCheckout(c: string) { return Boolean(await this.one<boolean>("select fn_billing_is_checkout($1) as v", [c])); }
  settleMpesa(c: string, ok: boolean, receipt: string | null, reason: string | null, raw: unknown) {
    return this.one<BillingSettleResult>("select fn_billing_settle_mpesa($1,$2,$3,$4,$5::jsonb) as v", [c, ok, receipt, reason, JSON.stringify(raw ?? {})]);
  }
  async pendingMpesa(older: number, limit: number) {
    const r = await this.q.query("select * from fn_billing_pending_mpesa($1,$2)", [older, limit]);
    return r.rows.map((x: Record<string, unknown>) => ({
      paymentId: String(x.payment_id), checkoutRequestId: x.checkout_request_id == null ? null : String(x.checkout_request_id),
      createdAtMs: new Date(String(x.created_at)).getTime(),
    }));
  }
}

/** Daraja's AccountReference allows 12 characters: TRIO-2026-00012 -> TRIO2600012. */
export function mpesaAccountRef(invoiceNumber: string): string {
  const [prefix = "INV", year = "", seq = ""] = invoiceNumber.split("-");
  const tail = `${year.slice(-2)}${seq}`;
  return `${prefix.slice(0, Math.max(1, 12 - tail.length))}${tail}`.slice(0, 12);
}

export class BillingService {
  constructor(
    private readonly repo: BillingRepository,
    private readonly opts: {
      /** The SYSTEM Daraja client (billing money always lands in the System account). */
      daraja: () => DarajaClient;
      /** Verify every result with STKPushQuery before settling (default true). */
      verify?: boolean;
      log?: (msg: string) => void;
    },
  ) {}

  overview(a: string, r: string) { return this.repo.overview(a, r); }
  accounts(a: string, r: string) { return this.repo.accounts(a, r); }
  invoices(a: string, r: string, f: { platformId?: string | null; status?: string | null; search?: string | null; limit?: number }) {
    const status = f.status ?? null;
    if (status && !["open", "paid", "void", "uncollectible", "overdue", "draft"].includes(status)) throw new Error("INVALID_STATUS");
    return this.repo.invoices(a, r, { platformId: f.platformId || null, status, search: f.search?.trim() || null, limit: Math.min(200, Math.max(1, f.limit ?? 50)) });
  }
  invoice(a: string, r: string, id: string) { return this.repo.invoice(a, r, id); }
  pendingCharges(a: string, r: string, p: string) { return this.repo.pendingCharges(a, r, p); }
  settings(a: string, r: string) { return this.repo.settings(a, r); }
  async saveSettings(a: string, r: string, patch: BillingSettingsPatch) { await this.repo.saveSettings(a, r, patch); return this.repo.settings(a, r); }
  plans() { return this.repo.plans(); }
  upsertPlan(a: string, r: string, p: { key: string; name: string; priceCents: number | null; maxSites: number | null; maxUsers: number | null; active: boolean }) {
    for (const v of [p.priceCents, p.maxSites, p.maxUsers]) if (v != null && (!Number.isInteger(v) || v < 0)) throw new Error("INVALID_AMOUNT");
    return this.repo.upsertPlan(a, r, p);
  }
  async createInvoice(a: string, r: string, platformId: string, lines: NewInvoiceLine[], includePending = true, dueDays: number | null = null, notes: string | null = null) {
    for (const l of lines) {
      if (!Number.isInteger(l.unitCents) || (l.quantity != null && (!Number.isInteger(l.quantity) || l.quantity < 1))) throw new Error("INVALID_LINES");
    }
    const id = await this.repo.createInvoice(a, r, platformId, lines, includePending, dueDays, notes);
    return this.repo.invoice(a, r, id);
  }
  addCharge(a: string, r: string, platformId: string, siteId: string | null, description: string, amountCents: number) {
    if (!Number.isInteger(amountCents) || amountCents === 0) throw new Error("INVALID_AMOUNT");
    return this.repo.addCharge(a, r, platformId, siteId, description.trim(), amountCents);
  }
  voidCharge(a: string, r: string, id: string) { return this.repo.voidCharge(a, r, id); }
  async recordPayment(a: string, r: string, invoiceId: string, method: ManualMethod, amountCents: number, reference: string | null, note: string | null) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
    await this.repo.recordPayment(a, r, invoiceId, method, amountCents, reference, note);
    return this.repo.invoice(a, r, invoiceId);
  }
  async setInvoiceStatus(a: string, r: string, invoiceId: string, status: "void" | "uncollectible", reason: string) {
    await this.repo.setInvoiceStatus(a, r, invoiceId, status, reason);
    return this.repo.invoice(a, r, invoiceId);
  }
  setExempt(a: string, r: string, p: string, e: boolean) { return this.repo.setExempt(a, r, p, e); }
  runNow(a: string, r: string) { return this.repo.runNow(a, r); }

  /**
   * Pay now: reserve a pending payment for the whole balance (the RPC authorizes: owner, or the invoice's own
   * platform admin), send the STK prompt from the System account, and attach Safaricom's checkout id. A push
   * that fails is closed immediately so the payer can try again.
   */
  async payNow(a: string, r: string, invoiceId: string, phone: string): Promise<{ paymentId: string; amountCents: number; invoiceNumber: string; checkoutRequestId: string }> {
    // Scope first (the RPC authorizes before it looks at the phone), so a cross-tenant call is refused, not validated.
    const p = phone.replace(/\s+/g, "");
    const start = await this.repo.startMpesa(a, r, invoiceId, p);
    try {
      const res = await this.opts.daraja().stkPush({ amountCents: start.amountCents, msisdn: p, accountRef: mpesaAccountRef(start.invoiceNumber), desc: "Invoice" });
      await this.repo.attachCheckout(start.paymentId, res.checkoutRequestId);
      return { ...start, checkoutRequestId: res.checkoutRequestId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.repo.failStart(start.paymentId, msg.startsWith("MPESA_NOT_CONFIGURED") ? "M-Pesa is not set up" : "The M-Pesa prompt could not be sent");
      if (msg.startsWith("MPESA_NOT_CONFIGURED")) throw new Error("MPESA_NOT_CONFIGURED");
      throw new Error("MPESA_PUSH_FAILED");
    }
  }

  /**
   * The shared System STK callback calls this first. Not a billing checkout -> {handled:false} (the deposit
   * handler takes it). The reported result is re-checked with STKPushQuery; while Safaricom is still
   * processing we throw so the callback is retried (or the sweep settles it later) — never paid unverified.
   */
  async handleStkCallback(checkoutRequestId: string, resultCode: number, resultDesc: string, receipt: string | null, raw: unknown): Promise<{ handled: boolean; result?: BillingSettleResult }> {
    if (!checkoutRequestId || !(await this.repo.isBillingCheckout(checkoutRequestId))) return { handled: false };
    let code = resultCode;
    // Both outcomes are verified: a forged "cancelled" must not close a prompt the payer is about to approve.
    if (this.opts.verify !== false) {
      const q = await this.opts.daraja().stkPushQuery(checkoutRequestId);
      if (q.processing || q.resultCode == null) throw new Error("STK_VERIFY_PENDING");
      code = q.resultCode;
    }
    const result = await this.repo.settleMpesa(checkoutRequestId, code === 0, code === 0 ? receipt : null,
      code === 0 ? null : (code === resultCode && resultDesc ? resultDesc : `M-Pesa result ${code}`), raw);
    return { handled: true, result };
  }

  /** Settle Pay-now payments whose callback never arrived, from Safaricom's authoritative status. */
  async reconcile(opts: { olderThanSecs?: number; limit?: number } = {}): Promise<{ scanned: number; settled: number; stillPending: number; errors: number }> {
    const rows = await this.repo.pendingMpesa(opts.olderThanSecs ?? 90, opts.limit ?? 25);
    let settled = 0, stillPending = 0, errors = 0;
    for (const p of rows) {
      try {
        if (!p.checkoutRequestId) {
          // Never reached Safaricom (the process died between reserve and push): close it after 10 minutes.
          if (Date.now() - p.createdAtMs > 10 * 60_000) { await this.repo.failStart(p.paymentId, "The M-Pesa prompt was never sent"); settled += 1; }
          else stillPending += 1;
          continue;
        }
        const q = await this.opts.daraja().stkPushQuery(p.checkoutRequestId);
        if (q.processing || q.resultCode == null) { stillPending += 1; continue; }
        const r = await this.repo.settleMpesa(p.checkoutRequestId, q.resultCode === 0, null,
          q.resultCode === 0 ? null : `M-Pesa result ${q.resultCode}`, { reconciled: true, at: new Date().toISOString() });
        if (r.status && r.status !== "pending") settled += 1;
      } catch (err) {
        errors += 1;
        this.opts.log?.(`billing reconcile failed for ${p.paymentId}: ${(err as Error).message}`);
      }
    }
    return { scanned: rows.length, settled, stillPending, errors };
  }
}

/**
 * Minimal in-memory billing store for API tests (the money logic is proven against Postgres). It mirrors the
 * RPCs' AUTHORIZATION exactly — owner: anything; platform admin: only invoices of its own platform
 * (`actorPlatform`), never money actions — so the cross-tenant route matrix exercises real refusals.
 */
export class InMemoryBillingRepository implements BillingRepository {
  readonly actorPlatform = new Map<string, string>();
  readonly invoicesById = new Map<string, Invoice>();
  private owner(r: string) { if (r !== "platform_superadmin") throw new Error("NOT_AUTHORIZED"); }
  private scope(a: string, r: string, platformId: string) {
    if (r === "platform_superadmin") return;
    if (r !== "platform_admin") throw new Error("NOT_AUTHORIZED");
    if (this.actorPlatform.get(a) !== platformId) throw new Error("PLATFORM_SCOPE_FORBIDDEN");
  }
  private get(id: string): Invoice { const i = this.invoicesById.get(id); if (!i) throw new Error("INVOICE_NOT_FOUND"); return i; }
  async overview(_a: string, r: string): Promise<BillingOverview> {
    this.owner(r);
    return { mrrCents: 0, arrCents: 0, outstandingCents: 0, overdueCents: 0, collectedThisMonthCents: 0, collectedLastMonthCents: 0,
      aging: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0 }, statusCounts: {}, upcoming: [], recentPayments: [] };
  }
  async accounts(a: string, r: string) { if (r === "platform_admin" && !this.actorPlatform.has(a)) throw new Error("PLATFORM_SCOPE_FORBIDDEN"); if (r !== "platform_admin") this.owner(r); return []; }
  async invoices(a: string, r: string, f: { platformId: string | null }) {
    const pid = r === "platform_admin" ? this.actorPlatform.get(a) : (this.owner(r), f.platformId);
    if (r === "platform_admin" && !pid) throw new Error("PLATFORM_SCOPE_FORBIDDEN");
    return [...this.invoicesById.values()].filter((i) => !pid || i.platformId === pid);
  }
  async invoice(a: string, r: string, id: string) { const i = this.get(id); this.scope(a, r, i.platformId); return i; }
  async pendingCharges(a: string, r: string, p: string) { this.scope(a, r, p); return []; }
  async settings(_a: string, r: string): Promise<BillingSettings> {
    if (r !== "platform_admin") this.owner(r);
    return { businessName: "TrioCodes", businessAddress: "", taxPin: "", billingEmail: "", billingPhone: "", invoicePrefix: "TRIO", nextNumber: 1,
      daysUntilDue: 7, taxRateBp: 0, taxLabel: "VAT", paymentInstructions: "", mpesaPayEnabled: true, footerNote: "", trialDays: 3, pastDueDays: 3, graceDays: 5, updatedAt: null };
  }
  async saveSettings(_a: string, r: string) { this.owner(r); }
  async plans() { return []; }
  async upsertPlan(_a: string, r: string) { this.owner(r); }
  async createInvoice(_a: string, r: string): Promise<string> { this.owner(r); throw new Error("NOTHING_TO_INVOICE"); }
  async addCharge(_a: string, r: string): Promise<string> { this.owner(r); return "charge"; }
  async voidCharge(_a: string, r: string) { this.owner(r); throw new Error("CHARGE_NOT_PENDING"); }
  async recordPayment(_a: string, r: string, id: string) { this.owner(r); this.get(id); }
  async setInvoiceStatus(_a: string, r: string, id: string) { this.owner(r); this.get(id); }
  async setExempt(_a: string, r: string) { this.owner(r); }
  async runNow(_a: string, r: string) { this.owner(r); return { issued: 0, transitions: 0, reminders: 0 }; }
  async startMpesa(a: string, r: string, id: string, phone: string) {
    const i = this.get(id); this.scope(a, r, i.platformId);
    if (!/^(\+?254|0)?[17]\d{8}$/.test(phone)) throw new Error("INVALID_PHONE");
    return { paymentId: "pay-mem", amountCents: i.amountDueCents, invoiceNumber: i.number };
  }
  async attachCheckout() {}
  async failStart() {}
  async isBillingCheckout() { return false; }
  async settleMpesa(): Promise<BillingSettleResult> { return { known: false }; }
  async pendingMpesa() { return []; }
}
