import { CurveGenerator } from "./curve.js";
import { SeededRng } from "./prng.js";
import { type GameConfig, assertFeasible, rtp } from "./config.js";
import { mulCents } from "./money.js";
import { winMultiplier, DEFAULT_WIN_SPREAD, type WinSpread } from "./engagement.js";
import type { Direction, Outcome } from "./types.js";

interface DirParams {
  tau: number;
  gain: number;
  /** The continuous payout's break-even move, solved on the same samples. See `solveCost`. */
  cost: number;
}

/**
 * Entry-time span the calibrator samples over. It MUST cover the curve's slowest timescale, or the
 * sampled move distribution is not representative of the trading day and the realized win-rate/RTP
 * drift off target.
 *
 * This is a full UTC day because the `market` curve profile carries structure all the way out to a
 * ~1-day period. Measured on the day-scale curve with a 1-hour window the error was real — win-rate
 * 0.668 vs 0.650 and RTP 0.977 vs 0.950; with a full-day window, 0.644 / 0.941 (both in tolerance).
 * Widening the window costs nothing: `nSamples` is unchanged, only the range entry times are drawn
 * from. See curve.ts PROFILES.market.
 */
export const CALIBRATION_WINDOW_S = 86_400;

function quantile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) throw new Error("empty");
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))));
  return sortedAsc[idx]!;
}

/**
 * Settlement engine. Outcomes are determined by the shared, seed-derived curve:
 *   signedMove = dir * (value(entry+T) - value(entry))
 *   win  <=> signedMove >= tau_dir       (favourable move clears the threshold)
 *   mult  =  min(1 + gain_dir*signedMove, maxMultiplier)   on win, else loss (payout 0)
 *
 * (tau, gain) are calibrated PER DIRECTION at construction so that the hold-to-expiry
 * RTP equals exactly 1 - houseEdge and the win-rate equals targetWinRate. Calibrating
 * per direction neutralises the curve's visual green bias for fairness.
 *
 * Provable fairness: value() is a pure function of the committed daily server seed, so
 * given the revealed seed + public (entryTime, direction) anyone can recompute the move,
 * the threshold (published) and therefore the exact outcome.
 */
export class SettlementEngine {
  readonly params: Record<Direction, DirParams>;

  constructor(
    private readonly curve: CurveGenerator,
    private readonly cfg: GameConfig,
    private readonly calibrationSeed = "calibration",
    private readonly durationS = cfg.defaultDurationS,
    private readonly sampleWindowS = CALIBRATION_WINDOW_S,
    private readonly nSamples = 200_000,
  ) {
    assertFeasible(cfg);
    this.params = {
      buy: this.calibrate("buy", calibrationSeed, sampleWindowS, nSamples),
      sell: this.calibrate("sell", calibrationSeed, sampleWindowS, nSamples),
    };
  }

  private signedMove(dir: Direction, entryT: number): number {
    return this.moveAt(dir, entryT, this.durationS);
  }

  /**
   * The favourable move this contract has made after `elapsedS` seconds.
   *
   * The same quantity `signedMove` settles on, read at an arbitrary moment rather than only at
   * expiry. It is what lets the floating P/L follow the price instead of a timer: at
   * `elapsedS = durationS` the two are the same number, so the live path and the settlement cannot
   * disagree about where the contract ends up.
   *
   * Public because the game server needs it every tick; the curve it reads is this day's, so a
   * caller holding a position from an earlier day must not use it (see `livePriceMultiplier`).
   */
  moveAt(dir: Direction, entryT: number, elapsedS: number): number {
    const d = dir === "buy" ? 1 : -1;
    return d * (this.curve.value(entryT + elapsedS) - this.curve.value(entryT));
  }

  /** The calibrated move-to-multiplier gain for a direction, which the live path scales with. */
  gainFor(dir: Direction): number { return this.params[dir].gain; }

