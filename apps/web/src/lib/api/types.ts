import type { Cents, Direction, PositionStatus, PositionResult } from '@invest254/shared';

/** Cursor-paginated list envelope (docs/05 §8). */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AuthResult {
  token: string;
  userId: string;
  role: 'player' | 'marketer' | 'admin' | 'platform_admin' | 'platform_superadmin';
  /** The brand (site_id) this token is scoped to, echoed when the account is brand-scoped. */
  site?: string;
  /** Cents credited by the one-time sign-up welcome bonus (0094). Present on register only when > 0. */
  welcomeBonusCents?: number;
}

export interface MeDto {
  userId: string;
  role: AuthResult['role'];
  username: string;
  /** Account M-Pesa number (MSISDN, e.g. 254712345678) — used to prefill deposit/withdraw. */
  phone: string | null;
  /**
   * True when this (privileged) account must still set its security questions before its password
   * reset is protected (0097). The web forces a mandatory, non-dismissible setup gate when true.
   */
  securitySetupRequired?: boolean;
  /**
   * True when this (privileged) account's role REQUIRES TOTP 2FA but it is not yet enabled. The web
   * forces a mandatory, non-dismissible 2FA enrolment gate when true (mirrors securitySetupRequired).
   */
  mfaSetupRequired?: boolean;
  /** docs/42 UI-8: the brand / platform THIS session acts on (from the token), with display names. */
  scope?: {
    site: { id: string; name: string | null } | null;
    platform: { id: string; name: string | null } | null;
  };
}

/** GET /auth/mfa — current 2FA state for the signed-in account. */
export interface MfaStatusDto {
  enabled: boolean;
  recoveryCodesLeft: number;
  /** True when the account's role requires 2FA (admin / platform_admin / platform_superadmin). */
  required: boolean;
}

/** POST /auth/mfa/enroll — returned ONCE; 2FA stays inactive until confirmed with a TOTP code. */
export interface MfaEnrollDto {
  secret: string;
  otpauthUrl: string;
  recoveryCodes: string[];
}

/** One selectable security question (0097): stable key + human label. */
export interface SecurityQuestionDto {
  key: string;
  label: string;
}

/**
 * GET /auth/step-up (0196) — what this session must prove before a critical action, and whether it
 * already has.
 *
 * `factor` is the server's answer and the ONLY one the client may use. Deriving it from the role
 * would put the role-to-factor mapping in two places and let them drift, which is precisely what
 * apps/api/src/stepup.ts warns against. `required: false` (with a null factor) is a non-privileged
 * account, which never meets the gate at all.
 */
export interface StepUpStatusDto {
  required: boolean;
  factor: 'totp' | 'security_questions' | null;
  satisfied: boolean;
  /** How long a proof authorises further critical actions. Absent for a non-privileged account. */
  windowSeconds?: number;
  /**
   * The caller's OWN three question keys, when the required factor is the security questions.
   *
   * Safe to send: the caller has already proven they are this account, so these are their own.
   * It is the anonymous `/auth/password/reset-questions` that must serve decoys, not this. Without
   * it the prompt has to offer all ten and make an operator guess which three they chose — and for
   * the admin tier, whose second factor IS the questions, guessing wrong locks them out of every
   * critical action. Empty array = they never finished setup.
   */
  questionKeys?: string[];
}

/** POST /auth/step-up (0196) — the proof was accepted, and which factor it proved. */
export interface StepUpVerifyDto {
  verified: boolean;
  method: 'totp' | 'recovery_code' | 'security_questions';
  windowSeconds: number;
}

export interface BonusStatusDto {
  bonusId: string;
  amount: Cents;
  wageringX: number;
  wagered: Cents;
  required: Cents;
  remaining: Cents;
  status: string;
  createdAt: string;
}

