import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateCandles, upsertCandle, bucketStartMs, normalizeBucketMs, sma, bollinger, type Candle } from "./chart.js";

test("normalizeBucketMs: rejects non-multiples of 1000 and non-positive", () => {
  assert.equal(normalizeBucketMs(1000), 1000);
  assert.equal(normalizeBucketMs(2000), 2000);
  assert.throws(() => normalizeBucketMs(500));
  assert.throws(() => normalizeBucketMs(1500));
  assert.throws(() => normalizeBucketMs(0));
  assert.throws(() => normalizeBucketMs(-1000));
});

test("bucketStartMs: floors to bucket boundary", () => {
  assert.equal(bucketStartMs(0, 2000), 0);
  assert.equal(bucketStartMs(1999, 2000), 0);
  assert.equal(bucketStartMs(2000, 2000), 2000);
  assert.equal(bucketStartMs(5500, 2000), 4000);
});

test("aggregateCandles: groups ticks into OHLC buckets (seconds, ascending, unique)", () => {
  const ticks = [
    { t: 0, rate: 100 },
    { t: 500, rate: 105 },
    { t: 1500, rate: 95 },   // still bucket 0 (2s)
    { t: 2000, rate: 110 },  // bucket 1
    { t: 2500, rate: 108 },
    { t: 3999, rate: 120 },  // still bucket 1
  ];
  const candles = aggregateCandles(ticks, 2000);
  assert.equal(candles.length, 2);
  // bucket 0: open 100, high 105, low 95, close 95, time 0
  assert.deepEqual(candles[0], { time: 0, open: 100, high: 105, low: 95, close: 95 });
  // bucket 1: open 110, high 120, low 108, close 120, time 2 (seconds)
  assert.deepEqual(candles[1], { time: 2, open: 110, high: 120, low: 108, close: 120 });
  // strictly ascending, unique times (chart requirement)
  for (let i = 1; i < candles.length; i++) assert.ok(candles[i]!.time > candles[i - 1]!.time);
});

test("aggregateCandles: skips non-finite ticks, handles empty", () => {
  assert.deepEqual(aggregateCandles([], 1000), []);
  const c = aggregateCandles([{ t: 0, rate: 10 }, { t: 100, rate: NaN }, { t: 200, rate: 12 }], 1000);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0], { time: 0, open: 10, high: 12, low: 10, close: 12 });
});

test("upsertCandle: extends the current bucket in place", () => {
  const candles: Candle[] = [];
  const a = upsertCandle(candles, { t: 100, rate: 50 }, 2000);
  assert.deepEqual(a, { time: 0, open: 50, high: 50, low: 50, close: 50 });
  const b = upsertCandle(candles, { t: 900, rate: 55 }, 2000);
  assert.equal(candles.length, 1);              // same bucket -> no new candle
  assert.equal(b.close, 55);
  assert.equal(b.high, 55);
  assert.equal(b.low, 50);
});

test("upsertCandle: opens a new bar at the previous close (visually continuous)", () => {
  const candles: Candle[] = [];
  upsertCandle(candles, { t: 100, rate: 50 }, 2000);   // bucket 0
  upsertCandle(candles, { t: 1500, rate: 60 }, 2000);  // still bucket 0 -> close 60
  const c = upsertCandle(candles, { t: 2100, rate: 58 }, 2000); // bucket 1
  assert.equal(candles.length, 2);
  assert.equal(c.time, 2);
  assert.equal(c.open, 60);   // opens at previous close, not the new tick
  assert.equal(c.close, 58);
  assert.equal(c.high, 60);
  assert.equal(c.low, 58);
});

test("sma: null until the window fills, then the rolling mean", () => {
  const out = sma([2, 4, 6, 8, 10], 3);
  assert.deepEqual(out, [null, null, 4, 6, 8]);
});

test("bollinger: mid is the SMA, bands are symmetric around it", () => {
  const closes = [1, 2, 3, 4, 5, 6];
  const b = bollinger(closes, 3, 2);
  assert.equal(b[0], null);
  assert.equal(b[1], null);
  const last = b[b.length - 1]!;
  assert.equal(last.mid, 5);                         // mean of [4,5,6]
  assert.ok(last.upper > last.mid && last.lower < last.mid);
  assert.ok(Math.abs((last.upper - last.mid) - (last.mid - last.lower)) < 1e-9);
});
