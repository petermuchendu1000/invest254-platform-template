/**
 * Global economy → per-user override composition (migration 0099).
 *
 * The platform_superadmin global console can ENFORCE a separate game economy for PLAYERS and for
 * MARKETERS on the statistical (pool-OFF) path. Rather than teach the engine a new pricing layer, we
 * compose the enforced cohort economy INTO the same `UserOverride` the GameServer opens with AND the
 * RecoveryService reprices with (both consume `loadOverride`). This gives us, for free:
 *   - open/recovery consistency (identical override → identical reprice),
 *   - reuse of the tested per-user SettlementEngine calibration + infeasible-fallback,
 *   - the correct precedence: GLOBAL WINS — an enforced global field overrides the per-user override,
 *     which in turn overrides site_game_config.
 *
 * Cohort selection uses the canonical marketer predicate (fn_is_marketer_account) so it matches the
 * pool exemption and money routing exactly. The gate's `economy()` is fail-open (empty ⇒ nothing
 * enforced ⇒ the plain per-user override, i.e. today's behaviour).
 *
 * NOTE (documented, same class as the existing per-user-override caveat in overrides.ts): if the
 * operator changes a global economy field while a user holds an open position AND the engine crashes
 * in that window, recovery reprices under the new value. Global config is versioned/audited; the
 * outcome direction is committed at open; this is the accepted trade-off for live, no-redeploy control.
 */
import { enforcedValue, type CohortEconomy, type PlatformEconomy } from "@invest254/shared";
import type { UserOverride } from "./overrides.js";
import type { LoadOverride } from "./game.js";

/** Minimal shape we need from the gate (keeps this unit-testable without a real PlatformGate). */
export interface EconomySource {
  economy(): Promise<PlatformEconomy>;
}

/**
 * Merge an enforced cohort economy over a per-user override (global wins per field). Returns null only
 * when there is neither a user override nor any enforced global field (so non-override users on brands
 * with nothing enforced keep the global settlement — unchanged behaviour + no needless per-user engine).
 */
export function mergeCohortOverride(
  userId: string,
  base: UserOverride | null,
  cohort: CohortEconomy,
): UserOverride | null {
  const gWin = enforcedValue(cohort, "targetWinRate");
  const gEdge = enforcedValue(cohort, "houseEdge");
  const gMax = enforcedValue(cohort, "maxMultiplier");
  const gDur = enforcedValue(cohort, "defaultDurationS");
  const gMinS = enforcedValue(cohort, "minStakeCents");
  const gMaxS = enforcedValue(cohort, "maxStakeCents");
  const anyGlobal = [gWin, gEdge, gMax, gDur, gMinS, gMaxS].some((x) => x !== null);
  if (!base && !anyGlobal) return null;

  return {
    userId,
    // Pricing fields (winRate/houseEdge/maxWinMultiplier) — global enforce wins, else per-user, else null (=site).
    winRate: gWin ?? base?.winRate ?? null,
    houseEdge: gEdge ?? base?.houseEdge ?? null,
    maxWinMultiplier: gMax ?? base?.maxWinMultiplier ?? null,
    // Gate/duration fields — pre-open only, never affect pricing.
    tradeDurationS: gDur ?? base?.tradeDurationS ?? null,
    minStakeCents: gMinS ?? base?.minStakeCents ?? null,
    maxStakeCents: gMaxS ?? base?.maxStakeCents ?? null,
    notes: base?.notes ?? (anyGlobal ? "platform-global economy override (0099)" : null),
    updatedBy: base?.updatedBy ?? null,
    updatedAtMs: base?.updatedAtMs ?? 0,
  };
}

/**
 * Wrap a base per-user override loader so it also applies the enforced platform-global cohort economy.
 * The cohort (player vs marketer) is chosen by `isMarketer`. All three inputs are fail-open: any error
 * degrades to the base override alone, never blocking a trade.
 */
export function composeGlobalOverride(
  baseLoad: (userId: string) => Promise<UserOverride | null>,
  gate: EconomySource,
  isMarketer: (userId: string) => Promise<boolean>,
): LoadOverride {
  return async (userId: string): Promise<UserOverride | null> => {
    const [base, eco, marketer] = await Promise.all([
      baseLoad(userId).catch(() => null),
      gate.economy().catch(() => null),
      isMarketer(userId).catch(() => false),
    ]);
    if (!eco) return base; // gate unavailable ⇒ plain per-user override (unchanged behaviour)
    const cohort: CohortEconomy = marketer ? eco.marketer : eco.player;
    return mergeCohortOverride(userId, base, cohort);
  };
}
