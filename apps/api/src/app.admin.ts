import { Router, ApiError, requireAuth, requireRole, rateLimit, assertTargetSiteInScope, adminScopeSite, DEFAULT_SITE_ID, type Ctx } from "./http.js";
import type { PageQuery, AdminUserListQuery, AdminWithdrawalListQuery, AdminDepositListQuery, AdminTransactionListQuery, ReportRange, GameConfigPatch, MpesaConfigPatch, AdminPayoutListQuery, AdminUserActivityQuery, UserOverridePatch } from "@invest254/engine";
import type { ApiDeps } from "./app.js";

/**
 * Admin back office routes (J2) — all admin-gated (the hierarchy admits superadmin too):
 *  - GET    /admin/overview                       dashboard KPIs
 *  - GET    /admin/users?role&status&q&cursor      user list (keyset)
 *  - GET    /admin/users/:id                        user detail
 *  - POST   /admin/users/:id/{suspend|ban|reactivate}   set status (audited; 0021 RPC)
 *  - PATCH  /admin/affiliates/:id/rate              set commission rate (audited; 0021 RPC)
 *  - POST   /admin/wallets/:id/adjust               manual credit/debit (J3; audited; 0022 RPC)
 *  - GET    /admin/withdrawals?status&cursor        withdrawal queue (read)
 *  - GET    /admin/deposits?status&cursor           deposits monitor (J3; STK statuses)
 *  - GET    /admin/deposits/reconcile?staleMinutes  deposits reconcile read (J3)
 *  - GET    /admin/reports/daily?from&to&format     per-day finance report; JSON or CSV (J4)
 *  - GET    /admin/reports/users?from&to&format     per-user finance report; JSON or CSV (J4)
 *  - GET    /admin/audit?cursor                     audit trail (read)
 * Thin transport over the engine AdminService — guards/audit live in the RPCs / in-memory mirror.
 */

const BASE = "/api/v1";

/** Admin domain-error code -> HTTP status. */
const ADMIN_STATUS: Readonly<Record<string, number>> = {
  NOT_AUTHORIZED: 403,
  INSUFFICIENT_PRIVILEGE: 403,
  SUPERADMIN_PROTECTED: 403,
  NO_SELF_ACTION: 409,
  INVALID_STATUS: 400,
  INVALID_RATE: 400,
  INVALID_ROLE: 400,
  INVALID_PHONE: 400,
  INVALID_USERNAME: 400,
  PHONE_TAKEN: 409,
  USERNAME_TAKEN: 409,
  INVALID_AMOUNT: 400,
  INVALID_KIND: 400,
  INVALID_PATCH: 400,
  OVERRIDE_FAVORS_PLAYER: 422,
  INVALID_OVERRIDE: 400,
  REASON_REQUIRED: 400,
  INSUFFICIENT_FUNDS: 409,
  USER_NOT_FOUND: 404,
  WALLET_NOT_FOUND: 404,
  NOT_AFFILIATE: 404,
  NOT_FOUND: 404,
  // J5 — game config + seed rotation
  INVALID_CONFIG: 400,
  INVALID_DATE: 400,
  PAST_DATE: 409,
  SEED_REVEALED: 409,
  // J6 — affiliate payout decisions
  PAYOUT_NOT_FOUND: 404,
  B2C_UNAVAILABLE: 503,
};

/** Integer game_config fields (cents/durations) — must be whole numbers; the rest may be fractional. */
const CONFIG_INT_FIELDS = new Set(["minStakeCents", "maxStakeCents", "minWithdrawalCents", "defaultDurationS", "tickRateMs"]);
const CONFIG_FIELDS = ["houseEdge", "maxMultiplier", "minStakeCents", "maxStakeCents", "minWithdrawalCents", "defaultDurationS", "tickRateMs", "driftBias", "volatility", "targetWinRate"] as const;

const EAT_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The EAT (Africa/Nairobi, UTC+3, no DST) calendar date for an instant — the withdrawal-pool day key. */
function eatDay(d: Date = new Date()): string {
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/** suspend/ban/reactivate -> the account status the RPC applies. */
const STATUS_ACTION: Readonly<Record<string, string>> = { suspend: "suspended", ban: "banned", reactivate: "active" };

/** Run an AdminService call, translating thrown domain error codes into controlled ApiErrors. */
async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // A Postgres CHECK violation (e.g. the economy-feasibility / min-house-edge guard) surfaces as a
    // constraint-violation message, not a "CODE: ..." domain error — map it to a clean 422.
    if (/site_cfg_feasible/.test(message)) throw new ApiError("site_cfg_feasible", message, 422);
    const code = message.split(":")[0]!.trim();
    const status = ADMIN_STATUS[code];
    if (status) throw new ApiError(code, message, status);
    throw err;
  }
}

/**
 * Admin write-path per-brand enforcement (docs/22 Task H): a site-scoped admin may only mutate a
 * user in its own brand; a platform admin / platform_superadmin is unrestricted. Resolves the
 * target's brand via the AdminService then defers to the shared HTTP guard (tolerant of an unknown
 * target — the site-aware RPC stays the ultimate guard). Throws SITE_SCOPE_FORBIDDEN (403) on a
 * known cross-brand target.
 */
