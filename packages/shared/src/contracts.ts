/**
 * Authoritative settlement + fairness core for the Deriv-style contracts (Phase 2).
 *
 * PURE and deterministic — no DB, no DOM, no I/O — so it is the single source of truth shared by
 * the engine (real-money settlement) and the web (rendering/preview), and is fully unit-testable.
 *
 * Money is integer KES cents everywhere (see money.ts). The engine decides the OUTCOME and PAYOUT
 * here, then records the money atomically via the DB RPCs (mirroring fn_open/settle_position) — the
 * DB never decides outcomes.
 *
 * Fairness: the last digit is the final digit of the AUTHORITATIVE quote (CurveGenerator.rate(t)),
 * which is itself derived deterministically from the daily server seed. So digit outcomes inherit
 * the existing provable-fairness commitment (server_seed_hash) with nothing new to trust.
 */

// ── Digits ──────────────────────────────────────────────────────────────────────────────────────
export type DigitKind = 'even' | 'odd' | 'over' | 'under' | 'matches' | 'differs';

/** Default house payout factor: total return = stake × factor / winProbability (factor<1 ⇒ edge). */
export const DEFAULT_DIGIT_PAYOUT_FACTOR = 0.95;

/**
 * The authoritative last digit of a quote at the instrument's pip precision (Deriv shows e.g.
 * 9357.04 → 4). `pipDecimals` is how many decimals the quote carries (default 2). Guarded so a
 * non-finite quote yields 0 rather than NaN.
 */
export function lastDigit(rate: number, pipDecimals = 2): number {
  if (!Number.isFinite(rate)) return 0;
  const scaled = Math.round(Math.abs(rate) * 10 ** pipDecimals);
  return scaled % 10;
}

/** Theoretical win probability for a digit contract. `barrier` is the 0–9 digit for over/under. */
export function digitWinProbability(kind: DigitKind, barrier = 0): number {
  switch (kind) {
    case 'even':
    case 'odd':
      return 0.5;
    case 'over':
      return (9 - clampDigit(barrier)) / 10;
    case 'under':
      return clampDigit(barrier) / 10;
    case 'matches':
      return 0.1;
    case 'differs':
      return 0.9;
  }
  return 0;
}

/** Did this contract win, given the settled last digit? `target` is the barrier/prediction digit. */
export function evaluateDigit(kind: DigitKind, target: number, digit: number): boolean {
  const t = clampDigit(target);
  switch (kind) {
    case 'even':
      return digit % 2 === 0;
    case 'odd':
      return digit % 2 === 1;
    case 'over':
      return digit > t;
    case 'under':
      return digit < t;
    case 'matches':
      return digit === t;
    case 'differs':
      return digit !== t;
  }
  return false;
}

/**
 * Total amount CREDITED to the player if the digit contract wins (0 on a loss is implied by the
 * caller). return = round(stake × factor / prob). Net profit = return − stake.
 */
export function digitReturnCents(stakeCents: number, kind: DigitKind, barrier = 0, factor = DEFAULT_DIGIT_PAYOUT_FACTOR): number {
  const prob = digitWinProbability(kind, barrier);
  if (prob <= 0) return 0;
  return Math.round((stakeCents * factor) / prob);
}

export interface DigitSettlement {
  won: boolean;
  /** Amount credited back to the wallet: the full return on a win, 0 on a loss. */
  payoutCents: number;
  /** Net P/L vs the stake (+profit or −stake). */
  pnlCents: number;
  digit: number;
}

/** Settle a digit contract against the authoritative last digit. */
export function settleDigit(
  stakeCents: number,
  kind: DigitKind,
  target: number,
  digit: number,
  factor = DEFAULT_DIGIT_PAYOUT_FACTOR,
): DigitSettlement {
  const won = evaluateDigit(kind, target, digit);
  const payoutCents = won ? digitReturnCents(stakeCents, kind, kind === 'over' || kind === 'under' ? target : 0, factor) : 0;
  return { won, payoutCents, pnlCents: won ? payoutCents - stakeCents : -stakeCents, digit };
}

