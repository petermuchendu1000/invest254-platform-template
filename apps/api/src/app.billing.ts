import { Router, ApiError, requireAuth, requireRole, type Ctx } from "./http.js";
import type { BillingService, BillingSettingsPatch, ManualMethod, NewInvoiceLine } from "@invest254/engine";
import type { ApiDeps } from "./app.js";

/**
 * BILL-1 (docs/47) — invoices, payments, charges, plans and billing settings.
 *
 *   GET    /platform/billing/overview                  owner — MRR, ARR, outstanding, aging, upcoming, recent payments
 *   GET    /platform/billing/accounts                  owner: every platform · platform admin: its own
 *   GET    /platform/billing/invoices                  ?platform&status(open|paid|void|uncollectible|overdue)&q&limit
 *   GET    /platform/billing/invoices/:id              the full invoice (seller, lines, payments)
 *   POST   /platform/billing/invoices                  owner — a manual invoice
 *   POST   /platform/billing/invoices/:id/payments     owner — record a bank / cash / M-Pesa / other payment
 *   POST   /platform/billing/invoices/:id/status       owner — void | uncollectible (reason required)
 *   POST   /platform/billing/invoices/:id/pay          owner or the invoice's platform admin — M-Pesa Pay now (STK)
 *   GET    /platform/billing/charges?platform=         pending charges for the next invoice
 *   POST   /platform/billing/charges                   owner — a charge (+) or credit (−)
 *   DELETE /platform/billing/charges/:id               owner — void a pending charge
 *   GET    /platform/billing/settings                  seller details, terms, tax, dunning days
 *   PATCH  /platform/billing/settings                  owner
 *   GET    /platform/billing/plans                     every plan with how many platforms use it
 *   PUT    /platform/billing/plans/:key                owner — add or edit a plan
 *   POST   /platform/billing/accounts/:id/exempt       owner — { exempt }
 *   POST   /platform/billing/run                       owner — run renewals + dunning now
 * Scope, validation, arithmetic and audit are enforced in the fn_billing_* RPCs; this layer shapes input.
 */
const BASE = "/api/v1";
const STATUS: Readonly<Record<string, number>> = {
  NOT_AUTHORIZED: 403, PLATFORM_SCOPE_FORBIDDEN: 403,
  PLATFORM_NOT_FOUND: 404, INVOICE_NOT_FOUND: 404, SUBSCRIPTION_NOT_FOUND: 404,
  INVALID_LINES: 400, INVALID_AMOUNT: 400, INVALID_DESCRIPTION: 400, INVALID_METHOD: 400, INVALID_STATUS: 400,
  INVALID_DUE_DAYS: 400, INVALID_PHONE: 400, INVALID_PLAN_KEY: 400, INVALID_PLAN_NAME: 400, INVALID_LIMIT: 400,
  INVALID_PREFIX: 400, INVALID_TAX: 400, INVALID_DUNNING: 400, INVALID_SETTINGS: 400, REASON_REQUIRED: 400,
  NOTHING_TO_INVOICE: 409, INVOICE_NOT_OPEN: 409, INVOICE_HAS_PAYMENTS: 409, PAYMENT_IN_PROGRESS: 409,
  AMOUNT_EXCEEDS_BALANCE: 409, CHARGE_NOT_PENDING: 409, NOTHING_DUE: 409, MPESA_PAY_DISABLED: 409,
  MPESA_NOT_CONFIGURED: 503, MPESA_PUSH_FAILED: 502,
};
const MESSAGES: Readonly<Record<string, string>> = {
  NOTHING_TO_INVOICE: "Add at least one line, or include pending charges.",
  INVALID_LINES: "Every line needs a description and a non-zero price.",
  INVOICE_NOT_OPEN: "This invoice is no longer open.",
  INVOICE_HAS_PAYMENTS: "This invoice has payments, so it can't be voided. Write it off instead.",
  PAYMENT_IN_PROGRESS: "An M-Pesa prompt for this invoice is still open. Wait a minute and check your phone.",
  AMOUNT_EXCEEDS_BALANCE: "That is more than the balance due.",
  CHARGE_NOT_PENDING: "That charge is already on an invoice or was removed.",
  NOTHING_DUE: "Nothing is due on this invoice.",
  MPESA_PAY_DISABLED: "Paying by M-Pesa is switched off. Use the payment instructions on the invoice.",
  MPESA_NOT_CONFIGURED: "M-Pesa is not set up on the System account yet.",
  MPESA_PUSH_FAILED: "The M-Pesa prompt could not be sent. Try again in a moment.",
  INVALID_PHONE: "Enter a Safaricom number like 0712 345 678.",
  REASON_REQUIRED: "Give a short reason.",
  INVALID_PREFIX: "The invoice prefix must be 2–8 capital letters or digits.",
  INVALID_TAX: "Tax must be between 0% and 50%.",
  INVALID_DUE_DAYS: "Payment terms must be 0–90 days.",
  INVALID_DUNNING: "Trial, past-due and grace periods must be 0–90, 0–60 and 0–60 days.",
  INVALID_PLAN_KEY: "The plan key must be lowercase letters, digits or _ (2–31 characters, starting with a letter).",
};

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0]!.trim();
    const status = STATUS[code];
    if (status) throw new ApiError(code, MESSAGES[code] ?? message, status);
    throw err;
  }
}

