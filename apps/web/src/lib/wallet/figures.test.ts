import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletFigures } from './figures.js';

test('real mode: withdrawable = real cash; total = cash + bonus', () => {
  const f = walletFigures({ real: 5000, bonus: 100, mode: 'real', realBalance: 5000, bonusBalance: 100, demoBalance: 1_000_000 });
  assert.deepEqual(f, { demo: false, canWithdraw: true, realTotal: 5100, withdrawable: 5000, realCash: 5000, demoBalance: 1_000_000 });
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
  assert.deepEqual(walletFigures(undefined), { demo: false, canWithdraw: false, realTotal: 0, withdrawable: 0, realCash: 0, demoBalance: 0 });
});

// ── DEMO-3: canWithdraw is the ONE gate every surface asks before offering a way out ─────────────
// Every Withdraw button, tab, menu item and tap target reads this. If it is ever true on a demo
// wallet, play money becomes presentable as cashable somewhere in the UI.

test('canWithdraw is false on the demo account, whatever the demo balance is', () => {
  for (const demoBalance of [0, 1, 1_000_000, 9_999_999_999]) {
    const f = walletFigures({ real: demoBalance, bonus: 0, mode: 'demo', realBalance: 500_000, bonusBalance: 20_000, demoBalance });
    assert.equal(f.canWithdraw, false, `demo balance ${demoBalance} must never be offered a withdrawal`);
    assert.equal(f.withdrawable, 0);
  }
});

test('canWithdraw is false while the wallet is still unknown', () => {
  // Which account is active decides whether money can leave, so nothing is offered before the answer
  // is in — a Withdraw button that appears and then vanishes is exactly the hint this removes.
  assert.equal(walletFigures(undefined).canWithdraw, false);
  assert.equal(walletFigures(null).canWithdraw, false);
});

test('canWithdraw is true on the real account, even at a zero balance', () => {
  // Nothing to take out is not the same as no way out: the form states the minimum and the balance.
  const f = walletFigures({ real: 0, bonus: 0, mode: 'real', realBalance: 0, bonusBalance: 0, demoBalance: 1_000_000 });
  assert.equal(f.canWithdraw, true);
  assert.equal(f.withdrawable, 0);
});

test('canWithdraw is true for a demo-locked marketer (their payout IS the demo transfer)', () => {
  const f = walletFigures({ real: 200_000, bonus: 0, mode: 'demo', modeLocked: true, realBalance: 0, demoBalance: 200_000 });
  assert.equal(f.canWithdraw, true, 'marketers are demo-locked by design and keep their own transfer');
});

test('a wallet with no mode field (pre-0123 API) is treated as real', () => {
  const f = walletFigures({ real: 5000, bonus: 0 });
  assert.equal(f.demo, false);
  assert.equal(f.canWithdraw, true);
});

test('canWithdraw never disagrees with withdrawable being spendable', () => {
  // The invariant the surfaces rely on: if a withdrawal may be offered at all, the figure it is
  // offered against is the REAL cash — never the demo balance.
  const cases = [
    { real: 5000, bonus: 100, mode: 'real' as const, realBalance: 5000, bonusBalance: 100, demoBalance: 1_000_000 },
    { real: 1_000_000, bonus: 0, mode: 'demo' as const, realBalance: 5000, bonusBalance: 0, demoBalance: 1_000_000 },
    { real: 200_000, bonus: 0, mode: 'demo' as const, modeLocked: true, realBalance: 0, demoBalance: 200_000 },
  ];
  for (const w of cases) {
    const f = walletFigures(w);
    if (!f.canWithdraw) assert.equal(f.withdrawable, 0, 'nothing is withdrawable when no withdrawal may be offered');
    if (f.demo) assert.equal(f.canWithdraw, false, 'a demo player is never offered a withdrawal');
  }
});