export interface WalletDto {
  /** Spendable balance in the ACTIVE account (the demo balance while in demo mode). */
  real: Cents;
  /** Spendable bonus (0 in demo mode). */
  bonus: Cents;
  currency: string;
  bonuses?: BonusStatusDto[];
  /** DEMO-1: active account + every bucket (absent on older APIs → treat as real). */
  mode?: 'real' | 'demo';
  modeLocked?: boolean;
  realBalance?: Cents;
  bonusBalance?: Cents;
  demoBalance?: Cents;
  /** 0176: a marketer's separate practice (Demo) bucket, and whether they are currently on it. */
  practiceBalance?: Cents;
  marketerPractice?: boolean;
}


/** Wire shape of GET /game/config (docs/05 §4). */
export interface GameConfigDto {
  currency: string;
  minStakeCents: Cents;
  maxStakeCents: Cents;
  /** Smallest withdrawal a player can request — effective value (global economy over brand config). */
  minWithdrawalCents: Cents;
  /** Currency-native minimum withdrawal in the brand's display currency major units (docs/25 §16),
   *  e.g. 100 => $100. null => use minWithdrawalCents. Foreign brands enforce this exactly. */
  minWithdrawalNative?: number | null;
  /** STAKE-1: the admin's stake limits in the brand currency (multiples of 5); null → derived from cents. */
  minStakeNative?: number | null;
  maxStakeNative?: number | null;
  /** Smallest deposit accepted — effective value (global economy over the static default). */
  minDepositCents: Cents;
  /** Currency-native minimum deposit in the brand's display currency major units, e.g. 1 => $1.
   *  null => use minDepositCents. Foreign brands enforce this exactly (mirrors minWithdrawalNative). */
  minDepositNative?: number | null;
  /** Largest single deposit accepted, or null for no cap (global economy). */
  maxDepositCents: Cents | null;
  maxMultiplier: number;
  defaultDurationS: number;
  tickRateMs: number;
  rtp: number;
  timeframesS: number[];
  /** Live game_config version; changes when an operator saves new limits. */
  configVersion?: number;
}

/** GET /positions item — wire shape from apps/api `positionDto` (newest-first). */
export interface PositionDto {
  id: string;
  gameDayId: number | null;
  direction: Direction;
  stakeCents: Cents;
  entryRate: number;
  exitRate: number | null;
  multiplier: number | null;
  payoutCents: Cents | null;
  pnlCents: Cents | null;
  result: PositionResult | null;
  durationS: number;
  status: PositionStatus;
  openedAt: number; // epoch ms
  settledAt: number | null; // epoch ms, null while open
  /**
   * The chart PRICES the contract opened and closed at, as recorded at execution time.
   *
   * `entryRate`/`exitRate` above are the engine's unitless curve rates. The price axis re-anchors
   * every UTC midnight, so a rate cannot be turned back into the number the player saw — the engine
   * stamps these from the trade's own day (migration 0180). Null means unstamped (a trade older than
   * the column, or a brand that charts a line), and a price slot then reads "at market".
   */
  entryPrice?: number | null;
  exitPrice?: number | null;
  /**
   * The instrument this position was traded on (migration 0182).
   *
   * Optional and nullable so an older engine still typechecks, and null means the brand's own
   * symbol, which is what every row meant before the column existed.
   */
  symbol?: string | null;
  /**
   * MetaTrader's TICKET (migration 0184): the short ascending integer this trade is known by.
   *
   * `id` stays the uuid the API keys on; this is the one the History grids print and a trader
   * quotes. Optional and nullable so an older API still typechecks, and null means a row written
   * before the column, which reads as a dash rather than as eight hex characters pretending to be a
   * ticket.
   */
  ticket?: number | null;
}

/** Provable-fairness commitment for a game-day (`serverSeed` is null until revealed). */
export interface FairnessDto {
  gameDayId: number;
  tradeDate: string;
  serverSeedHash: string;
  serverSeed: string | null;
  revealedAt: number | null;
}

/** GET /digits/history — one persisted digit-contract receipt (docs/34). */
export interface DigitHistoryDto {
  id: string;
  kind: string;            // even|odd|over|under|matches|differs
  target: number | null;   // barrier (over/under) or picked digit (matches/differs)
  instrumentId: string | null;
  openIndex: number | null;
  settleIndex: number | null;
  stakeCents: Cents;
  entryRate: number;
  exitRate: number | null;
  settleDigit: number | null;
  payoutCents: Cents | null;
  pnlCents: Cents | null;
  result: string | null;   // 'win' | 'loss' | null (open)
  status: string;          // 'open' | 'settled'
  openedAt: number;        // epoch ms
  settledAt: number | null;
  /** DEMO-1: staked from the demo (play-money) account. */
  demo?: boolean;
}