const obj = (b: unknown): Record<string, unknown> => {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new ApiError("VALIDATION", "request body must be a JSON object", 400);
  return b as Record<string, unknown>;
};
const int = (v: unknown, name: string): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new ApiError("VALIDATION", `${name} must be a whole number`, 400);
  return n;
};
const intOrNull = (v: unknown, name: string): number | null => (v == null || v === "" ? null : int(v, name));
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !UUID.test(v)) throw new ApiError("VALIDATION", `${name} must be an id`, 400);
  return v;
};

const SETTINGS_TEXT = ["businessName", "businessAddress", "taxPin", "billingEmail", "billingPhone", "invoicePrefix", "taxLabel", "paymentInstructions", "footerNote"] as const;
const SETTINGS_INT = ["daysUntilDue", "taxRateBp", "trialDays", "pastDueDays", "graceDays"] as const;
export function parseSettingsPatch(body: unknown): BillingSettingsPatch {
  const b = obj(body); const out: Record<string, unknown> = {};
  for (const k of SETTINGS_TEXT) if (k in b) {
    if (typeof b[k] !== "string") throw new ApiError("VALIDATION", `${k} must be text`, 400);
    const v = (b[k] as string).trim();
    if (v.length > (k === "paymentInstructions" || k === "businessAddress" || k === "footerNote" ? 1000 : 120)) throw new ApiError("VALIDATION", `${k} is too long`, 400);
    out[k] = k === "invoicePrefix" ? v.toUpperCase() : v;
  }
  for (const k of SETTINGS_INT) if (k in b) out[k] = int(b[k], k);
  if ("mpesaPayEnabled" in b) {
    if (typeof b.mpesaPayEnabled !== "boolean") throw new ApiError("VALIDATION", "mpesaPayEnabled must be true or false", 400);
    out.mpesaPayEnabled = b.mpesaPayEnabled;
  }
  if (!Object.keys(out).length) throw new ApiError("VALIDATION", "nothing to update", 400);
  return out as BillingSettingsPatch;
}

export function parseLines(v: unknown): NewInvoiceLine[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > 50) throw new ApiError("VALIDATION", "lines must be a list (at most 50)", 400);
  return v.map((raw, i) => {
    const l = obj(raw);
    const description = str(l.description);
    if (!description || description.length > 200) throw new ApiError("INVALID_LINES", MESSAGES.INVALID_LINES!, 400);
    const line: NewInvoiceLine = { description, unitCents: int(l.unitCents, `lines[${i}].unitCents`) };
    if (l.quantity != null) line.quantity = int(l.quantity, `lines[${i}].quantity`);
    if (l.siteId) line.siteId = uuid(l.siteId, `lines[${i}].siteId`);
    if (l.kind != null) {
      if (!["adjustment", "credit", "addon_one_off", "addon_setup"].includes(String(l.kind))) throw new ApiError("INVALID_LINES", "unknown line kind", 400);
      line.kind = l.kind as NonNullable<NewInvoiceLine["kind"]>;
    }
    return line;
  });
}

