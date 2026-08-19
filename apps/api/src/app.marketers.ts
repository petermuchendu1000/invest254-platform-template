import { Router, ApiError, requireAuth, requireRole, rateLimit, adminScopeSite, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";
import { mpesaCode, mpesaReceivedMessage, mpesaSentMessage, ksh } from "./mpesa.js";

/**
 * Admin marketer routes (marketers = special players who RECEIVE payments and can withdraw).
 * All admin-gated (superadmin satisfies the hierarchy). Thin transport over the DB RPCs
 * (0033_marketers): fn_marketer_create / _credit / _withdraw / _set_fuliza / _set_airtime and
 * the marketer_profiles view. Amounts are integer cents (KES).
 *
 *  - POST   /admin/marketers                     { name, phone }                       -> marketer
 *  - GET    /admin/marketers?limit                                                     -> profiles[]
 *  - GET    /admin/marketers/:id                                                       -> profile
 *  - POST   /admin/marketers/:id/credit          { amountCents, ref?, meta? }          -> { balanceCents }
 *  - POST   /admin/marketers/:id/withdraw        { amountCents, ref?, meta?, method? } -> WithdrawResult
 *  - PATCH  /admin/marketers/:id/fuliza          { amountCents }                       -> { availableFulizaCents }
 *  - PATCH  /admin/marketers/:id/airtime         { amountCents }                       -> { airtimeBalanceCents }
 *  - GET    /admin/marketers/:id/statement?limit                                       -> ledger[]
 */

const BASE = "/api/v1";

// ── DTOs / repository contract ───────────────────────────────────────────────
export interface MarketerRow {
  id: string; name: string; phone: string; status: string;
  created_at: string; updated_at: string;
}
export interface MarketerProfile {
  id: string; name: string; first_name: string; initials: string;
  phone: string; status: string;
  balance_cents: number; available_fuliza_cents: number; airtime_balance_cents: number;
  currency: string;
}
export interface MarketerLedgerRow {
  id: number; entry_type: string; amount_cents: number; balance_after_cents: number;
  ref: string | null; meta: unknown; created_at: string;
}
export interface WithdrawResult {
  idempotent: boolean; balance_cents: number; withdrawal_id?: string; ledger_id: number;
}

/**
 * A marketer-facing transaction, shaped for the mpesa_2 app: the raw ledger fields plus a
 * ready-to-render M-PESA confirmation (code + full SMS text + amount) so the app can post an
 * OS/in-app notification that looks exactly like a real "money received" alert. Game winnings
 * withdrawn on invest254 land here as a `credit` with `source: "game_withdrawal"`.
 */
export interface MarketerTxDto {
  id: number;
  entryType: string;
  amountCents: number;          // signed: +credit / -withdrawal
  balanceAfterCents: number;
  ref: string | null;
  source: string | null;        // meta.source, e.g. "game_withdrawal"
  direction: "in" | "out";
  createdAtMs: number;
  mpesa: { code: string; party: string; amountText: string; message: string };
}

/** Map a raw ledger row to the app DTO, generating the M-PESA confirmation text. */
export function ledgerToTxDto(r: MarketerLedgerRow): MarketerTxDto {
  const createdAtMs = Number.isFinite(Date.parse(r.created_at)) ? Date.parse(r.created_at) : Date.now();
  const meta = (r.meta && typeof r.meta === "object" ? r.meta : {}) as Record<string, unknown>;
  const source = typeof meta.source === "string" ? meta.source : null;
  const direction: "in" | "out" = r.amount_cents >= 0 ? "in" : "out";
  // Counterparty on the confirmation. Game winnings paid instantly into the mpesa wallet read as
  // coming from the platform; otherwise honour an explicit meta.name, else the generic "M-PESA".
  const rawParty = source === "game_withdrawal"
    ? "Invest254"
    : (typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : "M-PESA");
  const party = rawParty.toUpperCase();
  const code = mpesaCode(createdAtMs, r.id);
  const amountCents = Math.abs(r.amount_cents);
  const message = direction === "in"
    ? mpesaReceivedMessage({ code, amountCents, party, balanceCents: r.balance_after_cents, atMs: createdAtMs })
    : mpesaSentMessage({ code, amountCents, party, balanceCents: r.balance_after_cents, atMs: createdAtMs });
  return {
    id: r.id,
    entryType: r.entry_type,
    amountCents: r.amount_cents,
    balanceAfterCents: r.balance_after_cents,
    ref: r.ref,
    source,
    direction,
    createdAtMs,
    mpesa: { code, party, amountText: ksh(amountCents), message },
  };
}

/** Persistence contract for the marketer module (Postgres impl in marketers.pg.ts). */
export interface MarketerRepo {
  /** Create (or upsert) a marketer within a brand. `siteId` stamps the brand; undefined => default site. */
  create(name: string, phone: string, siteId?: string): Promise<MarketerRow>;
  /** Admin edit of an existing marketer's name and/or phone (per-brand phone unique). */
  update(id: string, name: string | null, phone: string | null): Promise<MarketerRow>;
  /** List marketers. `siteId` scopes to one brand (undefined => all brands, for platform admins). */
  list(limit: number, siteId?: string): Promise<MarketerProfile[]>;
  profile(id: string): Promise<MarketerProfile | null>;
  /** Look up a marketer by phone (the identity shared with the invest254 website account). `siteId` scopes it. */
  profileByPhone(phone: string, siteId?: string): Promise<MarketerProfile | null>;
  credit(id: string, amountCents: number, ref: string | null, meta: unknown): Promise<number>;
  withdraw(id: string, amountCents: number, ref: string | null, meta: unknown, method: string): Promise<WithdrawResult>;
  setFuliza(id: string, amountCents: number): Promise<number>;
  setAirtime(id: string, amountCents: number): Promise<number>;
  statement(id: string, limit: number): Promise<MarketerLedgerRow[]>;
  // ── auth / lifecycle ──
  setPin(id: string, pin: string): Promise<void>;
  /** Returns the marketer id on success, or null on ANY failure (no enumeration). `siteId` scopes the brand. */
  login(phone: string, pin: string, siteId?: string): Promise<string | null>;
  changePin(id: string, currentPin: string, newPin: string): Promise<void>;
  setStatus(id: string, status: string): Promise<string>;
}

// ── Domain-error → HTTP status ───────────────────────────────────────────────
const MARKETER_STATUS: Readonly<Record<string, number>> = {
  MARKETER_NOT_FOUND: 404,
  MARKETER_NOT_ACTIVE: 409,
  INSUFFICIENT_FUNDS: 409,
  AMOUNT_MUST_BE_POSITIVE: 400,
  AMOUNT_MUST_BE_NONNEGATIVE: 400,
  NAME_REQUIRED: 400,
  PHONE_REQUIRED: 400,
  PHONE_TAKEN: 409,
  INVALID_PIN: 400,
  NO_PIN_SET: 409,
  INVALID_CREDENTIALS: 401,
  INVALID_STATUS: 400,
};

/** Translate a thrown DB/domain error (code prefix before ':') into a controlled ApiError. */
async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0]!.trim();
    const status = MARKETER_STATUS[code];
    if (status) throw new ApiError(code, message, status);
    throw err;
  }
}

