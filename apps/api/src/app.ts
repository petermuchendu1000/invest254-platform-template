import { rtp, PlatformGate, type GameConfig, type Cents, type VersionedGameConfig } from "@invest254/shared";
import type {
  FairnessRecord, PaymentService, AuthService, AffiliateService, AdminService, NotificationService, Verifier, PlatformService,
  Page, PageQuery, LedgerEntry, PositionRecord, PositionDetail, PositionListQuery, TransactionRecord, TxListQuery,
} from "@invest254/engine";
import { Router, ApiError, serverFrom, type Ctx } from "./http.js";
import { registerProtectedRoutes } from "./app.payments.js";
import { registerHistoryRoutes } from "./app.history.js";
import { registerSiteRoutes } from "./app.site.js";
import { registerAuthRoutes } from "./app.auth.js";
import { registerAffiliateRoutes } from "./app.affiliate.js";
import { registerAdminRoutes } from "./app.admin.js";
import { registerPlatformRoutes } from "./app.platform.js";
import { registerNotificationRoutes } from "./app.notifications.js";
import { registerMarketerRoutes, type MarketerRepo } from "./app.marketers.js";
import { registerReferralRoutes, type ReferralRepo } from "./app.referral.js";
import { registerSupportRoutes, type SupportDeps } from "./app.support.js";
import type { PlatformOnboardDeps } from "./app.platform.js";
import type { Server } from "node:http";

/**
 * Dependencies the HTTP API binds to REST. Everything here is an already-implemented
 * engine service/repository (or a thin read function over one); the API layer only adds
 * routing, validation, auth and serialization. `server.ts` wires the production (Postgres)
 * implementations; tests wire in-memory fakes. Player/payments/admin routes (E2) extend
 * this interface — E1 ships the public surface (health, game config, fairness).
 */
export interface BonusStatus { bonusId: string; amount: Cents; wageringX: number; wagered: Cents; required: Cents; remaining: Cents; status: string; createdAt: string; }
export interface WalletBalance { real: Cents; bonus: Cents; currency: string; bonuses?: BonusStatus[]; }

/**
 * Public brand identity for one site (docs/22 Task E). Served by `GET /site/brand?host=` and
 * consumed verbatim by the web resolver (`apps/web/src/lib/brand/brand.ts`) to re-skin per brand.
 * Sourced from the `sites` row (migration 0044); no secrets.
 */
export interface Brand {
  siteId: string;
  slug: string;
  name: string;
  wordmarkText?: string | null;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  colorPrimary: string;
  colorBg: string;
  colorAccent: string;
  theme: "dark" | "light" | "auto";
  currency: string;
  locale: string;
  licenceLine?: string | null;
  supportEmail?: string | null;
  /** Full per-brand design-token palette (docs/22): overrides the fixed --pp-* tokens end-to-end. */
  themeTokens?: Record<string, string> | null;
}

/** One admin-logged marketer expense (transparency ledger, migration 0068). */
export interface MarketerExpenseRow {
  id: string;
  category: string;
  amountCents: number;
  note: string | null;
  createdAtMs: number;
  createdBy: string | null;
}
/** Marketer-expenses persistence (add is admin-authorized; list is used by admin + the marketer's own dashboard). */
export interface MarketerExpensesDeps {
  add(actorId: string, actorRole: string, siteId: string, marketerUserId: string, category: string, amountCents: number, note: string | null): Promise<MarketerExpenseRow>;
  list(marketerUserId: string, limit: number): Promise<MarketerExpenseRow[]>;
}

