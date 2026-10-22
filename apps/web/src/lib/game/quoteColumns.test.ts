import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUOTE_COLUMNS, spreadPoints, useQuoteColumnsStore } from './quoteColumns.js';

/**
 * MetaTrader's optional Market Watch columns, and the one piece of arithmetic behind them.
 */

test("the optional set is MetaTrader's, in its order, and Symbol is not in it", () => {
  assert.deepEqual(QUOTE_COLUMNS.map((c) => c.label), ['Bid', 'Ask', 'Spread', 'Time', 'Daily Change']);
  // Every grid has a Symbol column and MetaTrader offers no way to hide it, so offering one here
  // would be an invention that could also leave the grid unreadable.
  assert.ok(!QUOTE_COLUMNS.some((c) => c.label === 'Symbol'));
});

test('every column starts on, which is what MetaTrader shows out of the box', () => {
  assert.deepEqual([...useQuoteColumnsStore.getState().on], QUOTE_COLUMNS.map((c) => c.id));
});

test('toggling keeps MetaTrader s own order however the columns are switched', () => {
  const { toggle } = useQuoteColumnsStore.getState();
  toggle('bid');
  toggle('time');
  assert.deepEqual([...useQuoteColumnsStore.getState().on], ['ask', 'spread', 'change']);
  // Switching one back puts it where MetaTrader has it, not on the end: a grid that reordered its
  // columns as they were toggled would be unreadable after a couple of visits to the menu.
  toggle('bid');
  assert.deepEqual([...useQuoteColumnsStore.getState().on], ['bid', 'ask', 'spread', 'change']);
  toggle('time');
  assert.deepEqual([...useQuoteColumnsStore.getState().on], ['bid', 'ask', 'spread', 'time', 'change']);
});

test("spreadPoints is in the symbol's own points, which is MetaTrader's unit", () => {
  // Gold at two digits: a 0.59 spread is 59 points, and MetaTrader's column prints 59.
  assert.equal(spreadPoints(3089.60, 3090.19, 2), 59);
  // Each side is rounded first, so the column is exactly the gap between the two numbers the grid
  // prints. Differencing the raw values here would give 58 beside a visible 3089.10 / 3089.67.
  assert.equal(spreadPoints(3089.095, 3089.674, 2), 57);
  // EURUSD at five: MetaTrader's own row reads `0`, not `0.00001`.
  assert.equal(spreadPoints(1.07806, 1.07806, 5), 0);
  assert.equal(spreadPoints(1.07806, 1.07824, 5), 18);
  // No quote, no figure. A zero would read as a zero spread, which is a different claim.
  assert.equal(spreadPoints(null, 1.2, 5), null);
  assert.equal(spreadPoints(1.2, null, 5), null);
});