// ── Input helpers ────────────────────────────────────────────────────────────
function bodyObj(ctx: Ctx): Record<string, unknown> {
  return ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
}
function reqStr(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim().length === 0) throw new ApiError("INVALID_INPUT", `${key} is required`, 400);
  return v.trim();
}
function optStr(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
/** Positive integer cents (for credit/withdraw). */
function reqPositiveCents(o: Record<string, unknown>, key = "amountCents"): number {
  const raw = o[key];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError("INVALID_AMOUNT", `${key} must be a positive integer (cents)`, 400);
  return n;
}
/** Non-negative integer cents (for admin-set balances like Fuliza / airtime). */
function reqNonNegCents(o: Record<string, unknown>, key = "amountCents"): number {
  const raw = o[key];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ApiError("INVALID_AMOUNT", `${key} must be a non-negative integer (cents)`, 400);
  return n;
}
function limitOf(ctx: Ctx, def = 50, max = 200): number {
  const raw = ctx.query.get("limit");
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError("INVALID_LIMIT", "limit must be a positive integer", 400);
  return Math.min(Math.floor(n), max);
}
function idOf(ctx: Ctx): string {
  const id = ctx.params.id;
  if (!id) throw new ApiError("INVALID_INPUT", "marketer id is required", 400);
  return id;
}

/** Exactly-4-digit PIN (accepts a string or number in the body). The marketer app enters it
 *  in four boxes, so the PIN is always exactly 4 digits — no more, no less. */
function reqPin(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^\d{4}$/.test(s)) throw new ApiError("INVALID_PIN", `${key} must be exactly 4 digits`, 400);
  return s;
}

