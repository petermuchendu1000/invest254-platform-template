import {
  rtp, PlatformGate,
  applyCohortEconomy, effectiveMinDeposit, effectiveMaxDeposit, effectiveMinWithdrawal,
  EMPTY_PLATFORM_ECONOMY, MIN_DEPOSIT_CENTS,
  type GameConfig, type Cents, type VersionedGameConfig, type PlatformEconomy,
} from "@invest254/shared";
import type { Logger } from "@invest254/shared/logger";
import type {
  FairnessRecord, PaymentService, AuthService, AffiliateService, AdminService, NotificationService, PushService, Verifier, PlatformService,
  SubscriptionService, TicketService,
  Page, PageQuery, LedgerEntry, PositionRecord, PositionDetail, PositionListQuery, DigitHistoryRow, TransactionRecord, TxListQuery,
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
import { registerPushRoutes } from "./app.push.js";
import { registerWithdrawalActionRoutes } from "./app.withdrawalact.js";
import { registerTelegramRoutes, type TelegramCommissionOps } from "./app.telegram.js";
import type { TelegramClient, PayoutAlert, PayoutDecisionRecord } from "./telegram.js";
import { registerMarketerRoutes, type MarketerRepo } from "./app.marketers.js";
import { registerReferralRoutes, type ReferralRepo } from "./app.referral.js";
import { registerSupportRoutes, type SupportDeps } from "./app.support.js";
import { registerLiveChatRoutes, type LiveChatDeps } from "./app.livechat.js";
import { registerKycRoutes, type KycDeps } from "./app.kyc.js";
import { registerSubscriptionRoutes } from "./app.subscriptions.js";
import { registerAddonRoutes, type AddonDeps } from "./app.addons.js";
import { registerTicketRoutes } from "./app.tickets.js";
import { registerPaymentScopeRoutes } from "./app.paymentscopes.js";
import { registerC2bRoutes } from "./app.c2b.js";
import { registerBillingRoutes } from "./app.billing.js";
import type { PlatformOnboardDeps, RegistrarConfigDeps } from "./app.platform.js";
import type { Server } from "node:http";

/**
 * Dependencies the HTTP API binds to REST. Everything here is an already-implemented
 * engine service/repository (or a thin read function over one); the API layer only adds
 * routing, validation, auth and serialization. `server.ts` wires the production (Postgres)
 * implementations; tests wire in-memory fakes. Player/payments/admin routes (E2) extend
 * this interface — E1 ships the public surface (health, game config, fairness).
 */
export interface BonusStatus { bonusId: string; amount: Cents; wageringX: number; wagered: Cents; required: Cents; remaining: Cents; status: string; createdAt: string; }
export interface WalletBalance {
  /** Spendable game balance in the ACTIVE account (demo balance while in demo mode). */
  real: Cents;
  /** Spendable bonus (0 in demo mode — demo stakes never touch it). */
  bonus: Cents;
  currency: string;
  bonuses?: BonusStatus[];
  /** DEMO-1: the active account and every bucket, for the Real/Demo switch. */
  mode?: "real" | "demo";
  /** Marketers are always demo (the switch is locked). */
  modeLocked?: boolean;
  realBalance?: Cents;
  bonusBalance?: Cents;
  demoBalance?: Cents;
}

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
  /** CHAT-1: WhatsApp support number (E.164 digits), shown in live chat and the account menu. */
  supportWhatsapp?: string | null;
  /** Full per-brand design-token palette (docs/22): overrides the fixed --pp-* tokens end-to-end. */
  themeTokens?: Record<string, string> | null;
  /** Per-brand price chart system (0111/0147, ADDON-1): line (free default), area, candlestick, bars, baseline. Presentation only. */
  chartStyle?: import("@invest254/shared").ChartStyle;
  /** Per-brand trade UI layout (migration 0112): 'classic' (default) or 'digits'. Presentation only. */
  tradeUi?: "classic" | "digits";
  /**
   * Live display-currency units per 1 KES (KES→currency), e.g. USD≈0.0077. 1 for KES brands.
   * The money of record is ALWAYS KES cents; this only drives how amounts are RENDERED. Resolved
   * at brand-fetch time from the FX provider; 0/undefined => the web safely falls back to KES.
   */
  fxRateFromKes?: number;
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
  /** Authoritative full sum of ALL logged expenses for a marketer (independent of the display page).
   *  Mirrors the expense term inside fn_commission_balance so the total shown always reconciles with
   *  "Available to withdraw" — never derive the total from a limit-capped `list()` page (BUGLOG #23). */
  total(marketerUserId: string): Promise<number>;
}

