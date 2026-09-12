import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payoutForStake, stakeForPayout } from './digitPayout.js';

const F = 0.95; // engine's DIGIT default payout factor (5% edge)

// ── Formula correctness against the documented model ─────────────────────────────────────────────
test('payoutForStake: even/odd (winProb 0.5) returns stake x 1.9', () => {
  assert.equal(payoutForStake(20000, 0.5, F), 38000); // KES 200 -> KES 380
});

test('payoutForStake: matches (winProb 0.1) returns ~9.5x', () => {
  assert.equal(payoutForStake(1000, 0.1, F), 9500);
});

test('stakeForPayout is the exact inverse (even/odd)', () => {
  assert.equal(stakeForPayout(38000, 0.5, F), 20000);
});

test('stakeForPayout: target payout on matches resolves a small stake', () => {
  // Want KES 95 back on a matches (0.1) contract -> stake = 9500 * 0.1 / 0.95 = 1000 cents
  assert.equal(stakeForPayout(9500, 0.1, F), 1000);
});

// ── Totality: hostile input yields 0, never throws (winProb 0 = Over 9 barrier, etc.) ────────────
test('non-positive / non-finite inputs yield 0', () => {
  for (const fn of [payoutForStake, stakeForPayout]) {
    assert.equal(fn(0, 0.5, F), 0);
    assert.equal(fn(-100, 0.5, F), 0);
    assert.equal(fn(Number.NaN, 0.5, F), 0);
    assert.equal(fn(1000, 0, F), 0);      // winProb 0 (impossible pick)
    assert.equal(fn(1000, 0.5, 0), 0);    // factor 0
  }
});

// ── Round-trip stability: payout(stake(payout)) stays within rounding of the target ──────────────
test('fuzz: stake<->payout round-trips within 1 cent of rounding', () => {
  let seed = 424242;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const probs = [0.5, 0.1, 0.9, 0.4, 0.6, 0.2, 0.8, 0.3, 0.7];
  for (let i = 0; i < 5000; i++) {
    const winProb = probs[Math.floor(rand() * probs.length)]!;
    const targetPayout = 100 + Math.floor(rand() * 5_000_000); // KES 1 .. 50,000
    const stake = stakeForPayout(targetPayout, winProb, F);
    const back = payoutForStake(stake, winProb, F);
    // Two roundings (payout->stake->payout) can drift at most ~ 1/winProb cents; assert a safe bound.
    assert.ok(Math.abs(back - targetPayout) <= Math.ceil(1 / winProb) + 1,
      `drift too big: winProb=${winProb} target=${targetPayout} stake=${stake} back=${back}`);
  }
});
