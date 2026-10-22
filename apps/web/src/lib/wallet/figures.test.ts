import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletFigures, shortfallAction, type WalletLike } from './figures.js';

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

test('marketer on their Real tab: Real=funny money (withdrawable), Demo=the separate practice bucket', () => {
  // 0176: funny money lives in demo_balance and is surfaced as the Real tab; practice_balance is the
  // Demo tab. On Real (marketerPractice=false) the funny money is withdrawable via the marketer transfer.
  const f = walletFigures({ real: 200_000, bonus: 0, mode: 'demo', modeLocked: true, marketerPractice: false, realBalance: 0, demoBalance: 200_000, practiceBalance: 40_000 });
  assert.equal(f.demo, false);
  assert.equal(f.canWithdraw, true);
  assert.equal(f.realTotal, 200_000, 'Real tab shows the funny money');
  assert.equal(f.withdrawable, 200_000);
  assert.equal(f.demoBalance, 40_000, 'Demo tab shows the practice bucket, not the funny money');
});

test('marketer on their Demo (practice) tab: never withdrawable, like a player in demo', () => {
  const f = walletFigures({ real: 40_000, bonus: 0, mode: 'demo', modeLocked: true, marketerPractice: true, realBalance: 0, demoBalance: 200_000, practiceBalance: 40_000 });
  assert.equal(f.demo, true, 'on practice the account presents as demo');
  assert.equal(f.canWithdraw, false, 'practice money is never withdrawable');
  assert.equal(f.withdrawable, 0);
  assert.equal(f.realTotal, 200_000, 'the Real tab still shows the funny money');
  assert.equal(f.demoBalance, 40_000, 'the Demo tab shows the practice bucket');
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

// ── a shortfall must refill the bucket actually being played ─────────────────────────────────────

test('shortfallAction: a player refills their demo, or deposits on real', () => {
  assert.equal(shortfallAction({ real: 100, bonus: 0, mode: 'demo', demoBalance: 100 }), 'refill-demo');
  assert.equal(shortfallAction({ real: 100, bonus: 0, mode: 'real', realBalance: 100 }), 'deposit');
});

test('shortfallAction: a marketer on funny money refills THAT, not the practice bucket', () => {
  // The bug: wallet.mode is permanently 'demo' here, so the old condition refilled the practice
  // bucket — one the player is not spending from — and reported success.
  const onFunny = { real: 100, bonus: 0, mode: 'demo' as const, modeLocked: true, marketerPractice: false, demoBalance: 100, practiceBalance: 0 };
  assert.equal(onFunny.mode, 'demo', 'the raw field really does say demo');
  assert.equal(shortfallAction(onFunny), 'refill-marketer');
});

test('shortfallAction: a marketer on practice refills the demo bucket, like any demo', () => {
  const onPractice = { real: 100, bonus: 0, mode: 'demo' as const, modeLocked: true, marketerPractice: true, demoBalance: 500, practiceBalance: 100 };
  assert.equal(shortfallAction(onPractice), 'refill-demo');
});

test('shortfallAction: a marketer is never sent to the deposit sheet', () => {
  // They have no real-money path at all, so offering one would be a dead end.
  for (const practice of [false, true]) {
    const w = { real: 100, bonus: 0, mode: 'demo' as const, modeLocked: true, marketerPractice: practice };
    assert.notEqual(shortfallAction(w), 'deposit', `practice=${practice}`);
  }
});

test('shortfallAction: an unknown wallet never offers to spend real money', () => {
  assert.equal(shortfallAction(undefined), 'deposit');
  // …and `deposit` is the safe default only because it ASKS; it moves nothing on its own.
});

test('shortfallAction: it always agrees with walletFigures about what a demo is', () => {
  const wallets: WalletLike[] = [
    { real: 1, bonus: 0, mode: 'real' },
    { real: 1, bonus: 0, mode: 'demo' },
    { real: 1, bonus: 0, mode: 'demo', modeLocked: true, marketerPractice: false },
    { real: 1, bonus: 0, mode: 'demo', modeLocked: true, marketerPractice: true },
  ];
  for (const w of wallets) {
    assert.equal(shortfallAction(w) === 'refill-demo', walletFigures(w).demo, JSON.stringify(w));
  }
});

// ── "DEMO" is a WORD ON SCREEN, and a marketer must never see it on their own money ─────────────

/**
 * The bug this pins: `wallet.mode` is permanently 'demo' for a marketer, because their stakes spend
 * the demo bucket (migration 0084). Any surface that asks `wallet.mode === 'demo'` to decide what to
 * LABEL the account therefore tags every marketer DEMO and names their server "<Brand>-Demo" — on
 * the screen they hold up on a live stream. `figures.demo` is the only correct answer, and it is
 * `marketerPractice` for a marketer.
 */
const marketerOnFunnyMoney = {
  real: 149_242, bonus: 0, mode: 'demo' as const, modeLocked: true, marketerPractice: false,
  realBalance: 0, demoBalance: 149_242, practiceBalance: 0,
};

test('a marketer on their own money is NOT a demo account, though wallet.mode says demo', () => {
  assert.equal(marketerOnFunnyMoney.mode, 'demo', 'the raw field really does say demo');
  assert.equal(walletFigures(marketerOnFunnyMoney).demo, false, 'but the account is not a demo one');
});

test('a marketer and a player on their live account agree: neither is demo', () => {
  const player = walletFigures({ real: 149_242, bonus: 0, mode: 'real', realBalance: 149_242 });
  assert.equal(walletFigures(marketerOnFunnyMoney).demo, player.demo);
});

test('a marketer DOES get a demo (their practice bucket) and it reads as one', () => {
  const onPractice = walletFigures({ ...marketerOnFunnyMoney, marketerPractice: true, practiceBalance: 1_000_000 });
  assert.equal(onPractice.demo, true, 'the practice tab is the demo account');
  assert.equal(onPractice.canWithdraw, false, 'and it is play money, so there is no way out of it');
  assert.equal(onPractice.demoBalance, 1_000_000);
});

test('both account types have a demo to switch to, and it is never the live balance', () => {
  // The point of "a demo both players and marketers can use": each has a second, separate,
  // non-withdrawable balance, and neither one's demo is the other's live money.
  const player = walletFigures({ real: 1_000_000, bonus: 0, mode: 'demo', realBalance: 500_000, demoBalance: 1_000_000 });
  const marketer = walletFigures({ ...marketerOnFunnyMoney, marketerPractice: true, practiceBalance: 1_000_000 });
  for (const [who, f] of [['player', player], ['marketer', marketer]] as const) {
    assert.equal(f.demo, true, `${who} is on demo`);
    assert.equal(f.canWithdraw, false, `${who}'s demo offers no way out`);
    assert.equal(f.withdrawable, 0, `${who} has nothing withdrawable while on demo`);
    assert.ok(f.demoBalance > 0, `${who} has a funded demo balance`);
    assert.notEqual(f.demoBalance, f.realCash, `${who}'s demo is a separate balance from their live one`);
  }
});
