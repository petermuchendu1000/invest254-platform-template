import { test } from "node:test";
import assert from "node:assert/strict";
import { heikinAshi } from "./chart.js";
import type { Candle } from "./chart.js";

const c = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close });

test("heikin ashi: the close is the bar's average of O, H, L and C", () => {
  const [ha] = heikinAshi([c(1, 10, 14, 8, 12)]);
  assert.equal(ha!.close, (10 + 14 + 8 + 12) / 4);
});

test("heikin ashi: the first bar opens at the midpoint of its own open and close", () => {
  const [ha] = heikinAshi([c(1, 10, 14, 8, 12)]);
  assert.equal(ha!.open, (10 + 12) / 2);
});

test("heikin ashi: every later bar opens at the midpoint of the PREVIOUS HA bar, not the real one", () => {
  const ha = heikinAshi([c(1, 10, 14, 8, 12), c(2, 12, 20, 11, 19)]);
  assert.equal(ha[1]!.open, (ha[0]!.open + ha[0]!.close) / 2);
});

test("heikin ashi: the high and low contain the body, which is what removes the wick noise", () => {
  for (const ha of heikinAshi([c(1, 10, 14, 8, 12), c(2, 12, 20, 11, 19), c(3, 19, 19, 5, 6)])) {
    assert.ok(ha.high >= Math.max(ha.open, ha.close), "high must contain the body");
    assert.ok(ha.low <= Math.min(ha.open, ha.close), "low must contain the body");
    assert.ok(ha.high >= ha.low);
  }
});

test("heikin ashi: times are carried through untouched, so the series stays aligned", () => {
  const src = [c(10, 1, 2, 0.5, 1.5), c(20, 1.5, 3, 1, 2.5), c(30, 2.5, 4, 2, 3)];
  assert.deepEqual(heikinAshi(src).map((h) => h.time), [10, 20, 30]);
});

test("heikin ashi: an empty series gives an empty series", () => {
  assert.deepEqual(heikinAshi([]), []);
});

test("heikin ashi: a flat market gives flat bars (no invented movement)", () => {
  const flat = [c(1, 5, 5, 5, 5), c(2, 5, 5, 5, 5), c(3, 5, 5, 5, 5)];
  for (const ha of heikinAshi(flat)) {
    assert.equal(ha.open, 5); assert.equal(ha.close, 5); assert.equal(ha.high, 5); assert.equal(ha.low, 5);
  }
});
