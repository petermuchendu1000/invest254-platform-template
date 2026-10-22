import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PENDING_KINDS, PENDING_LABELS, isPendingKind, pendingDirection, pendingKindsAt,
  pendingLevelValid, pendingRowLabel, pendingTriggered, type PendingKind,
} from './pending.js';

const ALL: readonly PendingKind[] = ['buyLimit', 'sellLimit', 'buyStop', 'sellStop'];

test("the labels are MetaTrader's four, spelled its way", () => {
  assert.deepEqual(ALL.map((k) => PENDING_LABELS[k]), ['Buy Limit', 'Sell Limit', 'Buy Stop', 'Sell Stop']);
});

test('a click ABOVE the price offers Sell Limit and Buy Stop, below it the other pair', () => {
  // MetaQuotes, verbatim: "If the menu is activated above the current price, a user can place Sell
  // Limit and Buy Stop orders. If the menu is activated below the current price, Buy Limit and
  // Sell Stop orders can be placed."
  assert.deepEqual(pendingKindsAt(3100, 3080), ['sellLimit', 'buyStop']);
  assert.deepEqual(pendingKindsAt(3060, 3080), ['buyLimit', 'sellStop']);
  // Exactly on the price takes the above-price pair, which is the side the screenshot shows.
  assert.deepEqual(pendingKindsAt(3080, 3080), ['sellLimit', 'buyStop']);
  // The pair a click offers is always one buy and one sell, never two of a side.
  for (const price of [3060, 3080, 3100]) {
    const [a, b] = pendingKindsAt(price, 3080);
    assert.notEqual(pendingDirection(a), pendingDirection(b));
  }
});

test('the row reads as MetaTrader prints it', () => {
  // `Sell Limit 1  219.306` — the type, the volume, then two spaces and the level.
  assert.equal(pendingRowLabel('sellLimit', '1', 219.306, 3), 'Sell Limit 1  219.306');
  assert.equal(pendingRowLabel('buyStop', '0.025', 3090.6, 2), 'Buy Stop 0.025  3090.60');
});

test('a limit waits for the market to come to it; a stop waits for it to break away', () => {
  // Buy Limit and Sell Stop both want the price to come DOWN to the level.
  assert.equal(pendingTriggered('buyLimit', 3080, 3079.99), true);
  assert.equal(pendingTriggered('buyLimit', 3080, 3080.01), false);
  assert.equal(pendingTriggered('sellStop', 3080, 3079.99), true);
  assert.equal(pendingTriggered('sellStop', 3080, 3080.01), false);
  // Sell Limit and Buy Stop both want it to go UP to the level.
  assert.equal(pendingTriggered('sellLimit', 3080, 3080.01), true);
  assert.equal(pendingTriggered('sellLimit', 3080, 3079.99), false);
  assert.equal(pendingTriggered('buyStop', 3080, 3080.01), true);
  assert.equal(pendingTriggered('buyStop', 3080, 3079.99), false);
});

test('a price exactly ON the level has reached it', () => {
  // A trader who set 3080 and watched the market print 3080 without filling would be right to call
  // it a bug, so every one of the four is inclusive at its level.
  for (const k of ALL) assert.equal(pendingTriggered(k, 3080, 3080), true, k);
});

test('a level on the wrong side is refused, because it would fill the instant it was placed', () => {
  // A Buy Limit must be BELOW the market: one above it is a market order wearing the wrong name.
  assert.equal(pendingLevelValid('buyLimit', 3070, 3080), true);
  assert.equal(pendingLevelValid('buyLimit', 3090, 3080), false);
  assert.equal(pendingLevelValid('sellStop', 3070, 3080), true);
  assert.equal(pendingLevelValid('sellStop', 3090, 3080), false);
  assert.equal(pendingLevelValid('sellLimit', 3090, 3080), true);
  assert.equal(pendingLevelValid('sellLimit', 3070, 3080), false);
  assert.equal(pendingLevelValid('buyStop', 3090, 3080), true);
  assert.equal(pendingLevelValid('buyStop', 3070, 3080), false);
  // A level exactly AT the market is refused for every type, for the same reason.
  for (const k of ALL) assert.equal(pendingLevelValid(k, 3080, 3080), false, k);
  // And nothing is valid without two real numbers.
  for (const k of ALL) {
    assert.equal(pendingLevelValid(k, Number.NaN, 3080), false, k);
    assert.equal(pendingLevelValid(k, 3080, Number.NaN), false, k);
  }
});

test('every type a click offers is one this platform could place at that level', () => {
  // The pair and the validity rule have to agree: an offered type whose level was invalid would be
  // a menu row that refuses itself.
  for (const [clicked, last] of [[3100, 3080], [3060, 3080]] as const) {
    for (const k of pendingKindsAt(clicked, last)) {
      assert.equal(pendingLevelValid(k, clicked, last), true, `${k} at ${clicked} vs ${last}`);
    }
  }
});

test("isPendingKind: only the four, so the socket cannot store a type nothing can fill", () => {
  // The kind arrives over the wire. Without this guard an unknown string would be armed and then
  // tested by `pendingTriggered`'s fallback branch, which is a rule nobody chose.
  for (const k of PENDING_KINDS) assert.equal(isPendingKind(k), true, k);
  for (const x of ['buy', 'sell', 'BuyLimit', 'buylimit', '', null, undefined, 1, {}]) {
    assert.equal(isPendingKind(x), false, String(x));
  }
  assert.deepEqual([...PENDING_KINDS].sort(), ['buyLimit', 'buyStop', 'sellLimit', 'sellStop']);
});
