import { SeededRng } from "./prng.js";
import { winMultiplier } from "./engagement.js";

/**
 * Withdrawal-pool controller — the "managed-book" brain (docs/25).
 *
 * PURE + DETERMINISTIC (given serverSeed + nonce): no I/O, no clock. The engine supplies the live
 * pool state and the elapsed EAT-day fraction; this module decides a pool-eligible trade's outcome
 * subject to (a) a hard daily budget cap and (b) a probabilistic pacing target, and renders the
 * reversing live-P&L path. Determinism makes every outcome reproducible for audit + crash recovery.
 *
 * Chosen strategy (researched vs token-bucket + hourly-carry-forward): probabilistic PROPORTIONAL
 * pacing against a carry-forward cumulative target (amount x elapsed-day-fraction), hard-capped by
 * available budget. Best mix of utilization (~99%), temporal spread, per-player fairness, and — unlike
 * a hard threshold — genuine per-trade randomness ("great uncertainty").
 */

/** Live budget for a brand's EAT day. available = amount - paid - reserved (never < 0). */
export interface PoolState { amountCents: number; paidCents: number; reservedCents: number; }

/** Controller tuning. Defaults from the day-simulation research (docs/25 §6, G). */
export interface PoolKnobs {
  p0: number;             // baseline win propensity when exactly on pace
  gain: number;           // pacing feedback gain on the normalized budget error
  pFloor: number;         // floor win prob (keep uncertainty even when far ahead of pace)
  pCap: number;           // cap win prob (never feel guaranteed even when far behind)
  meanMultiplier: number; // mean winning multiplier for the max-entropy amount draw
  maxMultiplier: number;  // brand cap (from site_game_config); hard ceiling on any single win
  // ── per-player engagement (docs/25): a VARIABLE-RATIO schedule — a ~constant per-trade win prob
  //    whose EV = targetSessionRtp (<1) makes the loss STATISTICAL, not positional, so wins land at
  //    unpredictable trades (no detectable 'win first then always lose' pattern). A gentle anti-churn
  //    nudge on long loss streaks prevents rage-quit without becoming a detectable rule. A per-player
  //    no-scoop share caps any one player's take (financial safety, not a per-trade tell). ──
  targetSessionRtp: number; // EV of a player's returned/staked over a session (<1 -> net loss)
  softLossStreak: number;   // anti-churn engages after this many consecutive losses
  streakNudge: number;      // gentle win-prob lift per loss beyond softLossStreak
  playerShare: number;      // no single player may win more than this fraction of the day's pool
  // ── minimum-withdrawal leverage (docs/25): goal-gradient + near-miss. A win that would put the
  //    balance at/above the withdrawal line is (mostly) capped so the balance lands JUST BELOW it
  //    ("so close"), driving more trades + redeposits; a small let-through crosses (real withdrawals
  //    -> social proof). Only engages near the line, so low-balance players build up normally. ──
  letThroughProb: number;   // chance a threshold-crossing win is allowed through (they can withdraw)
  nearMissLow: number;      // near-miss lands in [low, high] x minWithdrawal (fraction just below 1)
  nearMissHigh: number;
}
export const DEFAULT_POOL_KNOBS: PoolKnobs = {
  p0: 0.18, gain: 5, pFloor: 0.05, pCap: 0.6, meanMultiplier: 1.8, maxMultiplier: 5,
  targetSessionRtp: 0.6, softLossStreak: 3, streakNudge: 0.10, playerShare: 0.15,
  letThroughProb: 0.15, nearMissLow: 0.90, nearMissHigh: 0.985,
};

/** A player's running session (per EAT day). The engine keeps this per user; NULL fields default to 0. */
export interface PlayerSession { stakedCents: number; returnedCents: number; trades: number; wins: number; lossStreak: number; }
export const EMPTY_SESSION: PlayerSession = { stakedCents: 0, returnedCents: 0, trades: 0, wins: 0, lossStreak: 0 };