  private calibrate(dir: Direction, seed: string, windowS: number, n: number): DirParams {
    const rng = new SeededRng(seed, `calib:${dir}`);
    const moves: number[] = new Array(n);
    for (let i = 0; i < n; i++) moves[i] = this.signedMove(dir, rng.range(0, windowS));
    const asc = moves.slice().sort((a, b) => a - b);

    // tau: P(move >= tau) = targetWinRate  ->  tau is the (1 - winRate) quantile
    const tau = quantile(asc, 1 - this.cfg.targetWinRate);
    const winners = moves.filter((m) => m >= tau);
    const targetMeanWinMult = rtp(this.cfg) / this.cfg.targetWinRate;

    // gain: solve mean_winners( min(1 + gain*move, maxMult) ) = targetMeanWinMult  (monotone in gain)
    const meanWinMult = (gain: number): number => {
      let s = 0;
      for (const m of winners) s += Math.min(1 + gain * m, this.cfg.maxMultiplier);
      return s / winners.length;
    };
    let lo = 0, hi = 1;
    while (meanWinMult(hi) < targetMeanWinMult && hi < 1e9) hi *= 2;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (meanWinMult(mid) < targetMeanWinMult) lo = mid; else hi = mid;
    }
    const gain = (lo + hi) / 2;
    return { tau, gain, cost: this.solveCost(moves, gain) };
  }

  /**
   * The continuous payout's cost, solved on the SAME samples the step calibration just drew.
   *
   * Sharing the draw is not only thrift. Calibrating lazily on first use meant 200,000 fresh samples
   * inside the tick loop, which blocked the event loop long enough to stall the websocket tick
   * stream: two multiengine tests went from passing to timing out. One pass, both parameters.
   *
   * Monotone decreasing in cost (a bigger cost lowers every payout), so a bisection is exact.
   */
  private solveCost(moves: readonly number[], gain: number): number {
    const n = moves.length;
    const M = this.cfg.maxMultiplier;
    /**
     * Sort once, prefix-sum once, then every bisection step is two binary searches.
     *
     * The obvious implementation walks all 200,000 samples per step, which at 80 steps is 16M
     * operations per direction. That is paid synchronously at construction, and it cost ~140ms a
     * brand: enough to eat half the 600ms window two multiengine tests give the tick stream, which
     * took them from passing to failing.
     *
     * The structure makes that unnecessary. For a cost `c` the payout is piecewise linear in the
     * move: samples at or below `c - 1/gain` are on the floor and pay 0, samples at or above
     * `c + (M-1)/gain` are on the cap and pay M, and the band between them pays `1 + gain*(m - c)`,
     * whose sum needs only the COUNT and the TOTAL of the moves in that band. Both come straight
     * off a prefix sum, so no sample is ever revisited and the whole solve uses every one of them
     * rather than a subsample.
     */
    const asc = Float64Array.from(moves).sort();
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + asc[i]!;
    /** The first index whose move is >= x, by binary search. */
    const lowerBound = (x: number): number => {
      let lo = 0, hi = n;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (asc[mid]! < x) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const meanPayout = (cost: number): number => {
      const floorAt = lowerBound(cost - 1 / gain);        // below this, the payout is 0
      const capAt = lowerBound(cost + (M - 1) / gain);    // at or above this, the payout is M
      const band = capAt - floorAt;
      const bandSum = prefix[capAt]! - prefix[floorAt]!;
      return (band + gain * (bandSum - band * cost) + (n - capAt) * M) / n;
    };
    // The payout is zero everywhere once the cost exceeds the largest move, so the bracket is
    // finite. `asc[n-1]` is that largest move, already to hand from the sort.
    let lo = 0, hi = 1 / gain + (asc[n - 1] ?? 0) + 1e-9;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (meanPayout(mid) > rtp(this.cfg)) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** Settle a position at expiry (hold-to-expiry / auto-sell). */
  settle(stakeCents: number, dir: Direction, entryT: number): Outcome {
    const p = this.params[dir];
    const move = this.signedMove(dir, entryT);
    const entryRate = this.curve.rate(entryT);
    const exitRate = this.curve.rate(entryT + this.durationS);
    if (move >= p.tau) {
      /**
       * Floored at zero, because money cannot be negative.
       *
       * `tau` is the (1 - targetWinRate) quantile, so a brand with a HIGH target win rate has a
       * NEGATIVE tau and a contract can win on an adverse move. `1 + gain * move` then goes below
       * zero once the move passes `-1 / gain`, and `mulCents` rejects it: "invalid factor:
       * -0.2436...". Reproduced on the live v230 config (edge 0.03, win rate 0.95) at a
       * fifteen-minute horizon, on the 16th trade.
       *
       * It was unreachable rather than impossible before: at a ten-second horizon that config needs
       * a move past -0.009 to break, which the walk does not make in ten seconds, while at fifteen
       * minutes -0.12 is an ordinary tail. The same floor is already applied by
       * `livePriceMultiplier` and assumed by `GameServer.finalize`, which pays nothing below 1x.
       */
      const multiplier = Math.max(0, Math.min(1 + p.gain * move, this.cfg.maxMultiplier));
      const payoutCents = mulCents(stakeCents, multiplier);
      return { result: "win", multiplier, payoutCents, pnlCents: payoutCents - stakeCents, entryRate, exitRate, signedMove: move };
    }
    return { result: "loss", multiplier: 0, payoutCents: 0, pnlCents: -stakeCents, entryRate, exitRate, signedMove: move };
  }

  /**
   * Variable-ratio settle: same win/loss decision and same calibrated mean winning
   * multiplier as settle(), but the individual winning multiplier is drawn from the
   * engagement spread (frequent small wins, rare larger ones) via a per-position
   * seeded RNG. RTP is preserved: the spread distribution's mean equals the
   * calibrated mean by construction. `nonce` makes the draw deterministic and
   * auditable per position.
   */
  settleVariable(stakeCents: number, dir: Direction, entryT: number, nonce: number, serverSeed: string, _spread: WinSpread = DEFAULT_WIN_SPREAD): Outcome {
    const base = this.settle(stakeCents, dir, entryT);
    if (base.result !== "win") return base;
    // Mean winning multiplier is the RTP-pinned target the calibrator solves for:
    //   E[multiplier | win] = rtp / targetWinRate.
    // The previous derivation (1 + gain * meanWinningMove, gated on `tau > 0`) collapsed to
    // 1.0 whenever the win threshold tau was <= 0 — which is the NORMAL case for any
    // targetWinRate >= ~0.5 on a near-symmetric curve (driftBias 0). That made every win pay
    // exactly x1.00 (net zero) and silently degraded RTP down to the win-rate. Pinning the
    // mean to rtp/targetWinRate directly preserves RTP for every feasible config.
    const meanMult = rtp(this.cfg) / this.cfg.targetWinRate;
    const rng = new SeededRng(serverSeed, `engage:${nonce}`);
    // Maximum-entropy draw on (1, maxMultiplier] with mean pinned to meanMult ⇒ RTP exact,
    // full configured range used (rare wins approach the cap), most-random given the mean.
    const multiplier = winMultiplier(rng, meanMult, this.cfg.maxMultiplier);
    const payoutCents = mulCents(stakeCents, multiplier);
    return { ...base, multiplier, payoutCents, pnlCents: payoutCents - stakeCents };
  }

  /**
   * The CONTINUOUS payout's two parameters, per direction.
   *
   * See docs/mt5/20-real-sl-tp.md for the measurements behind this. In short: the step payout above
   * (nothing until `tau`, then a jump straight to 1 + gain*tau = 1.70x) is what makes a real stop
   * impossible. A take profit set below `tau` closes the contract on the zero side of the step and
   * pays the trader NOTHING for being right but modest (measured RTP 0.00%); a target at or above
   * `tau` leaks a third of the house edge (25% RTP becoming 33%). A step payout and a continuous
   * target cannot both be sane.
   *
   * The continuous form is a line through a cost:
   *
   *     payout = clamp(1 + gain * (move - cost), 0, maxMultiplier)
   *
   * `cost` is economically the SPREAD: the move a trader must make to break even, and the whole
   * house edge. `gain` is inherited from the step calibration unchanged, so the payout keeps the
   * spread the operator already tuned, and only the threshold becomes a cost.
   *
   * Measured over 40,000 trades per rule on three seeds: RTP holds at 24.4-25.4% against a 25%
   * target for every sane stopping rule (held to horizon, tight stops, wide stops, target only,
   * stop only), where the step payout leaked to 33%. No stopping rule beats the house.
   */
  /** The continuous parameters, solved in the same pass as tau and gain. */
  continuousParams(dir: Direction): { cost: number; gain: number } {
    const p = this.params[dir];
    return { cost: p.cost, gain: p.gain };
  }

  /**
   * What a contract is worth after `elapsedS` seconds, on the continuous payout.
   *
   * This is BOTH the live value and the settlement: closing at any moment pays what this says,
   * which is the property that makes a stop and a target mean something. There is no committed
   * endpoint to converge to and no cap that depends on a decision already taken, because under this
   * model nothing is decided at open except the cost the trader has to overcome.
   */
  valueAt(dir: Direction, entryT: number, elapsedS: number): number {
    const { cost, gain } = this.continuousParams(dir);
    const move = this.moveAt(dir, entryT, elapsedS);
    return Math.max(0, Math.min(1 + gain * (move - cost), this.cfg.maxMultiplier));
  }

  /**
   * Settle on the continuous payout at an arbitrary holding time.
   *
   * `result` is DERIVED from the payout rather than decided in advance: a contract that returns
   * more than its stake is a win, anything else a loss. That is what lets a stop loss close a
   * position at a partial loss, which the step model had no way to express.
   */
  settleContinuous(stakeCents: number, dir: Direction, entryT: number, elapsedS: number): Outcome {
    const multiplier = this.valueAt(dir, entryT, elapsedS);
    const entryRate = this.curve.rate(entryT);
    const exitRate = this.curve.rate(entryT + elapsedS);
    const payoutCents = mulCents(stakeCents, multiplier);
    return {
      result: payoutCents > stakeCents ? "win" : "loss",
      multiplier, payoutCents, pnlCents: payoutCents - stakeCents,
      entryRate, exitRate, signedMove: this.moveAt(dir, entryT, elapsedS),
    };
  }

  /**
   * Live multiplier for a WINNING position at round progress g in [0,1], rising
   * monotonically to the committed final multiplier via the C2 quintic smoothstep.
   * Manual SELL locks this value; since it is <= final and losses cannot be cashed
   * out early, early-selling can only REDUCE player payout (house edge >= target).
   */
  liveWinMultiplier(finalMultiplier: number, g: number): number {
    const x = Math.min(1, Math.max(0, g));
    const s = x * x * x * (x * (x * 6 - 15) + 10); // 6x^5-15x^4+10x^3
    return 1 + (finalMultiplier - 1) * s;
  }
}
