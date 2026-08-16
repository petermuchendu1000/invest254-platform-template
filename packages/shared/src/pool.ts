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
}
export const DEFAULT_POOL_KNOBS: PoolKnobs = {
  p0: 0.15, gain: 6, pFloor: 0.01, pCap: 0.5, meanMultiplier: 1.9, maxMultiplier: 5,
};

export interface PoolDecision {
  result: "win" | "loss";
  multiplier: number;    // (1, cap] on win; 0 on loss
  payoutCents: number;   // round(stake*mult) on win (<= available), else 0
  winProbUsed: number;   // the pacing win-probability used (audit)
  reason: "granted" | "budget_exhausted" | "propensity_loss" | "budget_clamped_to_loss";
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
 * Decide a pool-eligible trade. Deterministic in (serverSeed, nonce). A win requires the propensity
 * draw to clear the pacing probability AND the drawn payout to fit the remaining budget; a payout
 * that would breach the budget is shrunk to fit, and if that leaves no real profit it becomes a loss.
 * The budget cap is ABSOLUTE: payoutCents <= available(pool) always.
 */
export function decidePoolOutcome(args: {
  stakeCents: number; pool: PoolState; dayFraction: number; knobs?: PoolKnobs;
  serverSeed: string; nonce: number;
}): PoolDecision {
  const k = args.knobs ?? DEFAULT_POOL_KNOBS;
  const avail = available(args.pool);
  const p = winProbability(args.pool, args.dayFraction, k);
  const rng = new SeededRng(args.serverSeed, `pool:${args.nonce}`);
  const roll = rng.next();                             // consume 1st: propensity
  const draw = winMultiplier(rng, k.meanMultiplier, k.maxMultiplier); // consume 2nd: amount (always drawn -> stable stream)
  if (avail <= 0) return { result: "loss", multiplier: 0, payoutCents: 0, winProbUsed: p, reason: "budget_exhausted" };
  if (roll >= p)  return { result: "loss", multiplier: 0, payoutCents: 0, winProbUsed: p, reason: "propensity_loss" };
  let mult = draw;
  let payout = Math.round(args.stakeCents * mult);
  if (payout > avail) {                                // clamp the win to the remaining budget
    payout = avail;
    mult = payout / args.stakeCents;
    if (!(mult > 1)) return { result: "loss", multiplier: 0, payoutCents: 0, winProbUsed: p, reason: "budget_clamped_to_loss" };
  }
  return { result: "win", multiplier: mult, payoutCents: payout, winProbUsed: p, reason: "granted" };
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
