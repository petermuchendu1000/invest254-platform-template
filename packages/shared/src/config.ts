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
  defaultDurationS: { min: 1, max: 3600 },
  driftBias: { min: -1, max: 1 },
} as const;

export const DEFAULT_CONFIG: GameConfig = {
  houseEdge: 0.75,
  maxMultiplier: 5.0,
  minStakeCents: 25000,
  maxStakeCents: 5_000_000,
  minWithdrawalCents: 25000,
  defaultDurationS: 10,
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

/** DEFAULT_CONFIG at the reserved "no database" version. */
export const DEFAULT_VERSIONED_CONFIG: VersionedGameConfig = { ...DEFAULT_CONFIG, version: 0 };

export function rtp(cfg: GameConfig): number {
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
