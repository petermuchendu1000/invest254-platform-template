import type { Cents } from "./money.js";

/**
 * Display mapping for the curve: rate = CURVE_BASE_RATE + CURVE_AMPLITUDE * value,
 * with value ∈ (-1, 1). Defined here (a dependency-free module) so the browser can
 * import it to invert rate -> value without pulling in Node-only curve/prng code.
 */
export const CURVE_BASE_RATE = 0.2;
export const CURVE_AMPLITUDE = 0.25;

/** Game configuration, mirroring the public.game_config DB singleton. */
export interface GameConfig {
  houseEdge: number;        // 0.75 -> RTP 0.25
  maxMultiplier: number;    // 5.0
  minStakeCents: Cents;     // 25000 (KES 250)
  maxStakeCents: Cents;     // 5_000_000
  minWithdrawalCents: Cents; // 25000 (KES 250) — smallest cash-out an admin allows
  /**
   * Currency-native minimum withdrawal in the brand's DISPLAY currency major units (docs/25 §16),
   * e.g. 100 => $100 on a USD brand, 2000 => KES 2,000 on a KES brand. Optional: when unset the
   * engine/API use `minWithdrawalCents` (KES cents) verbatim. The API converts this to the effective
   * KES-cents floor at the live FX rate (see `effectiveMinWithdrawalCents`).
   */
  minWithdrawalNative?: number | null;
  /**
   * RESOLVED near-miss withdrawal line in KES cents (docs/25 §16): the currency-native minimum
   * (`minWithdrawalNative`) converted to KES cents at the live FX rate, computed by the engine's
   * config store at load. Drives the pool near-miss lever for ALL game types (rise/fall + digits) so
   * a USD brand's line is $200-in-KES, not the legacy KES value. Absent ⇒ use `minWithdrawalCents`.
   */
  minWithdrawalEffectiveCents?: number;
  /**
   * Currency-native minimum DEPOSIT in the brand's DISPLAY currency major units, e.g. 1 => $1 on a
   * USD brand. Optional: when unset the API/UI use the global KES-cents floor (`MIN_DEPOSIT_CENTS`).
   * Mirrors `minWithdrawalNative`; enforced by converting to KES cents at the live FX rate.
   */
  minDepositNative?: number | null;
  defaultDurationS: number; // 10
  tickRateMs: number;       // 150
  driftBias: number;        // visual green bias (does NOT affect fairness; see settlement)
  volatility: number;       // curve amplitude scaler
  /** Target fraction of positions that win (per direction). Tunes feel; RTP stays fixed. */
  targetWinRate: number;    // 0.125 default
  /**
   * Deriv-style DIGIT contracts use their OWN payout factor — NOT the rise/fall `houseEdge`.
   * Total win return = round(stake × factor / winProbability); factor<1 ⇒ house edge = 1−factor.
   * Optional so pre-existing configs keep working; the engine falls back to
   * DEFAULT_DIGIT_PAYOUT_FACTOR (0.95 ⇒ 5% edge). Deriv's even/odd on-screen figure (95.2% payout)
   * corresponds to factor 0.976 — operators can set that here to mirror it exactly.
   */
  digitPayoutFactor?: number; // 0.95 default (5% edge)
}

/**
 * A GameConfig plus the `game_config_versions.version` it was loaded from.
 *
 * The version is what makes live config safe: a position records the version that priced
 * it, so crash recovery re-derives its outcome against the exact parameters in force when
 * it opened rather than whatever the admin has since saved. Version 0 is reserved for the
 * hardcoded DEFAULT_CONFIG fallback used when no database is attached (local dev).
 */
export interface VersionedGameConfig extends GameConfig {
  version: number;
}

/**
 * Operational bounds mirrored from the game_config CHECK constraints (migration 0028).
 * Kept here so the admin UI can reject a value before the round-trip and so the engine
 * validates a hot-reloaded row with the same rules the database enforced on write.
 */
export const CONFIG_BOUNDS = {
  tickRateMs: { min: 50, max: 60_000 },
  /**
   * The ceiling is the CURVE's, not a preference.
   *
   * `WALK_POINTS = 86_400 + 900 + 2` gives the day's walk exactly 900 seconds of headroom past
   * midnight, "so a round opened near midnight is not flattened by the clamp". A horizon longer
   * than that margin asks for curve values which do not exist for an entry late in the day: the
   * walk clamps, the sampled moves go degenerate, and the calibration silently collapses. Measured
   * at a 3600s horizon: realised win rate 0.00 against a 0.125 target.
   *
   * 3600 was the old bound and was never reachable safely. Capping it at the margin makes the
   * config unable to express a brand the engine cannot price.
   */
  defaultDurationS: { min: 1, max: 900 },
  driftBias: { min: -1, max: 1 },
} as const;