async function ensureUserInScope(deps: ApiDeps, ctx: Ctx, userId: string): Promise<void> {
  assertTargetSiteInScope(ctx, await deps.admin.siteOfUser(userId));
}

/** Parse cursor pagination params (limit clamped by the repository). */
function pageQuery(ctx: Ctx): PageQuery {
  const limitRaw = ctx.query.get("limit");
  return { limit: limitRaw === null ? undefined : Number(limitRaw), cursor: ctx.query.get("cursor") };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse optional inclusive `from`/`to` (YYYY-MM-DD) report bounds (J4). */
function reportRange(ctx: Ctx): ReportRange {
  const parse = (name: string): string | undefined => {
    const v = ctx.query.get(name);
    if (v === null) return undefined;
    if (!DATE_RE.test(v)) throw new ApiError("INVALID_DATE", `${name} must be YYYY-MM-DD`, 400);
    return v;
  };
  const from = parse("from");
  const to = parse("to");
  if (from !== undefined && to !== undefined && from > to) throw new ApiError("INVALID_RANGE", "from must be <= to", 400);
  return { from, to };
}

/** Escape one CSV cell per RFC 4180 (quote when it holds a comma, quote, CR or LF). */
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Stream a CSV file response directly (the JSON layer no-ops once headers are sent). */
function sendCsv(ctx: Ctx, filename: string, header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): void {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  ctx.res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
  });
  ctx.res.end(lines.join("\r\n") + "\r\n");
}

/** True when `?format=csv` is requested. */
const wantsCsv = (ctx: Ctx): boolean => (ctx.query.get("format") ?? "").toLowerCase() === "csv";

/** Parse a `?limit=` query param for plain (non-cursor) lists, clamped to [1, max]. */
function listLimit(ctx: Ctx, def: number, max = 100): number {
  const raw = ctx.query.get("limit");
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError("INVALID_LIMIT", "limit must be a positive integer", 400);
  return Math.min(Math.floor(n), max);
}

/** Parse a partial game_config patch (J5): numeric fields only, at least one, integers where required.
 *  0095: `poolMode` (boolean) is also accepted — it flips sites.pool_mode via fn_admin_set_pool_mode. */
function parseGameConfigPatch(ctx: Ctx): GameConfigPatch {
  const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
  const patch: Record<string, number | boolean> = {};
  for (const key of CONFIG_FIELDS) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) throw new ApiError("VALIDATION", `${key} must be a finite number`, 400);
    if (CONFIG_INT_FIELDS.has(key) && !Number.isInteger(n)) throw new ApiError("VALIDATION", `${key} must be an integer (cents/seconds/ms)`, 400);
    patch[key] = n;
  }
  if (body.poolMode !== undefined && body.poolMode !== null) {
    if (typeof body.poolMode !== "boolean") throw new ApiError("VALIDATION", "poolMode must be a boolean", 400);
    patch.poolMode = body.poolMode;
  }
  if (Object.keys(patch).length === 0) throw new ApiError("VALIDATION", "provide at least one config field to update", 400);
  return patch as GameConfigPatch;
}

/** Parse a per-user overrides patch (J8). Numeric fields accept a value or null (clear to global). */
const OVERRIDE_NUM_FIELDS = ["winRate", "houseEdge", "tradeDurationS", "maxWinMultiplier", "minStakeCents", "maxStakeCents"] as const;
function parseOverridePatch(ctx: Ctx): UserOverridePatch {
  const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
  const patch: Record<string, unknown> = {};
  for (const key of OVERRIDE_NUM_FIELDS) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === null || raw === "") { patch[key] = null; continue; } // clear back to the global value
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) throw new ApiError("VALIDATION", `${key} must be a number or null`, 400);
    if (key === "winRate" && !(n > 0 && n <= 1)) throw new ApiError("VALIDATION", "winRate must be in (0,1]", 400);
    if (key === "houseEdge" && !(n >= 0 && n < 1)) throw new ApiError("VALIDATION", "houseEdge must be in [0,1)", 400);
    if (key === "maxWinMultiplier" && !(n > 1)) throw new ApiError("VALIDATION", "maxWinMultiplier must be > 1", 400);
    if (key === "tradeDurationS" && (!Number.isInteger(n) || n < 1 || n > 3600)) throw new ApiError("VALIDATION", "tradeDurationS must be an integer in 1..3600", 400);
    if ((key === "minStakeCents" || key === "maxStakeCents") && (!Number.isInteger(n) || n <= 0)) throw new ApiError("VALIDATION", `${key} must be a positive integer (cents)`, 400);
    patch[key] = n;
  }
  if ("notes" in body) patch["notes"] = body.notes === null ? null : String(body.notes).slice(0, 500);
  if (Object.keys(patch).length === 0) throw new ApiError("VALIDATION", "provide at least one override field", 400);
  return patch as UserOverridePatch;
}

