import type { Cents, Direction, PositionStatus, PositionResult } from '@invest254/shared';

/** Cursor-paginated list envelope (docs/05 §8). */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AuthResult {
  token: string;
  userId: string;
  role: 'player' | 'marketer' | 'admin' | 'superadmin' | 'platform_superadmin';
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
  real: Cents;
  bonus: Cents;
  currency: string;
  bonuses?: BonusStatusDto[];
}


/** Wire shape of GET /game/config (docs/05 §4). */
export interface GameConfigDto {
  currency: string;
  minStakeCents: Cents;
  maxStakeCents: Cents;
  /** Smallest withdrawal a player can request (admin-editable in game config). */
  minWithdrawalCents: Cents;
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
}

/** Provable-fairness commitment for a game-day (`serverSeed` is null until revealed). */
export interface FairnessDto {
  gameDayId: number;
  tradeDate: string;
  serverSeedHash: string;
  serverSeed: string | null;
  revealedAt: number | null;
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
