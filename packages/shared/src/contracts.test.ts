import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastDigit,
  digitWinProbability,
  evaluateDigit,
  digitReturnCents,
  settleDigit,
  multiplierPnlCents,
  stopoutPrice,
  dealCancellationFeeCents,
  evaluateMultiplier,
  seededWin,
  decideDigitAtWinRate,
  type DigitKind,
  type MultiplierState,
} from './contracts.js';

// ── Fairness: last digit of the authoritative quote ─────────────────────────────────────────────
test('lastDigit reads the final digit at pip precision', () => {
  assert.equal(lastDigit(9357.04), 4);
  assert.equal(lastDigit(9606.0), 0);
  assert.equal(lastDigit(9606.99), 9);
  assert.equal(lastDigit(100), 0);
  assert.equal(lastDigit(12.34), 4);
  assert.equal(lastDigit(Number.NaN), 0);
  assert.equal(lastDigit(4821.3, 1), 3); // 1-dp instrument
});

// ── Probabilities ───────────────────────────────────────────────────────────────────────────────
test('digit win probabilities match Deriv semantics', () => {
  assert.equal(digitWinProbability('even'), 0.5);
  assert.equal(digitWinProbability('odd'), 0.5);
  assert.equal(digitWinProbability('matches'), 0.1);
  assert.equal(digitWinProbability('differs'), 0.9);
  assert.equal(digitWinProbability('over', 5), 0.4); // digits 6,7,8,9
  assert.equal(digitWinProbability('under', 5), 0.5); // digits 0..4
  assert.equal(digitWinProbability('over', 9), 0); // impossible
  assert.equal(digitWinProbability('under', 0), 0); // impossible
});

// ── Outcome evaluation ──────────────────────────────────────────────────────────────────────────
test('evaluateDigit is correct for every contract type', () => {
  assert.equal(evaluateDigit('even', 0, 4), true);
  assert.equal(evaluateDigit('even', 0, 3), false);
  assert.equal(evaluateDigit('odd', 0, 7), true);
  assert.equal(evaluateDigit('over', 5, 6), true);
  assert.equal(evaluateDigit('over', 5, 5), false);
  assert.equal(evaluateDigit('under', 5, 4), true);
  assert.equal(evaluateDigit('under', 5, 5), false);
  assert.equal(evaluateDigit('matches', 7, 7), true);
  assert.equal(evaluateDigit('matches', 7, 6), false);
  assert.equal(evaluateDigit('differs', 7, 6), true);
  assert.equal(evaluateDigit('differs', 7, 7), false);
});

// ── Payout math ─────────────────────────────────────────────────────────────────────────────────
test('digitReturnCents = round(stake × factor / prob)', () => {
  assert.equal(digitReturnCents(1000, 'even'), 1900); // 1000*0.95/0.5
  assert.equal(digitReturnCents(1000, 'matches'), 9500); // 1000*0.95/0.1
  assert.equal(digitReturnCents(1000, 'differs'), 1056); // round(1000*0.95/0.9)
  assert.equal(digitReturnCents(1000, 'over', 3), 1583); // prob 0.6 → round(950/0.6)
  assert.equal(digitReturnCents(1000, 'over', 9), 0); // impossible → 0
});

test('settleDigit returns win/loss payout and net pnl', () => {
  const win = settleDigit(1000, 'even', 0, 4);
  assert.deepEqual([win.won, win.payoutCents, win.pnlCents], [true, 1900, 900]);
  const lose = settleDigit(1000, 'even', 0, 3);
  assert.deepEqual([lose.won, lose.payoutCents, lose.pnlCents], [false, 0, -1000]);
});

