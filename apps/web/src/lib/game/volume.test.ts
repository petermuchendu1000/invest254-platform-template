import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useVolumeStore } from './volume.js';

test('the volume starts unchosen, which is not the same as zero', () => {
  useVolumeStore.setState({ lots: null });
  assert.equal(useVolumeStore.getState().lots, null);
});

test('one store, so every surface that can place an order reads the same volume', () => {
  // The bug this exists for: the chart's one-click panel and the order ticket each held their own
  // `useState`, so stepping the panel to 0.10 and tapping BUY opened a ticket on the brand's
  // minimum. Two readers, one value.
  useVolumeStore.setState({ lots: null });
  useVolumeStore.getState().set(0.1);
  assert.equal(useVolumeStore.getState().lots, 0.1);
  useVolumeStore.getState().set(0.025);
  assert.equal(useVolumeStore.getState().lots, 0.025);
});
