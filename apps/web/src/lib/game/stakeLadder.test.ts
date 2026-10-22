import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMultipleOf5, pillLabel, resolveStakeUnits, stakeLadder } from './stakeLadder.js';
import { effectiveVolume } from '../../../../../packages/shared/src/symbols.js';

test('owner example: $5 → 5, 10, 20, 25, 50, 100', () => {
  assert.deepEqual(stakeLadder(5, null), [5, 10, 20, 25, 50, 100]);
});

test('follows the minimum; every pill a multiple of 5', () => {
  assert.deepEqual(stakeLadder(250, 50_000), [250, 500, 1000, 1250, 2500, 5000]);
  assert.deepEqual(stakeLadder(15, null), [15, 30, 60, 75, 150, 300]);
  for (const m of [5, 10, 15, 20, 35, 250, 1000]) assert.ok(stakeLadder(m, null).every(isMultipleOf5));
});

test('capped by the maximum', () => {
  assert.deepEqual(stakeLadder(5, 30), [5, 10, 20, 25]);
  assert.deepEqual(stakeLadder(5, 5), [5]);
});

test('native admin values win when the enforced cents agree', () => {
  // $5 set; enforced cents carry a 10% FX margin, so they read $4.50 / $1,100 at today's rate
  assert.deepEqual(resolveStakeUnits({ nativeMin: 5, nativeMax: 1000, minDisplay: 4.5, maxDisplay: 1100, floor: 5 }), { min: 5, max: 1000, ladder: [5, 10, 20, 25, 50, 100], inverted: false });
});

test('never below what the server enforces (stale rate / global override), rounded to a whole unit', () => {
  assert.equal(resolveStakeUnits({ nativeMin: 5, minDisplay: 7.75, floor: 5 }).min, 8);  // whole unit, not 10
  assert.equal(resolveStakeUnits({ minDisplay: 250 }).min, 250);           // KES brand, no native value
  assert.equal(resolveStakeUnits({ minDisplay: 1.94, floor: 5 }).min, 5);   // USD brand on KES 250
});

test('max never above the enforced max; any positive native value applies', () => {
  assert.equal(resolveStakeUnits({ nativeMax: 5000, minDisplay: 5, maxDisplay: 387.4 }).max, 387); // whole unit, not 385
  assert.equal(resolveStakeUnits({ nativeMin: 7, minDisplay: 5 }).min, 7);  // non-multiple-of-5 native now honoured
});

/**
 * An INVERTED range is a misconfiguration, and the one thing it must never become is a single
 * tradable amount.
 *
 * This used to pin the max to the min. One value then reached `effectiveVolume` as
 * `{min: x, max: x}`, both volume steppers sat on their bound at once, and the ticket printed
 * "min 0.058 / max 0.058" with nothing the trader could change. MetaTrader's Volume is a numeric
 * spinner whose limits come from the symbol's contract specification, so an impossible brand
 * ceiling is dropped and that specification's own ceiling stands.
 */
test('an inverted min/max does NOT collapse the range: no brand ceiling, and it is reported', () => {
  const u = resolveStakeUnits({ nativeMin: 50, nativeMax: 20, minDisplay: 5 });
  assert.equal(u.min, 50);
  assert.equal(u.max, null, 'an impossible ceiling is no ceiling, never the minimum');
  assert.equal(u.inverted, true, 'and the condition is detectable rather than silent');
  // The pills still climb from the minimum, so the ladder is usable rather than a single chip.
  assert.deepEqual(u.ladder, [50, 100, 200, 250, 500, 1000]);

  // The same thing by conversion rather than by admin entry: a USD brand on a $5 floor whose
  // enforced maximum converts to $4 at today's rate.
  const fx = resolveStakeUnits({ minDisplay: 1.94, maxDisplay: 4, floor: 5 });
  assert.equal(fx.min, 5);
  assert.equal(fx.max, null);
  assert.equal(fx.inverted, true);

  // A range of exactly one unit is NOT inverted: the operator may legitimately allow one amount.
  const one = resolveStakeUnits({ nativeMin: 580, nativeMax: 580, minDisplay: 580 });
  assert.equal(one.max, 580);
  assert.equal(one.inverted, false);
});

test('sub-$5 minimums: a $1 floor yields a 1·2·4·5·10·20 ladder', () => {
  assert.deepEqual(stakeLadder(1, null), [1, 2, 4, 5, 10, 20]);
  assert.equal(resolveStakeUnits({ nativeMin: 1, minDisplay: 0.9, floor: 1 }).min, 1);
  assert.deepEqual(resolveStakeUnits({ nativeMin: 1, minDisplay: 0.9, floor: 1 }).ladder, [1, 2, 4, 5, 10, 20]);
});

/**
 * The whole path the bug report came down: the brand's cents, through `resolveStakeUnits`, into
 * `effectiveVolume`, out as the pair the ticket prints as "min … / max …".
 *
 * Reported as "why cant I edit the amounts in the execution panels (min 0.058 / max 0.058)". With
 * the max pinned to the min this produced one tradable volume, which disabled both steppers.
 */
test('an inverted brand range leaves the ORDER TICKET a range it can move in', () => {
  const LOT_STAKE_CENTS = 1_000_000;
  const majorToLots = (v: number) => (v * 100) / LOT_STAKE_CENTS; // KES brand: major units → cents → lots
  const spec = { min: 0.01, max: 100, step: 0.01 };               // Forex\Majors, from conventionalVolume

  // KES 58,000 cents enforced minimum against a 30,000 cents maximum: impossible, and configured.
  const u = resolveStakeUnits({ minDisplay: 580, maxDisplay: 300 });
  const vol = effectiveVolume(spec, majorToLots(u.min), u.max === null ? null : majorToLots(u.max));
  assert.equal(vol.min, 0.058);
  assert.ok(vol.max > vol.min, `the range must not collapse, got min ${vol.min} / max ${vol.max}`);
  assert.equal(vol.max, spec.max, "the symbol's own ceiling stands when the brand's is impossible");
  // And a typed volume survives the clamp, which is the control the trader could not use.
  assert.equal(Math.min(vol.max, Math.max(vol.min, 1)), 1);
});

test('labels', () => {
  assert.deepEqual([5, 250, 1000, 1250, 2500, 10_000].map(pillLabel), ['5', '250', '1k', '1.25k', '2.5k', '10k']);
});