export interface ApiDeps {
  /** JWT verifier for player/admin routes; null → DEV header auth (see requireAuth). */
  verifier: Verifier | null;
  /** Self-managed phone+password auth + basic-KYC profile (G3/G4/H1). */
  auth: Pick<AuthService, "register" | "login" | "me" | "issueToken"
    | "beginMfaEnrolment" | "confirmMfa" | "disableMfa" | "mfaStatus"
    | "changePassword" | "resetPassword">;
  /** Marketer enrollment, commission accrual, dashboard reads (I1/I2/I3) + payouts (I4). */
  affiliate: Pick<AffiliateService,
    "enroll" | "accrueDaily" | "summary" | "listReferrals" | "listCommissions"
    | "requestPayout" | "approvePayout" | "completePayout" | "rejectPayout" | "siteOfPayout" | "recordClick">;
  /** Admin back office (J2): dashboard reads, user status, commission rate, withdrawal queue, audit. */
  admin: Pick<AdminService,
    "overview" | "listUsers" | "getUserDetail" | "listUserActivity" | "setUserStatus" | "setCommissionRate" | "setUserRole" | "updateUserDetails" | "listWithdrawals" | "listTransactions" | "listAudit"
    | "adjustBalance" | "resetBalanceToLastFunded" | "listDeposits" | "depositsReconcile" | "reportDaily" | "reportByUser" | "reportDay"
    | "getGameConfig" | "updateGameConfig" | "getMpesaConfig" | "updateMpesaConfig" | "rtpMonitor" | "realCashRtp" | "configChangeReview" | "listSeeds" | "rotateSeed"
    | "getWithdrawalPool" | "setWithdrawalPool" | "setDefaultPool" | "getWithdrawalsEnabled" | "setWithdrawalsEnabled"
    | "listAffiliatePayouts" | "recordAction"
    | "adjustBalanceKind" | "clearBalance" | "getUserOverrides" | "setUserOverrides"
    | "siteOfUser" | "siteOfTransaction">;
  /** Platform-superadmin console (docs/22 Task H): cross-brand onboarding + economy + KPIs. */
  platform: Pick<PlatformService, "listSites" | "overview" | "performance" | "createSite" | "updateSite" | "setSiteConfig"
    | "marketerRollup" | "createMarketerGlobal" | "linkMarketer" | "setSiteTheme" | "setSiteOwner"
    | "getGlobalConfig" | "setGlobalConfig" | "distributePool" | "listPoolDistributions">;
  /** Per-user sticky notifications: admin/system raise; player reads active + dismisses (J7). */
  notifications: Pick<NotificationService, "create" | "listActive" | "adminList" | "dismiss" | "resolve" | "resolveByCategory">;
  /** Marketer payments module (0033): create/credit/withdraw + admin-set Fuliza/airtime + statement. */
  marketers: MarketerRepo;
  /** Deposit-based referral commissions + separate commission-payout queue (0078/0079). */
  referral: ReferralRepo;
  /** Admin-logged marketer expenses (transparency, migration 0068). */
  marketerExpenses: MarketerExpensesDeps;
  /** Platform-wide master switches (migration 0092): deposits/withdrawals/play/marketers/registrations.
   * Optional so test doubles need not supply it; absent => gate skipped (fail-open). server.ts always sets it. */
  platformGate?: PlatformGate;
  /**
   * Public game configuration source. A PROVIDER, not a value: config is edited live in the
   * admin panel, so a snapshot captured at boot would serve stale limits forever (the exact
   * bug this replaced -- GET /game/config used to return the hardcoded DEFAULT_CONFIG while
   * the database said something else).
   */
  config: () => GameConfig | VersionedGameConfig;
  /**
   * Brand-aware public game config (fixes the x4/x5 divergence): resolve a site ref
   * (slug | primary_domain | site id) to THAT brand's live `site_game_config` — the exact row the
   * engine prices from — so the player-facing limits/cap match the engine instead of the legacy
   * `game_config` singleton. Returns null when the ref does not resolve to an active brand, in which
   * case the route falls back to `config()`. Optional so tests/single-tenant deployments still work.
   */
  gameConfigForSite?(ref: string): Promise<(GameConfig | VersionedGameConfig) | null>;
  /** Public fairness record for a game-day id (commitment always; seed only after reveal). */
  fairnessById(gameDayId: number): Promise<FairnessRecord | null>;
  /** Public brand resolution (docs/22 Task E): host (or slug) → the `sites` brand DTO, or null. */
  brandByHost(host: string): Promise<Brand | null>;
  /**
   * Optional multi-tenant CORS allowance (docs/22, GAP 3): given a request `Origin`, return true if
   * it belongs to an ACTIVE brand domain. Consulted only when `CORS_ALLOWED_ORIGINS` is restricted
   * (not `*`); wired in server.ts to a cached, periodically-refreshed view of `sites`, so every
   * onboarded client's origin is allowed without a redeploy.
   */
  corsAllowOrigin?: (origin: string) => boolean;

  // ── E2: player + payments + admin ──
  /** Deposit/withdrawal orchestration over the atomic 0014 RPCs + Daraja. */
  payments: Pick<PaymentService,
    "initiateDeposit" | "requestWithdrawal" | "handleStkCallback" | "handleB2cResult" | "approveWithdrawal" | "rejectWithdrawal" | "reconcileDeposits">;
  /** Resolve a player's display handle (falls back to a guest handle). */
  resolveHandle(userId: string): Promise<string>;
  /** Wallet balances (real + bonus) for the authenticated player, scoped to their brand. */
  walletBalance(userId: string, siteId?: string): Promise<WalletBalance>;

  // ── F2: player history reads (each scoped to the caller's own userId AND site) ──
  ledger(userId: string, q: PageQuery, siteId?: string): Promise<Page<LedgerEntry>>;
  positions(userId: string, q: PositionListQuery, siteId?: string): Promise<Page<PositionRecord>>;
  positionDetail(userId: string, positionId: string, siteId?: string): Promise<PositionDetail | null>;
  transactions(userId: string, q: TxListQuery, siteId?: string): Promise<Page<TransactionRecord>>;

