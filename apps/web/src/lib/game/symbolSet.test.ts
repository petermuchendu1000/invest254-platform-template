import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WATCHLIST, MAX_WATCHED } from './symbolSet.js';

/**
 * The store itself needs a browser (zustand plus localStorage), so what is testable here is the
 * contract its callers depend on: the default list and the cap. Both are claims about other parts
 * of the system, which is exactly why they are worth pinning.
 */

test('the default watch list is the majors plus this platform’s own symbol', () => {
  // The chart is on XAUUSD, so a list that did not contain it would open with the traded instrument
  // missing from the window that exists to list it.
  assert.ok(DEFAULT_WATCHLIST.includes('XAUUSD'));
  for (const s of ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD']) {
    assert.ok(DEFAULT_WATCHLIST.includes(s), s);
  }
  assert.equal(new Set(DEFAULT_WATCHLIST).size, DEFAULT_WATCHLIST.length, 'no duplicates');
});

test('the default list fits inside the cap, which fits the engine’s own', () => {
  // The cap mirrors the engine's MAX_WATCHED_SYMBOLS. If it were larger, the extra rows would be
  // subscribed and never quoted, which looks like a broken feed rather than a full list.
  assert.ok(DEFAULT_WATCHLIST.length <= MAX_WATCHED);
  assert.equal(MAX_WATCHED, 20);
});
