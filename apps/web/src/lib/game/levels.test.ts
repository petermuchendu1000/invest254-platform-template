import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL_UNITS, pointSize, priceOfPoints, pointsOfPrice, buyShaped, swapForSide, shapeOf,
  sidesEnabled, applyRatioLock,
} from './levels.js';

test("the unit control is MetaTrader's three, under its own labels", () => {
  // Its segmented control shows Price and Pips; the help names Currency as the third.
  assert.deepEqual(LEVEL_UNITS.map((u) => u.label), ['Price', 'Pips', 'Currency']);
  assert.deepEqual(LEVEL_UNITS.map((u) => u.id), ['price', 'points', 'currency']);
});

test('a point is the instrument’s own tick, and the conversions are exact both ways', () => {
  assert.equal(pointSize(5), 0.00001);
  assert.equal(pointSize(2), 0.01);
  // A 5-digit pair.
  assert.equal(priceOfPoints(1.08500, 150, 5), 1.085 + 0.0015);
  assert.equal(pointsOfPrice(1.08500, 1.08650, 5), 150);
  // Gold, two digits: 250 points is 2.50.
  assert.equal(priceOfPoints(3080.00, 250, 2), 3082.5);
  assert.equal(pointsOfPrice(3080.00, 3082.50, 2), 250);
  // Negative distances round-trip too, which is the whole point of the sign convention.
  assert.equal(pointsOfPrice(3080.00, priceOfPoints(3080, -250, 2), 2), -250);
});

test('the default pair is shaped for a BUY, as MetaTrader’s is', () => {
  // "Levels default as for a buy (TP above price, SL below)."
  const l = buyShaped(200);
  assert.equal(l.tpPoints, 200);
  assert.equal(l.slPoints, -200);
  assert.equal(shapeOf(l), 'buy');
  // The caller's distance is used whichever sign it arrives with.
  assert.deepEqual(buyShaped(-200), buyShaped(200));
});

test('tapping the other side swaps them, and tapping the same side again does not', () => {
  // "If you then tap Sell, the app swaps them automatically."
  const buy = buyShaped(200);
  const sell = swapForSide(buy, 'sell');
  assert.deepEqual(sell, { slPoints: 200, tpPoints: -200 });
  assert.equal(shapeOf(sell), 'sell');
  // Idempotent: a pair already right for the side is left alone, or two taps would flip it back.
  assert.deepEqual(swapForSide(sell, 'sell'), sell);
  assert.deepEqual(swapForSide(buy, 'buy'), buy);
});

test('one level on its own still has a shape, because MetaTrader lets you set only a stop', () => {
  assert.equal(shapeOf({ slPoints: -100, tpPoints: null }), 'buy');
  assert.equal(shapeOf({ slPoints: null, tpPoints: -100 }), 'sell');
  assert.deepEqual(swapForSide({ slPoints: -100, tpPoints: null }, 'sell'), { slPoints: 100, tpPoints: null });
});

test('a pair with both levels on the same side is neither shape', () => {
  assert.equal(shapeOf({ slPoints: 100, tpPoints: 200 }), null);
  assert.equal(shapeOf({ slPoints: -100, tpPoints: -200 }), null);
  // A level AT the price is not a level.
  assert.equal(shapeOf({ slPoints: 0, tpPoints: 200 }), null);
});

test('inverting them by hand disables Buy and leaves Sell, which is MetaTrader’s own rule', () => {
  // "only the Sell button stays enabled and Buy is disabled, on the assumption you meant it."
  assert.deepEqual(sidesEnabled(buyShaped(200)), { buy: true, sell: true });
  assert.deepEqual(sidesEnabled({ slPoints: 200, tpPoints: -200 }), { buy: false, sell: true });
});

test('a self-contradicting pair disables both, and no levels at all disables neither', () => {
  // "Invalid fields are highlighted in red and the trade buttons go inactive."
  assert.deepEqual(sidesEnabled({ slPoints: 100, tpPoints: 200 }), { buy: false, sell: false });
  // An order with no stop and no target is the ordinary case, not an invalid one.
  assert.deepEqual(sidesEnabled({ slPoints: null, tpPoints: null }), { buy: true, sell: true });
});

test('the ratio lock moves the other level by the same PROPORTION, not the same points', () => {
  // "A lock button fixes the TP:SL ratio — adjust one and the other follows."
  const before = { slPoints: -100, tpPoints: 200 };            // 1:2
  const after = applyRatioLock(before, { ...before, slPoints: -150 }, 'sl');
  assert.deepEqual(after, { slPoints: -150, tpPoints: 300 });  // still 1:2
  const other = applyRatioLock(before, { ...before, tpPoints: 100 }, 'tp');
  assert.deepEqual(other, { slPoints: -50, tpPoints: 100 });   // still 1:2
});

test('the lock does nothing when there is no ratio to hold', () => {
  const before = { slPoints: null, tpPoints: 200 };
  const edit = { slPoints: -150, tpPoints: 200 };
  assert.deepEqual(applyRatioLock(before, edit, 'sl'), edit);
  const atZero = { slPoints: 0, tpPoints: 200 };
  assert.deepEqual(applyRatioLock(atZero, { slPoints: -150, tpPoints: 200 }, 'sl'), { slPoints: -150, tpPoints: 200 });
});

test('the lock keeps the pair’s shape when a level crosses the price', () => {
  // Dragging the stop through the price inverts the pair; the target must follow it rather than be
  // left on the far side, which would be a pair that is neither shape and disables both buttons.
  const before = { slPoints: -100, tpPoints: 200 };
  const crossed = applyRatioLock(before, { ...before, slPoints: 100 }, 'sl');
  assert.deepEqual(crossed, { slPoints: 100, tpPoints: -200 });
  assert.equal(shapeOf(crossed), 'sell');
});
