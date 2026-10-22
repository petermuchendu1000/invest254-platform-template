import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useLevelsStore } from './levelsStore.js';
import { priceOfPoints } from './levels.js';

const reset = () => useLevelsStore.setState({
  levels: { slPoints: null, tpPoints: null }, ref: null, locked: false,
});

test('the first price a level is set against becomes the anchor, and later edits keep it', () => {
  reset();
  const { set } = useLevelsStore.getState();
  set({ slPoints: -100, tpPoints: 200 }, 3050.00);
  assert.equal(useLevelsStore.getState().ref, 3050.00);
  // The market moves and the trader nudges the stop. The anchor must NOT move with it: a stop is a
  // price, and re-basing it on the new price is what made it crawl down the chart.
  set({ slPoints: -110, tpPoints: 200 }, 3051.37);
  assert.equal(useLevelsStore.getState().ref, 3050.00);
});

test('a level reads at the same price however many times the market has ticked', () => {
  reset();
  const { set } = useLevelsStore.getState();
  set({ slPoints: -100, tpPoints: null }, 3050.00);
  const first = priceOfPoints(useLevelsStore.getState().ref ?? 0, -100, 2);
  for (const tick of [3050.5, 3049.1, 3062.4, 3031.9]) {
    // Every surface offers the live price as the anchor on every write, exactly as the chart and
    // the dialog do; the store is what keeps them agreeing about where the stop is.
    set(useLevelsStore.getState().levels, tick);
  }
  assert.equal(priceOfPoints(useLevelsStore.getState().ref ?? 0, -100, 2), first);
  assert.equal(first, 3049.00);
});

test('clearing both levels drops the anchor, so the next pair is placed against the live price', () => {
  reset();
  const { set } = useLevelsStore.getState();
  set({ slPoints: -100, tpPoints: 200 }, 3050.00);
  set({ slPoints: null, tpPoints: null }, 3050.00);
  assert.equal(useLevelsStore.getState().ref, null);
  set({ slPoints: -100, tpPoints: null }, 3200.00);
  assert.equal(useLevelsStore.getState().ref, 3200.00);
});

test('a level set before the first quote anchors on the first price offered, not on zero', () => {
  reset();
  const { set } = useLevelsStore.getState();
  // No quote yet: a surface has nothing to offer and the pair holds a distance with no anchor.
  set({ slPoints: -100, tpPoints: null }, null);
  assert.equal(useLevelsStore.getState().ref, null);
  set({ slPoints: -100, tpPoints: null }, 3050.00);
  assert.equal(useLevelsStore.getState().ref, 3050.00);
});
