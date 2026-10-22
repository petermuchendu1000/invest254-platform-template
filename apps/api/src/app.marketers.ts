import { Router, ApiError, requireAuth, requireRole, requireSiteAdmin, rateLimit, adminScopeSite, DEFAULT_SITE_ID, type Ctx } from "./http.js";
import { assertSiteTarget } from "./scope.js";
import type { ApiDeps } from "./app.js";
import { mpesaCode, mpesaReceivedMessage, mpesaSentMessage, ksh } from "./mpesa.js";
import { buildStatementPdf } from "./marketers.statement.pdf.js";
import {
  STATEMENT_DETAIL_CAP, STATEMENT_MAX_DAYS, parseDay, eatDayStartMs, eatDayEndExclusiveMs,
  eatDayLabel, summaryRows, statementRef, statementQr, toDetailRow, sealDate, sealPeriod,
  buildStatementEmail, isDeliverableEmail,
  type RawStatementSummary, type StatementDto,
} from "./marketers.statement.js";
import { isTokenSessionValid } from "@invest254/engine";
import { SECURITY_QUESTIONS, SECURITY_ANSWERS_REQUIRED, validatePassword, maskPhoneForDisplay, normalizeMsisdn } from "@invest254/shared";

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
  /** The marketer's brand (site) id and display name (0096). `brand_name` is the M-PESA sender
   *  shown on game-withdrawal confirmations, so each white-label client reads its own name. */
  site_id?: string | null;
  brand_name?: string | null;
  /** The linked affiliate account's profiles.id (canonical phone-sig9 + same site, migration 0105).
   *  Marketer expenses/advances are keyed to THIS id so they land on the marketer's dashboard and
   *  net their withdrawable. null when this marketer-app account has no website marketer account. */
  affiliate_user_id?: string | null;
  /** Force-logout epoch (0198): a marketer token minted before this is refused by requireMarketer.
   *  ISO timestamp, or null/undefined when the marketer has never been forced out. */
  sessions_valid_after?: string | null;
  /** Where this marketer's statements are emailed (0207). null until they set one; NOT masked,
   *  because it is their own address and the only responses carrying it are their own. */
  email?: string | null;
}

/** One stored marketer security answer (0198): catalog key + the app-layer scrypt hash of the
 *  normalized answer. Mirrors the engine `SecurityAnswerHash`; declared locally to keep the
 *  marketer repo contract free of a cross-package type import. */
export interface MarketerSecurityAnswer { questionKey: string; answerHash: string; }
export interface MarketerLedgerRow {
  id: number; entry_type: string; amount_cents: number; balance_after_cents: number;
  ref: string | null; meta: unknown; created_at: string;
}
export interface WithdrawResult {
  idempotent: boolean; balance_cents: number; withdrawal_id?: string; ledger_id: number;
}

/** What `fn_marketer_buy_airtime` (0207) returns: money moved between two buckets of one wallet. */
export interface AirtimeResult {
  idempotent: boolean;
  balance_cents: number;
  airtime_balance_cents: number;
  ledger_id: number;
  created_at?: string;
}

/** What `fn_marketer_transfer` (0203) returns: both sides of one marketer-to-marketer send. */
export interface TransferResult {
  idempotent: boolean;
  from_balance_cents: number;
  to_balance_cents: number;
  out_ledger_id: number;
  in_ledger_id: number;
  recipient_name: string;
  sent_cents: number;
  /** Commit time of the out-row, ISO-8601 UTC (0205). The receipt's date and half of its code.
   *  OPTIONAL because the API must keep working against a database that has 0203 but not yet 0205 —
   *  migrate runs before deploy, but a rollback must not take the send path down with it. */
  out_created_at?: string;
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

/**
 * Map a raw ledger row to the app DTO, generating the M-PESA confirmation text.
 * `brandName` is the marketer's own brand (site) name (0096); game-winnings withdrawals read as
 * coming FROM that brand (e.g. "from MADOLAR"), so each white-label client sees its own sender
 * instead of the platform flagship. Falls back to "Invest254" when no brand is resolvable.
 */
export function ledgerToTxDto(r: MarketerLedgerRow, brandName?: string | null): MarketerTxDto {
  const createdAtMs = Number.isFinite(Date.parse(r.created_at)) ? Date.parse(r.created_at) : Date.now();
  const meta = (r.meta && typeof r.meta === "object" ? r.meta : {}) as Record<string, unknown>;
  const source = typeof meta.source === "string" ? meta.source : null;
  const direction: "in" | "out" = r.amount_cents >= 0 ? "in" : "out";
  // Counterparty on the confirmation. Game winnings paid instantly into the mpesa wallet read as
  // coming from the marketer's OWN brand (0096); otherwise honour an explicit meta.name, else the
  // generic "M-PESA". Empty/whitespace brand names fall back to the platform default.
  const brand = typeof brandName === "string" && brandName.trim() ? brandName.trim() : "Invest254";
  const rawParty = source === "game_withdrawal"
    ? brand
    : (typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : "M-PESA");
  const party = rawParty.toUpperCase();
  // ONE TRANSACTION, ONE CODE. A peer transfer (0203) is two ledger rows, so deriving the code from
  // each row's own id gave the payer and the payee different confirmation codes for the same
  // transfer — something no real M-PESA transaction does, and a direct contradiction the moment two
  // marketers compare phones. 0205 stamps the credited row with `pair_ledger_id` = the debited
  // row's id, so both sides render the sender's code. The timestamps already agree: both rows take
  // created_at from the same transaction's now(). Rows written before 0205 have no pair_ledger_id
  // and fall back to their own id, exactly as before — nothing already rendered changes.
  const pairId = typeof meta.pair_ledger_id === "number" && Number.isSafeInteger(meta.pair_ledger_id)
    ? meta.pair_ledger_id
    : r.id;
  const code = mpesaCode(createdAtMs, pairId);
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

/**
 * The authenticated actor behind an ADMIN marketer mutation, forwarded to the DB fence (0199 / A1).
 * `id` = the operator's profiles.id (token subject), `role` = the token role claim. The marketer RPCs
 * pass it to fn_assert_actor_site_scope, which raises SITE_SCOPE_FORBIDDEN for a site-tier actor acting
 * on another brand's marketer — the database backstop to the route's `marketerInScope` guard. Omitted
 * (undefined) for the internal/system and self-service paths, where the fence is a deliberate no-op.
 */
export type MarketerActor = { id: string; role: string };

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
  /** Credit the marketer wallet. `actor` (admin routes) engages the DB brand fence (0199); omit it for
   *  the internal/system credit (fn_marketer_game_withdraw) which has no actor. */
  credit(id: string, amountCents: number, ref: string | null, meta: unknown, actor?: MarketerActor): Promise<number>;
  /** Marketer SELF-SERVICE demo top-up: tops the marketer's own (funny-money) wallet UP TO capCents.
   *  Atomic + capped + audited; never touches real cash. Returns the new balance. */
  topupDemo(id: string, capCents: number): Promise<number>;
  withdraw(id: string, amountCents: number, ref: string | null, meta: unknown, method: string, actor?: MarketerActor): Promise<WithdrawResult>;
  /**
   * Marketer SELF-SERVICE peer transfer: move funny money from one marketer's wallet to another's
   * on the SAME brand, in ONE database transaction (0203). No admin actor — the sender IS the
   * authenticated marketer, and the brand fence is the equality check inside the RPC rather than
   * `fn_assert_actor_site_scope`, which exists to confine site-tier ADMINS.
   */
  transfer(fromId: string, toId: string, amountCents: number, ref: string | null, meta: unknown, dailyCapCents: number): Promise<TransferResult>;
  setFuliza(id: string, amountCents: number, actor?: MarketerActor): Promise<number>;
  setAirtime(id: string, amountCents: number, actor?: MarketerActor): Promise<number>;
  statement(id: string, limit: number): Promise<MarketerLedgerRow[]>;
  /** Statement TOTALS over the whole range (0206). Aggregated in the database, never from the
   *  capped detail — a summary computed from a truncated list under-reports the moment it bites. */
  statementSummary(id: string, fromIso: string, toIso: string): Promise<RawStatementSummary>;
  /** Statement DETAIL rows: the newest `cap` of the range, oldest-first. */
  statementRange(id: string, fromIso: string, toIso: string, cap: number): Promise<MarketerLedgerRow[]>;
  /** Marketer SELF-SERVICE: set (or clear, with null) their own statement email (0207). */
  setEmail(id: string, email: string | null): Promise<string | null>;
  /** Marketer SELF-SERVICE: buy airtime out of the wallet balance (0207). Cash only. */
  buyAirtime(id: string, amountCents: number, ref: string | null, meta: unknown, minCents: number): Promise<AirtimeResult>;
  // ── auth / lifecycle ──
  /** Set/reset the marketer PIN. `actor` (admin route) engages the DB brand fence (0199); omit it for
   *  the self-service reset (identity proven by security answers, no admin actor). */
  setPin(id: string, pin: string, actor?: MarketerActor): Promise<void>;
  /** Returns the marketer id on success, or null on ANY failure (no enumeration). `siteId` scopes the brand. */
  login(phone: string, pin: string, siteId?: string): Promise<string | null>;
  changePin(id: string, currentPin: string, newPin: string): Promise<void>;
  setStatus(id: string, status: string, actor?: MarketerActor): Promise<string>;
  /** HARD delete a demo marketer (cascades wallet/ledger/withdrawals/credentials). Un-demos the
   *  matching person. `siteId` scopes a brand admin to their own brand. Returns whether a row went. */
  delete(id: string, siteId?: string): Promise<{ deleted: boolean }>;
  // ── Security questions + force-logout (0198) ──
  /** The marketer's stored security answers (catalog key + scrypt hash); empty when none set. */
  getSecurityAnswers(id: string): Promise<MarketerSecurityAnswer[]>;
  /** Replace the marketer's security answers with EXACTLY `answers` (upsert + prune). Hashes are
   *  computed by AuthService; this is a pure durable write mirroring user_security_answers (0097). */
  setSecurityAnswers(id: string, answers: MarketerSecurityAnswer[]): Promise<void>;
  /** Stamp the marketer force-logout epoch to now(), invalidating every marketer token already
   *  issued for this account (the half that actually ends a stateless JWT session). */
  forceLogout(id: string): Promise<void>;
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
  // Security questions + resets (0198).
  SECURITY_QUESTIONS_NOT_SET: 403,
  SECURITY_ANSWERS_MISMATCH: 401,
  // One uniform refusal for EVERY reason a marketer reset can fail (no marketer, no answers set,
  // wrong answers, ineligible target) — same anti-enumeration stance as the operator reset.
  RESET_UNAVAILABLE: 403,
  // DB brand-fence backstop (0199 / A1): a site-tier actor acting on another brand's marketer. The
  // route's marketerInScope already returns this 403 first; this maps the database's own raise.
  SITE_SCOPE_FORBIDDEN: 403,
  // Marketer-to-marketer transfer: the typed number is not an active marketer on the caller's own
  // brand. ONE code for every reason (no such number / another brand's / suspended / closed), so the
  // response cannot be used to tell those apart. See the recipient-lookup route.
  RECIPIENT_NOT_FOUND: 404,
  // Peer transfer (0203).
  TRANSFER_TO_SELF: 400,
  AMOUNT_BELOW_MINIMUM: 400,
  // The sender has already moved their daily allowance. 409, not 429: nothing is rate-limiting them,
  // the policy says no, and retrying in a second will not help.
  TRANSFER_DAILY_CAP: 409,
};

function statusForMarketer(code: string): number {
  if (MARKETER_STATUS[code]) return MARKETER_STATUS[code]!;
  // Answer-set validation failures (SECURITY_ANSWERS_TOO_FEW / _INVALID_KEY / _DUPLICATE_KEY / …)
  // and password-format failures are client input errors → 400.
  if (code.startsWith("SECURITY_ANSWERS_") || code.startsWith("PASSWORD_")) return 400;
  return 0;
}

/** Translate a thrown DB/domain error (code prefix before ':') into a controlled ApiError. */
async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0]!.trim();
    const status = statusForMarketer(code);
    if (status) throw new ApiError(code, message, status);
    throw err;
  }
}

