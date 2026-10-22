/**
 * Stake pills: follow the admin's minimum — min, ×2, ×4, ×5, ×10, ×20 ($1 → 1 · 2 · 4 · 5 · 10 · 20;
 * $5 → 5 · 10 · 20 · 25 · 50 · 100), never above the maximum. Pure; amounts are display-currency MAJOR
 * units. The owner sets the minimum in whole brand-currency units (≥1); it used to be forced to
 * multiples of 5 ≥ 5, now relaxed so a brand can offer e.g. a $1 minimum.
 */
export const LADDER_STEPS = [1, 2, 4, 5, 10, 20] as const;

/** Round a converted (fallback) amount UP to a whole brand-currency unit, never below 1. */
export const ceilUnit = (v: number) => Math.max(1, Math.ceil(v - 1e-9));
export const floorUnit = (v: number) => Math.max(1, Math.floor(v + 1e-9));
// Kept for back-compat with any caller still importing them (now whole-unit, not 5).
export const ceil5 = ceilUnit;
export const floor5 = floorUnit;
export const isMultipleOf5 = (v: number) => Number.isFinite(v) && v > 0 && Math.abs(v / 5 - Math.round(v / 5)) < 1e-9;

export interface StakeUnits {
  min: number;
  max: number | null;
  ladder: number[];
  /**
   * True when the resolved maximum came out BELOW the resolved minimum, which is a brand
   * MISCONFIGURATION or a conversion artefact, never a range. Reported rather than swallowed so a
   * caller can say so and so the condition is greppable from one place.
   */
  inverted: boolean;
}

/**
 * Resolve the brand's stake range in display units.
 *  - `nativeMin`/`nativeMax`: what the admin set in the brand currency (whole units), if any — used
 *    AS-IS (the operator's intent), only floored at `floor`.
 *  - `minDisplay`/`maxDisplay`: the enforced KES-cents limits converted at the live rate. When no
 *    native value is set, the minimum is that converted floor rounded UP to a whole unit; the maximum
 *    rounded DOWN. The minimum never goes below `floor`, the maximum never above the converted max.
 *  - `floor`: the absolute currency floor (USD brands: $1).
 */
export function resolveStakeUnits(a: { nativeMin?: number | null; nativeMax?: number | null; minDisplay: number; maxDisplay?: number | null; floor?: number }): StakeUnits {
  const floor = Math.max(1, a.floor ?? 1);
  // Never below the server-enforced min (a global enforce or stale rate can only RAISE it), rounded
  // up to a whole unit; the native value (operator intent) applies when it is higher.
  const enforcedMin = ceilUnit(Math.max(a.minDisplay, floor));
  const min = Math.max(a.nativeMin && a.nativeMin > 0 ? a.nativeMin : 0, enforcedMin);
  const enforcedMax = a.maxDisplay != null && Number.isFinite(a.maxDisplay) ? floorUnit(a.maxDisplay) : null;
  const nativeMax = a.nativeMax && a.nativeMax > 0 ? a.nativeMax : null;
  const ceiling = nativeMax != null && enforcedMax != null ? Math.min(nativeMax, enforcedMax) : nativeMax ?? enforcedMax;
  /**
   * A ceiling below the floor is NO ceiling, not a one-value range.
   *
   * This used to read `if (max < min) max = min`, which turned a misconfigured or FX-converted
   * inversion into a single tradable amount. Downstream that single amount became
   * `effectiveVolume({min: x, max: x})`, both volume steppers sat on their bound at once, and the
   * ticket printed "min 0.058 / max 0.058" with nothing the trader could move: the reported bug.
   * MetaTrader's Volume control is never dead (`docs/mt5/01-order-and-close-dialogs.md` 1.3: a
   * "numeric spinner"; 2.4: "enter the volume to close in the "Volume" field"), and it takes its
   * limits from the SYMBOL's contract specification, so dropping an impossible brand ceiling lets
   * that specification's own ceiling stand, which is what `effectiveVolume` does with a null max.
   */
  const inverted = ceiling != null && ceiling < min;
  const max = inverted ? null : ceiling;
  return { min, max, ladder: stakeLadder(min, max), inverted };
}

export function stakeLadder(min: number, max: number | null): number[] {
  const base = min > 0 ? min : 1;
  const out: number[] = [];
  for (const k of LADDER_STEPS) {
    const v = base * k;
    if (max != null && v > max) break;
    out.push(v);
  }
  return out.length ? out : [base];
}

/** Compact pill label: 5 · 250 · 1k · 2.5k · 10k. */
export function pillLabel(v: number): string {
  if (v >= 1000) return `${Number((v / 1000).toFixed(2))}k`;
  return String(v);
}