// ── RTP / house edge: uniform digits ⇒ mean player return ≈ factor − 1 ───────────────────────────
test('house edge holds across contract types (uniform-digit fuzz)', () => {
  // High-quality, deterministic PRNG so 10 digit buckets are genuinely uniform.
  function mulberry32(a: number) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(0x1234abcd);
  const factor = 0.95;
  const N = 400_000;
  const cases: Array<{ kind: DigitKind; target: number }> = [
    { kind: 'even', target: 0 },
    { kind: 'over', target: 3 },
    { kind: 'under', target: 6 },
    { kind: 'differs', target: 4 },
    { kind: 'matches', target: 4 },
  ];
  for (const c of cases) {
    const prob = digitWinProbability(c.kind, c.target);
    const ret = digitReturnCents(1000, c.kind, c.target, factor);
    // Analytic expected return as a fraction of stake (accounts for cent rounding of `ret`).
    const evFrac = (prob * (ret - 1000) + (1 - prob) * -1000) / 1000;
    assert.ok(evFrac < 0 && evFrac > -0.1, `${c.kind}: EV ${evFrac} not a sane house edge`);
    let sum = 0;
    for (let i = 0; i < N; i++) sum += settleDigit(1000, c.kind, c.target, Math.floor(rnd() * 10), factor).pnlCents;
    const meanReturn = sum / N / 1000;
    const tol = c.kind === 'matches' ? 0.03 : 0.01; // matches has high variance
    assert.ok(Math.abs(meanReturn - evFrac) < tol, `${c.kind}: empirical ${meanReturn.toFixed(4)} vs analytic ${evFrac.toFixed(4)}`);
  }
});

// ── Multipliers ─────────────────────────────────────────────────────────────────────────────────
test('multiplier P/L scales with move × multiplier and floors at −stake', () => {
  const up = { dir: 'up' as const, entry: 100, multiplier: 100, stakeCents: 1000 };
  assert.equal(multiplierPnlCents(up, 101), 1000); // +1% × 100 × 1000
  assert.equal(multiplierPnlCents(up, 99), -1000); // −1% × 100 → −stake (clamped)
  assert.equal(multiplierPnlCents(up, 98), -1000); // clamped, never worse than −stake
  const down = { dir: 'down' as const, entry: 100, multiplier: 100, stakeCents: 1000 };
  assert.equal(multiplierPnlCents(down, 99), 1000); // profit when price falls
  assert.equal(multiplierPnlCents(down, 101), -1000);
});

test('stop-out price and DC fee', () => {
  assert.equal(stopoutPrice('up', 100, 100), 99);
  assert.equal(stopoutPrice('down', 100, 100), 101);
  assert.equal(dealCancellationFeeCents(1000, 0), 0);
  assert.ok(dealCancellationFeeCents(1000, 15) > dealCancellationFeeCents(1000, 5));
});

test('evaluateMultiplier applies stop-out / TP / SL / deal-cancellation correctly', () => {
  const base: MultiplierState = { dir: 'up', entry: 100, multiplier: 100, stakeCents: 1000, tpCents: null, slCents: null, dcUntilMs: null, dcFeeCents: 0 };
  // Take profit
  assert.deepEqual(pick(evaluateMultiplier({ ...base, tpCents: 500 }, 100.5, 0)), { close: true, reason: 'tp', realizedCents: 500 });
  // Stop loss (no DC)
  assert.deepEqual(pick(evaluateMultiplier({ ...base, slCents: 500 }, 99.5, 0)), { close: true, reason: 'sl', realizedCents: -500 });
  // Stop-out at 100% loss
  assert.deepEqual(pick(evaluateMultiplier(base, 99, 0)), { close: true, reason: 'stopout', realizedCents: -1000 });
  // Deal cancellation active → the same stop-out becomes a cancel (refund minus fee), SL ignored
  const dc: MultiplierState = { ...base, slCents: 300, dcUntilMs: 10_000, dcFeeCents: 40 };
  assert.deepEqual(pick(evaluateMultiplier(dc, 99, 5_000)), { close: true, reason: 'cancel', realizedCents: -40 });
  assert.equal(evaluateMultiplier(dc, 99.6, 5_000).close, false); // SL suppressed while DC live
  // After DC expires, SL applies again
  assert.equal(evaluateMultiplier(dc, 99.6, 20_000).reason, 'sl');
});