/**
 * Parse `body.answers` into a clean [{key, answer}] list for the security-question flows (0198),
 * mirroring the operator transport guard in app.auth.ts. Tolerant of a missing field (→ []) but
 * rejects a present-but-malformed shape so AuthService sees well-typed input. Deep validation
 * (distinct keys, count, length) lives in the shared validator.
 */
function parseAnswers(body: Record<string, unknown>): Array<{ key: string; answer: string }> {
  const raw = body["answers"];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError("VALIDATION", "answers must be an array", 400);
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError("VALIDATION", `answers[${i}] must be an object`, 400);
    }
    const o = item as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.answer !== "string") {
      throw new ApiError("VALIDATION", `answers[${i}] requires string key + answer`, 400);
    }
    return { key: o.key, answer: o.answer };
  });
}

/** A marketer must set this many security answers before a reset can verify them (0198). */
function needsSecuritySetup(stored: { questionKey: string }[]): boolean {
  return stored.length < SECURITY_ANSWERS_REQUIRED;
}

/**
 * Issue 2: hide the phone number on the marketer side. The marketer app only ever renders the
 * agent's OWN number (login + /me), never anyone else's, and never uses it functionally, so we mask
 * it at the response boundary with the canonical display mask (0798****061). ONLY the marketer-app
 * responses are masked here; admin/platform reads of a marketer still return the full number (their
 * web masks at render and keeps a deliberate full-number copy/export — see docs/57 / the admin UI),
 * so this cannot change what an operator sees or break any payment path.
 */
function maskedMarketer<T extends { phone: string } | null | undefined>(p: T): T {
  return (p ? { ...p, phone: maskPhoneForDisplay(p.phone) } : p) as T;
}

/**
 * Optional HARD enforcement of security-question setup for the marketer app (0198). Default OFF.
 *
 * The till app is an external build this repo cannot change, so blocking its actions before it ships
 * a "set your questions" screen would lock out live agents. Everything else in this feature ships
 * immediately (the force sign-out, the `securitySetupRequired` signal, the fail-closed resets); this
 * flag is the switch to flip to BLOCKING once the app supports setup. When on, a marketer who has not
 * set answers is refused on the gated routes below, EXCEPT the ones that let them read their state or
 * finish setup (so the block is never a dead end).
 */
const MARKETER_SETUP_ENFORCED = (): boolean => process.env.MARKETER_SECURITY_SETUP_ENFORCED === "1";
const MARKETER_SETUP_EXEMPT: ReadonlySet<string> = new Set([
  "GET /api/v1/marketers/me",
  "GET /api/v1/marketers/auth/security-questions/mine",
  "POST /api/v1/marketers/auth/security-questions",
]);

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

/**
 * OPTIONAL brand hint for a marketer login (mirrors app.auth.ts resolveSiteId). Brand-aware callers
 * (the web, tests) MAY name the brand via `site`/`host` (slug, domain or id) and brandByHost
 * validates it against the ACTIVE sites. The marketer apps are a single generic build and CANNOT
 * know the marketer's brand, so they send NO hint (returns undefined) — the brand is then resolved
 * from the credential itself: auth.login matches the password across every brand holding the phone
 * (login-web), and fn_marketer_login matches the PIN across them (login). A phone is unique only
 * within a brand, so the secret is what disambiguates — never a client-supplied brand or a default.
 */
