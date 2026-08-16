import { DEFAULT_CONFIG, checkFeasible, type Cents } from "@invest254/shared";
import type { Querier } from "./wallet.js";
import { type Page, type PageQuery, clampLimit, decodeKeyset, pageFrom } from "./paging.js";
import type { InMemoryIdentityRepository } from "./identity.js";
import type { InMemoryPaymentRepository } from "./payments.js";
import { InMemoryEngagementRepository } from "./engagement.js";
import type { DarajaConfig } from "./daraja.js";

/**
 * Admin back office (J2) — the operator domain seam the HTTP API binds to. Read aggregates
 * for the dashboard, paginated user/withdrawal/audit lists, and two guarded mutations:
 *  - setUserStatus  -> migration-0021 fn_admin_set_user_status (active|suspended|banned)
 *  - setCommissionRate -> fn_admin_set_commission_rate (0..1)
 * Both write an immutable row to `admin_actions` and enforce the role hierarchy server-side
 * (admin acts on players; only superadmin acts on another admin; no self-action). The Pg
 * repository calls those RPCs; the in-memory repository mirrors the identical guards + audit
 * for tests. All lists are newest-first, keyset-paginated (`<createdAtMs>:<id>` cursors).
 */

export interface AdminOverview {
  users: { total: number; active: number; suspended: number; banned: number; players: number; marketers: number; admins: number };
  finance: { depositsCents: Cents; withdrawalsCents: Cents; pendingWithdrawals: number; walletLiabilityCents: Cents };
  affiliate: { marketers: number; commissionAccruedCents: Cents; commissionPaidCents: Cents; pendingPayouts: number };
  game: { settledPositions: number; turnoverCents: Cents; ggrCents: Cents };
}
/** A user as the admin user-list sees them — enriched with wallet, lifetime cash flow,
 *  game economics and last-activity so operators get deep info at a glance (no drill-in needed). */
export interface AdminUserRow {
  userId: string; username: string; phone: string; role: string; status: string; createdAtMs: number;
  realBalanceCents: Cents; bonusBalanceCents: Cents;
  depositsCents: Cents; withdrawalsCents: Cents; netDepositsCents: Cents;
  lastFundedCents: Cents | null;
  turnoverCents: Cents; ggrCents: Cents; betCount: number;
  lastTxAtMs: number | null; lastTxKind: string | null; lastTxAmountCents: Cents | null; lastTxStatus: string | null;
  lastActiveAtMs: number | null;
}
export interface AdminUserDetail extends AdminUserRow {
  referredBy: string | null;
}
export interface AdminWithdrawalRow { txId: string; userId: string; username: string; amountCents: Cents; status: string; phone: string; createdAtMs: number; }
/** A transaction (deposit OR withdrawal) as the unified Finance transactions explorer sees it —
 *  carries the player identity, exact timestamps, provider, receipt and STK checkout id. */
export interface AdminTransactionRow {
  txId: string; userId: string; username: string; kind: string; amountCents: Cents; status: string;
  provider: string | null; phone: string; mpesaReceipt: string | null; checkoutRequestId: string | null;
  resultDesc: string | null; createdAtMs: number; updatedAtMs: number | null;
}
export interface AdminTransactionListQuery extends PageQuery { kind?: string | undefined; status?: string | undefined; q?: string | undefined; siteId?: string | undefined; }
export interface AdminAuditRow {
  id: string; actorId: string; actorRole: string; action: string;
  targetType: string; targetId: string | null; detail: unknown; createdAtMs: number;
}
export interface AdminUserListQuery extends PageQuery {
  role?: string | undefined; status?: string | undefined; q?: string | undefined;
  // Numeric threshold filters (all in cents / counts; undefined = no bound).
  minBalanceCents?: number | undefined; maxBalanceCents?: number | undefined;
  minDepositsCents?: number | undefined; minWithdrawalsCents?: number | undefined;
  minTurnoverCents?: number | undefined; minBets?: number | undefined;
  // Admin site scope (docs/22 Task E/H): filter to one brand. Undefined = platform-wide (all brands).
  siteId?: string | undefined;
}
export interface AdminWithdrawalListQuery extends PageQuery { status?: string | undefined; siteId?: string | undefined; }
export interface SetUserStatusResult { userId: string; status: string; }
export interface SetCommissionRateResult { userId: string; commissionRate: number; }
export interface SetUserRoleResult { userId: string; role: string; }
/** Result of a manual wallet balance adjustment (J3). */
export interface AdjustBalanceResult { userId: string; amountCents: Cents; newBalanceCents: Cents; direction: "credit" | "debit"; }
/** Result of resetting a wallet to the user's last funded (most recent successful deposit) amount. */
export interface ResetBalanceResult { userId: string; lastFundedCents: Cents; previousBalanceCents: Cents; newBalanceCents: Cents; }
// J8 — per-player controls: balance ops on either wallet + clear, and per-user engine overrides.
export type BalanceKind = "real" | "bonus";
export interface AdjustBalanceKindResult { userId: string; kind: BalanceKind; amountCents: Cents; newBalanceCents: Cents; direction: "credit" | "debit"; }
export interface ClearBalanceResult { userId: string; realBalanceCents: Cents; bonusBalanceCents: Cents; }
export interface UserOverrideRow {
  userId: string;
  winRate: number | null; houseEdge: number | null; tradeDurationS: number | null; maxWinMultiplier: number | null;
  minStakeCents: Cents | null; maxStakeCents: Cents | null; notes: string | null;
  updatedBy: string | null; updatedAtMs: number | null;
}
export interface UserOverridePatch {
  winRate?: number | null; houseEdge?: number | null; tradeDurationS?: number | null; maxWinMultiplier?: number | null;
  minStakeCents?: Cents | null; maxStakeCents?: Cents | null; notes?: string | null;
}
/** A deposit transaction as the admin deposits monitor sees it (J3). */
export interface AdminDepositRow {
  txId: string; userId: string; username: string; amountCents: Cents; status: string; phone: string;
  mpesaReceipt: string | null; checkoutRequestId: string | null; createdAtMs: number;
}
export interface AdminDepositListQuery extends PageQuery { status?: string | undefined; siteId?: string | undefined; }
/** One deposit-status bucket in the reconcile summary (J3). */
export interface AdminDepositStatusBucket { status: string; count: number; amountCents: Cents; }
/** Deposits reconcile read (J3): per-status totals + the non-terminal STK pushes that are stale
 *  (older than `staleMinutes`) and therefore the candidates to reconcile against M-Pesa. */
export interface AdminDepositsReconcile { summary: AdminDepositStatusBucket[]; staleMinutes: number; stale: AdminDepositRow[]; }
/** Inclusive `YYYY-MM-DD` date bounds for a report; either side may be omitted (J4). */
export interface ReportRange { from?: string | undefined; to?: string | undefined; }
/** One calendar day of operator finance (J4). Cash facts are keyed by transaction date,
 *  game facts (turnover/GGR) by the position's game-day trade date. */
export interface DailyReportRow { date: string; depositsCents: Cents; withdrawalsCents: Cents; turnoverCents: Cents; ggrCents: Cents; }
/** Per-user finance totals over the report window (J4). */
export interface UserReportRow { userId: string; username: string; depositsCents: Cents; withdrawalsCents: Cents; turnoverCents: Cents; ggrCents: Cents; }
/** A single calendar day (EAT) of comprehensive operator stats — the "day explorer" the admin
 *  reaches by picking a date on the calendar. Registrations are keyed by profile creation date,
 *  cash by transaction date, game facts by the position's trade date, pool by trade_day. */
export interface AdminDayReport {
  date: string;
  newRegistrants: number;          // players who registered that day
  newMarketers: number;            // marketers who enrolled that day
  activePlayers: number;           // distinct players who settled a trade that day
  depositors: number;              // distinct users with a successful deposit that day
  firstTimeDepositors: number;     // depositors whose FIRST-ever successful deposit was that day
  deposits: { count: number; amountCents: Cents };
  withdrawals: { count: number; amountCents: Cents };
  pendingWithdrawals: { count: number; amountCents: Cents };
  settledPositions: number;
  winningPositions: number;
  turnoverCents: Cents;
  payoutCents: Cents;              // total winnings credited to players that day
  ggrCents: Cents;                 // turnover − payout (net gaming revenue)
  commissionAccruedCents: Cents;   // affiliate commission accrued for that day
  poolBudgetCents: Cents;          // withdrawal-pool budget set for that day (all brands)
  poolPaidCents: Cents;            // withdrawal-pool winnings committed that day
}

// ── J5: game configuration, RTP monitor, seed rotation ─────────────────────────────────────────
/** The live game_config singleton as the admin panel sees it (J5). */
export interface GameConfigRow {
  houseEdge: number; maxMultiplier: number; minStakeCents: Cents; maxStakeCents: Cents;
  minWithdrawalCents: Cents;          // smallest cash-out a player can request (0043)
  defaultDurationS: number; tickRateMs: number; driftBias: number; volatility: number;
  targetWinRate: number;             // share of positions that win, per direction (0028)
  rtpTarget: number;                 // derived: 1 - house_edge
  /** game_config_versions.version now live. Bumps on every save; positions record it. */
  version: number;
  /** RTP / targetWinRate — must sit in (1, maxMultiplier] for the calibrator to solve. */
  requiredMeanWinMultiplier: number;
  updatedBy: string | null; updatedAtMs: number;
  /** When true (sites.pool_mode) the daily withdrawal pool governs payouts, so the win-shaping knobs
   *  (targetWinRate, driftBias, volatility, and effectively houseEdge/maxMultiplier) are DISPLAY-ONLY
   *  — the pool controller decides and paces wins against the budget, not these values. */
  poolMode: boolean;
}
/** Partial game_config edit (J5). Only provided keys change; the rest are left untouched. */
export interface GameConfigPatch {
  houseEdge?: number; maxMultiplier?: number; minStakeCents?: number; maxStakeCents?: number;
  minWithdrawalCents?: number;
  defaultDurationS?: number; tickRateMs?: number; driftBias?: number; volatility?: number;
  targetWinRate?: number;
}
/** Daily withdrawal-pool budget for a brand (docs/25, Phase 1). Money in cents; day = EAT calendar date. */
export interface WithdrawalPoolRow {
  siteId: string; tradeDay: string; amountCents: Cents; paidCents: Cents; reservedCents: Cents;
  availableCents: Cents; setBy: string | null; updatedAtMs: number;
  /** Per-brand recurring default that auto-seeds each new EAT day (migration 0064). */
  defaultDailyPoolCents: Cents;
}
/** Realised RTP over one rolling window (J5). `realisedRtp` is null when there is no turnover yet. */
export interface RtpWindowRow { window: string; settledPositions: number; turnoverCents: Cents; payoutCents: Cents; realisedRtp: number | null; }
/** RTP monitor: realised vs target across rolling windows, with a drift alert (J5). */
export interface RtpMonitor { targetRtp: number; toleranceAbs: number; minSamples: number; windows: RtpWindowRow[]; alert: boolean; }
/** One provably-fair day row for the admin seed panel (J5). Hash is the public commitment. */
export interface AdminSeedRow { gameDayId: number | null; tradeDate: string; serverSeedHash: string | null; seedVersion: number; revealed: boolean; revealedAtMs: number | null; }
/** Result of a superadmin-forced seed rotation (J5): the day and its new (bumped) seed version. */
export interface SeedRotateResult { tradeDate: string; seedVersion: number; }

// ── M-Pesa (Daraja) configuration — admin-managed; secrets write-only ───────────────────────
/** Admin-visible M-Pesa config. Secrets are never returned — only `has_*` presence flags. */
export interface MpesaConfigRow {
  environment: "sandbox" | "production";
  shortcode: string;
  stkCallbackUrl: string;
  b2cInitiator: string;
  b2cResultUrl: string;
  b2cTimeoutUrl: string;
  hasConsumerKey: boolean;
  hasConsumerSecret: boolean;
  hasPasskey: boolean;
  hasSecurityCredential: boolean;
  updatedBy: string | null;
  updatedAtMs: number;
}
/** Partial M-Pesa config edit (superadmin). Secret fields are write-only: omit/empty keeps current. */
export interface MpesaConfigPatch {
  environment?: "sandbox" | "production";
  shortcode?: string;
  stkCallbackUrl?: string;
  b2cInitiator?: string;
  b2cResultUrl?: string;
  b2cTimeoutUrl?: string;
  consumerKey?: string;
  consumerSecret?: string;
  passkey?: string;
  securityCredential?: string;
}

// ── J6: affiliate payout queue + chat moderation ───────────────────────────────────────────────
/** A payout request in the admin approve/reject queue (J6). */
export interface AdminPayoutRow { payoutId: string; affiliateId: string; username: string; phone: string; amountCents: Cents; status: string; approvedBy: string | null; createdAtMs: number; }
export interface AdminPayoutListQuery extends PageQuery { status?: string | undefined; }
/** A chat message in the moderation view (J6) — includes hidden rows with their visibility. */
export interface AdminChatModRow { id: number; userId: string | null; username: string; message: string; isHidden: boolean; createdAtMs: number; }

// ── J7: per-user activity timeline (deposits + withdrawals + bets merged) ───────────────────
/** One event in a user's unified activity timeline. `kind` discriminates the shape: cash events
 *  ("deposit"/"withdrawal") carry phone/mpesaReceipt; "bet" events carry the position fields
 *  (direction/payout/pnl/multiplier/result/settledAt/gameDayId). `amountCents` is the
 *  deposit/withdrawal amount or the bet stake; `createdAtMs` is the transaction time or the
 *  position's opened-at — the single sort/keyset key across both sources. */
