import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayExtremes, minuteBars, XAUUSD, DAY_S } from './candles.js';

/** A deterministic stand-in for a day's curve: a slow sine with a spike late in the day. */
const value = (t: number): number => Math.sin(t / 3600) * 0.3 + (t > 70_000 ? 0.9 : 0);

test('it reports the extremes SO FAR, not the whole day’s', () => {
  // The spike at t=70000 is the day's real high. Asked at noon it must not be reported: the curve
  // is deterministic for the whole day the moment its seed is known, so folding the day's bars
  // would hand back a high the price has not reached yet and print it as if it had. This is the
  // bug this function exists to make impossible.
  const noon = dayExtremes(XAUUSD, 2650, value, 0, DAY_S / 2);
  const whole = dayExtremes(XAUUSD, 2650, value, 0, DAY_S);
  assert.ok(whole.high > noon.high, `${whole.high} should beat ${noon.high}`);
});

test('extending from where it stopped gives the same answer as walking from zero', () => {
  // This is what makes it cheap: the quote fan-out extends by the seconds that have passed since
  // it last asked rather than rewalking the day on every tick.
  const whole = dayExtremes(XAUUSD, 2650, value, 0, DAY_S);
  const first = dayExtremes(XAUUSD, 2650, value, 0, 40_000);
  const extended = dayExtremes(XAUUSD, 2650, value, 40_001, DAY_S, first);
  assert.deepEqual(extended, whole);
});

test('and so does extending in many small steps, as a live feed does', () => {
  const whole = dayExtremes(XAUUSD, 2650, value, 0, 30_000);
  let acc = dayExtremes(XAUUSD, 2650, value, 0, 0);
  for (let t = 1; t <= 30_000; t += 997) {
    acc = dayExtremes(XAUUSD, 2650, value, t, Math.min(30_000, t + 996), acc);
  }
  assert.deepEqual(acc, whole);
});

test('it agrees with the minute bars over the same span, because both sample at 1 Hz', () => {
  // A day the chart has drawn and a range the watch list prints must not disagree about the same
  // minutes. Folding the first 600 bars is the same walk this does.
  const bars = minuteBars(XAUUSD, 0, 2650, value).slice(0, 600);
  const folded = bars.reduce(
    (a, b) => ({ high: Math.max(a.high, b.high), low: Math.min(a.low, b.low) }),
    { high: -Infinity, low: Infinity },
  );
  // 600 bars cover minutes 0..599, each sampled through its 60th second, i.e. seconds 0..35_940.
  const walked = dayExtremes(XAUUSD, 2650, value, 0, 599 * 60 + 60);
  assert.equal(walked.high, folded.high);
  assert.equal(walked.low, folded.low);
});

test('a day that has not started is its opening price, not an empty range', () => {
  const at0 = dayExtremes(XAUUSD, 2650, value, 0, 0);
  assert.equal(at0.high, at0.low);
  assert.ok(Number.isFinite(at0.high));
  // A negative or backwards span cannot produce Infinity either.
  const odd = dayExtremes(XAUUSD, 2650, value, 50, 10);
  assert.ok(Number.isFinite(odd.high) && Number.isFinite(odd.low));
});

test('the prices are on the instrument’s own tick, like every other price it serves', () => {
  const r = dayExtremes(XAUUSD, 2650, value, 0, 3600);
  for (const p of [r.high, r.low]) {
    assert.equal(Number(p.toFixed(XAUUSD.digits)), p, String(p));
  }
});

test('the high is never below the low', () => {
  for (const through of [0, 1, 60, 3600, DAY_S]) {
    const r = dayExtremes(XAUUSD, 2650, value, 0, through);
    assert.ok(r.high >= r.low, `${through}: ${r.high} < ${r.low}`);
  }
});
