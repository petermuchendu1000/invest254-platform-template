import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletFigures } from './figures.js';

test('real mode: withdrawable = real cash; total = cash + bonus', () => {
  const f = walletFigures({ real: 5000, bonus: 100, mode: 'real', realBalance: 5000, bonusBalance: 100, demoBalance: 1_000_000 });
  assert.deepEqual(f, { demo: false, realTotal: 5100, withdrawable: 5000, realCash: 5000, demoBalance: 1_000_000 });
});

test('demo mode: the demo balance is NEVER withdrawable (BUGLOG #82)', () => {
  const f = walletFigures({ real: 1_000_000, bonus: 0, mode: 'demo', realBalance: 5000, bonusBalance: 100, demoBalance: 1_000_000 });
  assert.equal(f.demo, true);
  assert.equal(f.withdrawable, 0);
  assert.equal(f.realCash, 5000);
  assert.equal(f.realTotal, 5100);
  assert.equal(f.demoBalance, 1_000_000);
});

test('demo mode on an older API without buckets: nothing withdrawable', () => {
  const f = walletFigures({ real: 1_000_000, bonus: 0, mode: 'demo' });
  assert.equal(f.withdrawable, 0);
  assert.equal(f.realTotal, 0);
  assert.equal(f.demoBalance, 1_000_000);
});

test('marketer (demo-locked) keeps the demo transfer', () => {
  const f = walletFigures({ real: 200_000, bonus: 0, mode: 'demo', modeLocked: true, realBalance: 0, demoBalance: 200_000 });
  assert.equal(f.demo, false);
  assert.equal(f.withdrawable, 200_000);
});

test('no wallet yet', () => {
  assert.deepEqual(walletFigures(undefined), { demo: false, realTotal: 0, withdrawable: 0, realCash: 0, demoBalance: 0 });
});