/** One marketer-initiated advance request (migration 0122). */
export interface MarketerAdvanceRow {
  id: string;
  amountCents: number;
  reason: string | null;
  status: "requested" | "approved" | "rejected" | "cancelled";
  decisionNote: string | null;
  decidedAtMs: number | null;
  expenseId: string | null;
  createdAtMs: number;
}
/** Admin queue view of an advance request (adds the marketer's identity + brand). */
export interface AdminAdvanceRow extends MarketerAdvanceRow {
  marketerUserId: string;
  username: string | null;
  phone: string | null;
  siteId: string;
}
/** Marketer advance-request persistence (marketer requests/cancels; admin decides; both sides read). */
export interface MarketerAdvancesDeps {
  request(marketerUserId: string, amountCents: number, reason: string | null): Promise<MarketerAdvanceRow>;
  cancel(marketerUserId: string, id: string): Promise<MarketerAdvanceRow>;
  listMine(marketerUserId: string, limit: number): Promise<MarketerAdvanceRow[]>;
  /** Approve (logs a marketer_expense 'advance') or reject (records the reason). Returns the admin row
   *  so the caller can notify the marketer (row carries marketerUserId). */
  decide(actorId: string, actorRole: string, id: string, approve: boolean, note: string | null): Promise<AdminAdvanceRow>;
  adminList(siteId: string | null, status: string | null, limit: number): Promise<AdminAdvanceRow[]>;
  /** Brand of a request (for admin site-scope enforcement before deciding). */
  siteOf(id: string): Promise<string | null>;
}