test('fuzz: a multiplier can never realise worse than the stake', () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 50_000; i++) {
    const dir = rnd() < 0.5 ? 'up' : 'down';
    const mult = [100, 200, 300, 400, 1000][Math.floor(rnd() * 5)]!;
    const entry = 100 + rnd() * 9000;
    const cur = entry * (0.9 + rnd() * 0.2);
    const s: MultiplierState = { dir, entry, multiplier: mult, stakeCents: 1000, tpCents: null, slCents: null, dcUntilMs: null, dcFeeCents: 0 };
    const e = evaluateMultiplier(s, cur, 0);
    assert.ok(e.pnlCents >= -1000, `pnl ${e.pnlCents} < -stake`);
    assert.ok(e.realizedCents >= -1000, `realized ${e.realizedCents} < -stake`);
  }
});

function pick(e: { close: boolean; reason: unknown; realizedCents: number }) {
  return { close: e.close, reason: e.reason, realizedCents: e.realizedCents };
}

// ── DEMO/marketer deriv-ui win-rate strategy (docs/25 DEMO parity) ──────────────────────────────
test('seededWin: empirical rate matches the target win rate (deterministic, over many nonces)', () => {
  for (const wr of [0.1, 0.5, 0.8, 0.95]) {
    let wins = 0;
    const N = 20_000;
    for (let n = 0; n < N; n++) if (seededWin('day-seed', n, wr)) wins++;
    const rate = wins / N;
    assert.ok(Math.abs(rate - wr) < 0.02, `winRate ${wr}: empirical ${rate.toFixed(3)} should be within 0.02`);
  }
});

test('seededWin is deterministic in (seed, nonce, winRate)', () => {
  assert.equal(seededWin('s', 42, 0.8), seededWin('s', 42, 0.8));
});

test('seededWin clamps out-of-range rates', () => {
  let anyLoss = false, anyWin = false;
  for (let n = 0; n < 100; n++) { if (!seededWin('s', n, 0)) anyLoss = true; if (seededWin('s', n, 1)) anyWin = true; }
  assert.ok(anyLoss && !seededWin('s', 7, 0), 'winRate 0 never wins');
  assert.ok(anyWin && seededWin('s', 7, 1), 'winRate 1 always wins');
});

test('decideDigitAtWinRate: a marketer wins ~0.8 even on a 10%-natural "matches" contract, paid at fixed odds', () => {
  const N = 20_000; let wins = 0; let paid = 0;
  for (let n = 0; n < N; n++) {
    const r = decideDigitAtWinRate('seed', n, 'matches', 3, 0.8, 100_000, 0.95);
    if (r.won) { wins++; paid += r.payoutCents; }
    // the displayed digit must be CONSISTENT with the decided outcome
    assert.equal(evaluateDigit('matches', 3, r.digit), r.won, `digit ${r.digit} must match won=${r.won}`);
  }
  const rate = wins / N;
  assert.ok(Math.abs(rate - 0.8) < 0.02, `matches win rate ${rate.toFixed(3)} ≈ 0.8`);
  // fixed odds: a winning 'matches' pays stake × 0.95 / 0.1 = 9.5×
  assert.equal(decideDigitAtWinRate('seed', 0, 'matches', 3, 0.8, 100_000, 0.95).won
    ? decideDigitAtWinRate('seed', 0, 'matches', 3, 0.8, 100_000, 0.95).payoutCents : 0,
    (() => { const r = decideDigitAtWinRate('seed', 0, 'matches', 3, 0.8, 100_000, 0.95); return r.won ? 950_000 : 0; })());
});

test('decideDigitAtWinRate: an impossible-win contract (under 0) can never be forced to win', () => {
  for (let n = 0; n < 200; n++) {
    const r = decideDigitAtWinRate('seed', n, 'under', 0, 0.99, 100_000, 0.95);
    assert.equal(r.won, false, 'under 0 has win probability 0 → always a loss, whatever the win rate');
  }
});
