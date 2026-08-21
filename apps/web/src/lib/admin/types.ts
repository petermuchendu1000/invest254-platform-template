import type { Cents } from '@invest254/shared';

// ── Admin DTOs — mirror apps/engine/src/admin.ts wire shapes ──

export interface AdminOverview {
  users: {
    total: number;
    active: number;
    suspended: number;
    banned: number;
    players: number;
    marketers: number;
    admins: number;
  };
  finance: {
    depositsCents: Cents;
    /** Real cash out (M-Pesa B2C) only — excludes internal marketer transfers. */
    withdrawalsCents: Cents;
    /** Marketer game-winnings moved into the companion marketer wallet (provider='internal'). Not cash out. */
    internalTransfersCents: Cents;
    pendingWithdrawals: number;
    walletLiabilityCents: Cents;
  };
  affiliate: {
    marketers: number;
    commissionAccruedCents: Cents;
    commissionPaidCents: Cents;
    pendingPayouts: number;
  };
  game: { settledPositions: number; turnoverCents: Cents; ggrCents: Cents };
  /** Internal marketer cohort (migration 0033/0036) — isolated from every real figure above. */
  marketer: {
    accounts: number;
    /** Internal funding into marketer player wallets (ledger adjustments) — not real deposits. */
    creditedCents: Cents;
    turnoverCents: Cents;
    ggrCents: Cents;
    walletLiabilityCents: Cents;
  };
}

export interface RtpWindowRow {
  window: string;
  settledPositions: number;
  turnoverCents: Cents;
  payoutCents: Cents;
  realisedRtp: number | null;
}
export interface RtpMonitor {
  targetRtp: number;
  toleranceAbs: number;
  minSamples: number;
  windows: RtpWindowRow[];
  alert: boolean;
}

/** Real-cash RTP (rec #7): committed-money truth; marketer cohort shown separately from real players. */
export interface RealCashSide { turnoverCents: Cents; payoutCents: Cents; ggrCents: Cents; bets: number; rtp: number | null; }
export interface RealCashWindow { window: string; real: RealCashSide; demo: RealCashSide; cash: { depositsCents: Cents; withdrawalsCents: Cents; netCashCents: Cents }; }
export interface RealCashRtp { rtpTarget: number | null; windows: RealCashWindow[]; }

/** One economy-config version in the change-review (diff vs prior + risk flag). */
export interface ConfigChangeRow {
  version: number; createdAtMs: number; houseEdge: number; targetWinRate: number; maxMultiplier: number;
  prevHouseEdge: number | null; prevTargetWinRate: number | null; changedFields: string[]; risk: boolean; riskReason: string;
}

/** Enriched user-list row — wallet, lifetime cash flow, game economics and last activity. */
export interface AdminUserRow {
  userId: string;
  username: string;
  phone: string;
  role: string;
  status: string;
  createdAtMs: number;
  realBalanceCents: Cents;
  bonusBalanceCents: Cents;
  /** Non-withdrawable demo bucket (migration 0084); non-zero only for marketer/demo accounts. */
  demoBalanceCents: Cents;
  /** True when this is a demo/marketer account (plays on demo_balance; excluded from real cash). */
  isMarketer: boolean;
  depositsCents: Cents;
  withdrawalsCents: Cents;
  netDepositsCents: Cents;
  lastFundedCents: Cents | null;
  turnoverCents: Cents;
  ggrCents: Cents;
  betCount: number;
  lastTxAtMs: number | null;
  lastTxKind: string | null;
  lastTxAmountCents: Cents | null;
  lastTxStatus: string | null;
  lastActiveAtMs: number | null;
}
export interface AdminUserDetail extends AdminUserRow {
  referredBy: string | null;
}
export interface SetUserStatusResult {
  userId: string;
  status: string;
}
export interface SetUserRoleResult {
  userId: string;
  role: string;
}
export interface AdjustBalanceResult {
  userId: string;
  amountCents: Cents;
  newBalanceCents: Cents;
  direction: 'credit' | 'debit';
}
export interface ResetBalanceResult {
  userId: string;
  lastFundedCents: Cents;
  previousBalanceCents: Cents;
  newBalanceCents: Cents;
}

