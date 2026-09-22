import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOnline, seedOnline, isStaffRole, ONLINE_MIN, ONLINE_MAX } from './onlineDisplay.js';

test('isStaffRole: only admin/superadmin are staff', () => {
  assert.equal(isStaffRole('admin'), true);
  assert.equal(isStaffRole('platform_superadmin'), true);
  assert.equal(isStaffRole('player'), false);
  assert.equal(isStaffRole('marketer'), false);
  assert.equal(isStaffRole(undefined), false);
  assert.equal(isStaffRole(null), false);
});

test('seedOnline stays within bounds across many draws', () => {
  for (let i = 0; i < 10_000; i++) {
    const v = seedOnline();
    assert.ok(v >= ONLINE_MIN && v <= ONLINE_MAX, `seed ${v} out of range`);
  }
});

test('nextOnline never leaves [MIN, MAX] even from the edges', () => {
  // Drive the walk with random steps starting from each edge and the middle.
  for (const start of [ONLINE_MIN, ONLINE_MAX, 575]) {
    let v = start;
    for (let i = 0; i < 50_000; i++) {
      v = nextOnline(v);
      assert.ok(v >= ONLINE_MIN && v <= ONLINE_MAX, `value ${v} out of range at step ${i}`);
    }
  }
});

test('nextOnline reflects back inward when it would exceed a bound', () => {
  // Force a big positive step from just under MAX -> must clamp below MAX.
  const overshoot = nextOnline(ONLINE_MAX - 1, ONLINE_MIN, ONLINE_MAX, () => 1);
  assert.ok(overshoot <= ONLINE_MAX);
  // Force a big negative step from just above MIN -> must clamp above MIN.
  const undershoot = nextOnline(ONLINE_MIN + 1, ONLINE_MIN, ONLINE_MAX, () => 0);
  assert.ok(undershoot >= ONLINE_MIN);
});

test('nextOnline actually moves (variation, not a constant)', () => {
  let v = 575;
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    v = nextOnline(v);
    seen.add(v);
  }
  assert.ok(seen.size > 5, 'expected the count to vary over time');
});
