import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoLive, DEMO_WIN_RATE, type DemoPosition } from './demoTrade.js';

/**
 * The guest demo's simulation.
 *
 * Everything here is fabricated by design — see the module note, which says so in as many words.
 * What these tests pin is the one property a fabricated figure MUST have: the number on screen at
 * expiry is exactly what settles. A panel that shows +5,873 for ten seconds and then pays a loss
 * is the failure that would make the whole surface a lie rather than a simulation.
 */

const pos = (over: Partial<DemoPosition> = {}): DemoPosition => ({
  id: 'd1',
  direction: 'buy',
  stakeCents: 100_000,      // KES 1,000
  entryPrice: 9407.13,
  openedAtMs: 1_000_000,
  durationS: 10,
  multiplier: 1.87,
  willWin: true,
  ...over,
});

const at = (p: DemoPosition, s: number) => demoLive(p, p.openedAtMs + s * 1000);

test('a winning contract lands EXACTLY on its payout, to the cent', () => {
  const p = pos({ willWin: true });
  const end = at(p, 10);
  assert.equal(end.expired, true);
  // stake x (multiplier - 1) is the profit; the wobble must be gone by now.
  assert.equal(end.livePnlCents, Math.round(p.stakeCents * (p.multiplier - 1)));
  assert.equal(end.estReturnCents, p.stakeCents + end.livePnlCents);
});

test('a losing contract lands EXACTLY on minus the stake, and returns nothing', () => {
  const p = pos({ willWin: false });
  const end = at(p, 10);
  assert.equal(end.livePnlCents, -p.stakeCents);
  assert.equal(end.estReturnCents, 0, 'a loss must not show money coming back');
});

test('the countdown and the bar agree, and neither runs past the contract', () => {
  const p = pos();
  assert.equal(at(p, 0).secondsLeft, 10);
  assert.equal(at(p, 7).secondsLeft, 3);
  assert.equal(at(p, 10).secondsLeft, 0);
  assert.equal(at(p, 999).secondsLeft, 0, 'a late tick must not go negative');

  assert.equal(at(p, 0).progress, 0);
  assert.equal(at(p, 5).progress, 0.5);
  assert.equal(at(p, 10).progress, 1);
  assert.equal(at(p, 999).progress, 1, 'the bar must not overfill');
});

test('the figure moves while the contract runs — it is not a static number', () => {
  const p = pos();
  const seen = new Set([2, 3, 4, 5, 6, 7].map((s) => at(p, s).livePnlCents));
  assert.ok(seen.size >= 4, `the P&L barely moved across the contract: ${[...seen].join(', ')}`);
});

test('it starts at zero rather than jumping straight to the answer', () => {
  assert.equal(at(pos(), 0).livePnlCents, 0);
  // A quarter of the way in, a winner should still be well short of its final payout.
  const p = pos({ willWin: true });
  const quarter = at(p, 2.5).livePnlCents;
  assert.ok(quarter < at(p, 10).livePnlCents * 0.5, 'the curve front-loads the result');
});

test('a longer or larger contract scales, and nothing divides by zero', () => {
  assert.equal(at(pos({ durationS: 60, stakeCents: 500_000 }), 60).livePnlCents, Math.round(500_000 * 0.87));
  // A zero-duration contract must not produce NaN or Infinity.
  const degenerate = demoLive(pos({ durationS: 0 }), 1_000_000);
  assert.ok(Number.isFinite(degenerate.livePnlCents));
  assert.ok(Number.isFinite(degenerate.progress));
});

test('the win rate is a single configured constant, stated as such', () => {
  // Not an assertion about fairness — it is the opposite. This pins that the number lives in ONE
  // place so it can be changed or disabled without hunting through components.
  assert.ok(DEMO_WIN_RATE > 0 && DEMO_WIN_RATE <= 1);
});
