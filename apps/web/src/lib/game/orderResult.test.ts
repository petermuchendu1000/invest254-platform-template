import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorTitle, friendlyError, refusalReason, fillLine } from './orderResult.js';
import { claimOrderWindow, orderWindowWaiting, resetOrderWindows } from './orderWindow.js';

const fmt = (c: number) => `KES ${(c / 100).toFixed(2)}`;

test('a rejection is titled in words, never as an engine code', () => {
  assert.equal(errorTitle('INSUFFICIENT_FUNDS'), 'Insufficient balance');
  assert.equal(errorTitle('SYSTEM_DISABLED'), 'Paused');
  // The catch-all matters most: a trader reading ENGINE_ERROR learns nothing they can act on.
  assert.equal(errorTitle('ENGINE_ERROR'), 'Trade rejected');
  assert.equal(errorTitle('SOMETHING_NEW'), 'Trade rejected');
});

test('raw cents never reach the window', () => {
  assert.equal(friendlyError('STAKE_BELOW_MIN: min 25000', undefined, fmt), 'Minimum stake is KES 250.00.');
  assert.equal(friendlyError('STAKE_ABOVE_MAX: max 100000', undefined, fmt), 'Maximum stake is KES 1000.00.');
  // And the generic safety net, for a message shape nobody has written a rule for yet.
  assert.equal(friendlyError('weird: min 25000', undefined, fmt), 'weird: min KES 250.00');
});

test('the engine codes a trader can act on are turned into advice', () => {
  assert.equal(friendlyError('INSUFFICIENT_FUNDS', undefined, fmt), 'Top up or lower the stake.');
  assert.equal(friendlyError('CONTRACT_EXISTS', undefined, fmt), 'One contract at a time on this market.');
});

test('the single-open refusal says why, because nothing on screen shows the blocker', () => {
  // A contract that is still SETTLING holds the slot while the Trade screen already reports no
  // open positions. Before this, the tap did nothing whatever and said nothing.
  const r = refusalReason('POSITION_OPEN');
  assert.equal(r.title, 'Trade rejected');
  assert.match(r.detail, /settling/);
});

test('every local refusal has a title and a reason, so none can be silent', () => {
  for (const code of ['POSITION_OPEN', 'LOGIN_REQUIRED', 'OFFLINE', 'WRONG_SYMBOL'] as const) {
    const r = refusalReason(code);
    assert.ok(r.title.length > 0, code);
    assert.ok(r.detail.length > 0, code);
  }
});

test("a fill reads in MetaTrader's own phrasing", () => {
  // The same shape its Close position screen puts under its title: "buy 0.61 GBPUSD at 1.33629".
  assert.equal(
    fillLine({ direction: 'sell', lots: 0.03, symbol: 'XAUUSD', price: 3082.07, digits: 2 }),
    'sell 0.03 XAUUSD at 3082.07',
  );
  assert.equal(
    fillLine({ direction: 'buy', lots: 0.025, symbol: 'EURUSD', price: 1.0812345, digits: 5, volDigits: 3 }),
    'buy 0.025 EURUSD at 1.08123',
  );
});

test('a fill with no entry price yet names the trade without inventing one', () => {
  assert.equal(
    fillLine({ direction: 'buy', lots: 1, symbol: 'XAUUSD', price: null, digits: 2 }),
    'buy 1.00 XAUUSD',
  );
});

test('a waiting window owns the rejection, so the popup stands down', () => {
  resetOrderWindows();
  assert.equal(orderWindowWaiting(), false);
  const release = claimOrderWindow();
  assert.equal(orderWindowWaiting(), true);
  release();
  assert.equal(orderWindowWaiting(), false);
});

test('two windows can be mid-order, and the first to finish does not clear the other', () => {
  // The classic ticket and the advanced dialog can both be mounted.
  resetOrderWindows();
  const a = claimOrderWindow();
  const b = claimOrderWindow();
  a();
  assert.equal(orderWindowWaiting(), true);
  b();
  assert.equal(orderWindowWaiting(), false);
});

test('a release is idempotent, so an unmount after a result cannot silence the popup for good', () => {
  resetOrderWindows();
  const release = claimOrderWindow();
  release();
  release();
  release();
  assert.equal(orderWindowWaiting(), false);
  // And a later order still claims normally rather than starting from a negative count.
  claimOrderWindow();
  assert.equal(orderWindowWaiting(), true);
  resetOrderWindows();
});
