import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetReached, levelPrice, isContinuousBrand } from './levelWatch.js';

test('a buy takes profit when the price rises to its target', () => {
  assert.equal(targetReached({ direction: 'buy', target: 3100, price: 3099.99 }), false);
  assert.equal(targetReached({ direction: 'buy', target: 3100, price: 3100 }), true);
  assert.equal(targetReached({ direction: 'buy', target: 3100, price: 3100.01 }), true);
});

test('a sell takes profit when the price falls to its target', () => {
  assert.equal(targetReached({ direction: 'sell', target: 3000, price: 3000.01 }), false);
  assert.equal(targetReached({ direction: 'sell', target: 3000, price: 3000 }), true);
  assert.equal(targetReached({ direction: 'sell', target: 3000, price: 2999.99 }), true);
});

test('the POSITION’s direction decides, not the side of the anchor the level sits on', () => {
  // A sell whose target was dragged ABOVE the anchor is a target a falling price never reaches.
  // That is MetaTrader's rule and it is the trader's own doing; the pair being the wrong shape is
  // what `sidesEnabled` refuses at order time.
  assert.equal(targetReached({ direction: 'sell', target: 3200, price: 3100 }), true);
  assert.equal(targetReached({ direction: 'buy', target: 3200, price: 3100 }), false);
});

test('no target and no price never fire, so an unset level cannot close a contract', () => {
  assert.equal(targetReached({ direction: 'buy', target: null, price: 3100 }), false);
  assert.equal(targetReached({ direction: 'buy', target: 3100, price: null }), false);
  assert.equal(targetReached({ direction: 'sell', target: null, price: null }), false);
});

test('a level is a price measured from the anchor, and unset without one', () => {
  const levels = { slPoints: -100, tpPoints: 200 };
  assert.equal(levelPrice(levels, 3050, 'tp', 2), 3052);
  assert.equal(levelPrice(levels, 3050, 'sl', 2), 3049);
  // No anchor yet: there is no price for a distance to be measured from, so there is no level.
  assert.equal(levelPrice(levels, null, 'tp', 2), null);
  assert.equal(levelPrice({ slPoints: null, tpPoints: null }, 3050, 'tp', 2), null);
});

test('the level reads on the instrument’s own tick, so a five-digit pair is not rounded to two', () => {
  assert.equal(levelPrice({ slPoints: -150, tpPoints: 150 }, 1.08500, 'tp', 5), 1.0865);
  assert.equal(levelPrice({ slPoints: -150, tpPoints: 150 }, 1.08500, 'sl', 5), 1.0835);
});

/**
 * The web's proxy for the engine's `continuous`, which decides which of two copies every SL/TP
 * surface prints. The engine sets `continuous = this.priceAxis !== undefined` and forces it false on
 * a pool-controlled position, so both facts have to hold.
 */
test('a brand is continuous only with a price axis AND pool mode off', () => {
  assert.equal(isContinuousBrand({ chartStyle: 'candlestick', earlyCloseEnabled: true }), true);
  assert.equal(isContinuousBrand({ chartStyle: 'bars', earlyCloseEnabled: true }), true);
  assert.equal(isContinuousBrand({ chartStyle: 'area', earlyCloseEnabled: true }), true);
});

test('a line brand has no price axis, so neither of its levels can fire', () => {
  // The trap this replaces: `earlyCloseEnabled` alone is true here, and it used to be what the copy
  // keyed off, so a line brand claimed a working take profit it has no axis to measure.
  assert.equal(isContinuousBrand({ chartStyle: 'line', earlyCloseEnabled: true }), false);
});

test('pool mode decides every position itself, so no level fires there either', () => {
  assert.equal(isContinuousBrand({ chartStyle: 'candlestick', earlyCloseEnabled: false }), false);
  assert.equal(isContinuousBrand({ chartStyle: 'line', earlyCloseEnabled: false }), false);
});

test('an unknown or missing chart style falls back to `line`, so the copy never over-promises', () => {
  // `chartStyleOf` normalises an unknown value to `line` rather than throwing, which is the same
  // fallback the engine's own wiring takes: no axis, no levels, committed contract.
  assert.equal(isContinuousBrand({ chartStyle: undefined, earlyCloseEnabled: true }), false);
  assert.equal(isContinuousBrand({ chartStyle: 'nonsense', earlyCloseEnabled: true }), false);
});