export interface ApiDeps {
  /** JWT verifier for player/admin routes; null → DEV header auth (see requireAuth). */
  verifier: Verifier | null;
  /** Self-managed phone+password auth + basic-KYC profile (G3/G4/H1). */
  auth: Pick<AuthService, "register" | "login" | "me" | "issueToken" | "issueSessionToken"
    | "beginMfaEnrolment" | "confirmMfa" | "disableMfa" | "mfaStatus"
    | "changePassword" | "resetPassword"
    | "setSecurityAnswers" | "securitySetupRequired" | "getResetQuestionKeys" | "assertSessionValid">;
  /** Marketer enrollment, commission accrual, dashboard reads (I1/I2/I3) + payouts (I4). */
  affiliate: Pick<AffiliateService,
    "enroll" | "accrueDaily" | "summary" | "listReferrals" | "listCommissions"
    | "requestPayout" | "approvePayout" | "completePayout" | "rejectPayout" | "siteOfPayout" | "recordClick">;
  /** Admin back office (J2): dashboard reads, user status, commission rate, withdrawal queue, audit. */
  admin: Pick<AdminService,
    "overview" | "listUsers" | "getUserDetail" | "listUserActivity" | "setUserStatus" | "setCommissionRate" | "setUserRole" | "deleteUser" | "updateUserDetails" | "listWithdrawals" | "listTransactions" | "listAudit" | "listPlatformAudit" | "listSystemLogs"
    | "adjustBalance" | "resetBalanceToLastFunded" | "listDeposits" | "depositsReconcile" | "reportDaily" | "reportByUser" | "reportDay"
    | "getGameConfig" | "updateGameConfig" | "getMpesaConfig" | "updateMpesaConfig" | "rtpMonitor" | "realCashRtp" | "configChangeReview" | "listSeeds" | "rotateSeed"
    | "getWithdrawalPool" | "setWithdrawalPool" | "setDefaultPool" | "getWithdrawalsEnabled" | "setWithdrawalsEnabled"
    | "listAffiliatePayouts" | "recordAction"
    | "adjustBalanceKind" | "clearBalance" | "getUserOverrides" | "setUserOverrides"
    | "siteOfUser" | "siteOfTransaction">;
  /** Platform-superadmin console (docs/22 Task H): cross-brand onboarding + economy + KPIs. */
  platform: Pick<PlatformService, "listSites" | "overview" | "performance" | "createSite" | "updateSite" | "setSiteConfig"
    | "marketerRollup" | "createMarketerGlobal" | "linkMarketer" | "setSiteTheme" | "setSiteOwner" | "setDefaultMarketer"
    | "getGlobalConfig" | "setGlobalConfig" | "distributePool" | "listPoolDistributions"
    | "poolDemand" | "distributePoolDynamic"
    | "listPaymentProviders" | "setProviderGlobal" | "setProviderSite" | "clearProviderSite"
    | "gatewaySchemas" | "getProviderConfig" | "setProviderConfig" | "testProviderConnection"
    | "listPlatforms" | "platformsOverview" | "createPlatform" | "updatePlatform" | "assignSiteToPlatform"
    | "appointPlatformAdmin" | "revokePlatformAdmin" | "platformOfSite" | "listPlatformAdmins" | "searchUsers">;
  /** Subscription plans + per-platform billing/status (Issue 2). Absent -> /subscriptions routes off. */
  subscriptions?: SubscriptionService | undefined;
  /** Internal escalation ticketing (Issue 2). Absent -> /tickets routes off. */
  tickets?: TicketService | undefined;
  /** Per-user sticky notifications: admin/system raise; player reads active + dismisses (J7). */
  notifications: Pick<NotificationService, "create" | "listActive" | "adminList" | "dismiss" | "resolve" | "resolveByCategory" | "listTemplates" | "audienceCount" | "broadcast" | "resolveCategory" | "ownerOf">;
  /** Admin Web Push subscriptions (Issue 1): opt-in real-time withdrawal-request alerts. Absent when
   *  push is not configured (no VAPID keys) — the /admin/push/* routes then stay unregistered. */
  push?: Pick<PushService, "publicKey" | "upsert" | "removeForUser"> | undefined;
  /** HMAC secret for email magic-link withdrawal actions (Issue 1). Absent => the /w/act routes stay off. */
  actionSecret?: string | undefined;
  /** Resolves the admin profile id recorded as approver/rejecter for email magic-link actions. */
  withdrawalActionActor?: (() => Promise<string | null>) | undefined;
  /** Telegram bot channel (Issue 1): instant alerts with inline Approve/Reject. Dormant if unset. */
  telegram?: TelegramClient | undefined;
  /** Allowlisted Telegram chat ids that receive alerts and may act on callbacks. */
  telegramChatIds?: string[] | undefined;
  /** Secret echoed by Telegram in X-Telegram-Bot-Api-Secret-Token; gates the webhook. */
  telegramWebhookSecret?: string | undefined;
  /** Rebuild the enriched payout card from the DB for in-place status edits + topic records. */
  describePayout?: ((kind: "withdrawal" | "commission", id: string) => Promise<PayoutAlert | null>) | undefined;
  /** Live pending real-money requests (DB truth) — powers the /pending bot command. */
  listPendingPayouts?: (() => Promise<PayoutAlert[]>) | undefined;
  /** Recent settled decisions (DB truth) — powers the /history bot command. */
  listRecentPayoutDecisions?: ((limit: number) => Promise<PayoutDecisionRecord[]>) | undefined;
  /** Verify a supplied password against an active superadmin credential (scrypt, constant-time). */
  verifyApprovalPassword?: ((password: string) => Promise<boolean>) | undefined;
  /** Human display name of the acting superadmin (for "Approved by …" on the card). */
  resolveActorName?: (() => Promise<string>) | undefined;
  /** Real-money commission payout ops for the bot (Approve = approve + mark-paid). */
  commissionTelegramOps?: TelegramCommissionOps | undefined;
  /** Optional forum group id for self-organising status topics. */
  telegramForumChatId?: string | undefined;
  /** Optional forum topic thread ids for Approved / Rejected records. */
  telegramTopics?: { approved?: number | undefined; rejected?: number | undefined } | undefined;
  /** Fired (fire-and-forget) when a marketer requests a real-money commission payout. */
  onCommissionRequested?: ((payoutId: string) => void) | undefined;
  /** Marketer payments module (0033): create/credit/withdraw + admin-set Fuliza/airtime + statement. */
  marketers: MarketerRepo;
  /** Deposit-based referral commissions + separate commission-payout queue (0078/0079). */
  referral: ReferralRepo;
  /** Admin-logged marketer expenses (transparency, migration 0068). */
  marketerExpenses: MarketerExpensesDeps;
  /** Marketer-initiated advance requests (migration 0122): request -> admin approve/reject -> log. */
  marketerAdvances: MarketerAdvancesDeps;
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
  /** STAKE-1 (0170): stake limits in the brand's own currency + the FX rate used to enforce them. */
  stakeNative?: import("./stakelimits.js").StakeNativeStore | undefined;
  /** A marketer's current commission rate (0..1), or null when not an affiliate. */
  commissionRateOf?: ((userId: string) => Promise<number | null>) | undefined;
  fxRate?: ((currency: string) => Promise<number>) | undefined;
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
  /** Base logger (server.ts wires the env-configured one). Requests log through a per-request child. */
  logger?: Logger;

