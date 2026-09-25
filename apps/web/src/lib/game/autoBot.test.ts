import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterSettle, nextAuto, runPnl, startRun, type AutoConfig } from './autoBot.js';

const cfg = (o: Partial<AutoConfig> = {}): AutoConfig => ({
  baseCents: 50_000, multiplier: 2, targetCents: 200_000, stopLossCents: 100_000, minCents: 25_000, maxCents: 5_000_000, balanceCents: 1_000_000, ...o,
});

test('a new run starts from zero even after a finished run (BUGLOG #84)', () => {
  const sessionPnl = 250_000;                       // an earlier run already hit its target
  const run = startRun(sessionPnl);
  assert.equal(runPnl(run, sessionPnl), 0);
  assert.deepEqual(nextAuto(run, sessionPnl, cfg()), { kind: 'place', stakeCents: 50_000 });
});

test('target and stop-loss are measured on the run', () => {
  const run = startRun(-400_000);
  assert.deepEqual(nextAuto(run, -200_000, cfg()), { kind: 'stop', reason: 'target' });
  assert.deepEqual(nextAuto(run, -500_000, cfg()), { kind: 'stop', reason: 'stoploss' });
  assert.equal(nextAuto(run, -450_000, cfg()).kind, 'place');
});

test('martingale doubles after each loss and resets on a win', () => {
  let run = startRun(0);
  run = afterSettle(run, false); run = afterSettle(run, false);
  assert.deepEqual(nextAuto(run, -150_000, cfg({ stopLossCents: 0 })), { kind: 'place', stakeCents: 200_000 });
  run = afterSettle(run, true);
  assert.equal(run.lossStreak, 0); assert.equal(run.trades, 3);
  assert.deepEqual(nextAuto(run, 0, cfg()), { kind: 'place', stakeCents: 50_000 });
});

test('capped by the brand maximum and the balance; stops when it cannot cover the minimum', () => {
  const run = { ...startRun(0), lossStreak: 10 };
  assert.deepEqual(nextAuto(run, 0, cfg({ stopLossCents: 0, targetCents: 0 })), { kind: 'place', stakeCents: 1_000_000 });
  assert.deepEqual(nextAuto(run, 0, cfg({ stopLossCents: 0, targetCents: 0, balanceCents: 9_000_000 })), { kind: 'place', stakeCents: 5_000_000 });
  assert.deepEqual(nextAuto(startRun(0), 0, cfg({ balanceCents: 10_000 })), { kind: 'stop', reason: 'funds' });
});

test('a stake below the minimum never runs', () => {
  assert.deepEqual(nextAuto(startRun(0), 0, cfg({ baseCents: 1_000 })), { kind: 'stop', reason: 'stake' });
  assert.deepEqual(nextAuto(startRun(0), 0, cfg({ baseCents: Number.NaN })), { kind: 'stop', reason: 'stake' });
});

test('a silly multiplier or a long streak stays finite', () => {
  const run = { ...startRun(0), lossStreak: 5000 };
  const d = nextAuto(run, 0, cfg({ multiplier: 1e9, stopLossCents: 0, maxCents: undefined }));
  assert.deepEqual(d, { kind: 'place', stakeCents: 1_000_000 });
  assert.deepEqual(nextAuto(startRun(0), 0, cfg({ multiplier: 0.2 })), { kind: 'place', stakeCents: 50_000 });
});