/** GET /positions/:id — single position plus its fairness record. */
export interface PositionDetailDto extends PositionDto {
  fairness: FairnessDto | null;
}

/** GET /wallet/ledger item (signed amountCents; newest-first). */
export interface LedgerEntryDto {
  id: number;
  type: string;
  amountCents: Cents;
  balanceKind: string;
  refTable: string | null;
  refId: string | null;
  meta: unknown;
  ts: number;
}

export type TransactionKind = 'deposit' | 'withdrawal';

/** GET /transactions item. */
export interface TransactionDto {
  id: string;
  kind: TransactionKind;
  amountCents: Cents;
  status: string;
  provider: string | null;
  phone: string | null;
  mpesaReceipt: string | null;
  ts: number;
}

export interface DepositResult {
  transactionId: string;
  checkoutRequestId: string;
}

/** Result of a Mega Pay STK deposit (migration 0116). */
export interface MegaPayDepositResult {
  transactionId: string;
  transactionRequestId: string;
  checkoutRequestId: string;
}

/** A deposit gateway effective-enabled for the brand (migration 0116). */
export interface DepositProviderDto {
  code: string;
  displayName: string;
}

/**
 * A deposit CHANNEL the server says this player can actually complete right now. The sheet renders
 * these verbatim — it must never infer tabs from provider codes, because an enabled gateway does not
 * imply every rail is usable (PayHero's Lipwa checkout additionally needs `lipwa_url`, and the manual
 * Pay Bill is hidden for a brand on its own accounts). `label` is consumer-facing; the gateway brand
 * is deliberately never exposed.
 */
export interface DepositMethodDto {
  id: string;
  provider: string;
  channel: 'stk' | 'lipwa' | 'paybill' | 'checkout';
  /** PayX only: the method code to send back on initiate (e.g. 'MPESA', 'CARD'). */
  methodCode?: string;
  /** PayX only: the fields this method needs from the player. Absent/empty => nothing to collect. */
  fields?: Array<{ name: string; type: string; pattern?: string }>;
  label: string;
}

export interface WithdrawalResult {
  transactionId: string;
  newBalance: Cents;
  /** Marketer instant transfer: the amount went straight to the mpesa-app wallet (no approval). */
  paid?: boolean;
  /** New mpesa-app (marketer) wallet balance after an instant transfer. */
  mpesaBalance?: Cents;
}


// ── Affiliate / marketer (M5 backend; engine AffiliateService) ──

/** POST /affiliate/enroll — idempotent marketer enrollment. */
export interface AffiliateEnrollment {
  referralCode: string;
  referralPath: string;
  commissionRate: number;
  status: string;
  role: string;
  /** Fresh JWT reflecting the promoted marketer role (so dashboard routes work without re-login). */
  token?: string;
}

/** GET /affiliate/summary — marketer dashboard aggregates (monetary fields in cents). */
/** GET /marketers/me — the marketer's own profile incl. the SIMULATED (funny-money) wallet balance. */
export interface MarketerProfileDto {
  id: string;
  name: string;
  first_name: string;
  initials: string;
  phone: string;
  status: string;
  balance_cents: number;
  available_fuliza_cents: number;
  airtime_balance_cents: number;
  currency: string;
  site_id: string | null;
  brand_name: string | null;
}

export interface AffiliateSummary {
  referralCode: string;
  referralPath: string;
  commissionRate: number;
  status: string;
  totalReferrals: number;
  activePlayers7d: number;
  activePlayers30d: number;
  turnoverCents: Cents;
  ggrCents: Cents;
  commissionAccruedCents: Cents;
  commissionPaidCents: Cents;
  availableCents: Cents;
  /** Realtime "today" (EAT) figures for the live marketer performance panel. */
  referralsToday: number;
  activePlayersToday: number;
  commissionTodayCents: Cents;
  /** Funnel: referral-link clicks and first-time-depositors (docs/19). */
  clicks: number;
  clicksToday: number;
  ftdCount: number;
}