/** Plain (non-secret) and secret M-Pesa config fields the PATCH accepts. */
const MPESA_PLAIN_FIELDS = ["shortcode", "stkCallbackUrl", "b2cInitiator", "b2cResultUrl", "b2cTimeoutUrl"] as const;
const MPESA_SECRET_FIELDS = ["consumerKey", "consumerSecret", "passkey", "securityCredential"] as const;

/** Validate + assemble an M-Pesa config patch. Strings are trimmed; empty secret strings are
 *  dropped (write-only semantics: only a non-empty value rotates a secret). */
function parseMpesaConfigPatch(ctx: Ctx): MpesaConfigPatch {
  const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
  const patch: Record<string, string> = {};
  if (body.environment !== undefined && body.environment !== null) {
    const env = String(body.environment);
    if (env !== "sandbox" && env !== "production") throw new ApiError("VALIDATION", "environment must be 'sandbox' or 'production'", 400);
    patch.environment = env;
  }
  for (const key of MPESA_PLAIN_FIELDS) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") throw new ApiError("VALIDATION", `${key} must be a string`, 400);
    patch[key] = raw.trim();
  }
  for (const key of MPESA_SECRET_FIELDS) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") throw new ApiError("VALIDATION", `${key} must be a string`, 400);
    const v = raw.trim();
    if (v !== "") patch[key] = v; // empty → keep existing secret
  }
  if (Object.keys(patch).length === 0) throw new ApiError("VALIDATION", "provide at least one M-Pesa field to update", 400);
  return patch as MpesaConfigPatch;
}

/** Require a non-empty `id`/`tradeDate` `YYYY-MM-DD` body field (J5 seed rotation). */
function bodyTradeDate(ctx: Ctx): string {
  const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
  const v = body.tradeDate ?? body.date;
  if (typeof v !== "string" || !DATE_RE.test(v)) throw new ApiError("INVALID_DATE", "tradeDate must be YYYY-MM-DD", 400);
  return v;
}