/** Marketer resolved by requireMarketer, keyed by request ctx. */
const marketerCtx = new WeakMap<Ctx, MarketerProfile>();

/**
 * Marketer-scoped gate. The DB is the source of truth for access (NOT the JWT role claim):
 *  - token subject must be an existing marketer  -> else 403 NOT_MARKETER (e.g. a player, or a
 *    demoted user whose marketer record never existed)
 *  - the marketer must be status='active'        -> else 403 MARKETER_INACTIVE (suspended/disabled),
 *    so a demotion/suspension takes effect immediately even while an old token is still valid.
 */
function requireMarketer(deps: ApiDeps) {
  return async (ctx: Ctx): Promise<void> => {
    if (!ctx.claims) throw new ApiError("AUTH_REQUIRED", "authentication required", 401);
    const profile = await deps.marketers.profile(ctx.claims.userId);
    if (!profile) throw new ApiError("NOT_MARKETER", "not a marketer account", 403);
    if (profile.status !== "active") throw new ApiError("MARKETER_INACTIVE", `marketer is ${profile.status}`, 403);
    marketerCtx.set(ctx, profile);
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────
export function registerMarketerRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const admin = requireRole("admin");
  const marketer = requireMarketer(deps);
  const loginLimit = rateLimit({ name: "marketer-login", by: "ip", limit: Number(process.env.RATE_LIMIT_AUTH_PER_MIN) || 40, windowMs: 60_000 });

  // Create / upsert a marketer (by phone) + provision wallet.
  router.post(`${BASE}/admin/marketers`, auth, admin, async (ctx: Ctx) => {
    const b = bodyObj(ctx);
    const m = await domain(() => deps.marketers.create(reqStr(b, "name"), reqStr(b, "phone"), adminScopeSite(ctx) ?? undefined));
    return { status: 201, body: m };
  });

  // Edit an existing marketer's name and/or phone (admin/superadmin). Per-brand phone-unique.
  router.patch(`${BASE}/admin/marketers/:id`, auth, admin, async (ctx: Ctx) => {
    const b = bodyObj(ctx);
    const name = typeof b.name === "string" ? b.name : null;
    const phone = typeof b.phone === "string" ? b.phone : null;
    if (name === null && phone === null) throw new ApiError("VALIDATION", "name and/or phone is required", 400);
    return domain(() => deps.marketers.update(idOf(ctx), name, phone));
  });

  // List marketer profiles (incl. derived first_name + initials and balances).
  // Brand-scoped admins see ONLY their brand's marketers; a platform admin sees all.
  router.get(`${BASE}/admin/marketers`, auth, admin, async (ctx: Ctx) =>
    domain(() => deps.marketers.list(limitOf(ctx), adminScopeSite(ctx) ?? undefined)));

  // Single marketer profile.
  router.get(`${BASE}/admin/marketers/:id`, auth, admin, async (ctx: Ctx) => {
    const p = await domain(() => deps.marketers.profile(idOf(ctx)));
    if (!p) throw new ApiError("MARKETER_NOT_FOUND", "marketer not found", 404);
    return p;
  });

  // Pay a marketer (credit). Idempotent when `ref` is supplied.
  router.post(`${BASE}/admin/marketers/:id/credit`, auth, admin, async (ctx: Ctx) => {
    const b = bodyObj(ctx);
    const balanceCents = await domain(() =>
      deps.marketers.credit(idOf(ctx), reqPositiveCents(b), optStr(b, "ref"), b.meta ?? {}));
    return { balanceCents };
  });

  // Withdraw from a marketer. Blocks overdraw; idempotent when `ref` is supplied.
  router.post(`${BASE}/admin/marketers/:id/withdraw`, auth, admin, async (ctx: Ctx) => {
    const b = bodyObj(ctx);
    return domain(() =>
      deps.marketers.withdraw(idOf(ctx), reqPositiveCents(b), optStr(b, "ref"), b.meta ?? {}, optStr(b, "method") ?? "internal"));
  });

  // Admin sets Available Fuliza for a marketer.
  router.patch(`${BASE}/admin/marketers/:id/fuliza`, auth, admin, async (ctx: Ctx) => {
    const availableFulizaCents = await domain(() => deps.marketers.setFuliza(idOf(ctx), reqNonNegCents(bodyObj(ctx))));
    return { availableFulizaCents };
  });

  // Admin sets airtime balance for a marketer.
  router.patch(`${BASE}/admin/marketers/:id/airtime`, auth, admin, async (ctx: Ctx) => {
    const airtimeBalanceCents = await domain(() => deps.marketers.setAirtime(idOf(ctx), reqNonNegCents(bodyObj(ctx))));
    return { airtimeBalanceCents };
  });

  // Marketer ledger statement (newest-first).
  router.get(`${BASE}/admin/marketers/:id/statement`, auth, admin, async (ctx: Ctx) =>
    domain(() => deps.marketers.statement(idOf(ctx), limitOf(ctx))));

  // ── Marketer self-service auth (phone + PIN) ───────────────────────────────
  // Login: returns a marketer-role JWT + the caller's profile. Generic 401 on any failure.
  router.post(`${BASE}/marketers/auth/login`, loginLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("marketers")))
      throw new ApiError("SYSTEM_DISABLED", "The marketer system is temporarily disabled by the platform.", 403);
    const b = bodyObj(ctx);
    const phone = reqStr(b, "phone");
    const pin = reqPin(b, "pin");
    const id = await domain(() => deps.marketers.login(phone, pin));
    if (!id) throw new ApiError("INVALID_CREDENTIALS", "invalid phone or PIN", 401);
    const token = await deps.auth.issueToken(id, "marketer");
    const marketerProfile = await deps.marketers.profile(id);
    return { token, marketer: marketerProfile };
  });

  // Website-credential login: the marketer signs in with the SAME phone + password they use on the
  // invest254 website. We verify the website account, then resolve the marketer wallet linked to
  // that phone and mint a marketer-scoped token. This is what lets the app fetch the correct
  // marketer name + number at login instead of showing a hardcoded identity.
  //  - bad phone/password           -> 401 INVALID_CREDENTIALS (generic, no enumeration)
  //  - valid account, not a marketer -> 403 NOT_MARKETER
  //  - marketer suspended/disabled   -> 403 MARKETER_INACTIVE
  router.post(`${BASE}/marketers/auth/login-web`, loginLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("marketers")))
      throw new ApiError("SYSTEM_DISABLED", "The marketer system is temporarily disabled by the platform.", 403);
    const b = bodyObj(ctx);
    const phone = reqStr(b, "phone");
    // Read the password verbatim (no trim) so credentials aren't silently mangled.
    const password = typeof b.password === "string" ? b.password : "";
    if (password.length === 0) throw new ApiError("VALIDATION", "password is required", 400);

    // 1) Prove the website account (phone + password). Any failure collapses to a generic 401.
    try {
      await deps.auth.login({ phone, password });
    } catch {
      throw new ApiError("INVALID_CREDENTIALS", "invalid phone or password", 401);
    }

    // 2) The website identity must be linked to an ACTIVE marketer wallet (same phone).
    const profile = await domain(() => deps.marketers.profileByPhone(phone));
    if (!profile) throw new ApiError("NOT_MARKETER", "not a marketer account", 403);
    if (profile.status !== "active") throw new ApiError("MARKETER_INACTIVE", `marketer is ${profile.status}`, 403);

    // 3) Mint a marketer-scoped token (subject = marketer id, as requireMarketer/me expect).
    const token = await deps.auth.issueToken(profile.id, "marketer");
    return { token, marketer: profile };
  });

  // The authenticated marketer's own profile (name/initials/balance/Fuliza/airtime).
  router.get(`${BASE}/marketers/me`, auth, marketer, async (ctx: Ctx) => marketerCtx.get(ctx)!);

  // Marketer's own transaction feed (newest-first), each with a ready-to-render M-PESA
  // confirmation. The app polls this to raise "money received" notifications when a game
  // withdrawal lands in the wallet. The token subject IS the marketer id (see requireMarketer).
  router.get(`${BASE}/marketers/me/transactions`, auth, marketer, async (ctx: Ctx) => {
    const rows = await domain(() => deps.marketers.statement(ctx.claims!.userId, limitOf(ctx)));
    return { items: rows.map(ledgerToTxDto) };
  });

  // Change own PIN (proves possession of the current PIN).
  router.post(`${BASE}/marketers/auth/pin`, auth, marketer, loginLimit, async (ctx: Ctx) => {
    const b = bodyObj(ctx);
    await domain(() => deps.marketers.changePin(marketerCtx.get(ctx)!.id, reqPin(b, "currentPin"), reqPin(b, "newPin")));
    return { ok: true };
  });

  // ── Admin lifecycle (onboarding + demotion/suspension) ─────────────────────
  // Set/reset a marketer's PIN (onboarding or admin recovery — no self-service reset).
  router.post(`${BASE}/admin/marketers/:id/pin`, auth, admin, async (ctx: Ctx) => {
    await domain(() => deps.marketers.setPin(idOf(ctx), reqPin(bodyObj(ctx), "pin")));
    return { ok: true };
  });

  // Set status: active | suspended | disabled. 'disabled'/'suspended' = demotion (blocks login + /me).
  router.patch(`${BASE}/admin/marketers/:id/status`, auth, admin, async (ctx: Ctx) => {
    const status = await domain(() => deps.marketers.setStatus(idOf(ctx), reqStr(bodyObj(ctx), "status")));
    return { status };
  });

  // Bulk: apply a status change (activate|suspend|disable) or a flat credit to many marketers at
  // once. Each row maps to the same idempotent single-marketer RPC and runs independently (partial
  // success). For 'credit', a batch `ref` yields a per-marketer idempotency key (`<ref>:<id>`) so a
  // re-run never double-credits.
  router.post(`${BASE}/admin/marketers/bulk`, auth, admin, async (ctx: Ctx) => {
    const b = bodyObj(ctx);
    const action = typeof b.action === "string" ? b.action : "";
    const raw = Array.isArray(b.marketerIds) ? b.marketerIds : [];
    const ids = [...new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0))];
    if (ids.length === 0) throw new ApiError("VALIDATION", "marketerIds must be a non-empty array", 400);
    if (ids.length > 200) throw new ApiError("VALIDATION", "at most 200 marketers per bulk action", 400);
    const STATUS: Record<string, string> = { activate: "active", suspend: "suspended", disable: "disabled" };
    let run: (id: string) => Promise<unknown>;
    if (action in STATUS) {
      const status = STATUS[action]!;
      run = async (id) => ({ status: await deps.marketers.setStatus(id, status) });
    } else if (action === "credit") {
      const amountCents = reqPositiveCents(b);
      const batchRef = optStr(b, "ref");
      run = async (id) => ({ balanceCents: await deps.marketers.credit(id, amountCents, batchRef ? `${batchRef}:${id}` : null, b.meta ?? {}) });
    } else {
      throw new ApiError("VALIDATION", "action must be one of: activate, suspend, disable, credit", 400);
    }
    const results = await Promise.all(ids.map(async (id) => {
      try { return { id, ok: true, result: await run(id) }; }
      catch (e) { return { id, ok: false, error: (e as { message?: string })?.message ?? "ERROR" }; }
    }));
    const okCount = results.filter((r) => r.ok).length;
    return { action, total: ids.length, okCount, failCount: results.length - okCount, results };
  });
}
