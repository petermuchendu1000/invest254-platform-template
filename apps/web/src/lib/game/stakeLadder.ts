/**
 * Stake pills (owner's rule, BUGLOG #87): every pill is a multiple of 5 in the brand currency and
 * follows the admin's minimum — min, ×2, ×4, ×5, ×10, ×20 ($5 → 5 · 10 · 20 · 25 · 50 · 100), never
 * above the maximum. Pure; amounts are display-currency MAJOR units.
 */
export const LADDER_STEPS = [1, 2, 4, 5, 10, 20] as const;

export const ceil5 = (v: number) => Math.max(5, Math.ceil(v / 5 - 1e-9) * 5);
export const floor5 = (v: number) => Math.floor(v / 5 + 1e-9) * 5;
export const isMultipleOf5 = (v: number) => Number.isFinite(v) && v > 0 && Math.abs(v / 5 - Math.round(v / 5)) < 1e-9;

export interface StakeUnits { min: number; max: number | null; ladder: number[] }

/**
 * Resolve the brand's stake range in display units.
 *  - `nativeMin`/`nativeMax`: what the admin set in the brand currency (multiples of 5), if any.
 *  - `minCents`/`maxCents` → `minDisplay`/`maxDisplay`: the enforced KES-cents limits converted at the
 *    live rate. The pill minimum never goes below them (a stale rate or a global override can only
 *    raise it), and the maximum never above them.
 *  - `floor`: a currency floor (USD brands: $5).
 */
export function resolveStakeUnits(a: { nativeMin?: number | null; nativeMax?: number | null; minDisplay: number; maxDisplay?: number | null; floor?: number }): StakeUnits {
  const enforcedMin = ceil5(Math.max(a.minDisplay, a.floor ?? 0));
  const min = Math.max(a.nativeMin && isMultipleOf5(a.nativeMin) ? a.nativeMin : 0, enforcedMin);
  const enforcedMax = a.maxDisplay != null && Number.isFinite(a.maxDisplay) ? floor5(a.maxDisplay) : null;
  const nativeMax = a.nativeMax && isMultipleOf5(a.nativeMax) ? a.nativeMax : null;
  let max = nativeMax != null && enforcedMax != null ? Math.min(nativeMax, enforcedMax) : nativeMax ?? enforcedMax;
  if (max != null && max < min) max = min;
  return { min, max, ladder: stakeLadder(min, max) };
}

export function stakeLadder(min: number, max: number | null): number[] {
  const base = ceil5(min);
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