export interface AdminUserActivityRow {
  kind: "deposit" | "withdrawal" | "bet";
  id: string;
  createdAtMs: number;
  status: string;
  amountCents: Cents;
  direction: string | null;
  payoutCents: Cents | null;
  pnlCents: Cents | null;
  multiplier: number | null;
  result: string | null;
  settledAtMs: number | null;
  gameDayId: number | null;
  phone: string | null;
  mpesaReceipt: string | null;
}
/** Activity-timeline query: optional `kind` filter ("deposit"|"withdrawal"|"bet"), keyset-paginated. */
export interface AdminUserActivityQuery extends PageQuery { kind?: string | undefined; }
/** A position projected for the admin activity timeline (the in-memory bet source). */
export interface AdminBetSnapshot {
  id: string; status: string; direction: string; stakeCents: Cents;
  payoutCents: Cents | null; pnlCents: Cents | null; multiplier: number | null;
  result: string | null; openedAtMs: number; settledAtMs: number | null; gameDayId: number | null;
}
/** Per-user bet source the in-memory admin repo merges into the activity timeline (Postgres reads
 *  the positions table directly). */
export interface AdminBetSource { adminBetsOf(userId: string): AdminBetSnapshot[]; }

/** Durable boundary for the admin back office (RPCs + reads / in-memory mirror). */
export interface AdminRepository {
  overview(): Promise<AdminOverview>;
  listUsers(q: AdminUserListQuery): Promise<Page<AdminUserRow>>;
  getUserDetail(userId: string): Promise<AdminUserDetail | null>;
  /** A single user's unified activity timeline (deposits + withdrawals + bets), newest-first, keyset-paginated. */
  listUserActivity(userId: string, q: AdminUserActivityQuery): Promise<Page<AdminUserActivityRow>>;
  setUserStatus(actorId: string, actorRole: string, targetId: string, status: string, reason: string | null): Promise<SetUserStatusResult>;
  setCommissionRate(actorId: string, actorRole: string, targetId: string, rate: number): Promise<SetCommissionRateResult>;
  setUserRole(actorId: string, actorRole: string, targetId: string, role: string): Promise<SetUserRoleResult>;
  listWithdrawals(q: AdminWithdrawalListQuery): Promise<Page<AdminWithdrawalRow>>;
  /** Unified deposits + withdrawals feed for the Finance transactions explorer (newest-first, keyset). */
  listTransactions(q: AdminTransactionListQuery): Promise<Page<AdminTransactionRow>>;
  listAudit(q: PageQuery, siteId?: string): Promise<Page<AdminAuditRow>>;
  adjustBalance(actorId: string, actorRole: string, targetId: string, amountCents: Cents, reason: string): Promise<AdjustBalanceResult>;
  /** Reset a user's real wallet to their most recent successful deposit amount (audited). */
  resetBalanceToLastFunded(actorId: string, actorRole: string, targetId: string, reason: string): Promise<ResetBalanceResult>;
  // J8 — balance ops on either wallet, one-shot clear, and per-user engine overrides.
  adjustBalanceKind(actorId: string, actorRole: string, targetId: string, amountCents: Cents, kind: BalanceKind, reason: string): Promise<AdjustBalanceKindResult>;
  clearBalance(actorId: string, actorRole: string, targetId: string, kind: "real" | "bonus" | "both", reason: string): Promise<ClearBalanceResult>;
  getUserOverrides(userId: string): Promise<UserOverrideRow | null>;
  setUserOverrides(actorId: string, actorRole: string, targetId: string, patch: UserOverridePatch): Promise<UserOverrideRow>;
  listDeposits(q: AdminDepositListQuery): Promise<Page<AdminDepositRow>>;
  depositsReconcile(staleMinutes: number): Promise<AdminDepositsReconcile>;
  reportDaily(range: ReportRange): Promise<DailyReportRow[]>;
  reportByUser(range: ReportRange): Promise<UserReportRow[]>;
  reportDay(date: string): Promise<AdminDayReport>;
  // J5 — game config + RTP monitor + seed rotation (superadmin mutations guarded in the RPC/mirror)
  // siteId scopes the read/write to a brand's `site_game_config` (the table the ENGINE prices from).
  // Omitted => the default site. This is the fix for the control-plane/data-plane split (0061).
  getGameConfig(siteId?: string): Promise<GameConfigRow>;
  updateGameConfig(actorId: string, actorRole: string, patch: GameConfigPatch, siteId?: string): Promise<GameConfigRow>;
  // docs/25 Phase 1 — daily withdrawal-pool budget (per brand, EAT day). Read + superadmin set.
  getWithdrawalPool(siteId: string, tradeDay: string): Promise<WithdrawalPoolRow>;
  setWithdrawalPool(actorId: string, actorRole: string, siteId: string, tradeDay: string, amountCents: Cents): Promise<WithdrawalPoolRow>;
  /** docs/25 (0064) — set the brand's recurring default that auto-seeds each new EAT day. */
  setDefaultPool(actorId: string, actorRole: string, siteId: string, tradeDay: string, amountCents: Cents): Promise<WithdrawalPoolRow>;
  getMpesaConfig(): Promise<MpesaConfigRow>;
  updateMpesaConfig(actorId: string, actorRole: string, patch: MpesaConfigPatch): Promise<MpesaConfigRow>;
  rtpMonitor(): Promise<RtpMonitor>;
  listSeeds(limit: number): Promise<AdminSeedRow[]>;
  rotateSeed(actorId: string, actorRole: string, tradeDate: string): Promise<SeedRotateResult>;
  // J6 — affiliate payout queue + chat moderation
  listAffiliatePayouts(q: AdminPayoutListQuery): Promise<Page<AdminPayoutRow>>;
  listChat(limit: number, includeHidden: boolean): Promise<AdminChatModRow[]>;
  hideChat(actorId: string, actorRole: string, id: number): Promise<boolean>;
  unhideChat(actorId: string, actorRole: string, id: number): Promise<boolean>;
  /** Append an immutable audit row for an admin action whose mutation lives in another service/RPC (J6). */
  recordAction(actorId: string, actorRole: string, action: string, targetType: string, targetId: string | null, detail: unknown): Promise<void>;
  // Admin write-path per-brand enforcement (docs/22 Task H): resolve the brand a mutation TARGET
  // belongs to so the API can reject a site-scoped admin acting across brands. A null/legacy site
  // normalizes to the default brand; an unknown target resolves to null (the site-aware RPC stays
  // the ultimate guard, so a null never blocks).
  siteOfUser(userId: string): Promise<string | null>;
  siteOfTransaction(txId: string): Promise<string | null>;
}

const VALID_STATUS = ["active", "suspended", "banned"];
const ADMIN_ROLES = ["admin", "superadmin"];
const VALID_ROLES = ["player", "marketer", "admin", "superadmin"];

/** In-memory admin site filter (docs/22 Task E): rows with a null/legacy site read as the default
 *  brand, so a default-scoped admin still sees them; undefined filter = platform-wide (all brands). */
const ADMIN_DEFAULT_SITE = "00000000-0000-0000-0000-000000000001";
const siteMatches = (rowSite: string | null | undefined, filter: string | undefined): boolean =>
  filter === undefined || (rowSite ?? ADMIN_DEFAULT_SITE) === filter;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Rolling windows for the realised-RTP monitor (J5). `days = null` is all-time. */
const RTP_WINDOWS: ReadonlyArray<{ window: string; days: number | null }> = [
  { window: "7d", days: 7 }, { window: "30d", days: 30 }, { window: "all", days: null },
];
const RTP_TOLERANCE = 0.05;   // absolute realised-vs-target drift that raises an alert
const RTP_MIN_SAMPLES = 50;   // settled positions a window needs before it can alert (avoid small-N noise)

/** UTC day key offset by `days` from now (e.g. days=6 -> the start day of a 7-day window). */
function utcDayKeyAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Build one RTP window row; realised RTP is payout/turnover (null when there is no turnover). */
function rtpWindowRow(window: string, n: number, turnover: number, payout: number): RtpWindowRow {
  return { window, settledPositions: n, turnoverCents: turnover, payoutCents: payout, realisedRtp: turnover > 0 ? payout / turnover : null };
}

/** Assemble the monitor + drift alert (alerts only on windows with enough samples). */
function buildRtpMonitor(targetRtp: number, windows: RtpWindowRow[]): RtpMonitor {
  const alert = windows.some((w) => w.settledPositions >= RTP_MIN_SAMPLES && w.realisedRtp !== null && Math.abs(w.realisedRtp - targetRtp) > RTP_TOLERANCE);
  return { targetRtp, toleranceAbs: RTP_TOLERANCE, minSamples: RTP_MIN_SAMPLES, windows, alert };
}

/** Map a raw game_config row to the public DTO (rtpTarget derived as 1 - house_edge). */
function mapGameConfigRow(x: any): GameConfigRow {
  const houseEdge = Number(x.house_edge);
  const targetWinRate = Number(x.target_win_rate);
  return {
    houseEdge, maxMultiplier: Number(x.max_multiplier), minStakeCents: num(x.min_stake), maxStakeCents: num(x.max_stake),
    minWithdrawalCents: num(x.min_withdrawal),
    defaultDurationS: Number(x.default_duration_s), tickRateMs: Number(x.tick_rate_ms),
    driftBias: Number(x.drift_bias), volatility: Number(x.volatility), targetWinRate,
    rtpTarget: 1 - houseEdge, version: Number(x.version ?? 0),
    requiredMeanWinMultiplier: targetWinRate > 0 ? (1 - houseEdge) / targetWinRate : Number.POSITIVE_INFINITY,
    updatedBy: x.updated_by == null ? null : String(x.updated_by), updatedAtMs: ms(x.updated_at),
    poolMode: x.pool_mode === true,
  };
}

/** Map a raw withdrawal_pool row to the DTO (availableCents derived). */
function mapPoolRow(x: any, siteId?: string, tradeDay?: string): WithdrawalPoolRow {
  const amount = num(x.amount_cents), paid = num(x.paid_cents), reserved = num(x.reserved_cents);
  return {
    siteId: String(x.site_id ?? siteId),
    tradeDay: x.trade_day instanceof Date ? x.trade_day.toISOString().slice(0, 10) : String(x.trade_day ?? tradeDay),
    amountCents: amount, paidCents: paid, reservedCents: reserved, availableCents: amount - paid - reserved,
    setBy: x.set_by == null ? null : String(x.set_by), updatedAtMs: ms(x.updated_at),
    defaultDailyPoolCents: num(x.default_daily_pool_cents),
  };
}

/** The default config as a GameConfigRow (in-memory mirror seed). */
function defaultGameConfigRow(): GameConfigRow {
  const c = DEFAULT_CONFIG;
  return {
    houseEdge: c.houseEdge, maxMultiplier: c.maxMultiplier, minStakeCents: c.minStakeCents, maxStakeCents: c.maxStakeCents,
    minWithdrawalCents: c.minWithdrawalCents,
    defaultDurationS: c.defaultDurationS, tickRateMs: c.tickRateMs, driftBias: c.driftBias, volatility: c.volatility,
    targetWinRate: c.targetWinRate, rtpTarget: 1 - c.houseEdge, version: 1,
    requiredMeanWinMultiplier: (1 - c.houseEdge) / c.targetWinRate,
    updatedBy: null, updatedAtMs: Date.now(),
    poolMode: false,
  };
}

/** Internal (unmasked) M-Pesa config — only used by the in-memory mirror and the DB loader shape. */
interface MpesaInternal {
  environment: "sandbox" | "production";
  shortcode: string; consumerKey: string; consumerSecret: string; passkey: string;
  stkCallbackUrl: string; b2cInitiator: string; b2cSecurityCredential: string;
  b2cResultUrl: string; b2cTimeoutUrl: string;
  updatedBy: string | null; updatedAtMs: number;
}
function defaultMpesaInternal(): MpesaInternal {
  return {
    environment: "sandbox", shortcode: "", consumerKey: "", consumerSecret: "", passkey: "",
    stkCallbackUrl: "", b2cInitiator: "", b2cSecurityCredential: "", b2cResultUrl: "", b2cTimeoutUrl: "",
    updatedBy: null, updatedAtMs: Date.now(),
  };
}
function maskMpesaInternal(m: MpesaInternal): MpesaConfigRow {
  return {
    environment: m.environment, shortcode: m.shortcode, stkCallbackUrl: m.stkCallbackUrl,
    b2cInitiator: m.b2cInitiator, b2cResultUrl: m.b2cResultUrl, b2cTimeoutUrl: m.b2cTimeoutUrl,
    hasConsumerKey: m.consumerKey !== "", hasConsumerSecret: m.consumerSecret !== "",
    hasPasskey: m.passkey !== "", hasSecurityCredential: m.b2cSecurityCredential !== "",
    updatedBy: m.updatedBy, updatedAtMs: m.updatedAtMs,
  };
}
/** Map a masked mpesa_config row (plain select or RPC return) to the wire DTO. */
function mapMpesaConfigRow(x: any): MpesaConfigRow {
  return {
    environment: x.environment === "production" ? "production" : "sandbox",
    shortcode: String(x.shortcode ?? ""),
    stkCallbackUrl: String(x.stk_callback_url ?? ""),
    b2cInitiator: String(x.b2c_initiator ?? ""),
    b2cResultUrl: String(x.b2c_result_url ?? ""),
    b2cTimeoutUrl: String(x.b2c_timeout_url ?? ""),
    hasConsumerKey: Boolean(x.has_consumer_key),
    hasConsumerSecret: Boolean(x.has_consumer_secret),
    hasPasskey: Boolean(x.has_passkey),
    hasSecurityCredential: Boolean(x.has_security_credential),
    updatedBy: x.updated_by == null ? null : String(x.updated_by),
    updatedAtMs: ms(x.updated_at),
  };
}

/** Read the raw M-Pesa config (incl. secrets) so the engine can build the Daraja client at
 *  startup. Returns only NON-EMPTY fields, letting the caller fall back to env per field. Any
 *  failure (e.g. table not yet migrated) yields {} → pure env behaviour, never a crash. */