export const DEFAULT_CONFIG: GameConfig = {
  houseEdge: 0.75,
  maxMultiplier: 5.0,
  minStakeCents: 25000,
  maxStakeCents: 5_000_000,
  minWithdrawalCents: 25000,
  /**
   * On a brand with protective levels this is the HORIZON a position is held to when neither its
   * stop, its target nor the trader closes it first. It is no longer the trader's to pick: the
   * Expiry control is gone, because choosing a term alongside a stop is two contradictory ways to
   * end one trade.
   *
   * Fifteen minutes: the longest horizon this curve can price, and so the longest leash a stop can
   * be given. At ten seconds a stop had no room to be reached and the levels were decoration.
   *
   * Two things pin it, and neither is taste:
   *
   *   The CURVE. The day's walk carries exactly 900 seconds of headroom past midnight, so a horizon
   *   beyond that asks for values which do not exist for an entry late in the day. See
   *   CONFIG_BOUNDS.
   *
   *   The CALIBRATION. The break-even cost is solved AT this horizon and scales as its square root,
   *   so a brand holding positions for fifteen minutes while pricing them for ten seconds would
   *   charge a ten-second spread against fifteen-minute moves and hand the trader the house edge.
   *   The horizon a position is valued over and the one it is held to have to be the same number.
   *
   * The economics do not constrain the choice within those bounds: the calibration re-solves for
   * whatever it is given. Measured RTP against a 25% target is 25.14% at 10s, 25.47% at 60s and
   * 25.33% at 300s. An operator who wants shorter contracts lowers it per brand, and in doing so
   * shortens the leash on every stop.
   */
  defaultDurationS: 900,
  tickRateMs: 150,
  driftBias: 0.30,
  volatility: 1.0,
  targetWinRate: 0.125,
  digitPayoutFactor: 0.95,
};

/**
 * Resolve the effective DIGIT payout factor for a config, clamped to a sane, playable band
 * (0.5..0.999) and defaulting to 0.95 when unset/invalid. Kept here so the engine, the shared
 * settlement, and the client-advertised payout figure all agree on one rule.
 */
export function digitPayoutFactor(cfg: Pick<GameConfig, "digitPayoutFactor">): number {
  const f = cfg.digitPayoutFactor;
  if (!Number.isFinite(f as number)) return 0.95;
  return Math.min(0.999, Math.max(0.5, f as number));
}

/**
 * The TERMINAL economy: the edge taken as a spread, the way a broker takes one.
 *
 * ── Why a candlestick brand cannot use the step economy ──────────────────────────────────────────
 *
 * A terminal brand prices a position CONTINUOUSLY, because that is what makes a stop and a target
 * mean anything: the payout is `clamp(1 + gain * (move - cost), 0, maxMultiplier)`, so closing at a
 * level pays what the position is worth AT that level. A line brand keeps the step contract, whose
 * outcome is committed at open and which therefore has nothing for a level to act on.
 *
 * That difference is not cosmetic, and two measured facts decide this config:
 *
 *   1. A position's value AT OPEN can never exceed the RTP. Measured by sweeping the edge from 0.02
 *      to 0.75 and taking the best shape available at each: the ratio of open-value to RTP is 1.00
 *      at every one of them. The reason is that the move distribution is centred on zero, so the
 *      value at open IS the value at the modal point, and a payout that is high there drags the mean
 *      up with it. At a 75% house edge the very best a trader could ever be shown on opening is
 *      0.25x, and the shipped step config showed 0.0167x: a 98% loss the instant they bought, with
 *      50.9% of a position's life pinned at exactly zero.
 *
 *   2. A continuous payout can honour BOTH an RTP and a win rate only when
 *      `maxMultiplier * targetWinRate < RTP`. At a cap of 5 and an RTP of 0.25 that caps the win
 *      rate at 0.05, while the step economy targets 0.125, so the pair is not expressible at all and
 *      the continuous win rate floats free of its target.
 *
 * So the step economy's 75% edge and a tradable terminal are mathematically incompatible, and no
 * shaping of the payout curve escapes it. A broker's edge is the SPREAD, which is exactly what
 * `cost` already is, so a terminal brand takes it there instead.
 *
 * ── Why these two numbers ────────────────────────────────────────────────────────────────────────
 *
 * `houseEdge` 0.10 sets the RTP, and `targetWinRate` is then free and decides the SHAPE. Swept at
 * this edge over six seeds, 2,400 positions each read every 10s across their whole 900s life:
 *
 *   winRate | value at open | life worth zero | ever in profit | in profit at the horizon
 *      0.20 |      0.0000x  |          62.2%  |         58.0%  |                   31.6%
 *      0.40 |      0.6382x  |          21.5%  |         73.9%  |                   40.0%
 *      0.60 |      0.8398x  |           6.5%  |         79.9%  |                   42.3%
 *      0.70 |      0.8801x  |           3.0%  |         80.0%  |                   42.3%
 *
 * 0.70 is where the curve flattens. A position opens at 0.88x, which a trader reads as the spread,
 * and moves with the price from there instead of sitting on the floor.
 *
 * The edge is intact and verified, not assumed: over 24 independent seeds at 50,000 positions each,
 * the realised RTP is 89.942% against the 90.0% target, a drift of -0.058pp with a standard error of
 * 0.051pp (t = -1.14). The house is, if anything, marginally ahead. An earlier sweep appeared to
 * overshoot in every row; that was 2,400 samples over a shared seed family, and it disappears at
 * proper sample sizes. Reproduce with scratchpad/preset.ts and scratchpad/rtpbias.ts.
 *
 * This does NOT reprice any existing brand. Economics are stored per brand in
 * `site_game_config_versions`, and an operator's saved row always wins; this is the default a brand
 * is seeded with and the fallback when no database is attached.
 */
