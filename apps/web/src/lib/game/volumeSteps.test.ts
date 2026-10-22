import { test } from 'node:test';
import assert from 'node:assert/strict';
import { volumeSteps, volClampReason } from './volumeSteps.js';

const labels = (v: number, lim = { min: 0.01, max: 100, step: 0.01 }) =>
  volumeSteps(v, lim).map((s) => s.label);

test("reproduces MetaTrader's own Android row at its own volume", () => {
  // `android/en/open_market.png`: -0.5 -0.1 -0.01 [0.61] +0.01 +0.1 +0.5
  assert.deepEqual(labels(0.61), ['−0.5', '−0.1', '−0.01', '+0.01', '+0.1', '+0.5']);
});

test("and the iOS row at the volume iOS shows it at", () => {
  // `iphone/en/open_market.png` shows -5 -1 [7.00] +1 +5. iOS draws five cells where Android draws
  // seven, so the extra pair is the 0.1 one; the magnitudes are what this is pinning.
  assert.deepEqual(labels(7), ['−5', '−1', '−0.1', '+0.1', '+1', '+5']);
});

test('the finest cell is never finer than the instrument’s own volume step', () => {
  // At this brand's 0.025 minimum the raw decade is 0.01, so D/10 would be 0.001 — a tenth of a
  // step, and a volume the engine would refuse. The clamp lifts the row back to MetaTrader's.
  assert.deepEqual(
    labels(0.025, { min: 0.025, max: 1, step: 0.01 }),
    ['−0.5', '−0.1', '−0.01', '+0.01', '+0.1', '+0.5'],
  );
});

test('there are always seven cells, six of them steps, whatever the volume', () => {
  for (const v of [0.01, 0.025, 0.3, 1, 2.5, 40, 900]) {
    assert.equal(volumeSteps(v, { min: 0.01, max: 1000, step: 0.01 }).length, 6, String(v));
  }
});

test('a step that would leave the range is disabled, not dropped', () => {
  // MetaTrader's own behaviour on the Close position screen: "the + steps are greyed out/disabled".
  // A row whose cells appeared and vanished as the volume moved would be a moving target.
  const atMin = volumeSteps(0.025, { min: 0.025, max: 1, step: 0.01 });
  assert.equal(atMin.length, 6);
  assert.deepEqual(atMin.filter((s) => s.delta < 0).map((s) => s.enabled), [false, false, false]);
  assert.deepEqual(atMin.filter((s) => s.delta > 0).map((s) => s.enabled), [true, true, true]);

  // At the ceiling the steps have scaled with the volume: 1.00 puts the row at 0.1 / 1 / 5, so the
  // two larger DECREASE cells would land at 0 and at -4, under the brand's 0.025 minimum, and are
  // disabled alongside all three increases. Only the 0.1 cell is live. This is the clamp doing its
  // job in both directions, and it is why the cells are disabled rather than dropped: the row keeps
  // its shape while most of it is unusable.
  const atMax = volumeSteps(1, { min: 0.025, max: 1, step: 0.01 });
  assert.deepEqual(atMax.filter((s) => s.delta > 0).map((s) => s.enabled), [false, false, false]);
  assert.deepEqual(atMax.filter((s) => s.delta < 0).map((s) => s.enabled), [false, false, true]);
});

test('the decrease cells carry a true minus, not a hyphen', () => {
  // MetaTrader's typography. A hyphen beside a tabular figure reads as a dash in the number.
  for (const s of volumeSteps(0.5, { min: 0.01, max: 10, step: 0.01 })) {
    if (s.delta < 0) assert.ok(s.label.startsWith('−'), s.label);
    else assert.ok(s.label.startsWith('+'), s.label);
  }
});

test('the row is ordered smallest-in-the-middle, as MetaTrader draws it', () => {
  const steps = volumeSteps(0.61, { min: 0.01, max: 100, step: 0.01 });
  const deltas = steps.map((s) => s.delta);
  assert.deepEqual(deltas, [-0.5, -0.1, -0.01, 0.01, 0.1, 0.5]);
});

/**
 * A typed volume that was changed must say WHY it was changed. MetaTrader's Volume field validates
 * and reports; it never swaps the number in silence, which is what made the field look broken when
 * the brand's range had collapsed to one value.
 */
test('a typed volume that was taken as written needs no reason', () => {
  assert.equal(volClampReason(0.5, 0.5, { minLots: 0.058, maxLots: 50, volStep: 0.01, volDigits: 3 }), null);
});

test('out of range and off the step grid are DIFFERENT reasons', () => {
  const lim = { minLots: 0.058, maxLots: 50, volStep: 0.01, volDigits: 3 };
  assert.match(volClampReason(9999, 50, lim)!, /outside the 0\.058 to 50\.000 lots this symbol allows/);
  // 1 is inside the range but off a grid that starts at 0.058, so the nearest step is 0.998.
  assert.match(volClampReason(1, 0.998, lim)!, /steps in 0\.01 lots from its 0\.058 minimum/);
});
