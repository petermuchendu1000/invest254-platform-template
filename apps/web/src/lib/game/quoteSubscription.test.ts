import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteSubscription, DEFAULT_WATCHLIST, MAX_WATCHED } from './symbolSet.js';

/**
 * The subscription is a SET per socket, so the whole screen has to agree on one. These cover the
 * rule that decides it.
 */

test('the charted symbol is always subscribed, even when it is not on the watch list', () => {
  // Otherwise the chart would show a symbol whose live edge never arrives: history and then a
  // frozen last bar, which looks exactly like a broken feed.
  const got = quoteSubscription('BTCUSD', ['EURUSD', 'GBPUSD']);
  assert.deepEqual(got, ['BTCUSD', 'EURUSD', 'GBPUSD']);
});

test('a symbol on both the chart and the list is one subscription', () => {
  assert.deepEqual(quoteSubscription('EURUSD', ['EURUSD', 'GBPUSD']), ['EURUSD', 'GBPUSD']);
});

test('no charted symbol means just the watch list, in its own order', () => {
  assert.deepEqual(quoteSubscription(null, [...DEFAULT_WATCHLIST]), [...DEFAULT_WATCHLIST]);
});

test('when the union overflows the cap, the chart survives and the list is trimmed', () => {
  // This is the whole reason the chart goes first. Dropping the instrument on screen to make room
  // for the twentieth row of a list would be exactly the wrong trade.
  const list = Array.from({ length: MAX_WATCHED }, (_, i) => `SYM${i}`);
  const got = quoteSubscription('BTCUSD', list);
  assert.equal(got.length, MAX_WATCHED);
  assert.equal(got[0], 'BTCUSD');
  assert.ok(!got.includes(`SYM${MAX_WATCHED - 1}`), 'the tail of the list is what gets dropped');
});

test('an empty name is never subscribed', () => {
  assert.deepEqual(quoteSubscription('', ['', 'EURUSD']), ['EURUSD']);
});