export const TERMINAL_CONFIG: GameConfig = {
  ...DEFAULT_CONFIG,
  houseEdge: 0.10,
  targetWinRate: 0.70,
};

/**
 * The economy a brand should be SEEDED with, by the kind of market it shows.
 *
 * `market` is the candlestick/terminal curve, which settles continuously and therefore needs the
 * spread economy; `wave` is the line brands, which keep the committed step contract and its edge
 * exactly as they are. The profile comes from the brand's chart style, so this is the same rule the
 * engine already uses to decide whether to hand a GameServer a price axis at all.
 */
export function defaultConfigForProfile(profile: "market" | "wave"): GameConfig {
  return profile === "market" ? TERMINAL_CONFIG : DEFAULT_CONFIG;
}

/**
 * The highest value a continuously-priced position can show the moment it opens.
 *
 * It is the RTP, to within the cap's effect. The floor at zero is convex, so by Jensen the mean
 * payout is at least the payout at the mean move, which puts the open value at or below the RTP; the
 * CAP is concave and pulls the other way, so a config whose cap binds often can sit a few percent
 * above it (measured worst case +1.6%, at a 0.5 edge). Exported so an admin surface can
 * tell an operator what a house edge will actually look like on a terminal brand BEFORE they save
 * it, rather than after a trader asks why every position starts at a near-total loss.
 */
export function continuousOpenValueCeiling(cfg: Pick<GameConfig, "houseEdge">): number {
  return rtp(cfg);
}

/**
 * Can a continuous payout honour this config's win rate as well as its RTP?
 *
 * `payout > 1` exactly when `move > cost`, so pinning the win rate fixes `cost` at the
 * (1 - winRate) quantile; the mean then ranges over `(maxMultiplier * winRate, 1)` as the gain goes
 * from infinite to zero. An RTP outside that band cannot be delivered by any linear payout that also
 * honours the win rate, which is why `settle.ts` solves only the mean and lets the continuous win
 * rate fall where it may. Reported rather than thrown: the step economy is legitimately outside this
 * band and is unaffected by it, because a step contract's win rate is pinned by `tau` directly.
 */
export function continuousWinRateExpressible(cfg: Pick<GameConfig, "houseEdge" | "maxMultiplier" | "targetWinRate">): boolean {
  return cfg.maxMultiplier * cfg.targetWinRate < rtp(cfg);
}

/** DEFAULT_CONFIG at the reserved "no database" version. */
export const DEFAULT_VERSIONED_CONFIG: VersionedGameConfig = { ...DEFAULT_CONFIG, version: 0 };

/** TERMINAL_CONFIG at the reserved "no database" version, for a candlestick brand. */
export const TERMINAL_VERSIONED_CONFIG: VersionedGameConfig = { ...TERMINAL_CONFIG, version: 0 };

export function rtp(cfg: Pick<GameConfig, "houseEdge">): number {
  return 1 - cfg.houseEdge;
}

/**
 * The mean multiplier winning positions must pay for the configured RTP to hold at the
 * configured win rate. Must land in (1, maxMultiplier] for the calibrator to solve.
 */
export function requiredMeanWinMultiplier(cfg: GameConfig): number {
  return rtp(cfg) / cfg.targetWinRate;
}

export interface ConfigFeasibility {
  ok: boolean;
  /** RTP / targetWinRate — the payout the calibrator has to hit on winners. */
  requiredMeanWinMultiplier: number;
  /** Human-readable failure reason, or null when the config is solvable. */
  reason: string | null;
}