export async function loadDarajaConfigFromDb(q: Querier): Promise<Partial<DarajaConfig>> {
  try {
    const r = await q.query(
      `select environment, shortcode, consumer_key, consumer_secret, passkey, stk_callback_url,
              b2c_initiator, b2c_security_credential, b2c_result_url, b2c_timeout_url
         from mpesa_config where id = 1`, []);
    if (!r.rows.length) return {};
    const x = r.rows[0] as Record<string, string | null>;
    const out: Partial<DarajaConfig> = {};
    if (x.environment === "sandbox" || x.environment === "production") out.env = x.environment;
    const put = (k: keyof DarajaConfig, v: string | null | undefined) => { if (v) (out as any)[k] = v; };
    put("shortcode", x.shortcode); put("consumerKey", x.consumer_key); put("consumerSecret", x.consumer_secret);
    put("passkey", x.passkey); put("stkCallbackUrl", x.stk_callback_url); put("b2cInitiator", x.b2c_initiator);
    put("b2cSecurityCredential", x.b2c_security_credential); put("b2cResultUrl", x.b2c_result_url);
    put("b2cTimeoutUrl", x.b2c_timeout_url);
    return out;
  } catch (e) {
    console.warn("[payments] loadDarajaConfigFromDb failed; using env only:", (e as Error).message);
    return {};
  }
}

/**
 * Mirror the game_config CHECK constraints; raises INVALID_CONFIG on any violation (J5).
 * Delegates to the shared `checkFeasible` so the in-memory repository, the database
 * constraint and the engine's hot-reload guard cannot drift apart.
 */
function validateGameConfig(c: GameConfigRow): void {
  const verdict = checkFeasible({
    houseEdge: c.houseEdge, maxMultiplier: c.maxMultiplier, minStakeCents: c.minStakeCents,
    maxStakeCents: c.maxStakeCents, minWithdrawalCents: c.minWithdrawalCents,
    defaultDurationS: c.defaultDurationS, tickRateMs: c.tickRateMs,
    driftBias: c.driftBias, volatility: c.volatility, targetWinRate: c.targetWinRate,
  });
  if (!verdict.ok) throw new Error("INVALID_CONFIG");
}

const num = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number)) || 0;
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
/** Normalize any timestamp/date value to a `YYYY-MM-DD` (UTC) day key. */
const day = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
/** Day key (UTC) for an epoch-ms timestamp. */
const dayOfMs = (msVal: number): string => new Date(msVal).toISOString().slice(0, 10);
/** True when `d` (YYYY-MM-DD) falls within an inclusive ReportRange. */
const inRange = (d: string, r: ReportRange): boolean => (r.from == null || d >= r.from) && (r.to == null || d <= r.to);

/** Re-raise the bare admin error code the RPCs raise instead of the wrapped pg message. */
function mapAdminError(e: unknown): never {
  const msg = (e as { message?: string })?.message ?? String(e);
  const m = msg.match(/(NOT_AUTHORIZED|INVALID_STATUS|NO_SELF_ACTION|USER_NOT_FOUND|INSUFFICIENT_PRIVILEGE|INVALID_RATE|NOT_AFFILIATE|REASON_REQUIRED|INVALID_AMOUNT|INVALID_ROLE|INSUFFICIENT_FUNDS|WALLET_NOT_FOUND|INVALID_CONFIG|INVALID_DATE|PAST_DATE|SEED_REVEALED|SUPERADMIN_PROTECTED|NOT_FOUND)/);
  throw new Error(m ? m[1] : msg);
}

// ─────────────────────────── Postgres-backed admin repository ───────────────────────────

/** Map a user_overrides row to the wire DTO (nulls preserved = "use the global value"). */
function mapOverrideRow(x: any): UserOverrideRow {
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    userId: String(x.user_id),
    winRate: n(x.win_rate),
    houseEdge: n(x.house_edge),
    tradeDurationS: x.trade_duration_s == null ? null : Number(x.trade_duration_s),
    maxWinMultiplier: n(x.max_win_multiplier),
    minStakeCents: x.min_stake == null ? null : Number(x.min_stake),
    maxStakeCents: x.max_stake == null ? null : Number(x.max_stake),
    notes: x.notes == null ? null : String(x.notes),
    updatedBy: x.updated_by == null ? null : String(x.updated_by),
    updatedAtMs: x.updated_at == null ? null : ms(x.updated_at),
  };
}

/** camelCase patch -> the snake_case jsonb the RPC reads. A key present (even null) is applied;
 *  an absent key is left unchanged. null clears a field back to the global default. */
function buildOverridePatch(patch: UserOverridePatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ("winRate" in patch) out["win_rate"] = patch.winRate ?? null;
  if ("houseEdge" in patch) out["house_edge"] = patch.houseEdge ?? null;
  if ("tradeDurationS" in patch) out["trade_duration_s"] = patch.tradeDurationS ?? null;
  if ("maxWinMultiplier" in patch) out["max_win_multiplier"] = patch.maxWinMultiplier ?? null;
  if ("minStakeCents" in patch) out["min_stake"] = patch.minStakeCents ?? null;
  if ("maxStakeCents" in patch) out["max_stake"] = patch.maxStakeCents ?? null;
  if ("notes" in patch) out["notes"] = patch.notes ?? null;
  return out;
}

export class PgAdminRepository implements AdminRepository {
  constructor(private readonly q: Querier) {}

  async overview(): Promise<AdminOverview> {
    const r = await this.q.query(
      `select
         (select count(*) from profiles) as u_total,
         (select count(*) from profiles where status = 'active') as u_active,
         (select count(*) from profiles where status = 'suspended') as u_suspended,
         (select count(*) from profiles where status = 'banned') as u_banned,
         (select count(*) from profiles where role = 'player') as u_players,
         (select count(*) from profiles where role = 'marketer') as u_marketers,
         (select count(*) from profiles where role in ('admin','superadmin')) as u_admins,
         (select coalesce(sum(amount),0) from transactions where kind='deposit' and status='success') as f_dep,
         (select coalesce(sum(amount),0) from transactions where kind='withdrawal' and status='success') as f_wd,
         (select count(*) from transactions where kind='withdrawal' and status='pending') as f_pending,
         (select coalesce(sum(real_balance + bonus_balance),0) from wallets) as f_liab,
         (select count(*) from affiliates) as a_marketers,
         (select coalesce(sum(commission),0) from affiliate_commissions where status='accrued') as a_accrued,
         (select coalesce(sum(commission),0) from affiliate_commissions where status='paid') as a_paid,
         (select count(*) from affiliate_payouts where status in ('requested','approved')) as a_pending,
         (select count(*) from positions where status='settled') as g_settled,
         (select coalesce(sum(stake),0) from positions where status='settled') as g_turnover,
         (select coalesce(sum(stake - payout),0) from positions where status='settled') as g_ggr`,
      []);
    const x = r.rows[0];
    return {
      users: { total: num(x.u_total), active: num(x.u_active), suspended: num(x.u_suspended), banned: num(x.u_banned),
        players: num(x.u_players), marketers: num(x.u_marketers), admins: num(x.u_admins) },
      finance: { depositsCents: num(x.f_dep), withdrawalsCents: num(x.f_wd), pendingWithdrawals: num(x.f_pending), walletLiabilityCents: num(x.f_liab) },
      affiliate: { marketers: num(x.a_marketers), commissionAccruedCents: num(x.a_accrued), commissionPaidCents: num(x.a_paid), pendingPayouts: num(x.a_pending) },
      game: { settledPositions: num(x.g_settled), turnoverCents: num(x.g_turnover), ggrCents: num(x.g_ggr) },
    };
  }