/** GET /affiliate/referrals item — one referred player. */
export interface ReferralRecord {
  username: string;
  joinedAtMs: number;
  lifetimeGgrCents: Cents;
}

/** GET /affiliate/commissions item — one daily commission bucket. */
export interface CommissionRecord {
  period: string;
  ggrCents: Cents;
  commissionCents: Cents;
  status: string;
  createdAtMs: number;
}

/** POST /affiliate/payouts result — reserved payout amount + id. */
export interface PayoutRequestResult {
  payoutId: string;
  amountCents: Cents;
}

/** One admin-logged marketer expense (transparency, migration 0068). */
export interface MarketerExpenseRow {
  id: string;
  category: string;
  amountCents: Cents;
  note: string | null;
  createdAtMs: number;
  createdBy: string | null;
}
/** GET /affiliate/expenses (and admin variant) — the marketer's expense ledger + total. */
export interface MarketerExpensesResponse {
  items: MarketerExpenseRow[];
  totalCents: Cents;
}

/** Marketer-initiated advance request lifecycle (migration 0122). */
export type AdvanceStatus = 'requested' | 'approved' | 'rejected' | 'cancelled';
export interface MarketerAdvanceDto {
  id: string;
  amountCents: Cents;
  reason: string | null;
  status: AdvanceStatus;
  decisionNote: string | null;
  decidedAtMs: number | null;
  expenseId: string | null;
  createdAtMs: number;
}
/** Admin queue view of an advance request (adds the marketer's identity + brand). */
export interface AdminAdvanceDto extends MarketerAdvanceDto {
  marketerUserId: string;
  username: string | null;
  phone: string | null;
  siteId: string;
}

// ── Ranged marketer money statement — GET /affiliate/money ──────────────────────────────────────
/**
 * The windows the money table's filter selects. `7d`/`30d`/`90d`/`180d` are TRAILING windows of N
 * days ending today (inclusive), matching `periodRange` in lib/history/mt5history.ts — NOT the
 * leaderboard's calendar-to-date `week`/`month`. Server-side the key resolves to inclusive EAT
 * (Africa/Nairobi) `YYYY-MM-DD` bounds; `all` is unbounded on both sides.
 */
export type MarketerMoneyRange = 'today' | 'yesterday' | '7d' | '30d' | '90d' | '180d' | 'all';

/** What happened INSIDE the selected window. Every figure is a server-side SQL aggregate over the
 *  whole range — never a sum of the returned page (BUGLOG #23). */
export interface MarketerMoneyWindowDto {
  earnedCents: Cents;
  earnedCount: number;
  /** Non-marketer commission in the window (a promoted player's instant 5%); funds nothing in the
   *  commission balance, so it is reported apart from `earnedCents`. */
  otherCommissionCents: Cents;
  expensesCents: Cents;
  expensesCount: number;
  /** Advances approved in the window. ALREADY counted inside `expensesCents` (an approved advance is
   *  logged as a category='advance' expense) — never add it to the arithmetic again. */
  advancesApprovedCents: Cents;
  advancesPendingCents: Cents;
  advancesCount: number;
  payoutsPaidCents: Cents;
  payoutsPendingCents: Cents;
}

/** The LIFETIME ladder — the exact terms of fn_commission_balance, unaffected by the range filter.
 *  `availableCents` is `max(earned − expenses − paid − held, 0)` over all time: the hero figure. */
export interface MarketerMoneyLifetimeDto {
  earnedCents: Cents;
  expensesCents: Cents;
  paidCents: Cents;
  heldCents: Cents;
  availableCents: Cents;
}

export interface MarketerMoneyDto {
  /** The resolved window, echoed back so the UI can label which figures are windowed. */
  range: MarketerMoneyRange;
  /** Inclusive EAT calendar bounds; `null` on a side means unbounded (`all`). */
  from: string | null;
  to: string | null;
  limit: number;
  window: MarketerMoneyWindowDto;
  lifetime: MarketerMoneyLifetimeDto;
  /** Display pages, newest first, capped at `limit`. */
  commissions: CommissionLineDto[];
  expenses: MarketerExpenseRow[];
  advances: MarketerAdvanceDto[];
}

