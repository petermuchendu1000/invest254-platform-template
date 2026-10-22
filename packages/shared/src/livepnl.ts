/**
 * The live profit path of an open contract, driven by the PRICE rather than by a timer.
 *
 * ── What this replaces, and why it was wrong ─────────────────────────────────────────────────────
 *
 * The floating P/L used to be a pure function of elapsed time and the seed. A winner rose along
 * `1 + (M-1)*smoothstep(g)`, monotonically, whatever the price did; a loser decayed to zero the same
 * way; and a pool-decided contract followed a seeded reversing feint with an invented dip. The
 * direction of the trade was not an input to any of them, so a buy and a sell opened in the same
 * second drew the same shape.
 *
 * On a trading terminal that is simply wrong: a buy whose price is falling must show a falling
 * profit. This makes the price the input it always should have been.
 *
 * ── The one thing that cannot change ─────────────────────────────────────────────────────────────
 *
 * The outcome is committed when the contract opens: on the statistical path from the move the curve
 * will have made by expiry, and on the pool path by the controller against the day's budget. The
 * live path must therefore LAND on that committed multiplier exactly at `g = 1`, or the number the
 * player watched would disagree with the number they are paid.
 *
 * So the price drives the path, and a weight that is zero until `CONVERGE_FROM` and one at expiry
 * carries it onto the endpoint over the final stretch. On a statistical WINNER the two already
 * agree at `g = 1` — the endpoint IS `1 + gain * move` at expiry — so the blend changes nothing and
 * the line tracks the price the whole way. It is only a loser (which pays zero, not a small
 * multiplier) and a pool-decided contract (whose endpoint the price does not determine) that
 * visibly converge.
 *
 * ── And the invariant that protects the house edge ───────────────────────────────────────────────
 *
 * Manual close locks whatever the live value is, and the settlement engine's guarantee is that
 * early closing "can only REDUCE player payout (house edge >= target)". A price spike part way
 * through a winning contract would otherwise show, and pay, more than the contract settles at. So a
 * caller that permits early close passes `cap` as the committed multiplier: the path still falls
 * freely with the price, and simply cannot rise above where it is going to end.
 *
 * A caller that refuses early close (every pool brand does) passes no cap, and the path is free to
 * run above its endpoint and come back — which is the reversing feint the old seeded path faked,
 * except that this one is the price actually moving.
 */

/**
 * Where the pull to the committed endpoint begins, as a fraction of the contract's life.
 *
 * Three quarters of the ride is the price and the last quarter blends. Long enough that the
 * convergence is smooth rather than a jump at the close, short enough that most of the contract
 * reads as the instrument it is drawn on.
 */
export const CONVERGE_FROM = 0.75;

export interface LivePathInput {
  /**
   * The favourable move so far: `dir * (value(entryT + g*T) - value(entryT))`, in curve units.
   * Positive means the price has moved the way this contract wants.
   */
  move: number;
  /** The settlement engine's calibrated `gain` for this direction, which turns a move into a multiplier. */
  gain: number;
  /** The multiplier this contract is committed to settle at. */
  endpoint: number;
  /** Round progress, clamped to [0, 1] internally. */
  g: number;
  /** The brand's ceiling, which the displayed value may never exceed. */
  maxMultiplier: number;
  /**
   * The highest value this path may show, for a contract that CAN be closed early. Omit where early
   * close is refused. See the house-edge note above.
   */
  cap?: number | undefined;
}

/** `6x^5 - 15x^4 + 10x^3`: the same C2 smoothstep the settlement engine uses, so the two agree. */
const smootherstep = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export function livePriceMultiplier(
  { move, gain, endpoint, g, maxMultiplier, cap }: LivePathInput,
): number {
  const x = Math.min(1, Math.max(0, g));
  // What the price says this contract is worth right now, on the settlement engine's own scale.
  // Floored at zero: a contract cannot be worth less than nothing, and a multiplier below zero
  // would read as the player owing more than the stake.
  let raw = Math.max(0, 1 + gain * move);
  raw = Math.min(raw, maxMultiplier);
  if (cap !== undefined) raw = Math.min(raw, cap);

  // Zero until the convergence window, one at expiry.
  const w = smootherstep((x - CONVERGE_FROM) / (1 - CONVERGE_FROM));
  return raw * (1 - w) + endpoint * w;
}
