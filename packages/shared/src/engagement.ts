import { SeededRng } from "./prng.js";
import type { Cents } from "./money.js";

/**
 * Engagement shaping — legitimate, RTP-preserving player-psychology helpers.
 *
 * These functions shape HOW outcomes are presented and distributed, never WHETHER
 * the player wins or how much the house keeps:
 *
 *  - Variable-ratio reinforcement: winning multipliers are drawn from a spread
 *    distribution (many small wins, occasional larger ones) whose MEAN is pinned
 *    to the calibrated value, so RTP is exactly preserved while win sizes stay
 *    unpredictable.
 *  - Near-miss: a loss whose signed move came within a small band of the win
 *    threshold is flagged so the UI can render "so close!" — the outcome is
 *    unchanged, only the presentation.
 *  - Loss disguised as win (LDW): a win whose payout is below the stake (e.g.
 *    multiplier 1.05x) is flagged so the UI can celebrate it like a win while
 *    still showing the net result honestly.
 *
 * Everything here is deterministic given (serverSeed, position nonce) so the
 * presentation is reproducible and auditable — same provable-fairness discipline
 * as the curve itself.
 */

/** Shape of the win-size spread: fraction of wins pushed to each end of the band. */
export interface WinSpread {
  /** Share of winning positions that land in the "small win" band. Default 0.7. */
  smallShare: number;
  /** Small-win band as a fraction of the calibrated mean multiplier. Default [0.55, 0.95]. */
  smallBand: [number, number];
}

export const DEFAULT_WIN_SPREAD: WinSpread = { smallShare: 0.7, smallBand: [0.55, 0.95] };

/**
 * Mean of the truncated-exponential density f(x) ∝ e^(-β x) on [a, b].
 * Monotonically DECREASING in β (β→+∞ ⇒ mean→a, β→-∞ ⇒ mean→b, β=0 ⇒ mean=(a+b)/2).
 * Closed form: E[X] = a + 1/β − L/(e^(βL) − 1), with L = b − a.
 */
function truncExpMean(beta: number, a: number, b: number): number {
  const L = b - a;
  if (Math.abs(beta * L) < 1e-9) return (a + b) / 2; // β→0 limit: uniform
  return a + 1 / beta - L / Math.expm1(beta * L);
}

/**
 * Solve for β so the truncated-exponential on [a, b] has mean `mu` (bisection on the
 * monotone `truncExpMean`). `mu` MUST lie in (a, b); callers guard the degenerate ends.
 */
export function solveTruncExpBeta(mu: number, a: number, b: number): number {
  const L = b - a;
  const mid = (a + b) / 2;
  if (Math.abs(mu - mid) < 1e-9 * L) return 0; // exact midpoint ⇒ uniform
  // β·L is kept within ±700 to avoid overflow; that range already pins the mean to a/b.
  let lo = -700 / L, hi = 700 / L; // truncExpMean(lo) ≈ b (max), truncExpMean(hi) ≈ a (min)
  for (let i = 0; i < 200; i++) {
    const mid2 = (lo + hi) / 2;
    // mean is DECREASING in β: if the mean here is still above target, push β up.
    if (truncExpMean(mid2, a, b) > mu) lo = mid2;
    else hi = mid2;
  }
  return (lo + hi) / 2;
}

/**
 * Inverse-CDF sample from the truncated-exponential on [a, b] for a uniform u ∈ [0,1).
 * G(y) = (1 − e^(−βy)) / (1 − e^(−βL)) on y∈[0,L]; invert to y = −ln(1 − u·(1−e^(−βL)))/β.
 * β = 0 is the uniform limit.
 */
function sampleTruncExp(u: number, beta: number, a: number, b: number): number {
  const L = b - a;
  if (Math.abs(beta * L) < 1e-9) return a + u * L; // uniform
  const c = 1 - Math.exp(-beta * L); // (0,1) for β>0; negative for β<0 — both invert correctly
  const y = -Math.log(1 - u * c) / beta;
  return a + y;
}

