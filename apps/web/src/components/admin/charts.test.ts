import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trendDelta } from './charts';

test('UI-C: a trend from nothing is "new", never a fake +100%', () => {
  assert.deepEqual(trendDelta([0, 0, 0, 0, 0, 5]), { deltaPct: null, isNew: true });
  assert.deepEqual(trendDelta([0, 0, 0, 0]), { deltaPct: null, isNew: false });
  assert.deepEqual(trendDelta([1, 2, 3]), { deltaPct: null, isNew: false }, 'too short to compare');
  assert.deepEqual(trendDelta([10, 10, 5, 5]), { deltaPct: -50, isNew: false });
  assert.deepEqual(trendDelta([-10, 0, 10, 0]), { deltaPct: 200, isNew: false }, 'negative base uses its magnitude');
});
