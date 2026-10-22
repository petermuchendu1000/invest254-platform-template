import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteTone, QUOTE_TONE_COLOUR, STALE_AFTER_MS, gutterGlyph, GUTTER_GLYPH, GUTTER_COLOUR,
  positionMark, POSITION_MARK_COLOUR,
} from './quoteTone.js';

/**
 * MetaQuotes' rule, verbatim: "Blue — the current price is higher than the previous one; Red — the
 * current price is lower than the previous one; Gray — the price has not changed for the last 15
 * seconds."
 */

test('a quote that just ticked up is blue, and one that ticked down is red', () => {
  const now = 1_000_000;
  assert.equal(quoteTone({ up: true, changedAt: now, now }), 'up');
  assert.equal(quoteTone({ up: false, changedAt: now, now }), 'down');
  assert.equal(QUOTE_TONE_COLOUR.up, '#3183ff');
  assert.equal(QUOTE_TONE_COLOUR.down, '#f23645');
});

test("the stale state is the window's foreground, not a grey", () => {
  // MetaQuotes writes "Gray", and its own screenshots disagree: the unchanged price samples at
  // #000000 on the white Market Watch and #FFFFFF on the black Popup Prices. Only the gutter glyph
  // is literally grey. Painting a current-but-unmoved quote grey would dim it for no reason.
  assert.equal(QUOTE_TONE_COLOUR.stale, 'currentColor');
});

test('the third state is staleness, not an unchanged tick', () => {
  const now = 1_000_000;
  // Fourteen seconds since the last CHANGE: still coloured.
  assert.equal(quoteTone({ up: true, changedAt: now - 14_000, now }), 'up');
  // Fifteen: stale. MetaTrader's own timeout, to the second.
  assert.equal(quoteTone({ up: true, changedAt: now - STALE_AFTER_MS, now }), 'stale');
  assert.equal(quoteTone({ up: false, changedAt: now - 60_000, now }), 'stale');
  assert.equal(STALE_AFTER_MS, 15_000);
});

test('a quote that keeps arriving at the same number still goes stale', () => {
  // This is the case the rule is actually about, and the one a naive reading misses: identical
  // quotes arriving every second are not a CHANGE, so the timer keeps running.
  const changedAt = 0;
  assert.equal(quoteTone({ up: true, changedAt, now: 10_000 }), 'up');
  assert.equal(quoteTone({ up: true, changedAt, now: 15_001 }), 'stale');
});

test('a going-stale quote comes back the moment it changes again', () => {
  assert.equal(quoteTone({ up: true, changedAt: 0, now: 20_000 }), 'stale');
  // A fresh change at 20s restores the colour.
  assert.equal(quoteTone({ up: false, changedAt: 20_000, now: 20_000 }), 'down');
});

test('before any quote has arrived there is no tone at all', () => {
  // Not one of MetaTrader's three: there is nothing to colour yet, which is distinct from stale.
  assert.equal(quoteTone({ up: null, changedAt: null, now: 1 }), null);
  assert.equal(quoteTone({ up: true, changedAt: null, now: 1 }), null);
  assert.equal(quoteTone({ up: null, changedAt: 1, now: 1 }), null);
});

test("the gutter glyph is MetaTrader's three states, in its own colours", () => {
  // Measured off en/market_watch_x2.png at 3x. The arrow is green and red while the price beside it
  // is blue and red: MetaTrader being inconsistent with itself, which is the thing being copied.
  const now = 1_000_000;
  assert.equal(gutterGlyph({ up: true, changedAt: now, now }), 'up');
  assert.equal(gutterGlyph({ up: false, changedAt: now, now }), 'down');
  assert.equal(GUTTER_GLYPH.up, '↗');
  assert.equal(GUTTER_GLYPH.down, '↘');
  assert.equal(GUTTER_GLYPH.flat, '•');
  assert.equal(GUTTER_COLOUR.up, '#00A91C');
  assert.equal(GUTTER_COLOUR.down, '#D83933');
  assert.equal(GUTTER_COLOUR.flat, '#A1A1A1');
});

test('the grey dot covers both a stale price and one that has never arrived', () => {
  // MetaTrader shows the dot on exactly those rows: XAUUSD and USDRUB in its own screenshot are
  // both stale by their Time column and both carry the dot.
  assert.equal(gutterGlyph({ up: true, changedAt: 0, now: 60_000 }), 'flat');
  assert.equal(gutterGlyph({ up: null, changedAt: null, now: 1 }), 'flat');
});

test("the phone's corner triangle is about MONEY, and the gutter arrow about the price", () => {
  /**
   * These two markers were conflated: the phone Quotes row was drawing the DESKTOP grid's
   * tick-direction arrow, which MetaTrader does not put on a phone at all. They state different
   * facts and they are deliberately different colours, so the test holds both at once — a later
   * reading of one document alone cannot quietly make them the same marker again.
   */
  assert.equal(POSITION_MARK_COLOUR.profit, '#1C5FE9', '04-mobile-app.md 81, measured');
  assert.notEqual(POSITION_MARK_COLOUR.profit, GUTTER_COLOUR.up);
  // Green is the one colour this marker can never be: MT5 mobile reserves green for Take Profit
  // (04-mobile-app.md 594-596), and the desktop gutter's green arrow is about the price moving.
  assert.notEqual(POSITION_MARK_COLOUR.profit, '#00A91C');
  assert.notEqual(POSITION_MARK_COLOUR.loss, '#00A91C');
});

test('breaking even is blue, because MetaTrader has two states here and not three', () => {
  assert.equal(positionMark(1), 'profit');
  assert.equal(positionMark(0), 'profit', 'zero is not a loss');
  assert.equal(positionMark(-1), 'loss');
});