  async listUsers(q: AdminUserListQuery): Promise<Page<AdminUserRow>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select p.id, p.username, p.phone, p.role, p.status, p.created_at,
              coalesce(w.real_balance,0)  as real_balance,
              coalesce(w.bonus_balance,0) as bonus_balance,
              coalesce(td.deposits,0)     as deposits,
              coalesce(tw.withdrawals,0)  as withdrawals,
              coalesce(po.turnover,0)     as turnover,
              coalesce(po.ggr,0)          as ggr,
              coalesce(po.bet_count,0)    as bet_count,
              lt.created_at as last_tx_at, lt.kind as last_tx_kind, lt.amount as last_tx_amount, lt.status as last_tx_status,
              lf.last_funded as last_funded,
              greatest(coalesce(lt.created_at, 'epoch'::timestamptz), coalesce(po.last_bet_at, 'epoch'::timestamptz)) as last_active_at
         from profiles p
         left join wallets w on w.user_id = p.id
         left join lateral (select coalesce(sum(amount),0) as deposits    from transactions t where t.user_id = p.id and t.kind='deposit'    and t.status='success') td on true
         left join lateral (select coalesce(sum(amount),0) as withdrawals from transactions t where t.user_id = p.id and t.kind='withdrawal' and t.status='success') tw on true
         left join lateral (select coalesce(sum(stake),0) as turnover, coalesce(sum(stake - payout),0) as ggr, count(*) as bet_count, max(opened_at) as last_bet_at
                              from positions x where x.user_id = p.id and x.status='settled') po on true
         left join lateral (select created_at, kind, amount, status from transactions t where t.user_id = p.id order by created_at desc, id desc limit 1) lt on true
         left join lateral (select amount as last_funded from transactions t where t.user_id = p.id and t.kind='deposit' and t.status='success' order by created_at desc, id desc limit 1) lf on true
        where ($1::text is null or p.role = $1)
          and ($2::text is null or p.status = $2)
          and ($13::uuid is null or p.site_id = $13)
          and ($3::text is null or p.username ilike '%'||$3||'%' or p.phone ilike '%'||$3||'%')
          and ($4::timestamptz is null or (p.created_at, p.id) < ($4::timestamptz, $5::uuid))
          and ($7::bigint  is null or coalesce(w.real_balance,0) >= $7)
          and ($8::bigint  is null or coalesce(w.real_balance,0) <= $8)
          and ($9::bigint  is null or coalesce(td.deposits,0)    >= $9)
          and ($10::bigint is null or coalesce(tw.withdrawals,0) >= $10)
          and ($11::bigint is null or coalesce(po.turnover,0)    >= $11)
          and ($12::bigint is null or coalesce(po.bet_count,0)   >= $12)
        order by p.created_at desc, p.id desc
        limit $6`,
      [q.role ?? null, q.status ?? null, q.q ?? null, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1,
       q.minBalanceCents ?? null, q.maxBalanceCents ?? null, q.minDepositsCents ?? null, q.minWithdrawalsCents ?? null, q.minTurnoverCents ?? null, q.minBets ?? null, q.siteId ?? null]);
    const rows: AdminUserRow[] = r.rows.map(mapUserRow);
    return pageFrom(rows, limit, (u) => `${u.createdAtMs}:${u.userId}`);
  }

  async getUserDetail(userId: string): Promise<AdminUserDetail | null> {
    const r = await this.q.query(
      `select p.id, p.username, p.phone, p.role, p.status, p.referred_by, p.created_at,
              coalesce(w.real_balance,0)  as real_balance,
              coalesce(w.bonus_balance,0) as bonus_balance,
              coalesce(td.deposits,0)     as deposits,
              coalesce(tw.withdrawals,0)  as withdrawals,
              coalesce(po.turnover,0)     as turnover,
              coalesce(po.ggr,0)          as ggr,
              coalesce(po.bet_count,0)    as bet_count,
              lt.created_at as last_tx_at, lt.kind as last_tx_kind, lt.amount as last_tx_amount, lt.status as last_tx_status,
              lf.last_funded as last_funded,
              greatest(coalesce(lt.created_at, 'epoch'::timestamptz), coalesce(po.last_bet_at, 'epoch'::timestamptz)) as last_active_at
         from profiles p
         left join wallets w on w.user_id = p.id
         left join lateral (select coalesce(sum(amount),0) as deposits    from transactions t where t.user_id = p.id and t.kind='deposit'    and t.status='success') td on true
         left join lateral (select coalesce(sum(amount),0) as withdrawals from transactions t where t.user_id = p.id and t.kind='withdrawal' and t.status='success') tw on true
         left join lateral (select coalesce(sum(stake),0) as turnover, coalesce(sum(stake - payout),0) as ggr, count(*) as bet_count, max(opened_at) as last_bet_at
                              from positions x where x.user_id = p.id and x.status='settled') po on true
         left join lateral (select created_at, kind, amount, status from transactions t where t.user_id = p.id order by created_at desc, id desc limit 1) lt on true
         left join lateral (select amount as last_funded from transactions t where t.user_id = p.id and t.kind='deposit' and t.status='success' order by created_at desc, id desc limit 1) lf on true
        where p.id = $1`,
      [userId]);
    if (!r.rows.length) return null;
    const x = r.rows[0];
    return { ...mapUserRow(x), referredBy: x.referred_by == null ? null : String(x.referred_by) };
  }

  // Write-path scope resolvers (docs/22 Task H): the brand a mutation target belongs to. A legacy
  // null site normalizes to the default brand; a missing row yields null (RPC remains the guard).
  async siteOfUser(userId: string): Promise<string | null> {
    const r = await this.q.query("select site_id from profiles where id = $1", [userId]);
    return r.rows.length ? String(r.rows[0].site_id ?? ADMIN_DEFAULT_SITE) : null;
  }
  async siteOfTransaction(txId: string): Promise<string | null> {
    const r = await this.q.query("select site_id from transactions where id = $1", [txId]);
    return r.rows.length ? String(r.rows[0].site_id ?? ADMIN_DEFAULT_SITE) : null;
  }

  async listUserActivity(userId: string, q: AdminUserActivityQuery): Promise<Page<AdminUserActivityRow>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const kind = q.kind ?? null;
    const r = await this.q.query(
      `select * from (
         select t.id::text as id, t.kind as kind, t.created_at as created_at, t.status as status,
                t.amount::bigint as amount_cents,
                null::text as direction, null::bigint as payout_cents, null::bigint as pnl_cents,
                null::double precision as multiplier, null::text as result,
                null::timestamptz as settled_at, null::bigint as game_day_id,
                t.phone as phone, t.mpesa_receipt as mpesa_receipt
           from transactions t
          where t.user_id = $1 and ($2::text is null or t.kind = $2)
         union all
         select p.id::text as id, 'bet' as kind, p.opened_at as created_at, p.status as status,
                p.stake::bigint as amount_cents,
                p.direction as direction, p.payout::bigint as payout_cents, p.pnl::bigint as pnl_cents,
                p.multiplier::double precision as multiplier, p.result as result,
                p.settled_at as settled_at, p.game_day_id::bigint as game_day_id,
                null::text as phone, null::text as mpesa_receipt
           from positions p
          where p.user_id = $1 and ($2::text is null or $2 = 'bet')
       ) a
       where ($3::timestamptz is null or (a.created_at, a.id) < ($3::timestamptz, $4::text))
       order by a.created_at desc, a.id desc
       limit $5`,
      [userId, kind, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1]);
    const rows: AdminUserActivityRow[] = r.rows.map(mapActivityRow);
    return pageFrom(rows, limit, (a) => `${a.createdAtMs}:${a.id}`);
  }

  async setUserStatus(actorId: string, actorRole: string, targetId: string, status: string, reason: string | null): Promise<SetUserStatusResult> {
    try {
      const r = await this.q.query("select user_id, status from fn_admin_set_user_status($1,$2,$3,$4,$5)", [actorId, actorRole, targetId, status, reason]);
      const x = r.rows[0];
      return { userId: String(x.user_id), status: String(x.status) };
    } catch (e) { mapAdminError(e); }
  }

  async setUserRole(actorId: string, actorRole: string, targetId: string, role: string): Promise<SetUserRoleResult> {
    try {
      const r = await this.q.query("select user_id, role from fn_admin_set_user_role($1,$2,$3,$4)", [actorId, actorRole, targetId, role]);
      const x = r.rows[0];
      return { userId: String(x.user_id), role: String(x.role) };
    } catch (e) { mapAdminError(e); }
  }

  async setCommissionRate(actorId: string, actorRole: string, targetId: string, rate: number): Promise<SetCommissionRateResult> {
    try {
      const r = await this.q.query("select user_id, commission_rate from fn_admin_set_commission_rate($1,$2,$3,$4)", [actorId, actorRole, targetId, rate]);
      const x = r.rows[0];
      return { userId: String(x.user_id), commissionRate: num(x.commission_rate) };
    } catch (e) { mapAdminError(e); }
  }

  async listWithdrawals(q: AdminWithdrawalListQuery): Promise<Page<AdminWithdrawalRow>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select t.id, t.user_id, t.amount, t.status, t.phone, t.created_at, p.username from transactions t
         left join profiles p on p.id = t.user_id
        where t.kind = 'withdrawal'
          and ($1::text is null or t.status = $1)
          and ($5::uuid is null or t.site_id = $5)
          and ($2::timestamptz is null or (t.created_at, t.id) < ($2::timestamptz, $3::uuid))
        order by t.created_at desc, t.id desc
        limit $4`,
      [q.status ?? null, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1, q.siteId ?? null]);
    const rows: AdminWithdrawalRow[] = r.rows.map((x) => ({
      txId: String(x.id), userId: String(x.user_id), username: x.username == null ? "" : String(x.username),
      amountCents: num(x.amount), status: String(x.status), phone: String(x.phone), createdAtMs: ms(x.created_at),
    }));
    return pageFrom(rows, limit, (t) => `${t.createdAtMs}:${t.txId}`);
  }

  async listTransactions(q: AdminTransactionListQuery): Promise<Page<AdminTransactionRow>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select t.id, t.user_id, t.kind, t.amount, t.status, t.provider, t.phone, t.mpesa_receipt,
              t.checkout_request_id, t.result_desc, t.created_at, t.updated_at, p.username
         from transactions t
         left join profiles p on p.id = t.user_id
        where ($1::text is null or t.kind = $1)
          and ($2::text is null or t.status = $2)
          and ($7::uuid is null or t.site_id = $7)
          and ($3::text is null or p.username ilike '%'||$3||'%' or t.phone ilike '%'||$3||'%' or t.mpesa_receipt ilike '%'||$3||'%')
          and ($4::timestamptz is null or (t.created_at, t.id) < ($4::timestamptz, $5::uuid))
        order by t.created_at desc, t.id desc
        limit $6`,
      [q.kind ?? null, q.status ?? null, q.q ?? null, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1, q.siteId ?? null]);
    const rows: AdminTransactionRow[] = r.rows.map(mapTransactionRow);
    return pageFrom(rows, limit, (t) => `${t.createdAtMs}:${t.txId}`);
  }

  async listAudit(q: PageQuery, siteId?: string): Promise<Page<AdminAuditRow>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select id, actor_id, actor_role, action, target_type, target_id, detail, created_at from admin_actions
        where ($1::timestamptz is null or (created_at, id) < ($1::timestamptz, $2::bigint))
          and ($4::uuid is null or site_id = $4)
        order by created_at desc, id desc
        limit $3`,
      [cur ? new Date(cur.tsMs).toISOString() : null, cur ? Number(cur.id) : null, limit + 1, siteId ?? null]);
    const rows: AdminAuditRow[] = r.rows.map((x) => ({
      id: String(x.id), actorId: String(x.actor_id), actorRole: String(x.actor_role), action: String(x.action),
      targetType: String(x.target_type), targetId: x.target_id == null ? null : String(x.target_id), detail: x.detail, createdAtMs: ms(x.created_at),
    }));
    return pageFrom(rows, limit, (a) => `${a.createdAtMs}:${a.id}`);
  }

  async adjustBalance(actorId: string, actorRole: string, targetId: string, amountCents: Cents, reason: string): Promise<AdjustBalanceResult> {
    try {
      const r = await this.q.query("select user_id, amount, new_balance from fn_admin_adjust_balance($1,$2,$3,$4,$5)", [actorId, actorRole, targetId, amountCents, reason]);
      const x = r.rows[0];
      const amt = num(x.amount);
      return { userId: String(x.user_id), amountCents: amt, newBalanceCents: num(x.new_balance), direction: amt >= 0 ? "credit" : "debit" };
    } catch (e) { mapAdminError(e); }
  }

  async resetBalanceToLastFunded(actorId: string, actorRole: string, targetId: string, reason: string): Promise<ResetBalanceResult> {
    try {
      const r = await this.q.query("select user_id, last_funded, previous_balance, new_balance from fn_admin_reset_balance_to_last_funded($1,$2,$3,$4)", [actorId, actorRole, targetId, reason]);
      const x = r.rows[0];
      return { userId: String(x.user_id), lastFundedCents: num(x.last_funded), previousBalanceCents: num(x.previous_balance), newBalanceCents: num(x.new_balance) };
    } catch (e) { mapAdminError(e); }
  }

  async adjustBalanceKind(actorId: string, actorRole: string, targetId: string, amountCents: Cents, kind: BalanceKind, reason: string): Promise<AdjustBalanceKindResult> {
    try {
      const r = await this.q.query("select user_id, kind, amount, new_balance from fn_admin_adjust_balance_kind($1,$2,$3,$4,$5,$6)", [actorId, actorRole, targetId, amountCents, kind, reason]);
      const x = r.rows[0];
      const amt = num(x.amount);
      return { userId: String(x.user_id), kind: String(x.kind) as BalanceKind, amountCents: amt, newBalanceCents: num(x.new_balance), direction: amt >= 0 ? "credit" : "debit" };
    } catch (e) { mapAdminError(e); }
  }

  async clearBalance(actorId: string, actorRole: string, targetId: string, kind: "real" | "bonus" | "both", reason: string): Promise<ClearBalanceResult> {
    try {
      const r = await this.q.query("select user_id, real_balance, bonus_balance from fn_admin_clear_balance($1,$2,$3,$4,$5)", [actorId, actorRole, targetId, kind, reason]);
      const x = r.rows[0];
      return { userId: String(x.user_id), realBalanceCents: num(x.real_balance), bonusBalanceCents: num(x.bonus_balance) };
    } catch (e) { mapAdminError(e); }
  }

  async getUserOverrides(userId: string): Promise<UserOverrideRow | null> {
    const r = await this.q.query(
      "select user_id, win_rate, house_edge, trade_duration_s, max_win_multiplier, min_stake, max_stake, notes, updated_by, updated_at from user_overrides where user_id = $1", [userId]);
    return r.rows.length ? mapOverrideRow(r.rows[0]) : null;
  }

  async setUserOverrides(actorId: string, actorRole: string, targetId: string, patch: UserOverridePatch): Promise<UserOverrideRow> {
    try {
      const r = await this.q.query(
        "select user_id, win_rate, house_edge, trade_duration_s, max_win_multiplier, min_stake, max_stake, notes, updated_by, updated_at from fn_admin_set_user_overrides($1,$2,$3,$4::jsonb)",
        [actorId, actorRole, targetId, JSON.stringify(buildOverridePatch(patch))]);
      return mapOverrideRow(r.rows[0]);
    } catch (e) { mapAdminError(e); }
  }

  async listDeposits(q: AdminDepositListQuery): Promise<Page<AdminDepositRow>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select t.id, t.user_id, t.amount, t.status, t.phone, t.mpesa_receipt, t.checkout_request_id, t.created_at, p.username
         from transactions t left join profiles p on p.id = t.user_id
        where t.kind = 'deposit'
          and ($1::text is null or t.status = $1)
          and ($5::uuid is null or t.site_id = $5)
          and ($2::timestamptz is null or (t.created_at, t.id) < ($2::timestamptz, $3::uuid))
        order by t.created_at desc, t.id desc
        limit $4`,
      [q.status ?? null, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1, q.siteId ?? null]);
    const rows: AdminDepositRow[] = r.rows.map(mapDepositRow);
    return pageFrom(rows, limit, (d) => `${d.createdAtMs}:${d.txId}`);
  }

  async depositsReconcile(staleMinutes: number): Promise<AdminDepositsReconcile> {
    const s = await this.q.query(
      `select status, count(*)::bigint as n, coalesce(sum(amount),0)::bigint as amt
         from transactions where kind = 'deposit' group by status order by status`, []);
    const summary: AdminDepositStatusBucket[] = s.rows.map((x) => ({ status: String(x.status), count: num(x.n), amountCents: num(x.amt) }));
    const r = await this.q.query(
      `select t.id, t.user_id, t.amount, t.status, t.phone, t.mpesa_receipt, t.checkout_request_id, t.created_at, p.username
         from transactions t left join profiles p on p.id = t.user_id
        where t.kind = 'deposit' and t.status in ('pending', 'processing')
          and t.created_at < now() - ($1::int * interval '1 minute')
        order by t.created_at desc, t.id desc
        limit 100`,
      [Math.max(0, Math.round(staleMinutes))]);
    return { summary, staleMinutes, stale: r.rows.map(mapDepositRow) };
  }

  async reportDaily(range: ReportRange): Promise<DailyReportRow[]> {
    const r = await this.q.query(
      `with t as (
         select created_at::date as d,
                coalesce(sum(amount) filter (where kind='deposit'), 0)    as dep,
                coalesce(sum(amount) filter (where kind='withdrawal'), 0)  as wd
           from transactions
          where status = 'success'
            and ($1::date is null or created_at::date >= $1::date)
            and ($2::date is null or created_at::date <= $2::date)
          group by 1),
       g as (
         select coalesce(gd.trade_date, po.settled_at::date, po.opened_at::date) as d,
                coalesce(sum(po.stake), 0)              as turnover,
                coalesce(sum(po.stake - po.payout), 0)  as ggr
           from positions po
           left join game_days gd on gd.id = po.game_day_id
          where po.status = 'settled'
            and ($1::date is null or coalesce(gd.trade_date, po.settled_at::date, po.opened_at::date) >= $1::date)
            and ($2::date is null or coalesce(gd.trade_date, po.settled_at::date, po.opened_at::date) <= $2::date)
          group by 1)
       select coalesce(t.d, g.d) as day,
              coalesce(t.dep, 0) as deposits, coalesce(t.wd, 0) as withdrawals,
              coalesce(g.turnover, 0) as turnover, coalesce(g.ggr, 0) as ggr
         from t full outer join g on t.d = g.d
        order by day asc`,
      [range.from ?? null, range.to ?? null]);
    return r.rows.map((x) => ({
      date: day(x.day), depositsCents: num(x.deposits), withdrawalsCents: num(x.withdrawals),
      turnoverCents: num(x.turnover), ggrCents: num(x.ggr),
    }));
  }

  async reportByUser(range: ReportRange): Promise<UserReportRow[]> {
    const r = await this.q.query(
      `with t as (
         select user_id,
                coalesce(sum(amount) filter (where kind='deposit'), 0)    as dep,
                coalesce(sum(amount) filter (where kind='withdrawal'), 0)  as wd
           from transactions
          where status = 'success'
            and ($1::date is null or created_at::date >= $1::date)
            and ($2::date is null or created_at::date <= $2::date)
          group by 1),
       g as (
         select po.user_id,
                coalesce(sum(po.stake), 0)              as turnover,
                coalesce(sum(po.stake - po.payout), 0)  as ggr
           from positions po
           left join game_days gd on gd.id = po.game_day_id
          where po.status = 'settled'
            and ($1::date is null or coalesce(gd.trade_date, po.settled_at::date, po.opened_at::date) >= $1::date)
            and ($2::date is null or coalesce(gd.trade_date, po.settled_at::date, po.opened_at::date) <= $2::date)
          group by 1)
       select p.id as user_id, p.username,
              coalesce(t.dep, 0) as deposits, coalesce(t.wd, 0) as withdrawals,
              coalesce(g.turnover, 0) as turnover, coalesce(g.ggr, 0) as ggr
         from (select user_id from t union select user_id from g) ids
         join profiles p on p.id = ids.user_id
         left join t on t.user_id = ids.user_id
         left join g on g.user_id = ids.user_id
        order by ggr desc, user_id asc`,
      [range.from ?? null, range.to ?? null]);
    return r.rows.map((x) => ({
      userId: String(x.user_id), username: String(x.username),
      depositsCents: num(x.deposits), withdrawalsCents: num(x.withdrawals),
      turnoverCents: num(x.turnover), ggrCents: num(x.ggr),
    }));
  }

  async reportDay(date: string): Promise<AdminDayReport> {
    const r = await this.q.query(
      `with
       reg as (
         select
           count(*) filter (where role = 'player')   as new_players,
           count(*) filter (where role = 'marketer')  as new_marketers
         from profiles where created_at::date = $1::date
       ),
       tx as (
         select
           count(*) filter (where kind='deposit'    and status='success')            as dep_n,
           coalesce(sum(amount) filter (where kind='deposit'    and status='success'),0) as dep_c,
           count(*) filter (where kind='withdrawal' and status='success')            as wd_n,
           coalesce(sum(amount) filter (where kind='withdrawal' and status='success'),0) as wd_c,
           count(*) filter (where kind='withdrawal' and status in ('pending','processing')) as pend_n,
           coalesce(sum(amount) filter (where kind='withdrawal' and status in ('pending','processing')),0) as pend_c,
           count(distinct user_id) filter (where kind='deposit' and status='success') as depositors
         from transactions where created_at::date = $1::date
       ),
       ftd as (
         select count(*) as n from (
           select user_id, min(created_at::date) as first_dep
             from transactions where kind='deposit' and status='success' group by user_id
         ) f where f.first_dep = $1::date
       ),
       g as (
         select
           count(*)                                   as settled,
           count(*) filter (where po.payout > po.stake) as winners,
           coalesce(sum(po.stake),0)                  as turnover,
           coalesce(sum(po.payout),0)                 as payout,
           coalesce(sum(po.stake - po.payout),0)      as ggr,
           count(distinct po.user_id)                 as active_players
         from positions po
         left join game_days gd on gd.id = po.game_day_id
         where po.status='settled'
           and coalesce(gd.trade_date, po.settled_at::date, po.opened_at::date) = $1::date
       ),
       comm as (
         select coalesce(sum(commission),0) as accrued from affiliate_commissions where period = $1::date
       ),
       pool as (
         select coalesce(sum(amount_cents),0) as budget, coalesce(sum(paid_cents),0) as paid
           from withdrawal_pool where trade_day = $1::date
       )
       select reg.new_players, reg.new_marketers,
              tx.dep_n, tx.dep_c, tx.wd_n, tx.wd_c, tx.pend_n, tx.pend_c, tx.depositors, ftd.n as ftd,
              g.settled, g.winners, g.turnover, g.payout, g.ggr, g.active_players,
              comm.accrued, pool.budget, pool.paid
       from reg, tx, ftd, g, comm, pool`,
      [date]);
    const x = (r.rows[0] ?? {}) as Record<string, unknown>;
    return {
      date,
      newRegistrants: Number(x.new_players ?? 0),
      newMarketers: Number(x.new_marketers ?? 0),
      activePlayers: Number(x.active_players ?? 0),
      depositors: Number(x.depositors ?? 0),
      firstTimeDepositors: Number(x.ftd ?? 0),
      deposits: { count: Number(x.dep_n ?? 0), amountCents: num(x.dep_c) },
      withdrawals: { count: Number(x.wd_n ?? 0), amountCents: num(x.wd_c) },
      pendingWithdrawals: { count: Number(x.pend_n ?? 0), amountCents: num(x.pend_c) },
      settledPositions: Number(x.settled ?? 0),
      winningPositions: Number(x.winners ?? 0),
      turnoverCents: num(x.turnover),
      payoutCents: num(x.payout),
      ggrCents: num(x.ggr),
      commissionAccruedCents: num(x.accrued),
      poolBudgetCents: num(x.budget),
      poolPaidCents: num(x.paid),
    };
  }

  // ── J5: game config + RTP monitor + seed rotation ────────────────────────────────────────────

  // Reads the BRAND's live economy from `site_game_config` — the exact row the multiplexed engine
  // prices from (SiteGameConfigStore). Previously this read the legacy `game_config` singleton, which
  // the engine never consults, so the operator panel and the live game were divorced (see 0061).
  async getGameConfig(siteId: string = ADMIN_DEFAULT_SITE): Promise<GameConfigRow> {
    const r = await this.q.query(
      "select g.house_edge, g.max_multiplier, g.min_stake, g.max_stake, g.min_withdrawal, g.default_duration_s, g.tick_rate_ms, g.drift_bias, g.volatility, g.target_win_rate, g.version, g.updated_by, g.updated_at, s.pool_mode from site_game_config g join sites s on s.id = g.site_id where g.site_id = $1", [siteId]);
    if (!r.rows.length) throw new Error("NOT_FOUND");
    return mapGameConfigRow(r.rows[0]);
  }

  // Writes the BRAND's economy via fn_admin_set_site_game_config (migration 0061): the site_game_config
  // trigger then bumps the version, snapshots history, and fires pg_notify so the engine re-prices the
  // next round with no redeploy. Feasibility is enforced by the site_game_config CHECK (-> INVALID_CONFIG).
  async updateGameConfig(actorId: string, actorRole: string, patch: GameConfigPatch, siteId: string = ADMIN_DEFAULT_SITE): Promise<GameConfigRow> {
    try {
      await this.q.query(
        "select 1 from fn_admin_set_site_game_config($1,$2,$3::uuid,$4::jsonb)",
        [actorId, actorRole, siteId, JSON.stringify(patch)]);
    } catch (e) { mapAdminError(e); }
    // Re-read through getGameConfig so the returned row carries pool_mode (joined from sites).
    return this.getGameConfig(siteId);
  }

  async getWithdrawalPool(siteId: string, tradeDay: string): Promise<WithdrawalPoolRow> {
    await this.q.query("select 1 from fn_pool_ensure_day($1::uuid, $2::date)", [siteId, tradeDay]); // auto-seed from default
    const r = await this.q.query(
      `select w.site_id, w.trade_day, w.amount_cents, w.paid_cents, w.reserved_cents, w.set_by, w.updated_at,
              s.default_daily_pool_cents
         from withdrawal_pool w join sites s on s.id = w.site_id
        where w.site_id = $1 and w.trade_day = $2`, [siteId, tradeDay]);
    if (!r.rows.length) {
      return { siteId, tradeDay, amountCents: 0, paidCents: 0, reservedCents: 0, availableCents: 0, setBy: null, updatedAtMs: Date.now(), defaultDailyPoolCents: 0 };
    }
    return mapPoolRow(r.rows[0], siteId, tradeDay);
  }

  async setWithdrawalPool(actorId: string, actorRole: string, siteId: string, tradeDay: string, amountCents: Cents): Promise<WithdrawalPoolRow> {
    try { await this.q.query("select fn_admin_set_withdrawal_pool($1,$2,$3::uuid,$4::date,$5)", [actorId, actorRole, siteId, tradeDay, amountCents]); }
    catch (e) { mapAdminError(e); }
    return this.getWithdrawalPool(siteId, tradeDay);
  }

  async setDefaultPool(actorId: string, actorRole: string, siteId: string, tradeDay: string, amountCents: Cents): Promise<WithdrawalPoolRow> {
    try { await this.q.query("select fn_admin_set_default_pool($1,$2,$3::uuid,$4)", [actorId, actorRole, siteId, amountCents]); }
    catch (e) { mapAdminError(e); }
    return this.getWithdrawalPool(siteId, tradeDay);
  }

  async getMpesaConfig(): Promise<MpesaConfigRow> {
    const r = await this.q.query(
      `select environment, shortcode, stk_callback_url, b2c_initiator, b2c_result_url, b2c_timeout_url,
              (consumer_key <> '') as has_consumer_key, (consumer_secret <> '') as has_consumer_secret,
              (passkey <> '') as has_passkey, (b2c_security_credential <> '') as has_security_credential,
              updated_by, updated_at from mpesa_config where id = 1`, []);
    if (!r.rows.length) throw new Error("NOT_FOUND");
    return mapMpesaConfigRow(r.rows[0]);
  }

  async updateMpesaConfig(actorId: string, actorRole: string, patch: MpesaConfigPatch): Promise<MpesaConfigRow> {
    try {
      const r = await this.q.query(
        `select environment, shortcode, stk_callback_url, b2c_initiator, b2c_result_url, b2c_timeout_url,
                has_consumer_key, has_consumer_secret, has_passkey, has_security_credential, updated_by, updated_at
           from fn_admin_update_mpesa_config($1,$2,$3::jsonb)`,
        [actorId, actorRole, JSON.stringify(patch)]);
      return mapMpesaConfigRow(r.rows[0]);
    } catch (e) { mapAdminError(e); }
  }

  async rtpMonitor(): Promise<RtpMonitor> {
    const cfg = await this.getGameConfig();
    const r = await this.q.query(
      `select
         count(*) filter (where settled_at >= now() - interval '7 days')                 as n7,
         coalesce(sum(stake)  filter (where settled_at >= now() - interval '7 days'), 0)  as t7,
         coalesce(sum(payout) filter (where settled_at >= now() - interval '7 days'), 0)  as p7,
         count(*) filter (where settled_at >= now() - interval '30 days')                as n30,
         coalesce(sum(stake)  filter (where settled_at >= now() - interval '30 days'), 0) as t30,
         coalesce(sum(payout) filter (where settled_at >= now() - interval '30 days'), 0) as p30,
         count(*) as na, coalesce(sum(stake), 0) as ta, coalesce(sum(payout), 0) as pa
       from positions where status = 'settled'`, []);
    const x = r.rows[0];
    const windows = [
      rtpWindowRow("7d", num(x.n7), num(x.t7), num(x.p7)),
      rtpWindowRow("30d", num(x.n30), num(x.t30), num(x.p30)),
      rtpWindowRow("all", num(x.na), num(x.ta), num(x.pa)),
    ];
    return buildRtpMonitor(cfg.rtpTarget, windows);
  }

  async listSeeds(limit: number): Promise<AdminSeedRow[]> {
    const r = await this.q.query(
      `select gd.id, gd.trade_date, gd.server_seed_hash, gd.revealed_at, coalesce(so.version, 0) as version
         from game_days gd left join seed_overrides so on so.trade_date = gd.trade_date
        order by gd.trade_date desc limit $1`, [clampLimit(limit)]);
    return r.rows.map((x) => ({
      gameDayId: x.id == null ? null : Number(x.id), tradeDate: day(x.trade_date),
      serverSeedHash: x.server_seed_hash == null ? null : String(x.server_seed_hash),
      seedVersion: num(x.version), revealed: x.revealed_at != null,
      revealedAtMs: x.revealed_at == null ? null : ms(x.revealed_at),
    }));
  }

  async rotateSeed(actorId: string, actorRole: string, tradeDate: string): Promise<SeedRotateResult> {
    try {
      const r = await this.q.query("select trade_date, version from fn_admin_rotate_seed($1,$2,$3::date)", [actorId, actorRole, tradeDate]);
      const x = r.rows[0];
      return { tradeDate: day(x.trade_date), seedVersion: num(x.version) };
    } catch (e) { mapAdminError(e); }
  }

  // ── J6: affiliate payout queue + chat moderation ─────────────────────────────────────────────

  async listAffiliatePayouts(q: AdminPayoutListQuery): Promise<Page<AdminPayoutRow>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select ap.id, ap.affiliate_id, pr.username, pr.phone, ap.amount, ap.status, ap.approved_by, ap.created_at
         from affiliate_payouts ap join profiles pr on pr.id = ap.affiliate_id
        where ($1::text is null or ap.status = $1)
          and ($2::timestamptz is null or (ap.created_at, ap.id) < ($2::timestamptz, $3::uuid))
        order by ap.created_at desc, ap.id desc limit $4`,
      [q.status ?? null, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1]);
    const rows: AdminPayoutRow[] = r.rows.map((x) => ({
      payoutId: String(x.id), affiliateId: String(x.affiliate_id), username: String(x.username), phone: String(x.phone),
      amountCents: num(x.amount), status: String(x.status), approvedBy: x.approved_by == null ? null : String(x.approved_by), createdAtMs: ms(x.created_at),
    }));
    return pageFrom(rows, limit, (p) => `${p.createdAtMs}:${p.payoutId}`);
  }

  async listChat(limit: number, includeHidden: boolean): Promise<AdminChatModRow[]> {
    const r = await this.q.query(
      `select id, user_id, username, message, is_hidden, created_at from chat_messages
        where ($2::boolean or is_hidden = false)
        order by created_at desc, id desc limit $1`, [clampLimit(limit), includeHidden]);
    return r.rows.map((x) => ({
      id: Number(x.id), userId: x.user_id ?? null, username: String(x.username), message: String(x.message),
      isHidden: Boolean(x.is_hidden), createdAtMs: ms(x.created_at),
    }));
  }

  async hideChat(actorId: string, actorRole: string, id: number): Promise<boolean> {
    const r = await this.q.query(
      `with upd as (update chat_messages set is_hidden = true where id = $1 and is_hidden = false returning id),
            aud as (insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
                    select $2, $3, 'chat.hide', 'chat', $1::text, '{}'::jsonb from upd)
       select count(*)::int as n from upd`, [id, actorId, actorRole]);
    return num(r.rows[0]?.n) > 0;
  }

  async unhideChat(actorId: string, actorRole: string, id: number): Promise<boolean> {
    const r = await this.q.query(
      `with upd as (update chat_messages set is_hidden = false where id = $1 and is_hidden = true returning id),
            aud as (insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
                    select $2, $3, 'chat.unhide', 'chat', $1::text, '{}'::jsonb from upd)
       select count(*)::int as n from upd`, [id, actorId, actorRole]);
    return num(r.rows[0]?.n) > 0;
  }

  async recordAction(actorId: string, actorRole: string, action: string, targetType: string, targetId: string | null, detail: unknown): Promise<void> {
    await this.q.query(
      "insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail) values($1,$2,$3,$4,$5,$6::jsonb)",
      [actorId, actorRole, action, targetType, targetId, JSON.stringify(detail ?? {})]);
  }
}