  // ── E2: player + payments + admin ──
  /** Deposit/withdrawal orchestration over the atomic 0014 RPCs + Daraja. */
  payments: Pick<PaymentService,
    "initiateDeposit" | "requestWithdrawal" | "handleStkCallback" | "handleB2cResult" | "approveWithdrawal" | "rejectWithdrawal" | "markWithdrawalPaid" | "reconcileDeposits"
    | "ingestC2b" | "claimPaybillDeposit" | "paybillConfig"
    | "initiateMegaPayDeposit" | "handleMegaPayCallback" | "reconcileMegaPayDeposits"
    | "initiatePayHeroDeposit" | "handlePayHeroCallback" | "reconcilePayHeroDeposits" | "listDepositProviders">;
  /** Resolve a player's display handle (falls back to a guest handle). */
  resolveHandle(userId: string): Promise<string>;
  /** docs/42 UI-8: display names of the brand/platform a session is scoped to (for the shells' scope chip).
   *  Optional; /auth/me omits `scope` names when absent or failing. */
  scopeNames?: ((siteId: string | null, platformId: string | null) => Promise<{ siteName: string | null; platformName: string | null }>) | undefined;
  /** Wallet balances (real + bonus) for the authenticated player, scoped to their brand. */
  walletBalance(userId: string, siteId?: string): Promise<WalletBalance>;
  /** DEMO-1: switch the caller's active account (migration 0123). Refused while a contract is open. */
  setAccountMode?: ((userId: string, siteId: string | undefined, mode: "real" | "demo") => Promise<"real" | "demo">) | undefined;
  /** DEMO-1: refill the demo balance to its starting amount (no-op when already at/above it). */
  topupDemo?: ((userId: string, siteId: string | undefined) => Promise<Cents>) | undefined;
  /** CHAT-1: human live chat (migration 0167). Absent = chat routes not registered. */
  liveChat?: LiveChatDeps | undefined;
  /** ACCT-1: player identity verification (migration 0168). */
  kyc?: KycDeps | undefined;

  // ── F2: player history reads (each scoped to the caller's own userId AND site) ──
  ledger(userId: string, q: PageQuery, siteId?: string): Promise<Page<LedgerEntry>>;
  positions(userId: string, q: PositionListQuery, siteId?: string): Promise<Page<PositionRecord>>;
  /** A player's DIGIT contract history (receipt/review). Scoped to the caller's userId AND site. */
  digitHistory(userId: string, q: PageQuery, siteId?: string): Promise<Page<DigitHistoryRow>>;
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
  /** PAY-1 (docs/43): per-platform / per-brand payment accounts. Absent -> the routes answer 503. */
  paymentScopes?: import("@invest254/engine").PaymentScopeService | undefined;
  /** PAY-2 (docs/45): C2B Pay Bill settings + Safaricom URL registration (owner tier). */
  c2b?: import("@invest254/engine").C2bConfigService | undefined;
  /** POOL-1 (docs/46): per-brand pool overview + automatic distribution. */
  poolOps?: import("@invest254/engine").PoolOpsService | undefined;
  /** BILL-1 (docs/47): invoices, payments (M-Pesa Pay now + manual), charges, plans, billing settings. */
  billing?: import("@invest254/engine").BillingService | undefined;
  /** Per-platform domain-registrar (Namecheap) configuration service (Issue 1 #3). */
  registrarConfig?: RegistrarConfigDeps;
  /** Add-on catalog / entitlements / requests service (Issue 2). */
  addons?: AddonDeps;
}

const BASE = "/api/v1";

