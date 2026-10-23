/**
 * autoscale.ts — the waves chart's vertical scale.
 *
 * The curve is `tanh(s × volatility + driftBias × driftScale)` (packages/shared/src/curve.ts), and
 * `volatility` is a PER-BRAND config knob. So with a fixed axis, how much of the canvas the wave
 * occupies is a per-brand accident: on the default brand it sat around ±0.2–0.4 against a fixed
 * ±0.9 — under half the height, and on a phone the movement was genuinely hard to read.
 *
 * The amplitude is NOT the renderer's to change. `volatility` feeds the SettlementEngine's tau/gain
 * calibration, which is what makes win-rate == targetWinRate and RTP == 1 − houseEdge hold; turning
 * it up to liven the chart would move the economics. So the axis is fitted to the price instead of
 * the price being fitted to the axis.
 *
 * Pure and side-effect free, so the rules below are testable without a canvas.
 */

/** The window's peak reaches this fraction of the half-height. */
export const Y_FILL = 0.88;
/** Floor: a dead-calm window must not magnify tick noise into drama. */
export const Y_SPAN_MIN = 0.12;
/** Ceiling: the previous fixed scale, so a high-volatility brand renders exactly as it did. */
export const Y_SPAN_MAX = 0.9;
/**
 * Asymmetric easing, and the asymmetry is the point: GROW fast so a spike is never clipped while
 * the scale catches up, SHRINK slowly so the chart does not visibly breathe between peaks. Applied
 * per frame, so roughly 0.1 s out and ~1 s back at 60 fps.
 */
export const Y_EASE_UP = 0.25;
export const Y_EASE_DOWN = 0.03;

/** The span that would put `peakAbs` at `Y_FILL` of the half-height, bounded. */
export function targetSpan(peakAbs: number): number {
  if (!Number.isFinite(peakAbs) || peakAbs <= 0) return Y_SPAN_MIN;
  return Math.min(Y_SPAN_MAX, Math.max(Y_SPAN_MIN, peakAbs / Y_FILL));
}

/** One frame of easing from `current` toward `target`. */
export function easeSpan(current: number, target: number): number {
  if (!Number.isFinite(current) || current <= 0) return target;
  return current + (target - current) * (target > current ? Y_EASE_UP : Y_EASE_DOWN);
}

/** A round grid step for `span`, aiming at ~4 lines per side. */
export function axisStep(span: number): number {
  const raw = span / 4;
  for (const s of [0.02, 0.05, 0.1, 0.2, 0.25, 0.5]) if (raw <= s) return s;
  return 0.5;
}

/** Calibration ticks strictly inside ±span, zero always included, ascending. */
export function axisTicks(span: number): number[] {
  const step = axisStep(span);
  const out: number[] = [0];
  for (let v = step; v < span; v += step) { out.push(v); out.push(-v); }
  return out.sort((a, b) => a - b);
}

/** Decimals the labels need at this span (a finer grid needs a second one). */
export function axisDecimals(span: number): number {
  return axisStep(span) < 0.1 ? 2 : 1;
}