/** Map a raw enriched `profiles` row (joined to wallet + cash-flow + game aggregates) into AdminUserRow. */
function mapUserRow(x: any): AdminUserRow {
  const deposits = num(x.deposits);
  const withdrawals = num(x.withdrawals);
  const lastActive = x.last_active_at == null ? 0 : ms(x.last_active_at);
  return {
    userId: String(x.id), username: String(x.username), phone: x.phone == null ? "" : String(x.phone),
    role: String(x.role), status: String(x.status), createdAtMs: ms(x.created_at),
    realBalanceCents: num(x.real_balance), bonusBalanceCents: num(x.bonus_balance),
    depositsCents: deposits, withdrawalsCents: withdrawals, netDepositsCents: deposits - withdrawals,
    lastFundedCents: x.last_funded == null ? null : num(x.last_funded),
    turnoverCents: num(x.turnover), ggrCents: num(x.ggr), betCount: num(x.bet_count),
    lastTxAtMs: x.last_tx_at == null ? null : ms(x.last_tx_at),
    lastTxKind: x.last_tx_kind == null ? null : String(x.last_tx_kind),
    lastTxAmountCents: x.last_tx_amount == null ? null : num(x.last_tx_amount),
    lastTxStatus: x.last_tx_status == null ? null : String(x.last_tx_status),
    lastActiveAtMs: lastActive > 0 ? lastActive : null,
  };
}