/**
 * Non-throwing feasibility check. Returned as data (not an exception) so three callers can
 * share one rule: the admin UI previews it live, the API rejects a bad PATCH with a useful
 * message, and the engine refuses to hot-swap into a config it cannot calibrate.
 */
export function checkFeasible(cfg: GameConfig): ConfigFeasibility {
  const required = requiredMeanWinMultiplier(cfg);
  const fail = (reason: string): ConfigFeasibility => ({ ok: false, requiredMeanWinMultiplier: required, reason });

  if (!Number.isFinite(cfg.houseEdge) || cfg.houseEdge < 0 || cfg.houseEdge >= 1) {
    return fail(`houseEdge must be in [0,1): ${cfg.houseEdge}`);
  }
  if (!Number.isFinite(cfg.maxMultiplier) || cfg.maxMultiplier <= 1) {
    return fail(`maxMultiplier must be > 1: ${cfg.maxMultiplier}`);
  }
  if (!Number.isFinite(cfg.targetWinRate) || cfg.targetWinRate <= 0 || cfg.targetWinRate > 1) {
    return fail(`targetWinRate must be in (0,1]: ${cfg.targetWinRate}`);
  }
  if (!Number.isFinite(cfg.volatility) || cfg.volatility <= 0) {
    return fail(`volatility must be > 0: ${cfg.volatility}`);
  }
  if (!Number.isFinite(cfg.driftBias) || cfg.driftBias < CONFIG_BOUNDS.driftBias.min || cfg.driftBias > CONFIG_BOUNDS.driftBias.max) {
    return fail(`driftBias must be in [${CONFIG_BOUNDS.driftBias.min},${CONFIG_BOUNDS.driftBias.max}]: ${cfg.driftBias}`);
  }
  if (!Number.isInteger(cfg.minStakeCents) || cfg.minStakeCents <= 0) {
    return fail(`minStakeCents must be a positive integer: ${cfg.minStakeCents}`);
  }
  if (!Number.isInteger(cfg.maxStakeCents) || cfg.maxStakeCents < cfg.minStakeCents) {
    return fail(`maxStakeCents must be an integer >= minStakeCents: ${cfg.maxStakeCents}`);
  }
  if (!Number.isInteger(cfg.minWithdrawalCents) || cfg.minWithdrawalCents <= 0) {
    return fail(`minWithdrawalCents must be a positive integer: ${cfg.minWithdrawalCents}`);
  }
  if (!Number.isInteger(cfg.defaultDurationS)
    || cfg.defaultDurationS < CONFIG_BOUNDS.defaultDurationS.min
    || cfg.defaultDurationS > CONFIG_BOUNDS.defaultDurationS.max) {
    return fail(`defaultDurationS must be an integer in [${CONFIG_BOUNDS.defaultDurationS.min},${CONFIG_BOUNDS.defaultDurationS.max}]: ${cfg.defaultDurationS}`);
  }
  if (!Number.isInteger(cfg.tickRateMs)
    || cfg.tickRateMs < CONFIG_BOUNDS.tickRateMs.min
    || cfg.tickRateMs > CONFIG_BOUNDS.tickRateMs.max) {
    return fail(`tickRateMs must be an integer in [${CONFIG_BOUNDS.tickRateMs.min},${CONFIG_BOUNDS.tickRateMs.max}]: ${cfg.tickRateMs}`);
  }
  if (required <= 1) {
    return fail(
      `infeasible: RTP ${rtp(cfg).toFixed(4)} at win rate ${cfg.targetWinRate} needs a mean winning ` +
      `multiplier of ${required.toFixed(4)}, which is <= 1 (winners would not profit). Lower targetWinRate below ${rtp(cfg).toFixed(4)}.`,
    );
  }
  if (required > cfg.maxMultiplier) {
    return fail(
      `infeasible: RTP ${rtp(cfg).toFixed(4)} at win rate ${cfg.targetWinRate} needs a mean winning ` +
      `multiplier of ${required.toFixed(4)}, above the ${cfg.maxMultiplier} cap. Raise maxMultiplier to >= ` +
      `${required.toFixed(4)}, raise targetWinRate to >= ${(rtp(cfg) / cfg.maxMultiplier).toFixed(4)}, or raise houseEdge.`,
    );
  }
  return { ok: true, requiredMeanWinMultiplier: required, reason: null };
}

/**
 * Validate that the configured target win-rate can satisfy the RTP given the
 * multiplier cap. Required mean winning multiplier = RTP / winRate; it must lie
 * within (1, maxMultiplier]. Throws if the config is infeasible.
 */
export function assertFeasible(cfg: GameConfig): void {
  const r = checkFeasible(cfg);
  if (!r.ok) throw new Error(r.reason ?? "INVALID_CONFIG");
}