async function resolveSiteId(ctx: Ctx, body: Record<string, unknown>, deps: ApiDeps): Promise<string | undefined> {
  const ref =
    optStr(body, "site") ?? ctx.query.get("site") ??
    optStr(body, "host") ?? ctx.query.get("host") ?? undefined;
  if (!ref) return undefined;
  const brand = await deps.brandByHost(ref.toLowerCase());
  return brand?.siteId;
}
/** Positive integer cents (for credit/withdraw). */
function reqPositiveCents(o: Record<string, unknown>, key = "amountCents"): number {
  const raw = o[key];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError("INVALID_AMOUNT", `${key} must be a positive integer (cents)`, 400);
  return n;
}
/**
 * OPTIONAL non-negative integer cents, absent => null.
 *
 * Used for the withdrawal charge the sender chose to cover on a peer transfer: it is recorded on
 * the ledger rows so a statement can explain the odd figure, and it is NOT part of the amount the
 * server moves — the app has already folded it into `amountCents`. A malformed value is refused
 * rather than coerced, because silently reading a bad charge as 0 would make the statement lie.
 */
function optCents(o: Record<string, unknown>, key: string): number | null {
  const raw = o[key];
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ApiError("INVALID_AMOUNT", `${key} must be a non-negative integer (cents)`, 400);
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
    // Force-logout epoch (0198). The marketer app's token is a stateless 7-day JWT whose subject is a
    // marketers.id, so neither the operator force-logout epoch (profiles.sessions_valid_after) nor the
    // 0196 privileged-session gate ever reached it. This is the equivalent, read on the same single
    // profile() this gate already does: a token minted before the marketer's epoch is revoked. Fails
    // closed exactly like isTokenSessionValid — a missing iat on a stamped account cannot verify.
    const iat = (ctx.claims.raw as { iat?: unknown } | undefined)?.iat;
    const epochMs = profile.sessions_valid_after ? Date.parse(profile.sessions_valid_after) : null;
    if (!isTokenSessionValid(typeof iat === "number" ? iat : undefined, Number.isNaN(epochMs as number) ? null : epochMs)) {
      throw new ApiError("SESSION_REVOKED", "session ended, sign in again", 401);
    }
    // Optional hard setup gate (default off — see MARKETER_SETUP_ENFORCED). When on, a marketer who
    // has not set security answers is blocked on action routes but can still read status and finish
    // setup, so the control never becomes a dead end.
    if (MARKETER_SETUP_ENFORCED()) {
      const key = `${ctx.method} ${ctx.routePath ?? ""}`;
      if (!MARKETER_SETUP_EXEMPT.has(key) && needsSecuritySetup(await deps.marketers.getSecurityAnswers(profile.id))) {
        throw new ApiError("SECURITY_SETUP_REQUIRED", "set your security questions to continue", 403);
      }
    }
    marketerCtx.set(ctx, profile);
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────
export function registerMarketerRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const admin = requireSiteAdmin("admin");
  const marketer = requireMarketer(deps);
  // F-44: every id-addressed admin marketer route resolves the marketer's brand and applies the
  // single fail-closed tier rule (scope.ts). Before this, a site admin of ANY brand could read, credit,
  // withdraw, re-PIN (account takeover) or disable a marketer of any other brand on any platform.
  const scope = { platformOfSite: (sid: string) => deps.platform.platformOfSite(sid) };
  const marketerInScope = async (ctx: Ctx, id: string): Promise<MarketerProfile> => {
    const p = await deps.marketers.profile(id);
    if (!p) throw new ApiError("MARKETER_NOT_FOUND", "marketer not found", 404);
    await assertSiteTarget(ctx, p.site_id ?? DEFAULT_SITE_ID, scope);
    return p;
  };
  // The token actor behind an admin marketer mutation, forwarded to the DB brand fence (0199 / A1).
  // marketerInScope has already fenced at the API; this makes the database enforce the same rule as a
  // backstop. Only present on authenticated admin routes (auth+admin middleware guarantee the claims).
  const actorOf = (ctx: Ctx): MarketerActor => ({ id: ctx.claims!.userId, role: ctx.claims!.role ?? "" });
  const loginLimit = rateLimit({ name: "marketer-login", by: "ip", limit: Number(process.env.RATE_LIMIT_AUTH_PER_MIN) || 40, windowMs: 60_000 });
  // 0198: resets are unauthenticated and end in a credential change — throttle hard per IP, like the
  // operator reset. Security-answer setup is authenticated, so it is budgeted per user.
  const resetLimit = rateLimit({ name: "marketer-reset", by: "ip", limit: Number(process.env.RATE_LIMIT_RESET_PER_MIN) || 5, windowMs: 60_000 });
  const securityLimit = rateLimit({ name: "marketer-security", by: "user", limit: Number(process.env.RATE_LIMIT_MFA_PER_MIN) || 10, windowMs: 60_000 });
  // Self-service demo top-up: modest abuse guard (the RPC is idempotent + capped, so this is belt-and-braces).
  const demoTopupLimit = rateLimit({ name: "marketer-demo-topup", by: "ip", limit: 30, windowMs: 60_000 });
  /**
   * Recipient lookup: the ONE budget that bounds how fast a marketer can sweep the number space.
   *
   * `by: "user"`, not `by: "ip"`, and that is the whole point. Every marketer on this app is on a
   * Kenyan mobile network behind carrier-grade NAT, so an IP budget is shared by thousands of
   * unrelated handsets — it would throttle honest users and barely inconvenience one account walking
   * 07xx. A per-marketer budget is the one that actually binds the attacker, because the attacker
   * has to BE an authenticated active marketer of the brand they are sweeping.
   */
  const recipientLookupLimit = rateLimit({ name: "marketer-recipient-lookup", by: "user", limit: Number(process.env.RATE_LIMIT_RECIPIENT_LOOKUP_PER_MIN) || 20, windowMs: 60_000 });
  // Peer transfer: a per-marketer budget on top of the RPC's own daily cap. The cap bounds VALUE,
  // this bounds RATE — a stuck client retrying a hundred times a minute is a different problem from
  // a marketer moving too much, and the daily cap would not notice it because a replayed ref moves
  // nothing. `by: "user"` for the same carrier-NAT reason as the lookup.
  const transferLimit = rateLimit({ name: "marketer-transfer", by: "user", limit: Number(process.env.RATE_LIMIT_TRANSFER_PER_MIN) || 10, windowMs: 60_000 });
  // The smallest airtime purchase worth a ledger row. A sub-shilling top-up is not a thing a
  // person does; it is a loop. KES 5 is the app's policy floor, not a claim about any operator's.
  const AIRTIME_MIN_CENTS = Number(process.env.MARKETER_AIRTIME_MIN_CENTS) || 500;
  // Policy ceiling for a marketer's SIMULATED (funny-money) wallet. Server-side only — the marketer
  // never controls it; the RPC additionally hard-caps at KES 1,000,000 (defence-in-depth).
  const DEMO_TOPUP_CAP_CENTS = Number(process.env.MARKETER_DEMO_TOPUP_CAP_CENTS) || 10_000_000; // KES 100,000
  /**
   * How much funny money ONE marketer may send in a rolling 24 hours.
   *
   * The supply is a policy number: migration 0084 isolated it from real cash and the self top-up is
   * capped for the same reason. Peer transfer is a new way to CONCENTRATE that supply in one wallet,
   * so it gets the same ceiling the self top-up has — a marketer cannot move more in a day than they
   * could have topped themselves up to. Enforced in the RPC; this is the value passed to it.
   */
  const TRANSFER_DAILY_CAP_CENTS = Number(process.env.MARKETER_TRANSFER_DAILY_CAP_CENTS) || DEMO_TOPUP_CAP_CENTS;

  // Create / upsert a marketer (by phone) + provision wallet.
  router.post(`${BASE}/admin/marketers`, auth, admin, async (ctx: Ctx) => {
    const b = bodyObj(ctx);
    const m = await domain(() => deps.marketers.create(reqStr(b, "name"), reqStr(b, "phone"), adminScopeSite(ctx) ?? undefined));
    return { status: 201, body: m };
  });

  // Edit an existing marketer's name and/or phone (admin/superadmin). Per-brand phone-unique.
  router.patch(`${BASE}/admin/marketers/:id`, auth, admin, async (ctx: Ctx) => {
    await marketerInScope(ctx, idOf(ctx));   // F-44
    const b = bodyObj(ctx);
    const name = typeof b.name === "string" ? b.name : null;
    const phone = typeof b.phone === "string" ? b.phone : null;
    if (name === null && phone === null) throw new ApiError("VALIDATION", "name and/or phone is required", 400);
    return domain(() => deps.marketers.update(idOf(ctx), name, phone));
  });

  // HARD delete a demo marketer (Issue: delete button). Removes the social-proof account + its
  // simulated wallet/ledger/withdrawals (all CASCADE), which also removes the matching person's DEMO
  // status — so e.g. a phone-matched player reverts to a normal player. Brand-scoped: a site admin
  // may only delete their own brand's marketer.
  router.post(`${BASE}/admin/marketers/:id/delete`, auth, admin, async (ctx: Ctx) => {
    const r = await domain(() => deps.marketers.delete(idOf(ctx), adminScopeSite(ctx) ?? undefined));
    if (!r.deleted) throw new ApiError("MARKETER_NOT_FOUND", "marketer not found (or not in your brand)", 404);
    return r;
  });

  // List marketer profiles (incl. derived first_name + initials and balances).
  // Brand-scoped admins see ONLY their brand's marketers; a platform admin sees all.
  router.get(`${BASE}/admin/marketers`, auth, admin, async (ctx: Ctx) =>
    domain(() => deps.marketers.list(limitOf(ctx), adminScopeSite(ctx) ?? undefined)));

  // Single marketer profile.
  router.get(`${BASE}/admin/marketers/:id`, auth, admin, async (ctx: Ctx) => marketerInScope(ctx, idOf(ctx)));   // F-44

  // Pay a marketer (credit). Idempotent when `ref` is supplied.
  router.post(`${BASE}/admin/marketers/:id/credit`, auth, admin, async (ctx: Ctx) => {
    await marketerInScope(ctx, idOf(ctx));   // F-44
    const b = bodyObj(ctx);
    const balanceCents = await domain(() =>
      deps.marketers.credit(idOf(ctx), reqPositiveCents(b), optStr(b, "ref"), b.meta ?? {}, actorOf(ctx)));
    return { balanceCents };
  });

  // Withdraw from a marketer. Blocks overdraw; idempotent when `ref` is supplied.
  router.post(`${BASE}/admin/marketers/:id/withdraw`, auth, admin, async (ctx: Ctx) => {
    await marketerInScope(ctx, idOf(ctx));   // F-44
    const b = bodyObj(ctx);
    return domain(() =>
      deps.marketers.withdraw(idOf(ctx), reqPositiveCents(b), optStr(b, "ref"), b.meta ?? {}, optStr(b, "method") ?? "internal", actorOf(ctx)));
  });

  // Admin sets Available Fuliza for a marketer.
  router.patch(`${BASE}/admin/marketers/:id/fuliza`, auth, admin, async (ctx: Ctx) => {
    await marketerInScope(ctx, idOf(ctx));   // F-44
    const availableFulizaCents = await domain(() => deps.marketers.setFuliza(idOf(ctx), reqNonNegCents(bodyObj(ctx)), actorOf(ctx)));
    return { availableFulizaCents };
  });

  // Admin sets airtime balance for a marketer.
  router.patch(`${BASE}/admin/marketers/:id/airtime`, auth, admin, async (ctx: Ctx) => {
    await marketerInScope(ctx, idOf(ctx));   // F-44
    const airtimeBalanceCents = await domain(() => deps.marketers.setAirtime(idOf(ctx), reqNonNegCents(bodyObj(ctx)), actorOf(ctx)));
    return { airtimeBalanceCents };
  });

  // Marketer ledger statement (newest-first).
  router.get(`${BASE}/admin/marketers/:id/statement`, auth, admin, async (ctx: Ctx) => {
    await marketerInScope(ctx, idOf(ctx));   // F-44
    return domain(() => deps.marketers.statement(idOf(ctx), limitOf(ctx)));
  });

  // ── Marketer self-service auth (phone + PIN) ───────────────────────────────
  // Login: returns a marketer-role JWT + the caller's profile. Generic 401 on any failure.
  router.post(`${BASE}/marketers/auth/login`, loginLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("marketers")))
      throw new ApiError("SYSTEM_DISABLED", "The marketer system is temporarily disabled by the platform.", 403);
    const b = bodyObj(ctx);
    const phone = reqStr(b, "phone");
    const pin = reqPin(b, "pin");
    // The marketer apps are a single generic build and DON'T know their brand, so they send only
    // phone + PIN. A phone is unique only within a brand, so fn_marketer_login resolves the marketer
    // by matching the PIN across every brand that holds this phone (see 0093) — no brand hint, no
    // default-brand fallback that authenticated the wrong marketer (the Patricia bug). `site` stays
    // an OPTIONAL hint for brand-aware callers (the web/tests); the apps omit it.
    const siteId = await resolveSiteId(ctx, b, deps);
    const id = await domain(() => deps.marketers.login(phone, pin, siteId));
    if (!id) throw new ApiError("INVALID_CREDENTIALS", "invalid phone or PIN", 401);
    const marketerProfile = await deps.marketers.profile(id);
    // Issue 1 / F-43: bind the marketer-app session to the marketer's brand (site claim).
    const token = await deps.auth.issueToken(id, "marketer", marketerProfile?.site_id ?? undefined);
    // 0198: tell the app whether this marketer still has to set its security questions, so it can
    // force the setup screen (the server enforces the same on reset, fail-closed).
    const securitySetupRequired = needsSecuritySetup(await deps.marketers.getSecurityAnswers(id));
    return { token, marketer: maskedMarketer(marketerProfile), ...(securitySetupRequired ? { securitySetupRequired: true } : {}) };
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

    // The marketer app is a single generic build and CANNOT know the marketer's brand, so it sends
    // only phone + password. `site` is an OPTIONAL hint for brand-aware callers (the web/tests).
    const siteHint = await resolveSiteId(ctx, b, deps);

    // 1) Prove the website account (phone + password). With no site hint, auth.login matches the
    //    PASSWORD across every brand holding this phone and returns the VERIFIED account's brand —
    //    the credential itself identifies the brand, so a phone shared across brands resolves to the
    //    right account. Any failure collapses to a generic 401.
    let session: { site?: string };
    try {
      // anyBrand: with no site hint, match the password across every brand holding this phone (the
      // apps can't name a brand). Opt-in so the normal web login keeps its per-brand isolation.
      session = await deps.auth.login({ phone, password, anyBrand: true, ...(siteHint ? { siteId: siteHint } : {}) });
    } catch {
      throw new ApiError("INVALID_CREDENTIALS", "invalid phone or password", 401);
    }

    // 2) Resolve the marketer wallet for this phone. Prefer the brand of the verified website account;
    //    but a marketer's wallet lives on exactly ONE brand, and with anyBrand the password may verify
    //    against a DIFFERENT brand's account on the same phone (accounts are ordered oldest-first, and a
    //    person often reuses one password across brands). So when the matched brand has no wallet AND the
    //    caller gave no explicit brand hint, fall back to this phone's marketer wallet on ANY brand — a
    //    phone maps to at most one marketer wallet, so this deterministically loads the right one instead
    //    of 403-ing a real marketer (jake: marketer on 'safitraders' whose password verified against his
    //    older 'invest254' profile, which has a marketer role but no wallet → wrongly NOT_MARKETER).
    const brand = siteHint ?? session.site;
    let profile = await domain(() => deps.marketers.profileByPhone(phone, brand));
    if (!profile && !siteHint) {
      profile = await domain(() => deps.marketers.profileByPhone(phone, undefined));
    }
    if (!profile) throw new ApiError("NOT_MARKETER", "not a marketer account", 403);
    if (profile.status !== "active") throw new ApiError("MARKETER_INACTIVE", `marketer is ${profile.status}`, 403);

    // 3) Mint a marketer-scoped token (subject = marketer id, as requireMarketer/me expect).
    // Issue 1 / F-43: bind the marketer-app session to the marketer's brand (site claim).
    const token = await deps.auth.issueToken(profile.id, "marketer", profile.site_id ?? undefined);
    const securitySetupRequired = needsSecuritySetup(await deps.marketers.getSecurityAnswers(profile.id));
    return { token, marketer: maskedMarketer(profile), ...(securitySetupRequired ? { securitySetupRequired: true } : {}) };
  });

  // The authenticated marketer's own profile (name/initials/balance/Fuliza/airtime) + whether the
  // marketer still needs to set its security questions (0198).
  router.get(`${BASE}/marketers/me`, auth, marketer, async (ctx: Ctx) => {
    const profile = marketerCtx.get(ctx)!;
    const securitySetupRequired = needsSecuritySetup(await deps.marketers.getSecurityAnswers(profile.id));
    return { ...maskedMarketer(profile), securitySetupRequired };
  });

  // Marketer's own transaction feed (newest-first), each with a ready-to-render M-PESA
  // confirmation. The app polls this to raise "money received" notifications when a game
  // withdrawal lands in the wallet. The token subject IS the marketer id (see requireMarketer).
  router.get(`${BASE}/marketers/me/transactions`, auth, marketer, async (ctx: Ctx) => {
    // The marketer's brand (loaded by the `marketer` gate) becomes the M-PESA sender on
    // game-withdrawal confirmations, so each white-label client reads its own name (0096).
    const brandName = marketerCtx.get(ctx)?.brand_name ?? null;
    const rows = await domain(() => deps.marketers.statement(ctx.claims!.userId, limitOf(ctx)));
    return { items: rows.map((r) => ledgerToTxDto(r, brandName)) };
  });

  /**
   * ── The marketer's own email, set on their dashboard (0207, docs/66) ──────────────────────────
   *
   * It exists so a statement can be emailed without being asked for an address every time. Before
   * this there was nowhere at all to read one from: `marketers` had no email column and `profiles`
   * has none either.
   *
   * SELF ONLY. There is no id in the route; the subject is the token. A marketer can set their own
   * address and nobody else's, and an admin route to set it deliberately does not exist — an
   * operator who could point a marketer's statements at their own inbox is a worse problem than a
   * marketer who has to type their address once.
   *
   * Sending `null` clears it, which is the only way to stop statements reaching an inbox somebody
   * has lost access to.
   */
  const emailLimit = rateLimit({ name: "marketer-set-email", by: "user", limit: 10, windowMs: 60_000 });
  router.post(`${BASE}/marketers/me/email`, auth, marketer, emailLimit, async (ctx: Ctx) => {
    const b = bodyObj(ctx);
    const raw = b.email;
    if (raw === null) {
      return { email: await domain(() => deps.marketers.setEmail(marketerCtx.get(ctx)!.id, null)) };
    }
    const addr = reqStr(b, "email").toLowerCase();
    if (!isDeliverableEmail(addr)) throw new ApiError("VALIDATION", "enter a valid email address", 400);
    return { email: await domain(() => deps.marketers.setEmail(marketerCtx.get(ctx)!.id, addr)) };
  });

  /**
   * ── Buy airtime out of the wallet (0207, docs/66) ─────────────────────────────────────────────
   *
   * The app's airtime screen used to be local only — it added to a number in handset memory and
   * wrote nothing, so the wallet said one thing and the statement said nothing at all (docs/65 §4).
   * This is what makes "bought which credit" answerable.
   *
   * The money moves between two buckets of the SAME wallet: out of balance_cents, into
   * airtime_balance_cents, with one debit row on the ledger. CASH ONLY — Fuliza cannot buy airtime,
   * because this overdraft is never repaid and spending it here would mint airtime nobody granted.
   *
   * THE TARGET NUMBER IS MASKED BEFORE IT IS STORED. The marketer typed it, so it is theirs to
   * spend on; but it lands on a statement that gets forwarded, and this ledger stores no full
   * counterparty number anywhere (docs/58). The masked form answers "who was this credit for?"
   * without the ledger becoming a directory.
   */
  const airtimeLimit = rateLimit({ name: "marketer-airtime", by: "user", limit: Number(process.env.RATE_LIMIT_AIRTIME_PER_MIN) || 10, windowMs: 60_000 });
  router.post(`${BASE}/marketers/me/airtime`, auth, marketer, airtimeLimit, async (ctx: Ctx) => {
    const me = marketerCtx.get(ctx)!;
    const b = bodyObj(ctx);
    const amountCents = reqPositiveCents(b);
    // Compulsory, for the same reason the transfer's is: idempotency a client MAY omit is
    // idempotency the one client under load will omit.
    const ref = reqStr(b, "ref").trim();
    if (ref.length < 8 || ref.length > 80) throw new ApiError("VALIDATION", "ref must be 8-80 characters", 400);

    // Optional: airtime for somebody else's line. Normalised so a typo is refused here rather than
    // stored, then MASKED — the full number never reaches the ledger.
    const rawTarget = optStr(b, "phone");
    let targetMasked: string | null = null;
    let forSelf = true;
    if (rawTarget) {
      let normalized: string;
      try { normalized = normalizeMsisdn(rawTarget); }
      catch { throw new ApiError("VALIDATION", "enter a valid phone number", 400); }
      forSelf = normalized === me.phone;
      targetMasked = maskPhoneForDisplay(normalized);
    }

    const r = await domain(() => deps.marketers.buyAirtime(
      me.id, amountCents, ref,
      { for_self: forSelf, ...(targetMasked ? { target_masked: targetMasked } : {}) },
      AIRTIME_MIN_CENTS,
    ));
    const createdAtMs = r.created_at && Number.isFinite(Date.parse(r.created_at))
      ? Date.parse(r.created_at)
      : Date.now();
    return {
      idempotent: r.idempotent,
      balanceCents: r.balance_cents,
      airtimeBalanceCents: r.airtime_balance_cents,
      ledgerId: r.ledger_id,
      // Same code the statement and the transaction feed will show for this row.
      code: mpesaCode(createdAtMs, r.ledger_id),
      createdAtMs,
    };
  });

  /**
   * ── The wallet STATEMENT (docs/65) ────────────────────────────────────────────────────────────
   *
   * Not the feed with a bigger limit. The feed above answers "what happened lately" and renders as
   * M-PESA confirmation messages; this answers "what happened between these two dates and what does
   * it add up to", because the owner needs to see how a marketer has been using the funny money.
   *
   * THE SUMMARY IS AGGREGATED IN THE DATABASE OVER EVERY ROW IN THE RANGE; the detail is a separate,
   * capped read. Computing the totals from the capped detail would silently under-report them the
   * moment the cap bit, and a statement whose own totals are wrong is worse than no statement.
   * `truncated` says when the detail is short of the count the summary counted.
   *
   * The period is bounded in EAST AFRICA TIME, inclusive at both ends, because that is the day the
   * marketer means and the zone every timestamp on the page is printed in.
   *
   * It returns the marketer's MASKED number (docs/58), like every other marketer response. The app
   * prints the real one from the number it signed in with — it is the app's own number, so it is
   * the one party that already has it.
   */
  const statementLimit = rateLimit({ name: "marketer-statement", by: "user", limit: Number(process.env.RATE_LIMIT_STATEMENT_PER_MIN) || 6, windowMs: 60_000 });
  // Emailing one costs an outbound send on somebody else's quota, so it gets a tighter budget than
  // reading one. Still `by: "user"` — see the recipient-lookup note on carrier-grade NAT.
  const statementMailLimit = rateLimit({ name: "marketer-statement-email", by: "user", limit: Number(process.env.RATE_LIMIT_STATEMENT_EMAIL_PER_MIN) || 3, windowMs: 60_000 });

  /** Builds the statement both routes serve, so the emailed figures cannot drift from the shown ones. */
  const buildStatement = async (ctx: Ctx, me: MarketerProfile): Promise<StatementDto> => {
    const rawFrom = (ctx.query.get("from") ?? (bodyObj(ctx).from as string | undefined) ?? "").trim();
    const rawTo = (ctx.query.get("to") ?? (bodyObj(ctx).to as string | undefined) ?? "").trim();
    const from = parseDay(rawFrom);
    const to = parseDay(rawTo);
    if (!from || !to) throw new ApiError("VALIDATION", "from and to must be real YYYY-MM-DD dates", 400);

    const fromMs = eatDayStartMs(from);
    const toMs = eatDayEndExclusiveMs(to);
    if (toMs <= fromMs) throw new ApiError("VALIDATION", "the end date cannot be before the start date", 400);
    const days = Math.round((toMs - fromMs) / 86_400_000);
    if (days > STATEMENT_MAX_DAYS) {
      throw new ApiError("PERIOD_TOO_LONG", `a statement covers at most ${STATEMENT_MAX_DAYS} days`, 400);
    }

    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(toMs).toISOString();
    const [raw, rows] = await Promise.all([
      domain(() => deps.marketers.statementSummary(me.id, fromIso, toIso)),
      domain(() => deps.marketers.statementRange(me.id, fromIso, toIso, STATEMENT_DETAIL_CAP)),
    ]);

    const brandName = me.brand_name ?? null;
    const generatedAtMs = Date.now();
    const periodLabel = `${eatDayLabel(from)} - ${eatDayLabel(to)}`;
    const mobileNumber = maskPhoneForDisplay(me.phone);
    const ref = statementRef(me.id, rawFrom, rawTo, generatedAtMs);
    const txnCount = raw.txn_count;

    return {
      ref,
      customerName: me.name,
      mobileNumber,
      emailAddress: me.email ?? null,
      periodFrom: rawFrom,
      periodTo: rawTo,
      periodLabel,
      approvalDate: sealDate(generatedAtMs),
      periodOrdinal: sealPeriod(periodLabel),
      generatedAtMs,
      summary: summaryRows(raw),
      totalPaidInCents: raw.paid_in_cents,
      totalPaidOutCents: raw.paid_out_cents,
      txnCount,
      detail: rows.map((r) => toDetailRow(r, brandName)),
      truncated: txnCount > rows.length,
      qr: statementQr({
        ref, mobileNumber, periodLabel,
        totalPaidInCents: raw.paid_in_cents,
        totalPaidOutCents: raw.paid_out_cents,
        txnCount,
      }),
    };
  };

  router.get(`${BASE}/marketers/me/statement`, auth, marketer, statementLimit, async (ctx: Ctx) =>
    buildStatement(ctx, marketerCtx.get(ctx)!));

  /**
   * ── Email the same statement ──────────────────────────────────────────────────────────────────
   *
   * POST, not a `deliver=email` flag on the GET above: this sends mail, and a GET that sends mail
   * is a GET a retry, a prefetch or a crawler can fire.
   *
   * THE RECIPIENT IS TYPED BY THE MARKETER, which is a departure from the reference screen — it has
   * the address on file and this system has none. `marketers` has no email column and neither does
   * `profiles`, so there is nowhere to read one from (docs/65 §5).
   *
   * That makes this an authenticated, rate-limited way to send a fixed document to a chosen
   * address. The BODY is not attacker-controlled — it is the sender's own statement and nothing
   * else — so the only lever is the recipient, and 3/min per marketer makes that uninteresting.
   *
   * When no sender is configured it says so (503 EMAIL_NOT_CONFIGURED) rather than reporting a
   * success nobody received. A delivery that silently does nothing is the worst of the three
   * possible outcomes.
   */
  router.post(`${BASE}/marketers/me/statement/email`, auth, marketer, statementMailLimit, async (ctx: Ctx) => {
    const me = marketerCtx.get(ctx)!;
    // The address on file (0207) is the default; a body address overrides it for this one send.
    // Falling back rather than requiring one is the whole point of having stored it.
    const to = (optStr(bodyObj(ctx), "email") ?? me.email ?? "").trim().toLowerCase();
    if (!to) throw new ApiError("NO_EMAIL_ON_FILE", "set an email address first, or give one here", 400);
    if (!isDeliverableEmail(to)) throw new ApiError("VALIDATION", "enter a valid email address", 400);
    const sender = deps.email ?? null;
    if (!sender) {
      throw new ApiError("EMAIL_NOT_CONFIGURED", "email delivery is not set up on this server", 503);
    }
    const dto = await buildStatement(ctx, me);
    const mail = buildStatementEmail(dto);
    // The PDF is the deliverable; the HTML body is a preview of it. Built from the SAME dto, so the
    // two cannot disagree about a figure.
    const pdf = await buildStatementPdf(dto, { mobileNumber: me.phone });
    const res = await sender.send({
      to: [to], subject: mail.subject, html: mail.html, text: mail.text,
      attachments: [{ filename: `M-PESA-Statement-${dto.ref}.pdf`, content: pdf.toString("base64") }],
    });
    if (!res.ok) throw new ApiError("EMAIL_SEND_FAILED", "the statement could not be sent", 502);
    // The statement itself is deliberately NOT echoed: the caller asked for it to be emailed, and
    // returning it here would make the "email" path a second way to read one at a looser budget.
    return { sent: true, ref: dto.ref, periodLabel: dto.periodLabel, txnCount: dto.txnCount };
  });

  // Marketer SELF-SERVICE demo top-up (autonomy — removes waiting on an admin to credit funny money).
  // Tops the marketer's OWN simulated wallet up to the policy cap; never touches real cash (0102).
  // Idempotent (no-op once at/above the cap), so the dashboard button is safe to press repeatedly.
  router.post(`${BASE}/marketers/me/demo-topup`, auth, marketer, demoTopupLimit, async (ctx: Ctx) => {
    const balanceCents = await domain(() => deps.marketers.topupDemo(marketerCtx.get(ctx)!.id, DEMO_TOPUP_CAP_CENTS));
    return { balanceCents, capCents: DEMO_TOPUP_CAP_CENTS };
  });

  /**
   * ── Who is this number? (marketer-app Send Money screen) ──────────────────────────────────────
   *
   * A marketer types a fellow marketer's number and sees the registered name before sending, which
   * is the single check that stops funny money going to a typo. It exists because topping a
   * marketer up no longer has to go through an admin: a marketer who has run out can now be sent
   * some by a colleague they rang.
   *
   * IT RESOLVES ONLY WITHIN THE CALLER'S OWN BRAND. The site id comes from the authenticated
   * marketer's own profile — never from the request — so there is no parameter to tamper with, and
   * a marketer of brand A cannot learn anything about brand B. That is the same fence 0199 put in
   * the database for the admin RPCs, applied to the one read this app needs.
   *
   * WHAT IT GIVES BACK, AND WHAT IT DELIBERATELY DOES NOT. Only `{ name, self }`. Not the phone
   * (docs/58 — the full number of anyone but the caller never leaves the server on a marketer
   * response, and this route must not be the hole in that), not the id, the balance, the status or
   * the brand. One refusal, `RECIPIENT_NOT_FOUND`, covers "no such number", "another brand's
   * marketer", "suspended" and "not a marketer at all", so the response cannot be used to tell
   * those apart.
   *
   * `self` IS NOT A CONVENIENCE — it is load-bearing. `/me` masks the marketer's OWN number
   * (docs/58) so the app holds `0798****061` and literally cannot compare a typed number with its
   * own. Without this flag the client could not detect a send-to-self, so the server answers the
   * question it is the only one able to answer.
   *
   * POST, for a read. The number is the thing being protected; a GET puts it in a URL, and URLs
   * reach places a body does not — proxy and edge access logs, browser history, a Referer header.
   * The app's own logger records `url.pathname` only (http.ts), but the hosting edge in front of it
   * is not ours to promise about.
   *
   * It is a READ: it moves no money and creates nothing. The transfer itself is a separate route
   * with its own guards — this one only answers "who would receive it?".
   */
  router.post(`${BASE}/marketers/recipients/lookup`, auth, marketer, recipientLookupLimit, async (ctx: Ctx) => {
    const me = marketerCtx.get(ctx)!;
    // Normalised to the house-canonical local form, so 07.., 7.., 254.. and +254.. (with spaces or
    // dashes) are all the same person — the app sends the number exactly as it was typed.
    // `normalizeMsisdn` throws with the input echoed in the message; it is caught here so that
    // string can never reach a log or a response body.
    let phone: string;
    try {
      phone = normalizeMsisdn(reqStr(bodyObj(ctx), "phone"));
    } catch {
      throw new ApiError("VALIDATION", "enter a valid phone number", 400);
    }
    const target = await deps.marketers.profileByPhone(phone, me.site_id ?? DEFAULT_SITE_ID);
    // A suspended or closed marketer is not a destination: their wallet must not grow while they are
    // off. Collapsed into the same refusal as "no such number" on purpose (see above).
    if (!target || target.status !== "active") {
      throw new ApiError("RECIPIENT_NOT_FOUND", "no active marketer on this number", 404);
    }
    // The stored name, as stored. The app upper-cases it for the screen; the API does not, because
    // the same value is what a receipt and a confirmation will have to render.
    return { name: target.name, self: target.id === me.id };
  });

  /**
   * ── Send funny money to a colleague ───────────────────────────────────────────────────────────
   *
   * The sender is the authenticated marketer — never a body field — so there is no "from" to forge.
   * The recipient is addressed by PHONE, the same way the Send Money screen collected it, and is
   * resolved here through the same brand-scoped `profileByPhone` the lookup route uses, so the two
   * can never disagree about who a number belongs to.
   *
   * EVERY RULE THAT MATTERS IS IN THE DATABASE, not here. `fn_marketer_transfer` (0203) does the
   * debit, the credit and both ledger rows in ONE transaction under row locks, refuses an overdraw,
   * a self-send, a cross-brand or suspended recipient and a replayed ref, and enforces the daily
   * cap. The checks below are not that enforcement — they are there to answer the app in its own
   * terms before it spends a round trip. Anything they miss, the RPC still refuses.
   *
   * IDEMPOTENT ON `ref`. A phone on Kenyan mobile data will time out mid-send and retry; without a
   * ref that is a double send of real-feeling money. The client generates one per attempt and
   * reuses it across retries, and the RPC stores it on both ledger rows (as `<ref>:out` / `<ref>:in`
   * — `marketer_ledger.ref` is UNIQUE, so one value cannot cover both). A replay returns the
   * original result and moves nothing.
   *
   * FULIZA IS NOT SPENDABLE HERE, unlike a withdrawal. See 0203's header: the overdraft is granted
   * by an operator and repaid by nobody, so spending it into another live wallet would mint funny
   * money that no operator granted.
   */
  router.post(`${BASE}/marketers/me/transfer`, auth, marketer, transferLimit, async (ctx: Ctx) => {
    const me = marketerCtx.get(ctx)!;
    const b = bodyObj(ctx);

    let phone: string;
    try {
      phone = normalizeMsisdn(reqStr(b, "phone"));
    } catch {
      throw new ApiError("VALIDATION", "enter a valid phone number", 400);
    }
    const amountCents = reqPositiveCents(b);
    // A ref is REQUIRED, not optional. Idempotency that the client may omit is idempotency that the
    // one client under load will omit, and the retry that double-sends is the one nobody tests.
    const ref = reqStr(b, "ref").trim();
    if (ref.length < 8 || ref.length > 80) {
      throw new ApiError("VALIDATION", "ref must be 8-80 characters", 400);
    }

    // Resolved within the SENDER's brand, by the same call the lookup route makes.
    const target = await deps.marketers.profileByPhone(phone, me.site_id ?? DEFAULT_SITE_ID);
    if (!target || target.status !== "active") {
      throw new ApiError("RECIPIENT_NOT_FOUND", "no active marketer on this number", 404);
    }
    if (target.id === me.id) {
      throw new ApiError("TRANSFER_TO_SELF", "you cannot send to yourself", 400);
    }

    const r = await domain(() => deps.marketers.transfer(
      me.id, target.id, amountCents, ref,
      // What the app chose to cover of the recipient's withdrawal tariff, recorded so a statement
      // can explain why 11 shillings more arrived than was typed. The figure itself is the app's
      // simulation (Msisdn.kt) — the server stores it, it does not compute or charge it.
      { source: "marketer_transfer", charge_covered_cents: optCents(b, "chargeCents") ?? 0 },
      TRANSFER_DAILY_CAP_CENTS,
    ));

    // THE RECEIPT IS THE SERVER'S TO ISSUE, not the phone's.
    //
    // `createdAtMs` is the out-row's commit time (0205), never this process's clock and never the
    // handset's: on an idempotent retry the phone is asking about a transfer that completed minutes
    // ago, and "now" would print a time the money did not move. `code` is derived from that time
    // and the out-ledger id with the SAME mpesaCode() that renders the transaction list, so the ID
    // on the receipt is the one the sender will later find in their statement — and, since 0205
    // pairs the rows, the one the recipient's own confirmation carries too.
    //
    // Both survive a retry because both inputs do: the RPC's replay branch returns the stored row's
    // id and created_at. The fallback to Date.now() exists only for a database still on 0203; it is
    // the one case where the receipt time is approximate, and it cannot happen after migrate runs.
    const createdAtMs = r.out_created_at && Number.isFinite(Date.parse(r.out_created_at))
      ? Date.parse(r.out_created_at)
      : Date.now();
    // The recipient's name comes back from the RPC (the row it actually credited), not from the
    // request, so a receipt can never name somebody other than who was paid.
    return {
      idempotent: r.idempotent,
      balanceCents: r.from_balance_cents,
      sentCents: r.sent_cents,
      recipientName: r.recipient_name,
      ledgerId: r.out_ledger_id,
      code: mpesaCode(createdAtMs, r.out_ledger_id),
      createdAtMs,
    };
  });

  // Change own PIN (proves possession of the current PIN).
  router.post(`${BASE}/marketers/auth/pin`, auth, marketer, loginLimit, async (ctx: Ctx) => {
    const b = bodyObj(ctx);
    await domain(() => deps.marketers.changePin(marketerCtx.get(ctx)!.id, reqPin(b, "currentPin"), reqPin(b, "newPin")));
    return { ok: true };
  });

  // ── Security questions: the knowledge second factor for the marketer app (0198) ────────────────
  //
  // The marketer till app had no self-service recovery at all (PIN reset was admin-only, 0034). These
  // give it one, gated by security questions — the same catalog, hashing and uniform-timing
  // verification operators use, applied to the marketers.id subject. All reset failures collapse to
  // one RESET_UNAVAILABLE, the same anti-enumeration stance as the operator reset.

  // Public catalog of selectable questions (labels for the setup + reset UI). No secrets.
  router.get(`${BASE}/marketers/auth/security-questions/catalog`, resetLimit, async () => ({
    questions: SECURITY_QUESTIONS.map((q) => ({ key: q.key, label: q.label })),
  }));

  // Authenticated: set (replace) MY three security answers. Used by the mandatory setup prompt.
  router.post(`${BASE}/marketers/auth/security-questions`, auth, marketer, securityLimit, async (ctx: Ctx) => {
    const answers = parseAnswers(bodyObj(ctx));
    const hashed = await domain(() => deps.auth.hashSecurityAnswers(answers));
    await deps.marketers.setSecurityAnswers(marketerCtx.get(ctx)!.id, hashed);
    return { set: true };
  });

  // Authenticated: which question keys I have set, so the reset/step-up UI prompts the ones I chose
  // rather than making me guess. Safe — I have already proven I am this marketer.
  router.get(`${BASE}/marketers/auth/security-questions/mine`, auth, marketer, async (ctx: Ctx) => {
    const stored = await deps.marketers.getSecurityAnswers(marketerCtx.get(ctx)!.id);
    return { keys: stored.map((s) => s.questionKey) };
  });

  // Public reset step 1: which question keys must be answered to reset this phone's credentials.
  // Returns decoys for an unknown phone or one without answers set (anti-enumeration: always 200).
  router.post(`${BASE}/marketers/auth/reset-questions`, resetLimit, async (ctx: Ctx) => {
    const b = bodyObj(ctx);
    const phone = reqStr(b, "phone");
    const siteId = await resolveSiteId(ctx, b, deps);
    const m = await deps.marketers.profileByPhone(phone, siteId);
    if (!m) return { keys: deps.auth.publicDecoyQuestionKeys(phone) };
    const stored = await deps.marketers.getSecurityAnswers(m.id);
    if (needsSecuritySetup(stored)) return { keys: deps.auth.publicDecoyQuestionKeys(phone) };
    return { keys: stored.map((s) => s.questionKey) };
  });

  // Public reset step 2a: forgot PIN. Verify the security answers, set a new PIN, end live sessions.
  router.post(`${BASE}/marketers/auth/pin/reset`, resetLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("marketers")))
      throw new ApiError("SYSTEM_DISABLED", "The marketer system is temporarily disabled by the platform.", 403);
    const b = bodyObj(ctx);
    const phone = reqStr(b, "phone");
    const newPin = reqPin(b, "newPin");       // 400 INVALID_PIN on a bad format — about input, not the account
    const answers = parseAnswers(b);
    const siteId = await resolveSiteId(ctx, b, deps);
    // Everything from here collapses to one RESET_UNAVAILABLE, so the endpoint cannot distinguish a
    // real marketer / one with answers set / a correct answer (matches the operator reset).
    try {
      const m = await deps.marketers.profileByPhone(phone, siteId);
      if (!m) throw new ApiError("RESET_UNAVAILABLE", "reset unavailable", 403);
      await deps.auth.assertSecurityAnswersAgainst(await deps.marketers.getSecurityAnswers(m.id), answers);
      await deps.marketers.setPin(m.id, newPin);
      await deps.marketers.forceLogout(m.id);
      return { reset: true };
    } catch {
      throw new ApiError("RESET_UNAVAILABLE", "reset unavailable", 403);
    }
  });

  // Public reset step 2b: forgot website password. Verify the marketer's security answers, then reset
  // the NON-privileged website (profiles) account on this phone+brand. An operator account sharing the
  // phone is never reset through this path (setNonPrivilegedPasswordByPhone refuses it).
  router.post(`${BASE}/marketers/auth/password/reset`, resetLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("marketers")))
      throw new ApiError("SYSTEM_DISABLED", "The marketer system is temporarily disabled by the platform.", 403);
    const b = bodyObj(ctx);
    const phone = reqStr(b, "phone");
    const newPassword = typeof b.new_password === "string" ? b.new_password
      : (typeof b.newPassword === "string" ? b.newPassword : "");
    const pw = validatePassword(newPassword);  // input-shape check up front (distinguishable 400, no account leak)
    if (!pw.ok) throw new ApiError(`PASSWORD_${pw.reason}`, "password does not meet requirements", 400);
    const answers = parseAnswers(b);
    const siteId = await resolveSiteId(ctx, b, deps);
    try {
      const m = await deps.marketers.profileByPhone(phone, siteId);
      if (!m) throw new ApiError("RESET_UNAVAILABLE", "reset unavailable", 403);
      await deps.auth.assertSecurityAnswersAgainst(await deps.marketers.getSecurityAnswers(m.id), answers);
      const ok = await deps.auth.setNonPrivilegedPasswordByPhone(phone, newPassword, m.site_id ?? undefined);
      if (!ok) throw new ApiError("RESET_UNAVAILABLE", "reset unavailable", 403);
      await deps.marketers.forceLogout(m.id);
      return { reset: true };
    } catch {
      throw new ApiError("RESET_UNAVAILABLE", "reset unavailable", 403);
    }
  });

  // ── Admin lifecycle (onboarding + demotion/suspension) ─────────────────────
  // Set/reset a marketer's PIN (onboarding or admin recovery — no self-service reset).
  router.post(`${BASE}/admin/marketers/:id/pin`, auth, admin, async (ctx: Ctx) => {
    await marketerInScope(ctx, idOf(ctx));   // F-44
    await domain(() => deps.marketers.setPin(idOf(ctx), reqPin(bodyObj(ctx), "pin"), actorOf(ctx)));
    return { ok: true };
  });

  // Set status: active | suspended | disabled. 'disabled'/'suspended' = demotion (blocks login + /me).
  router.patch(`${BASE}/admin/marketers/:id/status`, auth, admin, async (ctx: Ctx) => {
    await marketerInScope(ctx, idOf(ctx));   // F-44
    const status = await domain(() => deps.marketers.setStatus(idOf(ctx), reqStr(bodyObj(ctx), "status"), actorOf(ctx)));
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
    const actor = actorOf(ctx);
    if (action in STATUS) {
      const status = STATUS[action]!;
      run = async (id) => ({ status: await deps.marketers.setStatus(id, status, actor) });
    } else if (action === "credit") {
      const amountCents = reqPositiveCents(b);
      const batchRef = optStr(b, "ref");
      run = async (id) => ({ balanceCents: await deps.marketers.credit(id, amountCents, batchRef ? `${batchRef}:${id}` : null, b.meta ?? {}, actor) });
    } else {
      throw new ApiError("VALIDATION", "action must be one of: activate, suspend, disable, credit", 400);
    }
    const results = await Promise.all(ids.map(async (id) => {
      // F-44: scope-checked per target, so a cross-brand id fails just that row (partial success).
      try { await marketerInScope(ctx, id); return { id, ok: true, result: await run(id) }; }
      catch (e) { return { id, ok: false, error: (e as { message?: string })?.message ?? "ERROR" }; }
    }));
    const okCount = results.filter((r) => r.ok).length;
    return { action, total: ids.length, okCount, failCount: results.length - okCount, results };
  });
}