/** Map a raw deposit `transactions` row into the public AdminDepositRow. */
function mapActivityRow(x: any): AdminUserActivityRow {
  return {
    kind: String(x.kind) as AdminUserActivityRow["kind"],
    id: String(x.id), createdAtMs: ms(x.created_at), status: String(x.status),
    amountCents: num(x.amount_cents),
    direction: x.direction == null ? null : String(x.direction),
    payoutCents: x.payout_cents == null ? null : num(x.payout_cents),
    pnlCents: x.pnl_cents == null ? null : num(x.pnl_cents),
    multiplier: x.multiplier == null ? null : Number(x.multiplier),
    result: x.result == null ? null : String(x.result),
    settledAtMs: x.settled_at == null ? null : ms(x.settled_at),
    gameDayId: x.game_day_id == null ? null : num(x.game_day_id),
    phone: x.phone == null ? null : String(x.phone),
    mpesaReceipt: x.mpesa_receipt == null ? null : String(x.mpesa_receipt),
  };
}

function mapDepositRow(x: any): AdminDepositRow {
  return {
    txId: String(x.id), userId: String(x.user_id), username: x.username == null ? "" : String(x.username),
    amountCents: num(x.amount), status: String(x.status), phone: String(x.phone),
    mpesaReceipt: x.mpesa_receipt == null ? null : String(x.mpesa_receipt),
    checkoutRequestId: x.checkout_request_id == null ? null : String(x.checkout_request_id), createdAtMs: ms(x.created_at),
  };
}

/** Map a raw `transactions` row (joined to profiles) into the unified AdminTransactionRow. */
function mapTransactionRow(x: any): AdminTransactionRow {
  return {
    txId: String(x.id), userId: String(x.user_id), username: x.username == null ? "" : String(x.username),
    kind: String(x.kind), amountCents: num(x.amount), status: String(x.status),
    provider: x.provider == null ? null : String(x.provider), phone: x.phone == null ? "" : String(x.phone),
    mpesaReceipt: x.mpesa_receipt == null ? null : String(x.mpesa_receipt),
    checkoutRequestId: x.checkout_request_id == null ? null : String(x.checkout_request_id),
    resultDesc: x.result_desc == null ? null : String(x.result_desc),
    createdAtMs: ms(x.created_at), updatedAtMs: x.updated_at == null ? null : ms(x.updated_at),
  };
}

// ─────────────────────────── In-memory admin repository (tests) ───────────────────────────

/** In-memory keyset pagination over `(_ts desc, _id desc)` rows, mirroring the Pg keyset reads. */
function memKeyset<T extends { _ts: number; _id: string }>(all: T[], q: PageQuery): Page<Omit<T, "_ts" | "_id">> {
  const limit = clampLimit(q.limit);
  const cur = decodeKeyset(q.cursor);
  const sorted = [...all].sort((a, b) => (b._ts - a._ts) || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0));
  const filtered = cur ? sorted.filter((x) => x._ts < cur.tsMs || (x._ts === cur.tsMs && x._id < cur.id)) : sorted;
  const page = pageFrom(filtered, limit, (t) => `${t._ts}:${t._id}`);
  return { items: page.items.map(({ _ts, _id, ...rest }) => rest as Omit<T, "_ts" | "_id">), nextCursor: page.nextCursor };
}

interface MemAudit { id: number; actorId: string; actorRole: string; action: string; targetType: string; targetId: string | null; detail: unknown; createdAtMs: number; }

/** Project an admin transaction snapshot into the public AdminDepositRow shape. */
function memDepositRow(t: { txId: string; userId: string; amountCents: Cents; status: string; phone: string; mpesaReceipt: string | null; checkoutRequestId: string | null; createdAtMs: number }, username = ""): AdminDepositRow {
  return { txId: t.txId, userId: t.userId, username, amountCents: t.amountCents, status: t.status, phone: t.phone, mpesaReceipt: t.mpesaReceipt, checkoutRequestId: t.checkoutRequestId, createdAtMs: t.createdAtMs };
}

/**
 * In-memory AdminRepository composing the in-memory identity + payment stores. It enforces the
 * SAME guards and writes the SAME audit shape as the 0021 RPCs, so the engine/API tests exercise
 * the real authorization semantics without Postgres.
 */
export class InMemoryAdminRepository implements AdminRepository {
  private readonly audit: MemAudit[] = [];
  private seq = 0;
  // Per-brand game config mirror (site_game_config in the DB). Keyed by site_id; the default site is
  // seeded lazily. Mirrors the 0061 fix where admin config reads/writes the brand's site_game_config.
  private readonly gameConfigBySite = new Map<string, GameConfigRow>();
  /** Per-(site, EAT day) withdrawal-pool mirror for the test harness (docs/25 Phase 1). */
  private readonly pools = new Map<string, WithdrawalPoolRow>();
  private readonly poolDefaults = new Map<string, number>();  // siteId -> default daily budget (0064)
  private mpesa: MpesaInternal = defaultMpesaInternal();
  private readonly seedRows = new Map<string, AdminSeedRow>();
  // J8 in-memory stores (bonus wallet + per-user overrides) for the test harness.
  private readonly bonusBal = new Map<string, number>();
  private readonly overrides = new Map<string, UserOverrideRow>();
  constructor(
    private readonly identity: InMemoryIdentityRepository,
    private readonly payments: InMemoryPaymentRepository,
    private readonly engagement: InMemoryEngagementRepository = new InMemoryEngagementRepository(),
    private readonly bets?: AdminBetSource,
  ) {}

  async overview(): Promise<AdminOverview> {
    const users = this.identity.adminUsers();
    const txs = this.payments.adminTransactions();
    const commissions = this.identity.adminCommissions();
    const plays = this.identity.adminPlays();
    return {
      users: {
        total: users.length,
        active: users.filter((u) => u.status === "active").length,
        suspended: users.filter((u) => u.status === "suspended").length,
        banned: users.filter((u) => u.status === "banned").length,
        players: users.filter((u) => u.role === "player").length,
        marketers: users.filter((u) => u.role === "marketer").length,
        admins: users.filter((u) => u.role === "admin" || u.role === "superadmin").length,
      },
      finance: {
        depositsCents: txs.filter((t) => t.kind === "deposit" && t.status === "success").reduce((s, t) => s + t.amountCents, 0),
        withdrawalsCents: txs.filter((t) => t.kind === "withdrawal" && t.status === "success").reduce((s, t) => s + t.amountCents, 0),
        pendingWithdrawals: txs.filter((t) => t.kind === "withdrawal" && t.status === "pending").length,
        walletLiabilityCents: this.payments.adminWalletLiabilityCents(),
      },
      affiliate: {
        marketers: this.identity.adminAffiliates().length,
        commissionAccruedCents: commissions.filter((c) => c.status === "accrued").reduce((s, c) => s + c.commissionCents, 0),
        commissionPaidCents: commissions.filter((c) => c.status === "paid").reduce((s, c) => s + c.commissionCents, 0),
        pendingPayouts: this.identity.adminPendingPayoutCount(),
      },
      game: {
        settledPositions: plays.length,
        turnoverCents: plays.reduce((s, p) => s + p.stakeCents, 0),
        ggrCents: plays.reduce((s, p) => s + (p.stakeCents - p.payoutCents), 0),
      },
    };
  }

  /** Build an enriched AdminUserRow from the in-memory stores (mirrors the Pg lateral aggregates). */
  private async memUserRow(u: { userId: string; username: string; phone: string; role: string; status: string; createdAtMs: number }): Promise<AdminUserRow> {
    const txs = this.payments.adminTransactions().filter((t) => t.userId === u.userId);
    const plays = this.identity.adminPlaysOf(u.userId);
    const deposits = txs.filter((t) => t.kind === "deposit" && t.status === "success").reduce((s, t) => s + t.amountCents, 0);
    const withdrawals = txs.filter((t) => t.kind === "withdrawal" && t.status === "success").reduce((s, t) => s + t.amountCents, 0);
    const last = txs.slice().sort((a, b) => (b.createdAtMs - a.createdAtMs) || (a.txId < b.txId ? 1 : -1))[0];
    const lastFundedTx = txs
      .filter((t) => t.kind === "deposit" && t.status === "success")
      .sort((a, b) => (b.createdAtMs - a.createdAtMs) || (a.txId < b.txId ? 1 : -1))[0];
    const turnover = plays.reduce((s, p) => s + p.stakeCents, 0);
    const ggr = plays.reduce((s, p) => s + (p.stakeCents - p.payoutCents), 0);
    return {
      userId: u.userId, username: u.username, phone: u.phone, role: u.role, status: u.status, createdAtMs: u.createdAtMs,
      realBalanceCents: await this.payments.getBalance(u.userId), bonusBalanceCents: this.bonusBal.get(u.userId) ?? 0,
      depositsCents: deposits, withdrawalsCents: withdrawals, netDepositsCents: deposits - withdrawals,
      lastFundedCents: lastFundedTx ? lastFundedTx.amountCents : null,
      turnoverCents: turnover, ggrCents: ggr, betCount: plays.length,
      lastTxAtMs: last ? last.createdAtMs : null, lastTxKind: last ? last.kind : null,
      lastTxAmountCents: last ? last.amountCents : null, lastTxStatus: last ? last.status : null,
      lastActiveAtMs: last ? last.createdAtMs : null,
    };
  }

  async listUsers(q: AdminUserListQuery): Promise<Page<AdminUserRow>> {
    const needle = q.q?.toLowerCase();
    const matched = this.identity.adminUsers().filter((u) =>
      (q.role === undefined || u.role === q.role) &&
      (q.status === undefined || u.status === q.status) &&
      siteMatches(u.siteId, q.siteId) &&
      (needle === undefined || u.username.toLowerCase().includes(needle) || u.phone.includes(needle)));
    const built = await Promise.all(matched.map(async (u) => ({ ...(await this.memUserRow(u)), _ts: u.createdAtMs, _id: u.userId })));
    const rows = built.filter((r) =>
      (q.minBalanceCents === undefined || r.realBalanceCents >= q.minBalanceCents) &&
      (q.maxBalanceCents === undefined || r.realBalanceCents <= q.maxBalanceCents) &&
      (q.minDepositsCents === undefined || r.depositsCents >= q.minDepositsCents) &&
      (q.minWithdrawalsCents === undefined || r.withdrawalsCents >= q.minWithdrawalsCents) &&
      (q.minTurnoverCents === undefined || r.turnoverCents >= q.minTurnoverCents) &&
      (q.minBets === undefined || r.betCount >= q.minBets));
    return memKeyset(rows, q);
  }

  async getUserDetail(userId: string): Promise<AdminUserDetail | null> {
    const u = this.identity.adminUser(userId);
    if (!u) return null;
    return { ...(await this.memUserRow(u)), referredBy: u.referredBy };
  }

  // Write-path scope resolvers (docs/22 Task H) — mirror the Pg normalization: null/legacy site =>
  // default brand; an unknown target => null (never blocks; the site-aware RPC is the real guard).
  async siteOfUser(userId: string): Promise<string | null> {
    const u = this.identity.adminUser(userId);
    return u ? (u.siteId ?? ADMIN_DEFAULT_SITE) : null;
  }
  async siteOfTransaction(txId: string): Promise<string | null> {
    const t = this.payments.adminTransactions().find((x) => x.txId === txId);
    return t ? (t.siteId ?? ADMIN_DEFAULT_SITE) : null;
  }

  async listUserActivity(userId: string, q: AdminUserActivityQuery): Promise<Page<AdminUserActivityRow>> {
    const kind = q.kind;
    const rows: Array<AdminUserActivityRow & { _ts: number; _id: string }> = [];
    if (kind === undefined || kind === "deposit" || kind === "withdrawal") {
      for (const t of this.payments.adminTransactions()) {
        if (t.userId !== userId || (kind !== undefined && t.kind !== kind)) continue;
        rows.push({
          kind: t.kind, id: t.txId, createdAtMs: t.createdAtMs, status: t.status, amountCents: t.amountCents,
          direction: null, payoutCents: null, pnlCents: null, multiplier: null, result: null,
          settledAtMs: null, gameDayId: null, phone: t.phone, mpesaReceipt: t.mpesaReceipt,
          _ts: t.createdAtMs, _id: t.txId,
        });
      }
    }
    if ((kind === undefined || kind === "bet") && this.bets) {
      for (const b of this.bets.adminBetsOf(userId)) {
        rows.push({
          kind: "bet", id: b.id, createdAtMs: b.openedAtMs, status: b.status, amountCents: b.stakeCents,
          direction: b.direction, payoutCents: b.payoutCents, pnlCents: b.pnlCents, multiplier: b.multiplier,
          result: b.result, settledAtMs: b.settledAtMs, gameDayId: b.gameDayId, phone: null, mpesaReceipt: null,
          _ts: b.openedAtMs, _id: b.id,
        });
      }
    }
    return memKeyset(rows, q);
  }

