/**
 * autoscale.test.ts — the waves chart's vertical scale.
 *
 * The thing being pinned is a legibility guarantee: whatever a brand's configured `volatility`, the
 * wave has to fill the canvas, because the alternative is what prompted this — a wave sitting at
 * ±0.2–0.4 against a fixed ±0.9 axis, unreadable on a phone. The bounds matter as much as the fit:
 * no magnifying a dead-calm window into fake drama, and no regression for a brand that was already
 * using the full height.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Y_FILL, Y_SPAN_MIN, Y_SPAN_MAX, targetSpan, easeSpan, axisStep, axisTicks, axisDecimals,
} from './autoscale.js';

/** What fraction of the half-height a peak occupies at a given span. */
const fill = (peak: number, span: number) => peak / span;

test('the reported symptom is fixed: a ±0.35 wave fills the canvas instead of a third of it', () => {
  const peak = 0.35;
  assert.ok(fill(peak, Y_SPAN_MAX) < 0.4, 'precondition: on the old fixed ±0.9 it used under 40%');
  assert.ok(fill(peak, targetSpan(peak)) > 0.85, 'now it uses over 85% of the half-height');
});

test('the fill fraction holds across the whole plausible volatility range', () => {
  for (const peak of [0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 0.99]) {
    const span = targetSpan(peak);
    const f = fill(peak, span);
    // Below the floor the wave is deliberately allowed to be small; above the ceiling it clips a
    // touch, exactly as the fixed scale always did.
    if (peak / Y_FILL < Y_SPAN_MIN) { assert.ok(f < Y_FILL, `peak ${peak} is under the floor`); continue; }
    if (peak / Y_FILL > Y_SPAN_MAX) { assert.ok(f >= Y_FILL, `peak ${peak} is over the ceiling`); continue; }
    assert.ok(Math.abs(f - Y_FILL) < 1e-9, `peak ${peak}: fill ${f} should be ${Y_FILL}`);
  }
});

test('a dead-calm window is not magnified into drama', () => {
  // A near-flat market must look near-flat. Without a floor, a peak of 0.001 would be stretched to
  // fill the canvas and every tick of noise would read as a swing.
  assert.equal(targetSpan(0.001), Y_SPAN_MIN);
  assert.equal(targetSpan(0), Y_SPAN_MIN);
  assert.ok(fill(0.001, targetSpan(0.001)) < 0.01, 'still renders as the flat line it is');
});

test('a high-volatility brand renders exactly as it did before (no regression)', () => {
  // tanh bounds the curve at ±1, so the busiest possible brand pins to the old fixed scale.
  assert.equal(targetSpan(1), Y_SPAN_MAX);
  assert.equal(targetSpan(0.95), Y_SPAN_MAX);
  assert.equal(targetSpan(Number.POSITIVE_INFINITY), Y_SPAN_MIN, 'a non-finite peak falls back, never NaNs the axis');
});

test('easing grows fast and shrinks slowly, so a spike never clips and the chart never breathes', () => {
  // Growing: a sudden spike must be accommodated in a few frames.
  let span = Y_SPAN_MIN;
  const up = targetSpan(0.8);
  let frames = 0;
  while (span < up * 0.99 && frames < 600) { span = easeSpan(span, up); frames++; }
  assert.ok(frames <= 20, `grew in ${frames} frames (~${(frames / 60).toFixed(2)}s) — a spike must not sit clipped`);

  // Shrinking: must take meaningfully longer, or the chart visibly pulses between peaks.
  let down = up;
  const lo = targetSpan(0.2);
  let downFrames = 0;
  while (down > lo * 1.01 && downFrames < 6000) { down = easeSpan(down, lo); downFrames++; }
  assert.ok(downFrames > frames * 5, `shrank in ${downFrames} frames, only ${(downFrames / frames).toFixed(1)}x the grow time`);
});

test('easing converges and never overshoots', () => {
  let span = Y_SPAN_MIN;
  const target = targetSpan(0.5);
  for (let i = 0; i < 2000; i++) {
    const next = easeSpan(span, target);
    assert.ok(next <= target + 1e-12, `overshot: ${next} > ${target}`);
    span = next;
  }
  assert.ok(Math.abs(span - target) < 1e-6, 'converges');
});

test('easing recovers from a corrupt starting span rather than propagating it', () => {
  assert.equal(easeSpan(Number.NaN, 0.4), 0.4);
  assert.equal(easeSpan(0, 0.4), 0.4);
  assert.equal(easeSpan(-1, 0.4), 0.4);
});

// ── the grid ────────────────────────────────────────────────────────────────────────────────────

test('ticks stay inside the span, are symmetric, and always include zero', () => {
  for (const span of [0.12, 0.2, 0.35, 0.4, 0.45, 0.6, 0.9]) {
    const ticks = axisTicks(span);
    assert.ok(ticks.includes(0), `span ${span}: zero line is what tells an up minute from a down one`);
    assert.ok(ticks.every((v) => Math.abs(v) < span), `span ${span}: a tick outside the span would draw off-canvas`);
    for (const v of ticks) {
      assert.ok(ticks.some((o) => Math.abs(o + v) < 1e-9), `span ${span}: ${v} has no mirror — the axis must be symmetric`);
    }
    assert.deepEqual([...ticks].sort((a, b) => a - b), ticks, 'ascending');
    assert.ok(ticks.length >= 3 && ticks.length <= 13, `span ${span}: ${ticks.length} lines is not a readable grid`);
  }
});

test('the grid step is a round number a person would choose', () => {
  const ROUND = [0.02, 0.05, 0.1, 0.2, 0.25, 0.5];
  for (let span = 0.1; span <= 1; span += 0.01) {
    assert.ok(ROUND.includes(axisStep(span)), `span ${span.toFixed(2)} gave a non-round step ${axisStep(span)}`);
  }
  assert.equal(axisStep(Y_SPAN_MAX), 0.25, 'the old fixed scale keeps a familiar coarse grid');
});

test('labels carry enough decimals to stay distinct', () => {
  for (const span of [0.12, 0.2, 0.35, 0.5, 0.9]) {
    const dp = axisDecimals(span);
    const labels = axisTicks(span).map((v) => v.toFixed(dp));
    assert.equal(new Set(labels).size, labels.length, `span ${span}: ${labels.join(',')} has duplicates after rounding`);
  }
});