// ─────────────────────────── DTOs ───────────────────────────

/**
 * Serialize the config the browser validates against. It must be the SAME effective economy the
 * engine/PaymentService enforce, or the client and server disagree (e.g. the deposit form blocks an
 * amount the server would accept). So we fold the platform GLOBAL economy in with the exact "global
 * wins" precedence used server-side:
 *   - the enforced PLAYER cohort (stake bounds / multiplier / duration) is applied over the base config;
 *   - min deposit / max deposit / min withdrawal resolve to their enforced global value, else the base
 *     (static min-deposit constant, or the brand's `site_game_config` min-withdrawal).
 * `economy` defaults to empty so a missing platform gate is a safe no-op (base config unchanged).
 */
function gameConfigDto(cfg: GameConfig | VersionedGameConfig, economy: PlatformEconomy = EMPTY_PLATFORM_ECONOMY) {
  const eff = applyCohortEconomy(cfg, economy.player); // stake/multiplier/duration with global player enforce
  const p = economy.payments;
  return {
    currency: "KES",
    minStakeCents: eff.minStakeCents,
    maxStakeCents: eff.maxStakeCents,
    minWithdrawalCents: effectiveMinWithdrawal(cfg.minWithdrawalCents, p),
    // Currency-native minimum withdrawal (docs/25 §16): the brand's DISPLAY-currency floor (e.g. 100
    // => $100). The player app enforces this directly for foreign brands; null => use minWithdrawalCents.
    minWithdrawalNative: (cfg as GameConfig).minWithdrawalNative ?? null,
    // STAKE-1: the admin's stake limits in the brand currency (multiples of 5); null = derive from cents.
    minStakeNative: (cfg as { minStakeNative?: number | null }).minStakeNative ?? null,
    maxStakeNative: (cfg as { maxStakeNative?: number | null }).maxStakeNative ?? null,
    minDepositCents: effectiveMinDeposit(MIN_DEPOSIT_CENTS, p),
    maxDepositCents: effectiveMaxDeposit(null, p),
    maxMultiplier: eff.maxMultiplier,
    defaultDurationS: eff.defaultDurationS,
    tickRateMs: cfg.tickRateMs,
    rtp: rtp(eff),
    timeframesS: [eff.defaultDurationS],
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
    // Same platform GLOBAL economy the engine/PaymentService enforce — folded into the DTO so the
    // browser validates against the exact effective limits (no client/server divergence). Fail-open.
    const economy = deps.platformGate ? await deps.platformGate.economy() : EMPTY_PLATFORM_ECONOMY;
    if (deps.gameConfigForSite) {
      const origin = ctx.req.headers["origin"];
      const ref = ctx.query.get("site") || ctx.query.get("host")
        || (typeof origin === "string" ? origin : "");
      if (ref) {
        const c = await deps.gameConfigForSite(ref);
        if (c) return gameConfigDto(c, economy);
      }
    }
    return gameConfigDto(deps.config(), economy);
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
  const router = new Router({
    ...(deps.corsAllowOrigin ? { corsAllowOrigin: deps.corsAllowOrigin } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  registerPublicRoutes(router, deps);
  registerSiteRoutes(router, deps);
  registerAuthRoutes(router, deps);
  registerAffiliateRoutes(router, deps);
  registerReferralRoutes(router, deps);
  registerAdminRoutes(router, deps);
  registerPlatformRoutes(router, deps);
  registerNotificationRoutes(router, deps);
  registerPushRoutes(router, deps);
  registerWithdrawalActionRoutes(router, deps);
  registerTelegramRoutes(router, deps);
  registerMarketerRoutes(router, deps);
  registerProtectedRoutes(router, deps);
  registerHistoryRoutes(router, deps);
  registerSupportRoutes(router, deps);
  registerLiveChatRoutes(router, deps);
  registerKycRoutes(router, deps);
  registerSubscriptionRoutes(router, deps);
  registerAddonRoutes(router, deps);
  registerPaymentScopeRoutes(router, deps);
  registerC2bRoutes(router, deps);
  registerBillingRoutes(router, deps);
  registerTicketRoutes(router, deps);
  return router;
}

/** Build the API HTTP server (not yet listening). */
export function createApp(deps: ApiDeps): Server {
  return serverFrom(createRouter(deps));
}