  async setUserStatus(actorId: string, actorRole: string, targetId: string, status: string, reason: string | null): Promise<SetUserStatusResult> {
    if (!ADMIN_ROLES.includes(actorRole)) throw new Error("NOT_AUTHORIZED");
    if (!VALID_STATUS.includes(status)) throw new Error("INVALID_STATUS");
    if (actorId === targetId) throw new Error("NO_SELF_ACTION");
    const u = this.identity.adminUser(targetId);
    if (!u) throw new Error("USER_NOT_FOUND");
    if (u.role === "superadmin") throw new Error("SUPERADMIN_PROTECTED");
    if (ADMIN_ROLES.includes(u.role) && actorRole !== "superadmin") throw new Error("INSUFFICIENT_PRIVILEGE");
    const from = u.status;
    this.identity.adminSetStatus(targetId, status);
    this.record(actorId, actorRole, "user.status", "user", targetId, { from, to: status, reason });
    return { userId: targetId, status };
  }

  async setUserRole(actorId: string, actorRole: string, targetId: string, role: string): Promise<SetUserRoleResult> {
    if (actorRole !== "superadmin") throw new Error("NOT_AUTHORIZED");
    if (!VALID_ROLES.includes(role)) throw new Error("INVALID_ROLE");
    if (role === "superadmin") throw new Error("SUPERADMIN_PROTECTED");
    if (actorId === targetId) throw new Error("NO_SELF_ACTION");
    const u = this.identity.adminUser(targetId);
    if (!u) throw new Error("USER_NOT_FOUND");
    if (u.role === "superadmin") throw new Error("SUPERADMIN_PROTECTED");
    const from = u.role;
    this.identity.adminSetRole(targetId, role);
    this.record(actorId, actorRole, "user.role", "user", targetId, { from, to: role });
    return { userId: targetId, role };
  }

  async setCommissionRate(actorId: string, actorRole: string, targetId: string, rate: number): Promise<SetCommissionRateResult> {
    if (!ADMIN_ROLES.includes(actorRole)) throw new Error("NOT_AUTHORIZED");
    if (rate < 0 || rate > 1) throw new Error("INVALID_RATE");
    const a = this.identity.adminAffiliate(targetId);
    if (!a) throw new Error("NOT_AFFILIATE");
    const from = a.commissionRate;
    this.identity.adminSetCommissionRate(targetId, rate);
    this.record(actorId, actorRole, "affiliate.rate", "affiliate", targetId, { from, to: rate });
    return { userId: targetId, commissionRate: rate };
  }

  async listWithdrawals(q: AdminWithdrawalListQuery): Promise<Page<AdminWithdrawalRow>> {
    const rows = this.payments.adminTransactions()
      .filter((t) => t.kind === "withdrawal" && (q.status === undefined || t.status === q.status) && siteMatches(t.siteId, q.siteId))
      .map((t) => ({ txId: t.txId, userId: t.userId, username: this.identity.adminUser(t.userId)?.username ?? "", amountCents: t.amountCents, status: t.status, phone: t.phone, createdAtMs: t.createdAtMs, _ts: t.createdAtMs, _id: t.txId }));
    return memKeyset(rows, q);
  }

  async listTransactions(q: AdminTransactionListQuery): Promise<Page<AdminTransactionRow>> {
    const needle = q.q?.toLowerCase();
    const rows = this.payments.adminTransactions()
      .filter((t) =>
        (q.kind === undefined || t.kind === q.kind) &&
        (q.status === undefined || t.status === q.status) &&
        siteMatches(t.siteId, q.siteId) &&
        (needle === undefined ||
          (this.identity.adminUser(t.userId)?.username ?? "").toLowerCase().includes(needle) ||
          t.phone.includes(needle) ||
          (t.mpesaReceipt ?? "").toLowerCase().includes(needle)))
      .map((t) => ({
        txId: t.txId, userId: t.userId, username: this.identity.adminUser(t.userId)?.username ?? "",
        kind: t.kind, amountCents: t.amountCents, status: t.status, provider: null, phone: t.phone,
        mpesaReceipt: t.mpesaReceipt, checkoutRequestId: t.checkoutRequestId, resultDesc: null,
        createdAtMs: t.createdAtMs, updatedAtMs: null, _ts: t.createdAtMs, _id: t.txId,
      }));
    return memKeyset(rows, q);
  }

  async listAudit(q: PageQuery, _siteId?: string): Promise<Page<AdminAuditRow>> {
    const rows = this.audit.map((a) => ({
      id: String(a.id), actorId: a.actorId, actorRole: a.actorRole, action: a.action,
      targetType: a.targetType, targetId: a.targetId, detail: a.detail, createdAtMs: a.createdAtMs,
      _ts: a.createdAtMs, _id: String(a.id).padStart(12, "0"),
    }));
    return memKeyset(rows, q);
  }

  async adjustBalance(actorId: string, actorRole: string, targetId: string, amountCents: Cents, reason: string): Promise<AdjustBalanceResult> {
    if (!ADMIN_ROLES.includes(actorRole)) throw new Error("NOT_AUTHORIZED");
    if (!Number.isInteger(amountCents) || amountCents === 0) throw new Error("INVALID_AMOUNT");
    if (!reason || reason.trim() === "") throw new Error("REASON_REQUIRED");
    const tgt = this.identity.adminUser(targetId);
    if (!tgt) throw new Error("USER_NOT_FOUND");
    if (tgt.role === "superadmin") throw new Error("SUPERADMIN_PROTECTED");
    const before = await this.payments.getBalance(targetId);
    if (before + amountCents < 0) throw new Error("INSUFFICIENT_FUNDS");
    const after = this.payments.adminApplyAdjustment(targetId, amountCents);
    this.record(actorId, actorRole, "balance.adjust", "user", targetId, { amount: amountCents, reason, before, after });
    return { userId: targetId, amountCents, newBalanceCents: after, direction: amountCents > 0 ? "credit" : "debit" };
  }

  async resetBalanceToLastFunded(actorId: string, actorRole: string, targetId: string, reason: string): Promise<ResetBalanceResult> {
    if (!ADMIN_ROLES.includes(actorRole)) throw new Error("NOT_AUTHORIZED");
    if (!reason || reason.trim() === "") throw new Error("REASON_REQUIRED");
    const tgt = this.identity.adminUser(targetId);
    if (!tgt) throw new Error("USER_NOT_FOUND");
    if (tgt.role === "superadmin") throw new Error("SUPERADMIN_PROTECTED");
    const lastFunded = this.payments.adminTransactions()
      .filter((t) => t.userId === targetId && t.kind === "deposit" && t.status === "success")
      .sort((a, b) => (b.createdAtMs - a.createdAtMs) || (a.txId < b.txId ? 1 : -1))[0];
    if (!lastFunded) throw new Error("NO_FUNDING");
    const before = await this.payments.getBalance(targetId);
    const after = this.payments.adminApplyAdjustment(targetId, lastFunded.amountCents - before);
    this.record(actorId, actorRole, "balance.reset_last_funded", "user", targetId, { reason, before, after, lastFunded: lastFunded.amountCents });
    return { userId: targetId, lastFundedCents: lastFunded.amountCents, previousBalanceCents: before, newBalanceCents: after };
  }

  async adjustBalanceKind(actorId: string, actorRole: string, targetId: string, amountCents: Cents, kind: BalanceKind, reason: string): Promise<AdjustBalanceKindResult> {
    if (!ADMIN_ROLES.includes(actorRole)) throw new Error("NOT_AUTHORIZED");
    if (!Number.isInteger(amountCents) || amountCents === 0) throw new Error("INVALID_AMOUNT");
    if (kind !== "real" && kind !== "bonus") throw new Error("INVALID_KIND");
    if (!reason || reason.trim() === "") throw new Error("REASON_REQUIRED");
    const tgt = this.identity.adminUser(targetId);
    if (!tgt) throw new Error("USER_NOT_FOUND");
    if (tgt.role === "superadmin") throw new Error("SUPERADMIN_PROTECTED");
    let after: number;
    if (kind === "real") {
      const before = await this.payments.getBalance(targetId);
      if (before + amountCents < 0) throw new Error("INSUFFICIENT_FUNDS");
      after = this.payments.adminApplyAdjustment(targetId, amountCents);
    } else {
      const before = this.bonusBal.get(targetId) ?? 0;
      if (before + amountCents < 0) throw new Error("INSUFFICIENT_FUNDS");
      after = before + amountCents;
      this.bonusBal.set(targetId, after);
    }
    this.record(actorId, actorRole, "balance.adjust", "user", targetId, { kind, amount: amountCents, reason, after });
    return { userId: targetId, kind, amountCents, newBalanceCents: after, direction: amountCents > 0 ? "credit" : "debit" };
  }

  async clearBalance(actorId: string, actorRole: string, targetId: string, kind: "real" | "bonus" | "both", reason: string): Promise<ClearBalanceResult> {
    if (!ADMIN_ROLES.includes(actorRole)) throw new Error("NOT_AUTHORIZED");
    if (kind !== "real" && kind !== "bonus" && kind !== "both") throw new Error("INVALID_KIND");
    if (!reason || reason.trim() === "") throw new Error("REASON_REQUIRED");
    const tgt = this.identity.adminUser(targetId);
    if (!tgt) throw new Error("USER_NOT_FOUND");
    if (tgt.role === "superadmin") throw new Error("SUPERADMIN_PROTECTED");
    if (kind === "real" || kind === "both") {
      const real = await this.payments.getBalance(targetId);
      if (real !== 0) this.payments.adminApplyAdjustment(targetId, -real);
    }
    if (kind === "bonus" || kind === "both") this.bonusBal.set(targetId, 0);
    this.record(actorId, actorRole, "balance.clear", "user", targetId, { kind, reason });
    return { userId: targetId, realBalanceCents: await this.payments.getBalance(targetId), bonusBalanceCents: this.bonusBal.get(targetId) ?? 0 };
  }

  async getUserOverrides(userId: string): Promise<UserOverrideRow | null> {
    return this.overrides.get(userId) ?? null;
  }

  async setUserOverrides(actorId: string, actorRole: string, targetId: string, patch: UserOverridePatch): Promise<UserOverrideRow> {
    if (!ADMIN_ROLES.includes(actorRole)) throw new Error("NOT_AUTHORIZED");
    const tgt = this.identity.adminUser(targetId);
    if (!tgt) throw new Error("USER_NOT_FOUND");
    const cur: UserOverrideRow = this.overrides.get(targetId) ?? {
      userId: targetId, winRate: null, houseEdge: null, tradeDurationS: null, maxWinMultiplier: null,
      minStakeCents: null, maxStakeCents: null, notes: null, updatedBy: null, updatedAtMs: null,
    };
    const next: UserOverrideRow = { ...cur };
    if ("winRate" in patch) next.winRate = patch.winRate ?? null;
    if ("houseEdge" in patch) next.houseEdge = patch.houseEdge ?? null;
    if ("tradeDurationS" in patch) next.tradeDurationS = patch.tradeDurationS ?? null;
    if ("maxWinMultiplier" in patch) next.maxWinMultiplier = patch.maxWinMultiplier ?? null;
    if ("minStakeCents" in patch) next.minStakeCents = patch.minStakeCents ?? null;
    if ("maxStakeCents" in patch) next.maxStakeCents = patch.maxStakeCents ?? null;
    if ("notes" in patch) next.notes = patch.notes ?? null;
    next.updatedBy = actorId;
    next.updatedAtMs = Date.now();
    this.overrides.set(targetId, next);
    this.record(actorId, actorRole, "user.overrides", "user", targetId, { patch, after: next });
    return next;
  }

  async listDeposits(q: AdminDepositListQuery): Promise<Page<AdminDepositRow>> {
    const rows = this.payments.adminTransactions()
      .filter((t) => t.kind === "deposit" && (q.status === undefined || t.status === q.status) && siteMatches(t.siteId, q.siteId))
      .map((t) => ({ ...memDepositRow(t, this.identity.adminUser(t.userId)?.username ?? ""), _ts: t.createdAtMs, _id: t.txId }));
    return memKeyset(rows, q);
  }

  async depositsReconcile(staleMinutes: number): Promise<AdminDepositsReconcile> {
    const deposits = this.payments.adminTransactions().filter((t) => t.kind === "deposit");
    const buckets = new Map<string, { count: number; amountCents: number }>();
    for (const d of deposits) {
      const b = buckets.get(d.status) ?? { count: 0, amountCents: 0 };
      b.count += 1; b.amountCents += d.amountCents; buckets.set(d.status, b);
    }
    const summary = [...buckets.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([status, v]) => ({ status, count: v.count, amountCents: v.amountCents }));
    const cutoff = Date.now() - Math.max(0, staleMinutes) * 60_000;
    const stale = deposits
      .filter((d) => (d.status === "pending" || d.status === "processing") && d.createdAtMs < cutoff)
      .sort((a, b) => (b.createdAtMs - a.createdAtMs) || (a.txId < b.txId ? 1 : a.txId > b.txId ? -1 : 0))
      .slice(0, 100)
      .map((d) => memDepositRow(d, this.identity.adminUser(d.userId)?.username ?? ""));
    return { summary, staleMinutes, stale };
  }