export function registerBillingRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const padmin = requireRole("platform_admin");
  const owner = requireRole("platform_superadmin");
  const need = (): BillingService => {
    if (!deps.billing) throw new ApiError("NOT_CONFIGURED", "billing is not available on this deployment", 503);
    return deps.billing;
  };
  const who = (ctx: Ctx) => [ctx.claims!.userId, ctx.claims!.role ?? "player"] as const;
  const B = `${BASE}/platform/billing`;

  router.get(`${B}/overview`, auth, owner, async (ctx: Ctx) => { const [a, r] = who(ctx); return domain(() => need().overview(a, r)); });
  router.get(`${B}/accounts`, auth, padmin, async (ctx: Ctx) => { const [a, r] = who(ctx); return { accounts: await domain(() => need().accounts(a, r)) }; });
  router.get(`${B}/invoices`, auth, padmin, async (ctx: Ctx) => {
    const [a, r] = who(ctx);
    const platform = ctx.query.get("platform");
    const limit = Number(ctx.query.get("limit") ?? "50");
    return { invoices: await domain(() => need().invoices(a, r, {
      platformId: platform ? uuid(platform, "platform") : null, status: ctx.query.get("status") || null,
      search: ctx.query.get("q"), limit: Number.isFinite(limit) ? limit : 50,
    })) };
  });
  router.get(`${B}/invoices/:id`, auth, padmin, async (ctx: Ctx) => {
    const [a, r] = who(ctx); const id = uuid(ctx.params.id, "id");
    return domain(() => need().invoice(a, r, id));
  });
  router.post(`${B}/invoices`, auth, owner, async (ctx: Ctx) => {
    const b = obj(ctx.body); const [a, r] = who(ctx);
    const platformId = uuid(b.platformId, "platformId");
    const lines = parseLines(b.lines);
    const includePending = b.includePending == null ? true : b.includePending === true;
    return domain(() => need().createInvoice(a, r, platformId, lines, includePending, intOrNull(b.dueDays, "dueDays"), str(b.notes)));
  });
  router.post(`${B}/invoices/:id/payments`, auth, owner, async (ctx: Ctx) => {
    const b = obj(ctx.body); const [a, r] = who(ctx); const id = uuid(ctx.params.id, "id");
    const method = String(b.method ?? "");
    if (!["bank", "cash", "mpesa", "other"].includes(method)) throw new ApiError("INVALID_METHOD", "method must be bank, cash, mpesa or other", 400);
    return domain(() => need().recordPayment(a, r, id, method as ManualMethod, int(b.amountCents, "amountCents"), str(b.reference), str(b.note)));
  });
  router.post(`${B}/invoices/:id/status`, auth, owner, async (ctx: Ctx) => {
    const b = obj(ctx.body); const [a, r] = who(ctx); const id = uuid(ctx.params.id, "id");
    if (b.status !== "void" && b.status !== "uncollectible") throw new ApiError("INVALID_STATUS", "status must be void or uncollectible", 400);
    return domain(() => need().setInvoiceStatus(a, r, id, b.status as "void" | "uncollectible", String(b.reason ?? "")));
  });
  router.post(`${B}/invoices/:id/pay`, auth, padmin, async (ctx: Ctx) => {
    const b = obj(ctx.body); const [a, r] = who(ctx); const id = uuid(ctx.params.id, "id");
    return domain(() => need().payNow(a, r, id, typeof b.phone === "string" ? b.phone : ""));
  });
  router.get(`${B}/charges`, auth, padmin, async (ctx: Ctx) => {
    const [a, r] = who(ctx);
    const p = ctx.query.get("platform") || ctx.claims?.platform || "";
    return { charges: await domain(() => need().pendingCharges(a, r, uuid(p, "platform"))) };
  });
  router.post(`${B}/charges`, auth, owner, async (ctx: Ctx) => {
    const b = obj(ctx.body); const [a, r] = who(ctx);
    const desc = str(b.description);
    if (!desc) throw new ApiError("INVALID_DESCRIPTION", "a description is required", 400);
    const id = await domain(() => need().addCharge(a, r, uuid(b.platformId, "platformId"), b.siteId ? uuid(b.siteId, "siteId") : null, desc, int(b.amountCents, "amountCents")));
    return { id };
  });
  router.del(`${B}/charges/:id`, auth, owner, async (ctx: Ctx) => {
    const [a, r] = who(ctx); await domain(() => need().voidCharge(a, r, uuid(ctx.params.id, "id"))); return { ok: true };
  });
  router.get(`${B}/settings`, auth, padmin, async (ctx: Ctx) => { const [a, r] = who(ctx); return domain(() => need().settings(a, r)); });
  router.patch(`${B}/settings`, auth, owner, async (ctx: Ctx) => {
    const patch = parseSettingsPatch(ctx.body); const [a, r] = who(ctx);
    return domain(() => need().saveSettings(a, r, patch));
  });
  router.get(`${B}/plans`, auth, padmin, async (ctx: Ctx) => {
    const all = await domain(() => need().plans());
    // A platform admin sees the active catalog only (no counts of other tenants).
    return { plans: ctx.claims?.role === "platform_superadmin" ? all : all.filter((p) => p.active).map((p) => ({ ...p, platforms: 0 })) };
  });
  router.put(`${B}/plans/:key`, auth, owner, async (ctx: Ctx) => {
    const b = obj(ctx.body); const [a, r] = who(ctx);
    const name = str(b.name);
    if (!name) throw new ApiError("INVALID_PLAN_NAME", "a plan name is required", 400);
    await domain(() => need().upsertPlan(a, r, { key: String(ctx.params.key), name, priceCents: intOrNull(b.priceCents, "priceCents"),
      maxSites: intOrNull(b.maxSites, "maxSites"), maxUsers: intOrNull(b.maxUsers, "maxUsers"), active: b.active !== false }));
    return { plans: await domain(() => need().plans()) };
  });
  router.post(`${B}/accounts/:id/exempt`, auth, owner, async (ctx: Ctx) => {
    const b = obj(ctx.body); const [a, r] = who(ctx);
    if (typeof b.exempt !== "boolean") throw new ApiError("VALIDATION", "exempt must be true or false", 400);
    await domain(() => need().setExempt(a, r, uuid(ctx.params.id, "id"), b.exempt as boolean)); return { ok: true };
  });
  router.post(`${B}/run`, auth, owner, async (ctx: Ctx) => { const [a, r] = who(ctx); return domain(() => need().runNow(a, r)); });
}
