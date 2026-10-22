import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTradeUi, isTradeUi, TRADE_UIS } from './tradeUi.js';

/**
 * The screen and the shell around it both resolve this. They disagreed once — the override was read
 * only inside the screen — and the result was the new layout rendered inside the old header, which
 * is why the rule is pure and tested rather than written out twice.
 */
test('resolveTradeUi: the override wins, then the brand, then the default', () => {
  assert.equal(resolveTradeUi('candlestick', 'classic'), 'candlestick');
  assert.equal(resolveTradeUi(null, 'candlestick'), 'candlestick');
  assert.equal(resolveTradeUi(undefined, 'broker'), 'broker');
  assert.equal(resolveTradeUi(null, null), 'classic');
  assert.equal(resolveTradeUi(null, undefined), 'classic');
});

test('resolveTradeUi: anything the product does not have falls back rather than rendering nothing', () => {
  // `?ui=` is a URL anyone can type, and a brand row could carry a value a later migration removed.
  assert.equal(resolveTradeUi('nonsense', 'candlestick'), 'candlestick');
  assert.equal(resolveTradeUi('nonsense', 'also-nonsense'), 'classic');
  assert.equal(resolveTradeUi('', ''), 'classic');
});

test('isTradeUi accepts exactly the four layouts that exist', () => {
  assert.deepEqual([...TRADE_UIS], ['classic', 'digits', 'broker', 'candlestick']);
  for (const v of TRADE_UIS) assert.equal(isTradeUi(v), true);
  for (const v of [null, undefined, 1, 'Classic', 'mt5']) assert.equal(isTradeUi(v), false);
});

test('the layout list is the shared one, so the API and the screen cannot disagree', async () => {
  // The regression this guards: the API mapped trade_ui with its own ternary and served `classic`
  // for every value added after `digits`, so a brand set to `candlestick` rendered the old screen.
  const shared = await import('@invest254/shared/chart');
  assert.deepEqual([...TRADE_UIS], [...shared.TRADE_UIS]);
  assert.equal(shared.tradeUiOf('candlestick'), 'candlestick');
  assert.equal(shared.tradeUiOf('broker'), 'broker');
  assert.equal(shared.tradeUiOf('digits'), 'digits');
  // Unknown values fall back to the FREE default, never to a paid layout.
  assert.equal(shared.tradeUiOf('mt5'), 'classic');
  assert.equal(shared.tradeUiOf(null), 'classic');
  assert.equal(shared.tradeUiOf(undefined), 'classic');
});