  async reportDaily(range: ReportRange): Promise<DailyReportRow[]> {
    const acc = new Map<string, { dep: number; wd: number; turn: number; ggr: number }>();
    const bucket = (d: string) => {
      let b = acc.get(d);
      if (!b) { b = { dep: 0, wd: 0, turn: 0, ggr: 0 }; acc.set(d, b); }
      return b;
    };
    for (const t of this.payments.adminTransactions()) {
      if (t.status !== "success") continue;
      const d = dayOfMs(t.createdAtMs);
      if (!inRange(d, range)) continue;
      const b = bucket(d);
      if (t.kind === "deposit") b.dep += t.amountCents; else b.wd += t.amountCents;
    }
    for (const p of this.identity.adminReportPlays()) {
      if (!inRange(p.period, range)) continue;
      const b = bucket(p.period);
      b.turn += p.stakeCents; b.ggr += p.stakeCents - p.payoutCents;
    }
    return [...acc.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, v]) => ({ date, depositsCents: v.dep, withdrawalsCents: v.wd, turnoverCents: v.turn, ggrCents: v.ggr }));
  }

  async reportByUser(range: ReportRange): Promise<UserReportRow[]> {
    const acc = new Map<string, { dep: number; wd: number; turn: number; ggr: number }>();
    const bucket = (id: string) => {
      let b = acc.get(id);
      if (!b) { b = { dep: 0, wd: 0, turn: 0, ggr: 0 }; acc.set(id, b); }
      return b;
    };
    for (const t of this.payments.adminTransactions()) {
      if (t.status !== "success") continue;
      if (!inRange(dayOfMs(t.createdAtMs), range)) continue;
      const b = bucket(t.userId);
      if (t.kind === "deposit") b.dep += t.amountCents; else b.wd += t.amountCents;
    }
    for (const p of this.identity.adminReportPlays()) {
      if (!inRange(p.period, range)) continue;
      const b = bucket(p.userId);
      b.turn += p.stakeCents; b.ggr += p.stakeCents - p.payoutCents;
    }
    return [...acc.entries()]
      .map(([userId, v]) => ({
        userId, username: this.identity.adminUser(userId)?.username ?? userId,
        depositsCents: v.dep, withdrawalsCents: v.wd, turnoverCents: v.turn, ggrCents: v.ggr,
      }))
      .sort((a, b) => (b.ggrCents - a.ggrCents) || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  async reportDay(date: string): Promise<AdminDayReport> {
    const range: ReportRange = { from: date, to: date };
    let dep = { count: 0, amountCents: 0 }, wd = { count: 0, amountCents: 0 }, pend = { count: 0, amountCents: 0 };
    const depositors = new Set<string>();
    for (const t of this.payments.adminTransactions()) {
      if (!inRange(dayOfMs(t.createdAtMs), range)) continue;
      if (t.kind === "deposit" && t.status === "success") { dep.count++; dep.amountCents += t.amountCents; depositors.add(t.userId); }
      else if (t.kind === "withdrawal" && t.status === "success") { wd.count++; wd.amountCents += t.amountCents; }
      else if (t.kind === "withdrawal" && (t.status === "pending" || t.status === "processing")) { pend.count++; pend.amountCents += t.amountCents; }
    }
    let settled = 0, winners = 0, turnover = 0, payout = 0;
    const active = new Set<string>();
    for (const p of this.identity.adminReportPlays()) {
      if (!inRange(p.period, range)) continue;
      settled++; turnover += p.stakeCents; payout += p.payoutCents;
      if (p.payoutCents > p.stakeCents) winners++;
      active.add(p.userId);
    }
    return {
      date,
      newRegistrants: 0, newMarketers: 0,
      activePlayers: active.size, depositors: depositors.size, firstTimeDepositors: 0,
      deposits: dep, withdrawals: wd, pendingWithdrawals: pend,
      settledPositions: settled, winningPositions: winners,
      turnoverCents: turnover, payoutCents: payout, ggrCents: turnover - payout,
      commissionAccruedCents: 0, poolBudgetCents: 0, poolPaidCents: 0,
    };
  }

  // ── J5: game config + RTP monitor + seed rotation (mirrors the 0023 RPC guards) ───────────────

  /** Get-or-seed the per-site config mirror (default site seeded from DEFAULT_CONFIG). */
  private siteConfig(siteId: string): GameConfigRow {
    let c = this.gameConfigBySite.get(siteId);
    if (!c) { c = defaultGameConfigRow(); this.gameConfigBySite.set(siteId, c); }
    return c;
  }

  async getGameConfig(siteId: string = ADMIN_DEFAULT_SITE): Promise<GameConfigRow> { return { ...this.siteConfig(siteId) }; }

  async updateGameConfig(actorId: string, actorRole: string, patch: GameConfigPatch, siteId: string = ADMIN_DEFAULT_SITE): Promise<GameConfigRow> {
    if (actorRole !== "superadmin" && actorRole !== "platform_superadmin") throw new Error("INSUFFICIENT_PRIVILEGE");
    const current = this.siteConfig(siteId);
    const before = { ...current };
    const next: GameConfigRow = { ...current };
    if (patch.houseEdge !== undefined) next.houseEdge = patch.houseEdge;
    if (patch.maxMultiplier !== undefined) next.maxMultiplier = patch.maxMultiplier;
    if (patch.minStakeCents !== undefined) next.minStakeCents = patch.minStakeCents;
    if (patch.maxStakeCents !== undefined) next.maxStakeCents = patch.maxStakeCents;
    if (patch.minWithdrawalCents !== undefined) next.minWithdrawalCents = patch.minWithdrawalCents;
    if (patch.defaultDurationS !== undefined) next.defaultDurationS = patch.defaultDurationS;
    if (patch.tickRateMs !== undefined) next.tickRateMs = patch.tickRateMs;
    if (patch.driftBias !== undefined) next.driftBias = patch.driftBias;
    if (patch.volatility !== undefined) next.volatility = patch.volatility;
    if (patch.targetWinRate !== undefined) next.targetWinRate = patch.targetWinRate;
    next.rtpTarget = 1 - next.houseEdge;
    next.requiredMeanWinMultiplier = next.targetWinRate > 0 ? next.rtpTarget / next.targetWinRate : Number.POSITIVE_INFINITY;
    validateGameConfig(next);
    next.version = before.version + 1;
    next.updatedBy = actorId;
    next.updatedAtMs = Date.now();
    this.gameConfigBySite.set(siteId, next);
    this.record(actorId, actorRole, "game.config", "site_game_config", siteId, { before, after: next, patch });
    return { ...next };
  }

  async getWithdrawalPool(siteId: string, tradeDay: string): Promise<WithdrawalPoolRow> {
    const def = this.poolDefaults.get(siteId) ?? 0;
    const existing = this.pools.get(`${siteId}:${tradeDay}`);
    if (existing) return { ...existing, defaultDailyPoolCents: def };
    // auto-seed today's row from the brand default (mirrors fn_pool_ensure_day)
    return { siteId, tradeDay, amountCents: def, paidCents: 0, reservedCents: 0, availableCents: def, setBy: null, updatedAtMs: Date.now(), defaultDailyPoolCents: def };
  }

  async setWithdrawalPool(actorId: string, actorRole: string, siteId: string, tradeDay: string, amountCents: Cents): Promise<WithdrawalPoolRow> {
    if (actorRole !== "superadmin" && actorRole !== "platform_superadmin") throw new Error("NOT_AUTHORIZED");
    if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error("INVALID_AMOUNT");
    const cur = await this.getWithdrawalPool(siteId, tradeDay);
    if (amountCents < cur.paidCents + cur.reservedCents) throw new Error("AMOUNT_BELOW_COMMITTED");
    const row: WithdrawalPoolRow = {
      ...cur, amountCents, availableCents: amountCents - cur.paidCents - cur.reservedCents,
      setBy: actorId, updatedAtMs: Date.now(),
    };
    this.pools.set(`${siteId}:${tradeDay}`, row);
    this.record(actorId, actorRole, "pool.set", "withdrawal_pool", `${siteId}:${tradeDay}`, { after: row });
    return { ...row };
  }

  async setDefaultPool(actorId: string, actorRole: string, siteId: string, tradeDay: string, amountCents: Cents): Promise<WithdrawalPoolRow> {
    if (actorRole !== "superadmin" && actorRole !== "platform_superadmin") throw new Error("NOT_AUTHORIZED");
    if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error("INVALID_AMOUNT");
    this.poolDefaults.set(siteId, amountCents);
    this.record(actorId, actorRole, "pool.default.set", "site", siteId, { defaultDailyPoolCents: amountCents });
    return this.getWithdrawalPool(siteId, tradeDay);
  }

  async getMpesaConfig(): Promise<MpesaConfigRow> { return maskMpesaInternal(this.mpesa); }

  async updateMpesaConfig(actorId: string, actorRole: string, patch: MpesaConfigPatch): Promise<MpesaConfigRow> {
    if (actorRole !== "superadmin") throw new Error("NOT_AUTHORIZED");
    if (patch.environment !== undefined && patch.environment !== "sandbox" && patch.environment !== "production") {
      throw new Error("INVALID_CONFIG");
    }
    const before = maskMpesaInternal(this.mpesa);
    const m: MpesaInternal = { ...this.mpesa };
    if (patch.environment !== undefined) m.environment = patch.environment;
    if (patch.shortcode !== undefined) m.shortcode = patch.shortcode;
    if (patch.stkCallbackUrl !== undefined) m.stkCallbackUrl = patch.stkCallbackUrl;
    if (patch.b2cInitiator !== undefined) m.b2cInitiator = patch.b2cInitiator;
    if (patch.b2cResultUrl !== undefined) m.b2cResultUrl = patch.b2cResultUrl;
    if (patch.b2cTimeoutUrl !== undefined) m.b2cTimeoutUrl = patch.b2cTimeoutUrl;
    if (patch.consumerKey) m.consumerKey = patch.consumerKey;
    if (patch.consumerSecret) m.consumerSecret = patch.consumerSecret;
    if (patch.passkey) m.passkey = patch.passkey;
    if (patch.securityCredential) m.b2cSecurityCredential = patch.securityCredential;
    m.updatedBy = actorId; m.updatedAtMs = Date.now();
    this.mpesa = m;
    const after = maskMpesaInternal(m);
    this.record(actorId, actorRole, "mpesa.config", "mpesa_config", "1", { before, after });
    return after;
  }

  async rtpMonitor(): Promise<RtpMonitor> {
    const plays = this.identity.adminReportPlays();
    const agg = (days: number | null): { n: number; t: number; p: number } => {
      const lo = days == null ? null : utcDayKeyAgo(days - 1);
      let n = 0, t = 0, p = 0;
      for (const pl of plays) {
        if (lo != null && pl.period < lo) continue;
        n += 1; t += pl.stakeCents; p += pl.payoutCents;
      }
      return { n, t, p };
    };
    const windows = RTP_WINDOWS.map(({ window, days }) => { const a = agg(days); return rtpWindowRow(window, a.n, a.t, a.p); });
    return buildRtpMonitor(1 - this.siteConfig(ADMIN_DEFAULT_SITE).houseEdge, windows);
  }

  async listSeeds(limit: number): Promise<AdminSeedRow[]> {
    return [...this.seedRows.values()]
      .sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : a.tradeDate > b.tradeDate ? -1 : 0))
      .slice(0, clampLimit(limit));
  }

  async rotateSeed(actorId: string, actorRole: string, tradeDate: string): Promise<SeedRotateResult> {
    if (actorRole !== "superadmin") throw new Error("INSUFFICIENT_PRIVILEGE");
    if (!DATE_KEY_RE.test(tradeDate)) throw new Error("INVALID_DATE");
    if (tradeDate < new Date().toISOString().slice(0, 10)) throw new Error("PAST_DATE");
    const existing = this.seedRows.get(tradeDate);
    if (existing?.revealed) throw new Error("SEED_REVEALED");
    const seedVersion = (existing?.seedVersion ?? 0) + 1;
    this.seedRows.set(tradeDate, { gameDayId: existing?.gameDayId ?? null, tradeDate, serverSeedHash: null, seedVersion, revealed: false, revealedAtMs: null });
    this.record(actorId, actorRole, "game.seed_rotate", "game_day", tradeDate, { version: seedVersion });
    return { tradeDate, seedVersion };
  }

  // ── J6: affiliate payout queue + chat moderation ─────────────────────────────────────────────

  async listAffiliatePayouts(q: AdminPayoutListQuery): Promise<Page<AdminPayoutRow>> {
    const rows = this.identity.adminListPayouts(q.status).map((p) => ({
      payoutId: p.payoutId, affiliateId: p.affiliateId, username: p.username, phone: p.phone,
      amountCents: p.amountCents, status: p.status, approvedBy: p.approvedBy, createdAtMs: p.createdAtMs,
      _ts: p.createdAtMs, _id: p.payoutId,
    }));
    return memKeyset(rows, q);
  }

  async listChat(limit: number, includeHidden: boolean): Promise<AdminChatModRow[]> {
    const rows = await this.engagement.adminListChat(limit, includeHidden);
    return rows.map((r) => ({ id: r.id, userId: r.userId, username: r.username, message: r.message, isHidden: r.isHidden, createdAtMs: r.createdAtMs }));
  }

  async hideChat(actorId: string, actorRole: string, id: number): Promise<boolean> {
    const ok = await this.engagement.hideChat(id);
    if (ok) this.record(actorId, actorRole, "chat.hide", "chat", String(id), {});
    return ok;
  }

  async unhideChat(actorId: string, actorRole: string, id: number): Promise<boolean> {
    const ok = await this.engagement.unhideChat(id);
    if (ok) this.record(actorId, actorRole, "chat.unhide", "chat", String(id), {});
    return ok;
  }

  async recordAction(actorId: string, actorRole: string, action: string, targetType: string, targetId: string | null, detail: unknown): Promise<void> {
    this.record(actorId, actorRole, action, targetType, targetId, detail);
  }

  private record(actorId: string, actorRole: string, action: string, targetType: string, targetId: string | null, detail: unknown): void {
    this.audit.push({ id: ++this.seq, actorId, actorRole, action, targetType, targetId, detail, createdAtMs: Date.now() });
  }
}