/** Parse a positive-integer path param (chat message id). */
function intParam(ctx: Ctx, name: string): number {
  const n = Number(ctx.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError("INVALID_ID", `${name} must be a positive integer`, 400);
  return n;
}

export function registerAdminRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const admin = requireRole("admin");
  const superadmin = requireRole("superadmin");

  router.get(`${BASE}/admin/overview`, auth, admin, async (ctx: Ctx) => deps.admin.overview(adminScopeSite(ctx) ?? undefined));

  router.get(`${BASE}/admin/users`, auth, admin, async (ctx: Ctx) => {
    // Optional non-negative integer (cents/count) query param; ignored when absent or invalid.
    const numParam = (name: string): number | undefined => {
      const raw = ctx.query.get(name);
      if (raw === null || raw === "") return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
    };
    const q: AdminUserListQuery = {
      ...pageQuery(ctx),
      role: ctx.query.get("role") ?? undefined,
      status: ctx.query.get("status") ?? undefined,
      q: ctx.query.get("q") ?? undefined,
      minBalanceCents: numParam("minBalanceCents"),
      maxBalanceCents: numParam("maxBalanceCents"),
      minDepositsCents: numParam("minDepositsCents"),
      minWithdrawalsCents: numParam("minWithdrawalsCents"),
      minTurnoverCents: numParam("minTurnoverCents"),
      minBets: numParam("minBets"),
      // Admin site scope: a token minted for a site operator carries a `site` claim -> only that
      // brand's users; a platform admin token has no claim -> all brands (docs/22 Task E/H).
      siteId: ctx.claims?.site,
    };
    return deps.admin.listUsers(q);
  });

  router.get(`${BASE}/admin/users/:id`, auth, admin, async (ctx: Ctx) =>
    domain(() => deps.admin.getUserDetail(ctx.params.id!)));

  // Per-user activity timeline (J7) — deposits + withdrawals + bets, newest-first, keyset-paginated.
  router.get(`${BASE}/admin/users/:id/activity`, auth, admin, async (ctx: Ctx) => {
    const kindRaw = ctx.query.get("kind");
    if (kindRaw !== null && kindRaw !== "deposit" && kindRaw !== "withdrawal" && kindRaw !== "bet") {
      throw new ApiError("INVALID_KIND", "kind must be 'deposit', 'withdrawal', or 'bet'", 400);
    }
    const q: AdminUserActivityQuery = { ...pageQuery(ctx), kind: kindRaw ?? undefined };
    const page = await deps.admin.listUserActivity(ctx.params.id!, q);
    return { items: page.items, nextCursor: page.nextCursor };
  });

  for (const action of Object.keys(STATUS_ACTION)) {
    router.post(`${BASE}/admin/users/:id/${action}`, auth, admin, async (ctx: Ctx) => {
      const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
      const reason = typeof body.reason === "string" ? body.reason : null;
      const targetId = ctx.params.id!;
      await ensureUserInScope(deps, ctx, targetId);
      const result = await domain(() => deps.admin.setUserStatus(ctx.claims!.userId, ctx.claims!.role ?? "player", targetId, STATUS_ACTION[action]!, reason));
      // Blocking, non-dismissible banner while the account is limited; auto-resolve on reactivate.
      // Best-effort so a notification hiccup never fails the status change (the money-safe op).
      try {
        if (action === "suspend" || action === "ban") {
          await deps.notifications.resolveByCategory(targetId, "account_limited");
          await deps.notifications.create({
            userId: targetId, level: "error", dismissible: false, category: "account_limited",
            title: action === "ban" ? "Your account has been banned" : "Your account is suspended",
            body: reason && reason.trim() !== ""
              ? `Reason: ${reason.trim()}. Contact support if you believe this is a mistake.`
              : "Some actions are unavailable. Contact support if you believe this is a mistake.",
            createdBy: ctx.claims!.userId,
          });
        } else if (action === "reactivate") {
          await deps.notifications.resolveByCategory(targetId, "account_limited");
          await deps.notifications.create({
            userId: targetId, level: "success", dismissible: true, category: "account_reactivated",
            title: "Your account has been reactivated", body: "Welcome back — full access is restored.",
            createdBy: ctx.claims!.userId,
          });
        }
      } catch { /* non-fatal: status change already succeeded */ }
      return result;
    });
  }

  // Role management — a plain admin may promote/demote player<->marketer (the RPC confines admins to
  // that transition); superadmin+ retain full power (admin/superadmin). Effective on next login.
  router.post(`${BASE}/admin/users/:id/role`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const role = typeof body.role === "string" ? body.role : "";
    if (!["player", "marketer", "admin", "superadmin"].includes(role)) {
      throw new ApiError("VALIDATION", "role must be player|marketer|admin|superadmin", 400);
    }
    await ensureUserInScope(deps, ctx, ctx.params.id!);
    return domain(() => deps.admin.setUserRole(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, role));
  });

  // Edit a user's contact details — phone and/or username (item 6). Admin+, brand-scoped, unique-per-brand.
  router.post(`${BASE}/admin/users/:id/details`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const phone = typeof body.phone === "string" ? body.phone : null;
    const username = typeof body.username === "string" ? body.username : null;
    if (phone === null && username === null) throw new ApiError("VALIDATION", "provide phone and/or username", 400);
    await ensureUserInScope(deps, ctx, ctx.params.id!);
    return domain(() => deps.admin.updateUserDetails(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, phone, username));
  });

  router.patch(`${BASE}/admin/affiliates/:id/rate`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const rate = typeof body.rate === "number" ? body.rate : Number(body.rate);
    if (!Number.isFinite(rate)) throw new ApiError("VALIDATION", "rate (0..1) is required", 400);
    await ensureUserInScope(deps, ctx, ctx.params.id!);
    return domain(() => deps.admin.setCommissionRate(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, rate));
  });

  router.post(`${BASE}/admin/wallets/:id/adjust`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const reason = typeof body.reason === "string" ? body.reason : "";
    if (reason.trim() === "") throw new ApiError("REASON_REQUIRED", "reason is required", 400);
    const raw = body.amountCents ?? body.amount;
    const magnitude = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(magnitude) || magnitude === 0) throw new ApiError("INVALID_AMOUNT", "amountCents must be a non-zero integer (cents)", 400);
    // Optional explicit direction makes the sign unambiguous; otherwise a signed amount is taken as-is.
    const dir = body.direction;
    const signed = dir === "credit" || dir === "debit" ? Math.abs(magnitude) * (dir === "debit" ? -1 : 1) : magnitude;
    // J8: optional `kind` ('real'|'bonus'); default keeps the legacy real-wallet behaviour.
    const kind = body.kind === "bonus" ? "bonus" : body.kind === "real" ? "real" : undefined;
    await ensureUserInScope(deps, ctx, ctx.params.id!);
    if (kind) return domain(() => deps.admin.adjustBalanceKind(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, signed, kind, reason));
    return domain(() => deps.admin.adjustBalance(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, signed, reason));
  });

  // J8: clear a wallet (real|bonus|both) to zero.
  router.post(`${BASE}/admin/wallets/:id/clear`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const reason = typeof body.reason === "string" ? body.reason : "";
    if (reason.trim() === "") throw new ApiError("REASON_REQUIRED", "reason is required", 400);
    const kind = body.kind === "real" || body.kind === "bonus" || body.kind === "both" ? body.kind : "real";
    await ensureUserInScope(deps, ctx, ctx.params.id!);
    return domain(() => deps.admin.clearBalance(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, kind, reason));
  });

  // Reset a user's REAL wallet to their last funded (most recent successful deposit) amount.
  // For recovering a corrupted balance after a system issue — audited via the 0042 RPC.
  router.post(`${BASE}/admin/users/:id/reset-balance`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const reason = typeof body.reason === "string" ? body.reason : "";
    if (reason.trim() === "") throw new ApiError("REASON_REQUIRED", "reason is required", 400);
    await ensureUserInScope(deps, ctx, ctx.params.id!);
    return domain(() => deps.admin.resetBalanceToLastFunded(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, reason.trim()));
  });

  // Mass admin actions over a set of selected users. Each target is processed independently and
  // audited via the same domain calls as the single-user routes, so guards (superadmin-protected,
  // no-self-action) and audit apply per user; partial success is reported per target.
  router.post(`${BASE}/admin/users/bulk`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const action = typeof body.action === "string" ? body.action : "";
    const rawIds = Array.isArray(body.userIds) ? body.userIds : [];
    const userIds = [...new Set(rawIds.filter((x): x is string => typeof x === "string" && x.length > 0))];
    if (userIds.length === 0) throw new ApiError("VALIDATION", "userIds must be a non-empty array", 400);
    if (userIds.length > 500) throw new ApiError("VALIDATION", "at most 500 users per bulk action", 400);
    const actor = ctx.claims!.userId;
    const actorRole = ctx.claims!.role ?? "player";

    // Build a per-user executor for the requested action (validating shared params up front).
    let run: (id: string) => Promise<unknown>;
    switch (action) {
      case "suspend": case "ban": case "reactivate": {
        const status = STATUS_ACTION[action]!;
        const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
        run = async (id) => {
          const res = await deps.admin.setUserStatus(actor, actorRole, id, status, reason);
          try {
            if (action === "suspend" || action === "ban") {
              await deps.notifications.resolveByCategory(id, "account_limited");
              await deps.notifications.create({
                userId: id, level: "error", dismissible: false, category: "account_limited",
                title: action === "ban" ? "Your account has been banned" : "Your account is suspended",
                body: reason ? `Reason: ${reason}. Contact support if you believe this is a mistake.`
                             : "Some actions are unavailable. Contact support if you believe this is a mistake.",
                createdBy: actor,
              });
            } else {
              await deps.notifications.resolveByCategory(id, "account_limited");
              await deps.notifications.create({
                userId: id, level: "success", dismissible: true, category: "account_reactivated",
                title: "Your account has been reactivated", body: "Welcome back — full access is restored.", createdBy: actor,
              });
            }
          } catch { /* non-fatal: status change already succeeded */ }
          return res;
        };
        break;
      }
      case "reset-balance": {
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!reason) throw new ApiError("REASON_REQUIRED", "reason is required", 400);
        run = (id) => deps.admin.resetBalanceToLastFunded(actor, actorRole, id, reason);
        break;
      }
      case "clear-balance": {
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!reason) throw new ApiError("REASON_REQUIRED", "reason is required", 400);
        const kind = body.kind === "real" || body.kind === "bonus" || body.kind === "both" ? body.kind : "real";
        run = (id) => deps.admin.clearBalance(actor, actorRole, id, kind, reason);
        break;
      }
      case "adjust-balance": {
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!reason) throw new ApiError("REASON_REQUIRED", "reason is required", 400);
        const raw = body.amountCents ?? body.amount;
        const mag = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isInteger(mag) || mag <= 0) throw new ApiError("INVALID_AMOUNT", "amountCents must be a positive integer (cents)", 400);
        const signed = body.direction === "debit" ? -Math.abs(mag) : Math.abs(mag);
        const kind = body.kind === "bonus" ? "bonus" : body.kind === "real" ? "real" : undefined;
        run = (id) => kind
          ? deps.admin.adjustBalanceKind(actor, actorRole, id, signed, kind, reason)
          : deps.admin.adjustBalance(actor, actorRole, id, signed, reason);
        break;
      }
      case "notify": {
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title) throw new ApiError("VALIDATION", "title is required", 400);
        if (title.length > 120) throw new ApiError("VALIDATION", "title must be <= 120 chars", 400);
        const level = ["info", "success", "warning", "error"].includes(String(body.level)) ? String(body.level) : "info";
        const text = typeof body.body === "string" ? body.body.slice(0, 1000) : "";
        const dismissible = body.dismissible === undefined ? true : Boolean(body.dismissible);
        const category = typeof body.category === "string" && body.category ? body.category.slice(0, 64) : null;
        run = async (id) => {
          const row = await deps.notifications.create({ userId: id, title, body: text, level: level as "info" | "success" | "warning" | "error", dismissible, category, createdBy: actor });
          await deps.admin.recordAction(actor, actorRole, "notification.create", "user", id, { notificationId: row.id, level, dismissible, category, bulk: true });
          return { notificationId: row.id };
        };
        break;
      }
      default:
        throw new ApiError("VALIDATION", "action must be one of: suspend, ban, reactivate, reset-balance, clear-balance, adjust-balance, notify", 400);
    }

    const results = await Promise.all(userIds.map(async (id) => {
      try {
        // Per-brand write-path guard (docs/22 Task H): a site-scoped admin can only touch its own
        // brand's users. Enforced per target so a cross-brand id fails just that row (partial success).
        await ensureUserInScope(deps, ctx, id);
        return { userId: id, ok: true, result: await run(id) };
      }
      catch (e) { return { userId: id, ok: false, error: (e as { message?: string })?.message ?? "ERROR" }; }
    }));
    const okCount = results.filter((r) => r.ok).length;
    return { action, total: userIds.length, okCount, failCount: results.length - okCount, results };
  });

  // J8: per-user engine overrides (win rate / auto-sell duration / max multiplier / stake bounds).
  router.get(`${BASE}/admin/users/:id/overrides`, auth, admin, async (ctx: Ctx) =>
    (await deps.admin.getUserOverrides(ctx.params.id!)) ?? {
      userId: ctx.params.id!, winRate: null, houseEdge: null, tradeDurationS: null, maxWinMultiplier: null,
      minStakeCents: null, maxStakeCents: null, notes: null, updatedBy: null, updatedAtMs: null,
    });
  // Writing a per-user override is a powerful statistical lever → superadmin-gated (docs/22 Task H).
  // platform_superadmin (rank 5) also satisfies this. The RPC stamps the override with the target's
  // brand (user_overrides.site_id) and writes an admin_actions audit row.
  router.post(`${BASE}/admin/users/:id/overrides`, auth, superadmin, async (ctx: Ctx) => {
    const patch = parseOverridePatch(ctx);
    await ensureUserInScope(deps, ctx, ctx.params.id!);
    return domain(() => deps.admin.setUserOverrides(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, patch));
  });

  router.get(`${BASE}/admin/withdrawals`, auth, admin, async (ctx: Ctx) => {
    const q: AdminWithdrawalListQuery = { ...pageQuery(ctx), status: ctx.query.get("status") ?? undefined, siteId: ctx.claims?.site };
    return deps.admin.listWithdrawals(q);
  });

  router.get(`${BASE}/admin/deposits/reconcile`, auth, admin, async (ctx: Ctx) => {
    const raw = ctx.query.get("staleMinutes");
    const n = raw === null ? 15 : Number(raw);
    return deps.admin.depositsReconcile(Number.isFinite(n) && n >= 0 ? n : 15);
  });

  router.get(`${BASE}/admin/deposits`, auth, admin, async (ctx: Ctx) => {
    const q: AdminDepositListQuery = { ...pageQuery(ctx), status: ctx.query.get("status") ?? undefined, siteId: ctx.claims?.site };
    return deps.admin.listDeposits(q);
  });

  // Unified deposits + withdrawals feed for the Finance transactions explorer.
  // Filterable by kind (deposit|withdrawal), status, and free-text search (username/phone/receipt).
  router.get(`${BASE}/admin/transactions`, auth, admin, async (ctx: Ctx) => {
    const kindRaw = ctx.query.get("kind");
    if (kindRaw !== null && kindRaw !== "deposit" && kindRaw !== "withdrawal") {
      throw new ApiError("INVALID_KIND", "kind must be 'deposit' or 'withdrawal'", 400);
    }
    const q: AdminTransactionListQuery = {
      ...pageQuery(ctx),
      kind: kindRaw ?? undefined,
      status: ctx.query.get("status") ?? undefined,
      q: ctx.query.get("q") ?? undefined,
      siteId: ctx.claims?.site,
    };
    return deps.admin.listTransactions(q);
  });

  router.get(`${BASE}/admin/reports/daily`, auth, admin, async (ctx: Ctx) => {
    const rows = await deps.admin.reportDaily(reportRange(ctx), adminScopeSite(ctx) ?? undefined);
    if (wantsCsv(ctx)) {
      return sendCsv(ctx, "report-daily.csv",
        ["date", "deposits_cents", "withdrawals_cents", "turnover_cents", "ggr_cents"],
        rows.map((r) => [r.date, r.depositsCents, r.withdrawalsCents, r.turnoverCents, r.ggrCents]));
    }
    return { items: rows };
  });

  router.get(`${BASE}/admin/reports/users`, auth, admin, async (ctx: Ctx) => {
    const rows = await deps.admin.reportByUser(reportRange(ctx), adminScopeSite(ctx) ?? undefined);
    if (wantsCsv(ctx)) {
      return sendCsv(ctx, "report-users.csv",
        ["user_id", "username", "deposits_cents", "withdrawals_cents", "turnover_cents", "ggr_cents"],
        rows.map((r) => [r.userId, r.username, r.depositsCents, r.withdrawalsCents, r.turnoverCents, r.ggrCents]));
    }
    return { items: rows };
  });

  // Day explorer (calendar): comprehensive single-day stats. Defaults to today (EAT) if no date.
  router.get(`${BASE}/admin/reports/day`, auth, admin, async (ctx: Ctx) => {
    const date = ctx.query.get("date") ?? new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError("VALIDATION", "date must be YYYY-MM-DD", 400);
    return deps.admin.reportDay(date, adminScopeSite(ctx) ?? undefined);
  });

  router.get(`${BASE}/admin/audit`, auth, admin, async (ctx: Ctx) => deps.admin.listAudit(pageQuery(ctx)));

  // ── J5: game configuration + RTP monitor + seed rotation (superadmin mutations) ───────────────

  // Resolve the brand this admin edit targets: a site-scoped operator is pinned to their JWT `site`
  // claim (cannot cross brands); an unrestricted platform operator may name a brand via ?site=, else
  // the default site. This is what reconnects the panel to the table the engine reads (0061).
  const configSiteId = (ctx: Ctx): string => adminScopeSite(ctx) ?? ctx.query.get("site") ?? DEFAULT_SITE_ID;

  router.get(`${BASE}/admin/game-config`, auth, admin, async (ctx: Ctx) => deps.admin.getGameConfig(configSiteId(ctx)));

  router.patch(`${BASE}/admin/game-config`, auth, superadmin, async (ctx: Ctx) => {
    const patch = parseGameConfigPatch(ctx);
    return domain(() => deps.admin.updateGameConfig(ctx.claims!.userId, ctx.claims!.role ?? "player", patch, configSiteId(ctx)));
  });

  // docs/25 Phase 1 — daily withdrawal-pool budget (per brand, EAT day). Read = admin; set = superadmin.
  // `?day=YYYY-MM-DD` (EAT) optional; defaults to the current EAT day. Site resolved like game-config.
  router.get(`${BASE}/admin/withdrawal-pool`, auth, admin, async (ctx: Ctx) => {
    const day = ctx.query.get("day") || eatDay();
    if (!EAT_DAY_RE.test(day)) throw new ApiError("VALIDATION", "day must be YYYY-MM-DD (EAT)", 400);
    return deps.admin.getWithdrawalPool(configSiteId(ctx), day);
  });

  router.put(`${BASE}/admin/withdrawal-pool`, auth, superadmin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const day = body.day === undefined || body.day === null ? eatDay() : String(body.day);
    if (!EAT_DAY_RE.test(day)) throw new ApiError("VALIDATION", "day must be YYYY-MM-DD (EAT)", 400);
    const parseAmt = (v: unknown, label: string): number => {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isInteger(n) || n < 0) throw new ApiError("VALIDATION", `${label} must be a non-negative integer (cents)`, 400);
      return n;
    };
    const hasToday = body.amountCents !== undefined || body.amount !== undefined;
    const hasDefault = body.defaultAmountCents !== undefined;
    if (!hasToday && !hasDefault) throw new ApiError("VALIDATION", "provide amountCents (today) and/or defaultAmountCents (recurring)", 400);
    const today = hasToday ? parseAmt(body.amountCents ?? body.amount, "amountCents") : null;
    const dflt = hasDefault ? parseAmt(body.defaultAmountCents, "defaultAmountCents") : null;
    const actor = ctx.claims!.userId, role = ctx.claims!.role ?? "player", site = configSiteId(ctx);
    return domain(async () => {
      let row = await deps.admin.getWithdrawalPool(site, day);
      if (dflt !== null) row = await deps.admin.setDefaultPool(actor, role, site, day, dflt);
      if (today !== null) row = await deps.admin.setWithdrawalPool(actor, role, site, day, today);
      return row;
    });
  });

  // 0067 — per-brand withdrawal kill switch. Read + toggle for admin/superadmin. Site resolved like
  // the pool routes: a site-scoped admin only sees/flips its own brand; platform admins are unrestricted.
  // Distinct path (not under /admin/withdrawals/:id) so it can never collide with the moderation routes.
  router.get(`${BASE}/admin/withdrawals-enabled`, auth, admin, async (ctx: Ctx) => {
    return { enabled: await deps.admin.getWithdrawalsEnabled(configSiteId(ctx)) };
  });

  router.put(`${BASE}/admin/withdrawals-enabled`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    if (typeof body.enabled !== "boolean") throw new ApiError("VALIDATION", "enabled must be a boolean", 400);
    const actor = ctx.claims!.userId, role = ctx.claims!.role ?? "player", site = configSiteId(ctx);
    return domain(async () => ({ enabled: await deps.admin.setWithdrawalsEnabled(actor, role, site, body.enabled as boolean) }));
  });

  router.get(`${BASE}/admin/rtp`, auth, admin, async (ctx: Ctx) => deps.admin.rtpMonitor(adminScopeSite(ctx) ?? undefined));
  // Real-cash RTP (rec #7): committed-money truth from the ledger, marketer cohort shown separately.
  router.get(`${BASE}/admin/real-cash-rtp`, auth, admin, async (ctx: Ctx) => deps.admin.realCashRtp(adminScopeSite(ctx) ?? undefined));
  // Economy change review (docs/28 §4): recent config versions with diffs + risk flags.
  router.get(`${BASE}/admin/config-review`, auth, admin, async (ctx: Ctx) =>
    deps.admin.configChangeReview(adminScopeSite(ctx) ?? "00000000-0000-0000-0000-000000000001", Math.min(200, Math.max(1, Number(ctx.query.get("limit") ?? "50") || 50))));
  // ── M-Pesa configuration (admin reads masked; superadmin edits; secrets write-only) ──────────
  router.get(`${BASE}/admin/mpesa-config`, auth, admin, async () => domain(() => deps.admin.getMpesaConfig()));

  router.patch(`${BASE}/admin/mpesa-config`, auth, superadmin, async (ctx: Ctx) => {
    const patch = parseMpesaConfigPatch(ctx);
    return domain(() => deps.admin.updateMpesaConfig(ctx.claims!.userId, ctx.claims!.role ?? "player", patch));
  });

  router.get(`${BASE}/admin/seeds`, auth, admin, async (ctx: Ctx) => ({ items: await deps.admin.listSeeds(listLimit(ctx, 30), adminScopeSite(ctx) ?? undefined) }));

  router.post(`${BASE}/admin/seeds/rotate`, auth, superadmin, async (ctx: Ctx) =>
    domain(() => deps.admin.rotateSeed(ctx.claims!.userId, ctx.claims!.role ?? "player", bodyTradeDate(ctx))));

  // ── J6: affiliate payout approve/reject QUEUE ────────────────────────────────────────────────
  // The approve/reject *actions* already ship in app.affiliate.ts (I4) at
  // /admin/affiliate/payouts/:id/{approve,reject} (now audited). J6 adds the queue the UI lists from.
  router.get(`${BASE}/admin/affiliate/payouts`, auth, admin, async (ctx: Ctx) => {
    const q: AdminPayoutListQuery = { ...pageQuery(ctx), status: ctx.query.get("status") ?? undefined, siteId: adminScopeSite(ctx) ?? undefined };
    return deps.admin.listAffiliatePayouts(q);
  });


  // ── Fly.io machine restart (superadmin only) ──────────────────────────────
  // Restarts the API + engine Fly machines after a deploy so new code picks up.
  // The Fly API token lives ONLY in the FLY_API_TOKEN env var on the API server —
  // never in the repo, never sent to the browser. Rate-limited to 5/min.
  // Target apps come from FLY_APP_NAMES (comma-separated); falls back to the
  // legacy single FLY_APP_NAME, then to the two production apps.
  const flyRestartLimit = rateLimit({ name: "fly-restart", by: "user", limit: 5, windowMs: 60_000 });

  const flyTargetApps = (): string[] => {
    const many = process.env.FLY_APP_NAMES?.split(",").map((s) => s.trim()).filter(Boolean);
    if (many && many.length) return many;
    const one = process.env.FLY_APP_NAME?.trim();
    if (one) return [one];
    return ["invest254-api", "invest254-engine-pm"];
  };

  router.post(`${BASE}/admin/fly/restart`, auth, superadmin, flyRestartLimit, async (ctx: Ctx) => {
    const token = process.env.FLY_API_TOKEN;
    if (!token) throw new ApiError("FLY_NOT_CONFIGURED", "FLY_API_TOKEN is not set on the API server", 503);
    const apps = flyTargetApps();
    // The machine SERVING this request must not restart itself — that kills the in-flight
    // HTTP response and the UI shows a false "restart failed" even though the restart fired.
    // Fly injects FLY_MACHINE_ID into every machine; skip it and report it separately.
    const selfMachineId = process.env.FLY_MACHINE_ID;
    const perApp: Array<{ app: string; machinesRestarted: number; machineIds: string[]; skippedStopped: number; skippedSelf: number; failed: number; error?: string }> = [];
    for (const appName of apps) {
      const res = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { perApp.push({ app: appName, machinesRestarted: 0, machineIds: [], skippedStopped: 0, skippedSelf: 0, failed: 0, error: `machines list HTTP ${res.status}` }); continue; }
      const machines = (await res.json()) as Array<{ id: string; state: string }>;
      const restarted: string[] = [];
      let skippedStopped = 0, skippedSelf = 0, failed = 0;
      for (const m of machines) {
        if (m.state === "stopped" || m.state === "destroyed") { skippedStopped++; continue; }
        if (selfMachineId && m.id === selfMachineId) { skippedSelf++; continue; }
        const r = await fetch(`https://api.machines.dev/v1/apps/${appName}/machines/${m.id}/restart`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) restarted.push(m.id); else failed++;
      }
      const entry: { app: string; machinesRestarted: number; machineIds: string[]; skippedStopped: number; skippedSelf: number; failed: number; error?: string } =
        { app: appName, machinesRestarted: restarted.length, machineIds: restarted, skippedStopped, skippedSelf, failed };
      if (failed > 0) entry.error = `${failed} machine restart(s) failed`;
      perApp.push(entry);
    }
    const machinesRestarted = perApp.reduce((n, a) => n + a.machinesRestarted, 0);
    return { ok: perApp.every((a) => !a.error), apps: perApp, machinesRestarted, by: ctx.claims!.userId, at: new Date().toISOString() };
  });

  // Status check so the UI can show whether the integration is configured.
  router.get(`${BASE}/admin/fly/status`, auth, superadmin, async () => ({
    configured: Boolean(process.env.FLY_API_TOKEN),
    apps: flyTargetApps(),
    // legacy single-app field kept for older clients
    app: flyTargetApps()[0],
  }));
}