export interface PoolDecision {
  result: "win" | "loss";
  multiplier: number;    // (1, cap] on win; 0 on loss
  payoutCents: number;   // round(stake*mult) on win (<= available), else 0
  winProbUsed: number;   // the pacing win-probability used (audit)
  reason: "granted" | "budget_exhausted" | "propensity_loss" | "budget_clamped_to_loss" | "near_miss";
}

export function available(pool: PoolState): number {
  return Math.max(0, pool.amountCents - pool.paidCents - pool.reservedCents);
}

/** Cumulative payout allowed by `dayFraction` of the EAT day: amount x f (carry-forward pacing). */
export function paceTarget(amountCents: number, dayFraction: number): number {
  return amountCents * Math.min(1, Math.max(0, dayFraction));
}

/** Win probability for THIS trade: baseline nudged by how far paid is behind the pace target. */
export function winProbability(pool: PoolState, dayFraction: number, k: PoolKnobs): number {
  if (pool.amountCents <= 0) return 0;
  const err = (paceTarget(pool.amountCents, dayFraction) - pool.paidCents) / pool.amountCents;
  return Math.min(k.pCap, Math.max(k.pFloor, k.p0 + k.gain * err));
}

/**
 * Per-player VARIABLE-RATIO win probability (docs/25). The core is a ~CONSTANT per-trade win prob
 * whose expected value pins the session return to `targetSessionRtp` (< 1) — so a player's loss is
 * STATISTICAL and their win/loss sequence is UNPREDICTABLE in position (no "win first, then always
 * lose" tell; verified: win-rate is flat across trade index, first-win position is scattered). Only
 * two gentle adjustments, neither a detectable rule:
 *   - ANTI-CHURN: a long loss streak (>= softLossStreak) lifts the prob a little per extra loss, so
 *     nobody rage-quits on an endless run — but it stays probabilistic (never a forced win).
 *   - PACING: scaled by the global budget pace so the day's pool isn't front-loaded (a time/budget
 *     effect shared by everyone, not a per-player pattern).
 * Base = targetSessionRtp / meanMultiplier (e.g. 0.6/1.8 = 0.33). Financial caps (budget + no-scoop)
 * live in decidePoolOutcome.
 */
export function sessionWinProbability(s: PlayerSession, pool: PoolState, dayFraction: number, k: PoolKnobs): number {
  if (pool.amountCents <= 0) return 0;
  let p = k.targetSessionRtp / k.meanMultiplier;                      // variable-ratio base (EV = target RTP)
  if (s.lossStreak >= k.softLossStreak) p += k.streakNudge * (s.lossStreak - k.softLossStreak + 1); // soft anti-churn
  const pace = (paceTarget(pool.amountCents, dayFraction) - pool.paidCents) / pool.amountCents;
  p *= Math.max(0, Math.min(3, 1 + k.gain * pace));                   // global budget pacing (shared by all)
  return Math.min(k.pCap, Math.max(k.pFloor, p));
}

/**
 * Decide a pool-eligible trade. Deterministic in (serverSeed, nonce). A win requires the propensity
 * draw to clear the pacing probability AND the drawn payout to fit the remaining budget; a payout
 * that would breach the budget is shrunk to fit, and if that leaves no real profit it becomes a loss.
 * The budget cap is ABSOLUTE: payoutCents <= available(pool) always.
 */
