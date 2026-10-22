import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  swipeAxis, swipeOutcome, swipeOffset, shortcutAt, barWidthOf,
  OPEN_AT, AXIS_AT, SWIPE_ICON_W,
} from './swipe.js';

/** The two bars this shell draws: iOS's two commands on a Quotes row, Android's five on a position. */
const QUOTES = barWidthOf(2);
const POSITION = barWidthOf(5);

test('a gesture too small to read has no axis yet', () => {
  assert.equal(swipeAxis(0, 0), null);
  assert.equal(swipeAxis(AXIS_AT - 1, AXIS_AT - 1), null);
});

test('the axis is whichever the gesture has travelled further along', () => {
  assert.equal(swipeAxis(-30, 4), 'x');
  assert.equal(swipeAxis(-4, 30), 'y');
  // A list scrolls vertically, so a gesture on the line gives the list the benefit: equal travel
  // is not a swipe.
  assert.equal(swipeAxis(-20, 20), 'y');
});

test('a short drag springs back and runs nothing', () => {
  assert.equal(swipeOutcome(-1, POSITION), 'closed');
  assert.equal(swipeOutcome(-(OPEN_AT - 1), POSITION), 'closed');
});

test('past the first threshold the bar opens, and the threshold is the same on both bars', () => {
  assert.equal(swipeOutcome(-OPEN_AT, POSITION), 'open');
  assert.equal(swipeOutcome(-OPEN_AT, QUOTES), 'open');
});

test("past the second, MetaTrader's drag-further-left fires the last command", () => {
  assert.equal(swipeOutcome(-shortcutAt(POSITION), POSITION), 'shortcut');
  assert.equal(swipeOutcome(-(shortcutAt(POSITION) - 1), POSITION), 'open');
});

test('the shortcut always sits beyond the open bar, however many commands it holds', () => {
  // A fixed threshold short of the widest bar meant a trader dragging that bar fully open tripped
  // the shortcut just by reaching its last icon.
  for (const n of [1, 2, 3, 5, 6]) {
    const w = barWidthOf(n);
    assert.ok(shortcutAt(w) > w, `${n} commands: ${shortcutAt(w)} must clear ${w}`);
    assert.equal(swipeOutcome(-w, w), 'open');
  }
});

test('and it scales, so a two-icon row is not a drag across the whole screen', () => {
  assert.ok(shortcutAt(QUOTES) < shortcutAt(POSITION));
  // Reachable on the narrowest phone this shell is built for, from near the row's right edge.
  assert.ok(shortcutAt(POSITION) + 40 < 360, `${shortcutAt(POSITION)} must be reachable at 360px`);
});

test('a rightward drag on a closed row does nothing, because there is no bar on that side', () => {
  assert.equal(swipeOutcome(120, POSITION), 'closed');
  assert.equal(swipeOffset(120, POSITION), 0);
});

test('the row never slides further than just past the shortcut', () => {
  assert.equal(swipeOffset(-50, POSITION), 50);
  assert.equal(swipeOffset(-10_000, POSITION), shortcutAt(POSITION) + 40);
});

test('one icon is wide enough to tap', () => {
  // This app enforces a 44px minimum on controls that move money, and closing a position is one.
  assert.ok(SWIPE_ICON_W >= 44);
});
