import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOBILE_TF_GROUPS, MAX_QUICK_TF, DEFAULT_QUICK_TF, mobileTfLabel, useQuickTfStore,
} from './mobileTimeframes.js';
import { TIMEFRAME_KEYS, type Timeframe } from '@invest254/shared/candles';

test("the groups are MetaTrader's three and they add to its documented 21", () => {
  assert.deepEqual(MOBILE_TF_GROUPS.map((g) => g.label), ['Minutes', 'Hours', 'Days']);
  assert.deepEqual(MOBILE_TF_GROUPS.map((g) => g.items.length), [11, 7, 3]);
  assert.equal(MOBILE_TF_GROUPS.reduce((n, g) => n + g.items.length, 0), 21);
});

test('every period this chart can draw is in exactly one group, and nothing invented is', () => {
  const listed = MOBILE_TF_GROUPS.flatMap((g) => [...g.items]);
  assert.equal(new Set(listed).size, listed.length, 'a period is in two groups');
  assert.deepEqual([...listed].sort(), [...TIMEFRAME_KEYS].sort());
});

test('MN1 prints as MN, because that is what MetaTrader’s own strip says', () => {
  assert.equal(mobileTfLabel('MN1'), 'MN');
  assert.equal(mobileTfLabel('M30'), 'M30');
  assert.equal(mobileTfLabel('H4'), 'H4');
});

test("the default strip is MetaQuotes' own example, and fits under the ceiling", () => {
  assert.deepEqual([...DEFAULT_QUICK_TF], ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']);
  assert.ok(DEFAULT_QUICK_TF.length <= MAX_QUICK_TF);
  assert.equal(MAX_QUICK_TF, 9);
});

test('a long-press adds a period, and the strip stays in period order', () => {
  useQuickTfStore.setState({ quick: DEFAULT_QUICK_TF });
  useQuickTfStore.getState().toggle('H12');
  // Tapped last, but it belongs between H4 and D1: a strip that read "... H4 D1 W1 H12" would be
  // unreadable, and MetaTrader's never does.
  assert.deepEqual([...useQuickTfStore.getState().quick], ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'H12', 'D1', 'W1']);
});

test('the strip refuses a tenth period rather than silently dropping one', () => {
  useQuickTfStore.setState({ quick: DEFAULT_QUICK_TF });
  useQuickTfStore.getState().toggle('H12'); // 9 — the ceiling
  assert.equal(useQuickTfStore.getState().quick.length, MAX_QUICK_TF);
  useQuickTfStore.getState().toggle('M2'); // 10 — refused
  assert.equal(useQuickTfStore.getState().quick.length, MAX_QUICK_TF);
  assert.ok(!useQuickTfStore.getState().quick.includes('M2'));
});

test('a second long-press takes it off again', () => {
  useQuickTfStore.setState({ quick: DEFAULT_QUICK_TF });
  useQuickTfStore.getState().toggle('W1');
  assert.ok(!useQuickTfStore.getState().quick.includes('W1'));
});

test('the last period cannot be removed, because the gear would become the only way to switch', () => {
  useQuickTfStore.setState({ quick: ['H1'] as readonly Timeframe[] });
  useQuickTfStore.getState().toggle('H1');
  assert.deepEqual([...useQuickTfStore.getState().quick], ['H1']);
});