// ── Multipliers ─────────────────────────────────────────────────────────────────────────────────
export type MultDir = 'up' | 'down';
export type MultCloseReason = 'tp' | 'sl' | 'stopout' | 'cancel' | 'manual';

export interface MultiplierState {
  dir: MultDir;
  entry: number;
  multiplier: number;
  stakeCents: number;
  /** Take-profit trigger in cents of P/L (null = none). */
  tpCents: number | null;
  /** Stop-loss trigger as a positive cents loss (null = none). */
  slCents: number | null;
  /** Epoch ms until which deal cancellation is available (null = none). */
  dcUntilMs: number | null;
  /** Non-refundable deal-cancellation fee in cents. */
  dcFeeCents: number;
}

/** Live P/L in cents: ±(price move %) × multiplier × stake, floored at −stake (stop-out cap). */
export function multiplierPnlCents(s: Pick<MultiplierState, 'dir' | 'entry' | 'multiplier' | 'stakeCents'>, cur: number): number {
  if (!Number.isFinite(cur) || !Number.isFinite(s.entry) || s.entry === 0) return 0;
  const movePct = (cur - s.entry) / s.entry;
  const signed = s.dir === 'up' ? movePct : -movePct;
  const raw = Math.round(signed * s.multiplier * s.stakeCents);
  return Math.max(-s.stakeCents, raw);
}

/** Price at which the position stops out (100% loss). */
export function stopoutPrice(dir: MultDir, entry: number, multiplier: number): number {
  return dir === 'up' ? entry * (1 - 1 / multiplier) : entry * (1 + 1 / multiplier);
}

/** Deal-cancellation fee: scales with the window; 0 when off. */
export function dealCancellationFeeCents(stakeCents: number, minutes: number, rate = 0.02): number {
  return minutes <= 0 ? 0 : Math.round(stakeCents * rate * Math.sqrt(minutes));
}

export interface MultiplierEvaluation {
  /** Current (clamped) P/L in cents. */
  pnlCents: number;
  /** True when an automatic close condition is met. */
  close: boolean;
  reason: MultCloseReason | null;
  /** Realised P/L in cents if closing now for `reason`. */
  realizedCents: number;
}

/**
 * Evaluate an open Multiplier against the current price. Applies, in Deriv's order of precedence:
 * stop-out (100% loss) — which, inside an active deal-cancellation window, becomes a CANCEL
 * (stake refunded, only the DC fee lost); then Take Profit; then Stop Loss (ignored while DC is
 * active, per Deriv). Returns the live P/L and whether/why to auto-close.
 */
export function evaluateMultiplier(s: MultiplierState, cur: number, nowMs: number): MultiplierEvaluation {
  const pnl = multiplierPnlCents(s, cur);
  const dcLive = s.dcUntilMs != null && nowMs < s.dcUntilMs;

  if (pnl <= -s.stakeCents) {
    return dcLive
      ? { pnlCents: pnl, close: true, reason: 'cancel', realizedCents: -s.dcFeeCents }
      : { pnlCents: pnl, close: true, reason: 'stopout', realizedCents: -s.stakeCents };
  }
  if (s.tpCents != null && pnl >= s.tpCents) {
    return { pnlCents: pnl, close: true, reason: 'tp', realizedCents: s.tpCents };
  }
  if (!dcLive && s.slCents != null && pnl <= -s.slCents) {
    return { pnlCents: pnl, close: true, reason: 'sl', realizedCents: -s.slCents };
  }
  return { pnlCents: pnl, close: false, reason: null, realizedCents: pnl };
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────
function clampDigit(d: number): number {
  const n = Math.trunc(d);
  return n < 0 ? 0 : n > 9 ? 9 : n;
}