/** A single target's outcome in a bulk admin action. */
export interface BulkActionItem {
  userId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
export type BulkAction = 'suspend' | 'ban' | 'reactivate' | 'reset-balance' | 'clear-balance' | 'adjust-balance' | 'notify';
export interface BulkActionResult {
  action: BulkAction;
  total: number;
  okCount: number;
  failCount: number;
  results: BulkActionItem[];
}
export interface BulkActionInput {
  action: BulkAction;
  userIds: string[];
  reason?: string;
  kind?: 'real' | 'bonus' | 'both';
  amountCents?: number;
  direction?: 'credit' | 'debit';
  title?: string;
  body?: string;
  level?: NotificationLevel;
  dismissible?: boolean;
  category?: string | null;
}

export type AdminActivityKind = 'deposit' | 'withdrawal' | 'bet' | 'adjustment';
/** One event in a user's unified activity timeline (mirrors engine AdminUserActivityRow). */
export interface AdminUserActivityRow {
  kind: AdminActivityKind;
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

export interface AdminWithdrawalRow {
  txId: string;
  userId: string;
  username: string;
  phone: string;
  amountCents: Cents;
  status: string;
  provider: string | null;
  mpesaReceipt: string | null;
  createdAtMs: number;
  updatedAtMs: number | null;
  balanceCents: Cents;
  totalDepositsCents: Cents;
  depositCount: number;
  totalWithdrawalsCents: Cents;
  withdrawalCount: number;
  firstDepositAtMs: number | null;
}

export interface AdminDepositRow {
  txId: string;
  userId: string;
  username: string;
  amountCents: Cents;
  status: string;
  phone: string;
  mpesaReceipt: string | null;
  checkoutRequestId: string | null;
  createdAtMs: number;
}

/** Unified deposit/withdrawal row for the Finance transactions explorer. */
export interface AdminTransactionRow {
  txId: string;
  userId: string;
  username: string;
  kind: string;
  amountCents: Cents;
  status: string;
  provider: string | null;
  phone: string;
  mpesaReceipt: string | null;
  checkoutRequestId: string | null;
  resultDesc: string | null;
  createdAtMs: number;
  updatedAtMs: number | null;
}
export interface AdminDepositStatusBucket {
  status: string;
  count: number;
  amountCents: Cents;
}
export interface AdminDepositsReconcile {
  summary: AdminDepositStatusBucket[];
  staleMinutes: number;
  stale: AdminDepositRow[];
}

export interface AdminPayoutRow {
  payoutId: string;
  affiliateId: string;
  username: string;
  phone: string;
  amountCents: Cents;
  status: string;
  approvedBy: string | null;
  createdAtMs: number;
}

/** Deposit-referral commission payout as the admin queue sees it (0079). Separate stream from the
 *  GGR affiliate payouts above. `status`: requested → approved → paid (or rejected). */
export interface AdminCommissionPayoutRow {
  id: string;
  amountCents: Cents;
  status: string;
  requestedAtMs: number;
  approvedAtMs: number | null;
  paidAtMs: number | null;
  paidRef: string | null;
  note: string | null;
  beneficiaryUser: string;
  username: string | null;
  phone: string | null;
  siteId: string;
}


export interface GameConfigRow {
  houseEdge: number;
  maxMultiplier: number;
  minStakeCents: Cents;
  maxStakeCents: Cents;
  minWithdrawalCents: Cents;
  defaultDurationS: number;
  tickRateMs: number;
  driftBias: number;
  volatility: number;
  targetWinRate: number;
  rtpTarget: number;
  /** Live config version; bumps on every save and is stamped on every position opened after. */
  version: number;
  /** RTP / targetWinRate. Must land in (1, maxMultiplier] or the engine cannot calibrate. */
  requiredMeanWinMultiplier: number;
  updatedBy: string | null;
  updatedAtMs: number;
  /** When true, the daily withdrawal pool governs payouts and the win-shaping knobs
   *  (win rate, drift bias, volatility) are display-only — the pool controller decides wins. */
  poolMode: boolean;
}
export interface GameConfigPatch {
  houseEdge?: number;
  maxMultiplier?: number;
  minStakeCents?: number;
  maxStakeCents?: number;
  minWithdrawalCents?: number;
  defaultDurationS?: number;
  tickRateMs?: number;
  driftBias?: number;
  volatility?: number;
  targetWinRate?: number;
  /** docs/25 + 0095: toggle the brand between the pool brain (true, default) and the
   *  statistical brain (false). Superadmin only; applies live with no redeploy. */
  poolMode?: boolean;
}
/** docs/25: a brand's daily withdrawal-pool budget (EAT day). availableCents = amount - paid - reserved. */
export interface WithdrawalPoolRow {
  siteId: string;
  tradeDay: string;
  amountCents: Cents;
  paidCents: Cents;
  reservedCents: Cents;
  availableCents: Cents;
  setBy: string | null;
  updatedAtMs: number;
  /** Recurring per-brand default that auto-seeds each new EAT day (migration 0064). */
  defaultDailyPoolCents: Cents;
}
export interface AdminSeedRow {
  gameDayId: number | null;
  tradeDate: string;
  serverSeedHash: string | null;
  seedVersion: number;
  revealed: boolean;
  revealedAtMs: number | null;
}
export interface SeedRotateResult {
  tradeDate: string;
  seedVersion: number;
}

export interface DailyReportRow {
  date: string;
  depositsCents: Cents;
  withdrawalsCents: Cents;
  turnoverCents: Cents;
  ggrCents: Cents;
}
export interface UserReportRow {
  userId: string;
  username: string;
  depositsCents: Cents;
  withdrawalsCents: Cents;
  turnoverCents: Cents;
  ggrCents: Cents;
}
/** GET /admin/reports/day — comprehensive single-day (EAT) operator stats for the calendar explorer. */
export interface AdminDayReport {
  date: string;
  newRegistrants: number;
  newMarketers: number;
  activePlayers: number;
  depositors: number;
  firstTimeDepositors: number;
  deposits: { count: number; amountCents: Cents };
  withdrawals: { count: number; amountCents: Cents };
  pendingWithdrawals: { count: number; amountCents: Cents };
  settledPositions: number;
  winningPositions: number;
  turnoverCents: Cents;
  payoutCents: Cents;
  ggrCents: Cents;
  commissionAccruedCents: Cents;
  poolBudgetCents: Cents;
  poolPaidCents: Cents;
}

export interface AdminAuditRow {
  id: string;
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: unknown;
  createdAtMs: number;
}

export interface MpesaConfigRow {
  environment: 'sandbox' | 'production';
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
export interface MpesaConfigPatch {
  environment?: 'sandbox' | 'production';
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

// ── User notifications (J7) ──
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';
export interface AdminNotificationRow {
  id: number;
  level: NotificationLevel;
  title: string;
  body: string;
  dismissible: boolean;
  category: string | null;
  createdAtMs: number;
  dismissedAtMs: number | null;
  resolvedAtMs: number | null;
}
export interface NotificationInput {
  title: string;
  body?: string;
  level?: NotificationLevel;
  dismissible?: boolean;
  category?: string | null;
}

// ── Per-user engine overrides (J8) ──
export interface UserOverrideRow {
  userId: string;
  winRate: number | null;
  houseEdge: number | null;
  tradeDurationS: number | null;
  maxWinMultiplier: number | null;
  minStakeCents: Cents | null;
  maxStakeCents: Cents | null;
  notes: string | null;
  updatedBy: string | null;
  updatedAtMs: number | null;
}
export interface UserOverridePatch {
  winRate?: number | null;
  houseEdge?: number | null;
  tradeDurationS?: number | null;
  maxWinMultiplier?: number | null;
  minStakeCents?: Cents | null;
  maxStakeCents?: Cents | null;
  notes?: string | null;
}

// ── Marketers (special players who RECEIVE payments) ──
// Wire shapes mirror apps/api/src/app.marketers.ts (snake_case, as returned by the API).
export interface AdminMarketerRow {
  id: string;
  name: string;
  first_name: string;
  initials: string;
  phone: string;
  status: string;
  balance_cents: Cents;
  available_fuliza_cents: Cents;
  airtime_balance_cents: Cents;
  currency: string;
}
export interface AdminMarketerLedgerRow {
  id: number;
  entry_type: string;
  amount_cents: Cents;
  balance_after_cents: Cents;
  ref: string | null;
  meta: unknown;
  created_at: string;
}
export interface MarketerWithdrawResult {
  idempotent: boolean;
  balance_cents: Cents;
  withdrawal_id?: string;
  ledger_id: number;
}

// ── Generic bulk-action result for the finance/affiliate/marketer bulk endpoints ──────────────
/** One row's outcome in a bulk action (keyed by the item id: txId / payoutId / marketerId). */
export interface AdminBulkResultRow {
  id: string;
  ok: boolean;
  error?: string;
  result?: unknown;
}
/** Aggregate result of a bulk action: total attempted + per-row outcomes (partial success). */
export interface AdminBulkResult {
  action: string;
  total: number;
  okCount: number;
  failCount: number;
  results: AdminBulkResultRow[];
}
