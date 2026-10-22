import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  atLiveEdge, widthOf, liveWindow, clampBars, zoomedWindow,
  EDGE_SLACK_BARS, RIGHT_OFFSET_BARS, MIN_BARS, MAX_BARS,
} from './follow.js';

test('a view at the last bar is following; one scrolled back into history is not', () => {
  const n = 500;
  assert.equal(atLiveEdge({ from: 380, to: 499 }, n), true);
  assert.equal(atLiveEdge({ from: 100, to: 220 }, n), false);
});

test('the gap MetaTrader leaves past the last candle still counts as following', () => {
  // The right offset puts `to` BEYOND the last index. That is the normal following state, not
  // "adrift to the right".
  const n = 500;
  assert.equal(atLiveEdge({ from: 382, to: 499 + RIGHT_OFFSET_BARS }, n), true);
});

test('a couple of bars of slack counts as following, so a pixel of drift does not stop it', () => {
  const n = 500;
  assert.equal(atLiveEdge({ from: 380, to: 499 - EDGE_SLACK_BARS }, n), true);
  assert.equal(atLiveEdge({ from: 380, to: 499 - EDGE_SLACK_BARS - 1 }, n), false);
});

test('an empty chart and a missing range both count as following, so the first paint lands live', () => {
  assert.equal(atLiveEdge(null, 0), true);
  assert.equal(atLiveEdge(null, 500), true);
  assert.equal(atLiveEdge({ from: 0, to: 0 }, 0), true);
});

test('a new bar shifts the window by one bar and does NOT change its width', () => {
  // This is the bug in one assertion: the old snap forced 120 bars whatever the trader had chosen.
  const width = 23;                       // zoomed right in on a handful of candles
  const before = liveWindow(500, width);
  const after = liveWindow(501, width);   // one new bar
  assert.equal(after.to - after.from, before.to - before.from, 'the width must survive a new bar');
  assert.equal(after.to - before.to, 1, 'and the view moves by exactly the one bar that appeared');
  assert.equal(after.from - before.from, 1);
});

test('the live window ends at the last bar plus MetaTrader’s right offset', () => {
  const w = liveWindow(500, 120);
  assert.equal(w.to, 499 + RIGHT_OFFSET_BARS);
  assert.equal(w.from, w.to - 120);
});

test('a window keeps its own width whatever the fallback is', () => {
  assert.equal(widthOf({ from: 100, to: 160 }, 120), 60);
  assert.equal(widthOf(null, 120), 120);
  // A degenerate range cannot yield a zero width, which would divide by zero downstream.
  assert.equal(widthOf({ from: 50, to: 50 }, 120), 1);
  assert.equal(widthOf({ from: 50, to: 10 }, 120), 1);
});

test('zooming holds the right edge still, so the candle being read does not move', () => {
  const range = { from: 400, to: 500 };
  const zoomed = zoomedWindow(range, 40, 500);
  assert.equal(zoomed.to, 500, 'the right edge is fixed');
  assert.equal(zoomed.to - zoomed.from, 40);
});

test('zooming with no range yet falls back to the live window', () => {
  assert.deepEqual(zoomedWindow(null, 60, 500), liveWindow(500, 60));
});

test('a zoom level is clamped to what the chart will draw', () => {
  assert.equal(clampBars(1), MIN_BARS);
  assert.equal(clampBars(100_000), MAX_BARS);
  assert.equal(clampBars(120.4), 120);
});

test('following is DERIVED, so scrolling back and forward resumes it without a mode to toggle', () => {
  const n = 500;
  let range = liveWindow(n, 50);
  assert.equal(atLiveEdge(range, n), true);
  // Scroll 200 bars back into history: no longer following, and nothing had to be switched off.
  range = { from: range.from - 200, to: range.to - 200 };
  assert.equal(atLiveEdge(range, n), false);
  // Scroll forward to the edge again: following, and nothing had to be switched on.
  range = liveWindow(n, 50);
  assert.equal(atLiveEdge(range, n), true);
});
