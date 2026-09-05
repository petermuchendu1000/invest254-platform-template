/**
 * Candlestick aggregation for the live price stream.
 *
 * The engine emits a continuous tick stream (`{ t, rate }`, t = epoch ms, rate = price). The line
 * chart draws those ticks directly; a candlestick chart instead groups them into fixed-width OHLC
 * buckets. This module is PURE and deterministic (no DOM, no charting lib) so it can be unit-tested
 * and shared by any renderer (TradingView Lightweight Charts on the web today).
 *
 * Time is expressed in whole SECONDS (the UTCTimestamp unit Lightweight Charts expects). Because a
 * chart library requires candle times to be strictly ascending and unique, `bucketMs` MUST be a
 * positive multiple of 1000 — otherwise two buckets could collapse to the same integer second.
 */

/** One OHLC bar. `time` is a UNIX timestamp in SECONDS (bucket start). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Minimal tick shape this module needs (a superset `Tick` also satisfies it). */
export interface PriceTick {
  t: number;
  rate: number;
}

/** Validate + normalise a bucket width, guaranteeing unique per-second buckets. */
export function normalizeBucketMs(bucketMs: number): number {
  if (!Number.isFinite(bucketMs) || bucketMs < 1000 || bucketMs % 1000 !== 0) {
    throw new RangeError(`bucketMs must be a positive multiple of 1000, got ${bucketMs}`);
  }
  return bucketMs;
}

/** Epoch-ms → the start (also ms) of the bucket it falls in. */
export function bucketStartMs(tMs: number, bucketMs: number): number {
  return Math.floor(tMs / bucketMs) * bucketMs;
}

/**
 * Fold an ordered tick series into OHLC candles. Ticks are assumed ascending in `t` (the engine's
 * ring buffer is). Each new bucket opens at its first tick's rate; high/low track extremes; close is
 * the latest rate in the bucket. Returns candles ascending by `time` (chart-ready).
 */
export function aggregateCandles(ticks: readonly PriceTick[], bucketMs: number): Candle[] {
  normalizeBucketMs(bucketMs);
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curBucketMs = -1;
  for (const tk of ticks) {
    if (!Number.isFinite(tk.t) || !Number.isFinite(tk.rate)) continue;
    const b = bucketStartMs(tk.t, bucketMs);
    if (cur === null || b !== curBucketMs) {
      if (cur) out.push(cur);
      curBucketMs = b;
      cur = { time: Math.floor(b / 1000), open: tk.rate, high: tk.rate, low: tk.rate, close: tk.rate };
    } else {
      if (tk.rate > cur.high) cur.high = tk.rate;
      if (tk.rate < cur.low) cur.low = tk.rate;
      cur.close = tk.rate;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Real-time update: fold ONE new tick into an existing (mutable) candle array and return the single
 * candle a chart should `update()` with. If the tick belongs to the current (last) bucket it extends
 * it in place; otherwise it appends a new candle that OPENS at the previous candle's close (so the
 * series is visually continuous — no gaps between bars). Mutates `candles` in place.
 */
export function upsertCandle(candles: Candle[], tick: PriceTick, bucketMs: number): Candle {
  normalizeBucketMs(bucketMs);
  const time = Math.floor(bucketStartMs(tick.t, bucketMs) / 1000);
  const last = candles.length > 0 ? candles[candles.length - 1]! : null;
  if (last && last.time === time) {
    if (tick.rate > last.high) last.high = tick.rate;
    if (tick.rate < last.low) last.low = tick.rate;
    last.close = tick.rate;
    return last;
  }
  const open = last ? last.close : tick.rate;
  const candle: Candle = { time, open, high: Math.max(open, tick.rate), low: Math.min(open, tick.rate), close: tick.rate };
  candles.push(candle);
  return candle;
}

/**
 * Simple moving average of the closes ending AT each index (null until `period` bars exist).
 * Pure/O(n·1) with a rolling sum. Returned array is index-aligned with `candles`.
 */
export function sma(closes: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= period) sum -= closes[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Bollinger Bands (middle SMA ± mult·σ) over closes; index-aligned, null until `period` bars. */
export function bollinger(
  closes: readonly number[],
  period = 20,
  mult = 2,
): Array<{ mid: number; upper: number; lower: number } | null> {
  const out: Array<{ mid: number; upper: number; lower: number } | null> = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += closes[j]!;
    mean /= period;
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) { const d = closes[j]! - mean; varSum += d * d; }
    const sd = Math.sqrt(varSum / period);
    out[i] = { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd };
  }
  return out;
}
