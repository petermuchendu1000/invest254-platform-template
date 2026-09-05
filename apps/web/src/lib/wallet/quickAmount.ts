import { displayToKesCents, kesCentsToDisplay, type Cents } from '@invest254/shared/money';

/**
 * Context needed to translate an authoritative KES-cents target into the amount input's ENTRY unit.
 * KES brands enter whole shillings; foreign (display-currency) brands enter up to 2 decimal places.
 */
export interface QuickAmountCtx {
  /** True for a non-KES display brand (entry unit is the display currency). */
  isForeign: boolean;
  /** Display-currency units per 1 KES. Only consulted when `isForeign` is true. */
  fxRateFromKes: number;
}

/**
 * Largest amount — expressed in the withdraw form's ENTRY unit — whose authoritative KES-cents value
 * does NOT exceed `targetCents`. Returns a string ready to drop straight into the amount input, or
 * '' when the target floors to nothing.
 *
 * Powers the Binance-style 25% / 50% / 75% / MAX quick-select chips. The result is always floored
 * (never rounded up), so re-parsing the returned string back to KES cents is guaranteed to be
 * `<= targetCents`. That round-trip safety is essential: a chip must never push the amount above the
 * wallet balance and trip an "exceeds balance" error.
 *
 * - KES brands: whole shillings (the input only accepts integers), e.g. 47718.
 * - Foreign brands: up to 2dp of the display currency, stepped down until the KES round-trip fits.
 */
export function quickAmountEntry(targetCents: Cents, ctx: QuickAmountCtx): string {
  if (!Number.isFinite(targetCents) || targetCents <= 0) return '';

  if (!ctx.isForeign) {
    const wholeKes = Math.floor(targetCents / 100);
    return wholeKes > 0 ? String(wholeKes) : '';
  }

  const rate = ctx.fxRateFromKes;
  // Floor to 2dp of the display currency, then step down 1 cent at a time until the value converts
  // back to <= targetCents. The loop only ever runs a couple of iterations (rounding slack) and is
  // bounded by v > 0, so it always terminates.
  let v = Math.floor(kesCentsToDisplay(targetCents, rate) * 100) / 100;
  while (v > 0 && displayToKesCents(v, rate) > targetCents) {
    v = Math.round((v - 0.01) * 100) / 100;
  }
  return v > 0 ? String(v) : '';
}
