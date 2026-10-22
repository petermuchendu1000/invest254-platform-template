import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneClickTint, ONE_CLICK_FILL } from './oneClick.js';
import { STALE_AFTER_MS } from './quoteTone.js';

const now = 1_700_000_000_000;

test('an up tick tints the panel blue, a down tick red', () => {
  assert.equal(oneClickTint({ up: true, changedAt: now - 1000, now }), 'up');
  assert.equal(oneClickTint({ up: false, changedAt: now - 1000, now }), 'down');
});

test('a panel with no quote yet is red, which is what every MetaQuotes screenshot shows', () => {
  assert.equal(oneClickTint({ up: null, changedAt: null, now }), 'down');
});

test('a stale feed falls back to red rather than holding its last direction', () => {
  // The same fifteen-second rule Market Watch uses, so the panel and the watch list cannot
  // disagree about whether the price is moving.
  assert.equal(oneClickTint({ up: true, changedAt: now - (STALE_AFTER_MS - 1), now }), 'up');
  assert.equal(oneClickTint({ up: true, changedAt: now - STALE_AFTER_MS, now }), 'down');
});

test("the red is MetaQuotes' measured value, not a hex picked to look like it", () => {
  // Sampled from android/en/one_click_trading.png. iOS measures #D54A36; one value is used for
  // both, as one panel is being built, not two.
  assert.equal(ONE_CLICK_FILL.down, '#D85852');
  // The up state has no official screenshot, so its blue is the one MetaQuotes DOES document for
  // "the current price is higher than the previous one" rather than an invented companion.
  assert.equal(ONE_CLICK_FILL.up, '#3183ff');
});

test('both sides of the panel take one colour, because MetaTrader paints them the same', () => {
  // Guarding the surprising part: there is no per-side entry to reach for. A future edit that
  // wants red SELL / blue BUY has to change this test, and read why it is here.
  assert.deepEqual(Object.keys(ONE_CLICK_FILL).sort(), ['down', 'up']);
});
