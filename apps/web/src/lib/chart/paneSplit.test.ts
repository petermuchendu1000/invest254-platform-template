import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHROME_PX, MAX_PANEL_FRACTION, MIN_CHART_PX, MIN_PANEL_PX, clampPanelHeight } from './paneSplit.js';

/**
 * The splitter's whole job is that neither pane can be destroyed by a drag: the Toolbox must stay
 * readable and the chart must stay a chart. These are the clamp's promises, not its arithmetic.
 */
const TALL = 900; // a desktop window
const SHORT = 420; // a short phone in landscape

test('a comfortable drag is honoured exactly', () => {
  assert.equal(clampPanelHeight(300, TALL), 300);
});

test('the panel never falls below a readable height', () => {
  assert.equal(clampPanelHeight(10, TALL), MIN_PANEL_PX);
  assert.equal(clampPanelHeight(-500, TALL), MIN_PANEL_PX);
});

test('the chart always keeps its minimum', () => {
  const px = clampPanelHeight(10_000, TALL);
  assert.ok(TALL - CHROME_PX - px >= MIN_CHART_PX, `chart left with ${TALL - CHROME_PX - px}px`);
});

test('a drag that asks for the whole screen cannot bury the chart', () => {
  assert.ok(clampPanelHeight(10_000, TALL) <= Math.round(TALL * MAX_PANEL_FRACTION));
});

test('on a short screen the panel still gets a usable share', () => {
  // 420 - 100 - 160 = 160 of room, under the 68% cap (285), so room is the binding limit.
  assert.equal(clampPanelHeight(10_000, SHORT), 160);
});

test('on a screen too short for both minimums the panel keeps its floor rather than vanishing', () => {
  // 300 - 100 - 160 = 40 of room, which is less than the panel's floor: a pane with no height is a
  // broken pane, not a small one, so the floor wins and the chart scrolls.
  assert.equal(clampPanelHeight(10_000, 300), MIN_PANEL_PX);
});

test('the clamp is stable: re-clamping a clamped value changes nothing', () => {
  for (const v of [-10, 0, MIN_PANEL_PX, 300, 10_000]) {
    const once = clampPanelHeight(v, TALL);
    assert.equal(clampPanelHeight(once, TALL), once, `unstable at ${v}`);
  }
});
