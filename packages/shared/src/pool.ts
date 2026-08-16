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
  // ── per-player engagement (docs/25): hook early, suppress once up, relieve long loss streaks,
  //    cap wins-per-session so the budget SPREADS, and cap any one player's take (no scoop). ──
  hookTrades: number;     // first N trades of a session get the hook boost
  hookBoost: number;      // added win-prob during the hook (motivational early wins)
  maxWinsSession: number; // a player wins at most this many times per session -> spread + net loss
  upSuppress: number;     // multiply win-prob when the player is net-up (pull them back to a loss)
  maxLossStreak: number;  // anti-churn: after this many losses, relieve with a likely win
  reliefProb: number;     // the relieved win-prob
  playerShare: number;    // no single player may win more than this fraction of the day's pool
}
export const DEFAULT_POOL_KNOBS: PoolKnobs = {
  p0: 0.18, gain: 5, pFloor: 0.01, pCap: 0.8, meanMultiplier: 1.8, maxMultiplier: 5,
  hookTrades: 2, hookBoost: 0.45, maxWinsSession: 2, upSuppress: 0.12,
  maxLossStreak: 4, reliefProb: 0.8, playerShare: 0.15,
};

/** A player's running session (per EAT day). The engine keeps this per user; NULL fields default to 0. */
export interface PlayerSession { stakedCents: number; returnedCents: number; trades: number; wins: number; lossStreak: number; }
export const EMPTY_SESSION: PlayerSession = { stakedCents: 0, returnedCents: 0, trades: 0, wins: 0, lossStreak: 0 };

export interface PoolDecision {
  result: "win" | "loss";
  multiplier: number;    // (1, cap] on win; 0 on loss
  payoutCents: number;   // round(stake*mult) on win (<= available), else 0
  winProbUsed: number;   // the pacing win-probability used (audit)
  reason: "granted" | "budget_exhausted" | "propensity_loss" | "budget_clamped_to_loss" | "session_win_cap";
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
 * Per-player engagement win probability (docs/25). Shapes each player's SESSION so it feels alive
 * yet nets a loss over ~4-5 trades (redeposit pressure), within the global budget pace:
 *   - HOOK: the first `hookTrades` get a boost (motivational early wins).
 *   - SUPPRESS-WHEN-UP: once the player is net-ahead, win-prob is cut hard (pull them back to a loss).
 *   - ANTI-CHURN: a long loss streak (>= maxLossStreak) is relieved with a likely win (unless they've
 *     already had their session wins) so nobody rage-quits on an endless losing run.
 *   - PACING: the whole thing is scaled by the global budget pace so the day's pool isn't front-loaded.
 * (A player who has hit `maxWinsSession` is hard-stopped in decidePoolOutcome so the budget SPREADS.)
 */
export function sessionWinProbability(s: PlayerSession, pool: PoolState, dayFraction: number, k: PoolKnobs): number {
  if (pool.amountCents <= 0) return 0;
  let p = k.p0;
  if (s.trades < k.hookTrades) p += k.hookBoost;
  if (s.returnedCents > s.stakedCents) p *= k.upSuppress;              // net-up -> steer to a loss
  if (s.lossStreak >= k.maxLossStreak && s.wins < k.maxWinsSession) p = Math.max(p, k.reliefProb);
  const pace = (paceTarget(pool.amountCents, dayFraction) - pool.paidCents) / pool.amountCents;
  p *= Math.max(0, Math.min(3, 1 + k.gain * pace));
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
}): PoolDecision {
  const k = args.knobs ?? DEFAULT_POOL_KNOBS;
  const s = args.session;
  const avail = available(args.pool);
  const p = s ? sessionWinProbability(s, args.pool, args.dayFraction, k)
              : winProbability(args.pool, args.dayFraction, k);
  const rng = new SeededRng(args.serverSeed, `pool:${args.nonce}`);
  const roll = rng.next();                             // consume 1st: propensity
  const draw = winMultiplier(rng, k.meanMultiplier, k.maxMultiplier); // consume 2nd: amount (stable stream)
  if (avail <= 0) return { result: "loss", multiplier: 0, payoutCents: 0, winProbUsed: p, reason: "budget_exhausted" };
  // Spread: a player who already had their session wins steps aside so the budget reaches others.
  if (s && s.wins >= k.maxWinsSession) return { result: "loss", multiplier: 0, payoutCents: 0, winProbUsed: p, reason: "session_win_cap" };
  if (roll >= p) return { result: "loss", multiplier: 0, payoutCents: 0, winProbUsed: p, reason: "propensity_loss" };
  let mult = draw;
  let payout = Math.round(args.stakeCents * mult);
  // caps: global remaining budget AND the per-player no-scoop share (fraction of the day's pool).
  const playerCap = s ? Math.max(0, Math.floor(k.playerShare * args.pool.amountCents) - s.returnedCents) : avail;
  payout = Math.min(payout, avail, playerCap);
  if (payout <= args.stakeCents) {                     // clamp left no real profit -> loss
    return { result: "loss", multiplier: 0, payoutCents: 0, winProbUsed: p, reason: "budget_clamped_to_loss" };
  }
  mult = payout / args.stakeCents;
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
