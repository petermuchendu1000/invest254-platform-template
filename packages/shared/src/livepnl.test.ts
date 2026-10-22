import { test } from 'node:test';
import assert from 'node:assert/strict';
import { livePriceMultiplier, CONVERGE_FROM } from './livepnl.js';

/**
 * Equal to within a ten-millionth of a multiplier, which is far finer than any money this prints:
 * a multiplier is applied to a stake in cents, so a difference this size cannot move a payout.
 *
 * The blend multiplies by `w` and `1 - w`, and the two do not recombine to exactly 1 in binary, so
 * a value that is mathematically the price is 1.6000000000000003 here. The ONE place that stays an
 * exact comparison is the landing at `g = 1`, where `w` is exactly 1 and the arithmetic collapses:
 * the player must be paid precisely the multiplier they watched, so that test asserts equality.
 */
const close = (a: number, b: number, msg?: string) =>
  assert.ok(Math.abs(a - b) < 1e-7, `${msg ?? ''} ${a} !~ ${b}`);

const base = { gain: 20, maxMultiplier: 10, endpoint: 1.6 };
/** The value at progress `g` for a contract whose favourable move is `move` at that moment. */
const at = (g: number, move: number, over: Partial<typeof base> & { cap?: number } = {}) =>
  livePriceMultiplier({ ...base, ...over, g, move });

test('a falling price falls the profit, which is the whole point', () => {
  // The old path rose monotonically on a timer whatever the price did. A buy whose price is going
  // against it must show a profit going against it.
  const rising = at(0.3, 0.02);
  const flat = at(0.3, 0);
  const falling = at(0.3, -0.02);
  assert.ok(rising > flat && flat > falling, `${rising} > ${flat} > ${falling}`);
  close(flat, 1, 'no move is no profit and no loss');
});

test('it is the MOVE that drives it, not the elapsed time', () => {
  // Same move at three different moments inside the price-driven stretch: the same value.
  const a = at(0.1, 0.03);
  const b = at(0.4, 0.03);
  const c = at(0.7, 0.03);
  close(a, b);
  close(b, c);
});

test('it lands EXACTLY on the committed multiplier, whatever the price did', () => {
  // The outcome is committed at open and the player must be paid what they watched.
  for (const move of [-0.5, -0.01, 0, 0.01, 0.5]) {
    for (const endpoint of [0, 1, 1.6, 9.9]) {
      assert.equal(at(1, move, { endpoint }), endpoint, `${move} ${endpoint}`);
    }
  }
});

test('and it is the price alone until the convergence window opens', () => {
  const move = 0.02;
  const priceValue = 1 + base.gain * move;
  for (const g of [0, 0.25, 0.5, CONVERGE_FROM]) {
    close(at(g, move, { endpoint: 0 }), priceValue, `g=${g}`);
  }
  // One step past it and the endpoint has started to pull.
  assert.ok(at(CONVERGE_FROM + 0.05, move, { endpoint: 0 }) < priceValue);
});

test('a statistical WINNER tracks the price all the way, because the endpoint is where the price ends', () => {
  // On that path the committed multiplier IS `1 + gain*move` at expiry, so the blend has nothing to
  // correct and the line never leaves the candle.
  const finalMove = 0.03;
  const endpoint = 1 + base.gain * finalMove;
  for (const g of [0.8, 0.9, 0.99, 1]) {
    close(at(g, finalMove, { endpoint }), endpoint, `g=${g}`);
  }
});

test('a LOSER is carried to zero over the window rather than dropping off a cliff', () => {
  const path = [0.8, 0.85, 0.9, 0.95, 1].map((g) => at(g, 0.02, { endpoint: 0 }));
  for (let i = 1; i < path.length; i++) assert.ok(path[i]! < path[i - 1]!, `${i}: ${path[i]} !< ${path[i - 1]}`);
  assert.equal(path.at(-1), 0);
});

test('a contract that can be closed early never shows more than it will pay', () => {
  // The settlement engine's guarantee: early closing "can only REDUCE player payout (house edge >=
  // target)". A price spike part way through a winner would otherwise be shown AND paid.
  const endpoint = 1.6;
  const spike = at(0.3, 0.5, { endpoint, cap: endpoint });
  close(spike, endpoint);
  // It still falls freely below the cap, which is the behaviour being added.
  assert.ok(at(0.3, -0.01, { endpoint, cap: endpoint }) < endpoint);
});

test('and one that cannot be closed early is free to run above its endpoint and come back', () => {
  // Every pool brand refuses a manual close, so there is no payout to protect. This is the
  // reversing feint the old seeded path invented, except it is the price actually moving.
  const over = at(0.3, 0.5, { endpoint: 0 });
  assert.ok(over > 1, String(over));
  assert.equal(at(1, 0.5, { endpoint: 0 }), 0);
});

test('the brand ceiling is never exceeded, cap or no cap', () => {
  close(at(0.3, 1000, { endpoint: 1 }), base.maxMultiplier);
});

test('the value never goes below zero, however far the price runs against it', () => {
  // A multiplier below zero would read as the player owing more than they staked.
  for (const g of [0, 0.5, 0.9]) close(at(g, -1000, { endpoint: 0 }), 0);
});

test('a buy and a sell are mirror images, because the move is signed by direction', () => {
  // The old path took no direction at all, so two opposite trades opened together drew the same
  // shape. Here the caller signs the move and the two diverge.
  const buy = at(0.3, 0.02);
  const sell = at(0.3, -0.02);
  close(buy - 1, -(sell - 1));
});