/**
 * Maximum-entropy winning multiplier — the optimum payout draw.
 *
 * Given the calibrated mean winning multiplier `meanMult = RTP / winRate` and the payout cap
 * `maxMultiplier`, draw THIS position's multiplier from the MAXIMUM-ENTROPY distribution on
 * [lo, maxMultiplier] whose mean is exactly `meanMult`. Among all distributions on a bounded
 * interval with a fixed mean, the max-entropy one is the truncated exponential f(x) ∝ e^(−βx)
 * (β solved so E[X] = meanMult). Properties, all provable:
 *   • RTP is EXACT:            E[X] = meanMult ⇒ RTP = winRate · meanMult.
 *   • Uses the FULL range:     support is [lo, maxMultiplier]; raising the cap adds a genuine
 *                              heavy tail (rare wins approach the cap) instead of a dead clamp.
 *   • "Most random":           max entropy = least-assuming payout consistent with the mean.
 *   • Deterministic & O(1):    one seeded uniform through a closed-form inverse-CDF.
 * `lo` (default 1.01) keeps a win strictly profitable and matches the legacy floor.
 */
export function winMultiplier(rng: SeededRng, meanMult: number, maxMultiplier: number, lo = 1.01): number {
  const cap = maxMultiplier;
  if (!(cap > lo) || !(meanMult > lo)) return Math.min(Math.max(meanMult, 1), cap); // degenerate: near break-even
  if (meanMult >= cap) return cap; // mean pinned to the cap ⇒ point mass at the cap
  const beta = solveTruncExpBeta(meanMult, lo, cap);
  const x = sampleTruncExp(rng.next(), beta, lo, cap);
  return Math.min(Math.max(x, lo), cap);
}

/**
 * Variable-ratio win sizing (RTP-preserving). Kept for API compatibility — now delegates to the
 * maximum-entropy `winMultiplier`, which subsumes the old two-band mixture: it preserves the
 * calibrated mean, keeps most wins small with a real tail toward the cap, and is deterministic
 * per (serverSeed, nonce). The `spread` argument is accepted but no longer needed.
 */
export function variableRatioMultiplier(
  rng: SeededRng,
  meanMult: number,
  maxMultiplier: number,
  _spread: WinSpread = DEFAULT_WIN_SPREAD,
): number {
  return winMultiplier(rng, meanMult, maxMultiplier);
}

/**
 * Near-miss flag: the position lost, but its signed move came within `bandPct` of the
 * win threshold `tau`. Pure presentation metadata — the loss stands.
 */
export function isNearMiss(signedMove: number, tau: number, bandPct = 0.15): boolean {
  if (signedMove >= tau) return false;                 // that's a win, not a near-miss
  const band = Math.abs(tau) * bandPct;
  return signedMove >= tau - band;
}

/**
 * Loss-disguised-as-win flag: a winning position whose payout is still below the stake
 * (multiplier < 1 is impossible on a win here, so LDW means multiplier in [1, 1.25) —
 * the player "won" but netted less than ~25% profit). The UI celebrates the win while
 * the ledger shows the honest net.
 */
export function isLossDisguisedAsWin(multiplier: number): boolean {
  return multiplier >= 1 && multiplier < 1.25;
}

/** Presentation metadata attached to a settled position for the UI/feed. */
export interface OutcomePresentation {
  nearMiss: boolean;
  lossDisguisedAsWin: boolean;
  /** Headline the feed/toast should show. Always truthful about money. */
  headline: "big_win" | "win" | "small_win" | "near_miss" | "loss";
}

export function presentOutcome(input: {
  result: "win" | "loss";
  multiplier: number;
  signedMove: number;
  tau: number;
}): OutcomePresentation {
  if (input.result === "loss") {
    const nm = isNearMiss(input.signedMove, input.tau);
    return { nearMiss: nm, lossDisguisedAsWin: false, headline: nm ? "near_miss" : "loss" };
  }
  const ldw = isLossDisguisedAsWin(input.multiplier);
  const big = input.multiplier >= 2.5;
  return {
    nearMiss: false,
    lossDisguisedAsWin: ldw,
    headline: big ? "big_win" : ldw ? "small_win" : "win",
  };
}

/** Deterministic per-position RNG for engagement shaping (seed + nonce). */
export function positionRng(serverSeed: string, nonce: number): SeededRng {
  return new SeededRng(serverSeed, `engage:${nonce}`);
}