  /**
   * Support assistant (docs/11, migration 0057). Optional: when present, the RAG chat surface
   * (`/support/*`) is wired. Grounded-answer logic is `answerSupportQuestion` in
   * @invest254/shared; recording + retrieval + embedder + LLM are injected here.
   */
  support?: SupportDeps;

  /**
   * Instant client onboarding (docs/21): create a brand + economy and optionally provision its
   * domain across Cloudflare + Namecheap. Optional; when absent the /platform/onboard route 503s.
   */
  platformOnboard?: PlatformOnboardDeps;
}

const BASE = "/api/v1";

// ─────────────────────────── DTOs ───────────────────────────

function gameConfigDto(cfg: GameConfig | VersionedGameConfig) {
  return {
    currency: "KES",
    minStakeCents: cfg.minStakeCents,
    maxStakeCents: cfg.maxStakeCents,
    minWithdrawalCents: cfg.minWithdrawalCents,
    maxMultiplier: cfg.maxMultiplier,
    defaultDurationS: cfg.defaultDurationS,
    tickRateMs: cfg.tickRateMs,
    rtp: rtp(cfg),
    timeframesS: [cfg.defaultDurationS],
    // Lets a client tell "the operator changed the limits" from "my cache is stale".
    configVersion: (cfg as VersionedGameConfig).version ?? 0,
  };
}

function fairnessDto(r: FairnessRecord) {
  return {
    gameDayId: r.gameDayId,
    tradeDate: r.tradeDate,
    serverSeedHash: r.serverSeedHash,
    serverSeed: r.serverSeed,   // null until the day is revealed
    revealedAt: r.revealedAt,
  };
}


/** Parse a `?limit=` query param, clamped to [1, max] with a default. */
function parseLimit(ctx: Ctx, def: number, max = 100): number {
  const raw = ctx.query.get("limit");
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError("INVALID_LIMIT", "limit must be a positive integer", 400);
  return Math.min(Math.floor(n), max);
}

// ─────────────────────────── routes ───────────────────────────

/** Register the public (unauthenticated) routes — the E1 surface. */
export function registerPublicRoutes(router: Router, deps: ApiDeps): void {
  router.get(`${BASE}/health`, () => ({ status: "ok", time: new Date().toISOString() }));

  // Brand-aware config: many brand domains share ONE API, so the public config must reflect the
  // caller's brand (its `site_game_config`, what the engine prices from), not a global singleton.
  // Resolution order: explicit `?site=` (slug|domain|id) -> `?host=` -> the request `Origin` (the
  // brand domain the browser is on). Falls back to the legacy singleton when unresolved so the
  // endpoint never hard-fails. The web sends `?site=<brand.slug>` explicitly (see api.gameConfig).
  router.get(`${BASE}/game/config`, async (ctx) => {
    if (deps.gameConfigForSite) {
      const origin = ctx.req.headers["origin"];
      const ref = ctx.query.get("site") || ctx.query.get("host")
        || (typeof origin === "string" ? origin : "");
      if (ref) {
        const c = await deps.gameConfigForSite(ref);
        if (c) return gameConfigDto(c);
      }
    }
    return gameConfigDto(deps.config());
  });

  router.get(`${BASE}/game/fairness/:gameDayId`, async (ctx) => {
    const id = Number(ctx.params.gameDayId);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError("INVALID_ID", "gameDayId must be a positive integer", 400);
    const rec = await deps.fairnessById(id);
    if (!rec) throw new ApiError("NOT_FOUND", `no fairness record for game day ${id}`, 404);
    return fairnessDto(rec);
  });

}

/** Build the configured API router. */
export function createRouter(deps: ApiDeps): Router {
  const router = new Router(deps.corsAllowOrigin ? { corsAllowOrigin: deps.corsAllowOrigin } : {});
  registerPublicRoutes(router, deps);
  registerSiteRoutes(router, deps);
  registerAuthRoutes(router, deps);
  registerAffiliateRoutes(router, deps);
  registerReferralRoutes(router, deps);
  registerAdminRoutes(router, deps);
  registerPlatformRoutes(router, deps);
  registerNotificationRoutes(router, deps);
  registerMarketerRoutes(router, deps);
  registerProtectedRoutes(router, deps);
  registerHistoryRoutes(router, deps);
  registerSupportRoutes(router, deps);
  return router;
}

/** Build the API HTTP server (not yet listening). */
export function createApp(deps: ApiDeps): Server {
  return serverFrom(createRouter(deps));
}