/** A sticky notification shown to the player (J7). */
export interface NotificationDto {
  id: number;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  dismissible: boolean;
  category: string | null;
  createdAtMs: number;
}

// ── Deposit-based referral commissions (0078/0079) ──────────────────────────────────────────────
export interface ReferralSummaryDto {
  referralCode: string | null;
  referralPath: string | null;
  isMarketer: boolean;
  totalReferrals: number;
  earnedCents: number;
  /** Marketer commission accrued (role='marketer', status='accrued') — the base that funds
   *  held/paid/available. Use this (not earnedCents) wherever it sits beside Available so the
   *  numbers reconcile even for a player who was later promoted to marketer (BUGLOG #23). */
  marketerEarnedCents: number;
  heldCents: number;
  paidCents: number;
  availableCents: number;
  minPayoutCents: number;
}
export interface CommissionLineDto {
  id: number;
  depositTxId: string;
  referredUser: string;
  referredUsername: string | null;
  position: number;
  role: string;
  rate: number;
  depositAmountCents: number;
  commissionCents: number;
  status: string;
  createdAtMs: number;
}
export interface CommissionPayoutDto {
  id: string;
  amountCents: number;
  status: string;
  requestedAtMs: number;
  approvedAtMs: number | null;
  paidAtMs: number | null;
  paidRef: string | null;
  note: string | null;
}


/** Non-secret Pay Bill display config for the deposit sheet (migration 0115). */
export interface PaybillInfoDto {
  enabled: boolean;
  shortcode: string;
  accountNumber: string;
  businessName: string;
  instructions: string;
}

/** Result of claiming a Pay Bill M-PESA confirmation code. */
export interface PaybillClaimDto {
  status: 'credited' | 'already_claimed' | 'not_found';
  amountCents: number | null;
  newBalance: number | null;
  txId: string | null;
}

/**
 * One real thing that happened on this brand, for the candlestick screen's feed (docs/54).
 *
 * Deliberately thin: a first name, an amount and a coarse age. No id, no receipt, no wall-clock
 * time — the server will not send them, because this is a public endpoint about real people's money.
 */
export interface BrandActivityDto {
  kind: 'deposit' | 'withdrawal' | 'win';
  name: string;
  amountCents: number;
  agoSeconds: number;
}

/** One trader on the Top tab's board (docs/54). Ranked by net profit, name-masked like the feed. */
export interface LeaderboardRowDto {
  rank: number;
  name: string;
  trades: number;
  profitCents: number;
}

/** One live session and what it earned (docs/55). Earnings are a REPORT over existing attribution. */
export interface LiveSessionDto {
  id: string;
  startedAt: string;
  endsAt: string;
  endedAt: string | null;
  streamUrl: string | null;
  marginMinutes: number;
  live: boolean;
  earnedCents: number;
  deposits: number;
}

/** The brand's live rules, the running session (if any), and recent history. */
export interface MarketerLiveDto {
  settings: {
    enabled: boolean;
    sessionMinutes: number;
    marginMinutes: number;
    extendMinutes: number;
    maxSessionsDaily: number;
  };
  current: LiveSessionDto | null;
  history: LiveSessionDto[];
}

/** One choice on a community poll, with how many PEOPLE picked it (one vote per player). */
export interface CommunityPollOptionDto { id: string; label: string; votes: number }

/** A post in the brand's community channel (docs/56). Admins write; players read and vote. */
export interface CommunityPostDto {
  id: string;
  kind: 'post' | 'poll' | 'live';
  title: string | null;
  body: string;
  streamUrl: string | null;
  pinned: boolean;
  closed: boolean;
  createdAt: string;
  author: string;
  options: CommunityPollOptionDto[];
  /** The option this reader chose, so their own vote is shown back to them. */
  myVote: string | null;
  totalVotes: number;
}