export function decidePoolOutcome(args: {
  stakeCents: number; pool: PoolState; dayFraction: number; knobs?: PoolKnobs;
  serverSeed: string; nonce: number; session?: PlayerSession;
  /** Player's balance AFTER the stake was debited — used for the min-withdrawal near-miss. */
  balanceAfterStakeCents?: number;
  /** The brand's minimum withdrawal (the psychological finish line). 0/undefined disables the lever. */
  minWithdrawalCents?: number;
}): PoolDecision {
  const k = args.knobs ?? DEFAULT_POOL_KNOBS;
  const s = args.session;
  const avail = available(args.pool);
  const p = s ? sessionWinProbability(s, args.pool, args.dayFraction, k)
              : winProbability(args.pool, args.dayFraction, k);
  const rng = new SeededRng(args.serverSeed, `pool:${args.nonce}`);
  const roll = rng.next();                             // 1st: propensity
  const draw = winMultiplier(rng, k.meanMultiplier, k.maxMultiplier); // 2nd: amount
  if (avail <= 0) return { result: "loss", multiplier: 0, payoutCents: 0, winProbUsed: p, reason: "budget_exhausted" };
  if (roll >= p) return { result: "loss", multiplier: 0, payoutCents: 0, winProbUsed: p, reason: "propensity_loss" };
  let payout = Math.round(args.stakeCents * draw);
  // caps: global remaining budget AND the per-player no-scoop share (fraction of the day's pool).
  const playerCap = s ? Math.max(0, Math.floor(k.playerShare * args.pool.amountCents) - s.returnedCents) : avail;
  payout = Math.min(payout, avail, playerCap);
  // ── Min-withdrawal near-miss (goal-gradient): a win that would reach the withdrawal line is
  //    (mostly) held just below it, so the player lands "so close" and keeps chasing. A small
  //    let-through crosses (real withdrawal -> social proof). Only engages near the line. ──
  let reason: PoolDecision["reason"] = "granted";
  const W = args.minWithdrawalCents ?? 0;
  const bal = args.balanceAfterStakeCents;
  if (W > 0 && bal != null && bal + payout >= W && rng.next() >= k.letThroughProb) {  // 3rd: let-through
    const frac = k.nearMissLow + (k.nearMissHigh - k.nearMissLow) * rng.next();       // 4th: near-miss target
    payout = Math.min(payout, Math.max(0, Math.floor(frac * W) - bal));
    reason = "near_miss";
  }
  if (payout <= args.stakeCents) {                     // no real profit left -> loss (a near-miss loss if capped at the line)
    return { result: "loss", multiplier: 0, payoutCents: 0, winProbUsed: p, reason: reason === "near_miss" ? "near_miss" : "budget_clamped_to_loss" };
  }
  return { result: "win", multiplier: payout / args.stakeCents, payoutCents: payout, winProbUsed: p, reason };
}

/**
 * Live multiplier at trade progress g in [0,1] for a decided outcome, with a deliberate overshoot in
 * the OPPOSITE direction of the result: a decided LOSS shows green (>1) first then collapses to 0; a
 * decided WIN dips red (<1) first then rallies to the final multiplier. C1-smooth (smoothstep within
 * each phase), deterministic (seeded), and NON-monotonic — the "figures change until the end" effect.
 * The endpoint is exactly the decided value, so settlement (which uses the decision) always matches.
 */
export function poolLiveMultiplier(decision: PoolDecision, serverSeed: string, nonce: number, g: number): number {
  const rng = new SeededRng(serverSeed, `poolpath:${nonce}`);
  const overshoot = decision.result === "win" ? 1 - 0.4 * rng.next() : 1 + 0.6 * rng.next();
  const peakAt = 0.30 + 0.35 * rng.next();
  const finalMult = decision.result === "win" ? decision.multiplier : 0;
  const x = Math.min(1, Math.max(0, g));
  const ss = (t: number) => t * t * (3 - 2 * t); // smoothstep
  const v = x < peakAt
    ? 1 + (overshoot - 1) * ss(x / peakAt)
    : overshoot + (finalMult - overshoot) * ss((x - peakAt) / (1 - peakAt));
  return Math.max(0, v);
}

/** Sample the whole path (for previews/tests). path[0] == 1.0 region start; path[steps] == endpoint. */
export function poolPnlPath(decision: PoolDecision, serverSeed: string, nonce: number, steps = 20): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) out.push(Number(poolLiveMultiplier(decision, serverSeed, nonce, i / steps).toFixed(4)));
  return out;
}
