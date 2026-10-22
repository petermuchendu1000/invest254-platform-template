import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIMEFRAMES, TIMEFRAME_KEYS, isTimeframe, bucketStartS, nextBucketS, aggregate, minuteBars,
  priceOf, nextBase, toTick, valueOfRate, XAUUSD, BASE_RETENTION, DAY_S,
  CurveGenerator, DEFAULT_CONFIG, CURVE_BASE_RATE, CURVE_AMPLITUDE,
  type Candle, type Timeframe,
} from "./index.js";

const DAY0 = Date.UTC(2026, 2, 16) / 1000; // a Monday, so W1 bucketing is easy to reason about

test("the timeframe table is MT5's, in ascending order", () => {
  // MetaTrader 5 offers exactly these 21 periods; the chart's selector is driven by this table, so a
  // missing or misnamed one is a visible product gap rather than an internal detail.
  assert.deepEqual(TIMEFRAME_KEYS, [
    "M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30",
    "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1",
  ]);
  const fixed = TIMEFRAME_KEYS.filter((k) => k !== "MN1");
  for (let i = 1; i < fixed.length; i++) {
    assert.ok(TIMEFRAMES[fixed[i]!] > TIMEFRAMES[fixed[i - 1]!], `${fixed[i]} must exceed ${fixed[i - 1]}`);
  }
  assert.equal(isTimeframe("H4"), true);
  assert.equal(isTimeframe("H5"), false);
});

test("bucketing: minute/hour/day align to UTC, W1 to Monday, MN1 to the 1st", () => {
  const t = Date.UTC(2026, 2, 18, 13, 47, 29) / 1000; // Wed 18 Mar 2026 13:47:29Z
  assert.equal(bucketStartS(t, "M15"), Date.UTC(2026, 2, 18, 13, 45) / 1000);
  assert.equal(bucketStartS(t, "H4"), Date.UTC(2026, 2, 18, 12) / 1000);
  // D1 must land on UTC midnight: that is the boundary the engine reseeds on, so one D1 candle is
  // exactly one server seed's day and a player can verify it against one revealed seed.
  assert.equal(bucketStartS(t, "D1"), Date.UTC(2026, 2, 18) / 1000);
  assert.equal(bucketStartS(t, "W1"), Date.UTC(2026, 2, 16) / 1000); // the Monday
  assert.equal(bucketStartS(t, "MN1"), Date.UTC(2026, 2, 1) / 1000);
  // Sunday belongs to the week that STARTED on the preceding Monday.
  assert.equal(bucketStartS(Date.UTC(2026, 2, 22, 23) / 1000, "W1"), Date.UTC(2026, 2, 16) / 1000);
  // Month lengths vary, so MN1 steps by calendar, not by a fixed span.
  assert.equal(nextBucketS(Date.UTC(2026, 1, 1) / 1000, "MN1"), Date.UTC(2026, 2, 1) / 1000);
  assert.equal(nextBucketS(Date.UTC(2026, 11, 1) / 1000, "MN1"), Date.UTC(2027, 0, 1) / 1000);
});

test("aggregate: a coarser bar is the open of the first, extremes of all, close of the last", () => {
  const src: Candle[] = [
    { time: DAY0 + 0, open: 10, high: 12, low: 9, close: 11 },
    { time: DAY0 + 60, open: 11, high: 15, low: 11, close: 14 },
    { time: DAY0 + 120, open: 14, high: 14, low: 7, close: 8 },
    { time: DAY0 + 180, open: 8, high: 9, low: 8, close: 9 },   // next M3 bucket
  ];
  const out = aggregate(src, "M3");
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { time: DAY0, open: 10, high: 15, low: 7, close: 8 });
  assert.deepEqual(out[1], { time: DAY0 + 180, open: 8, high: 9, low: 8, close: 9 });
});

test("aggregate: every timeframe agrees — the same day folds to the same open/high/low/close", () => {
  // The chart folds one set of M1 bars into every period. If the fold were lossy, switching
  // timeframe would change the price history under the player.
  const curve = new CurveGenerator("agg-seed", DEFAULT_CONFIG, "market");
  const m1 = minuteBars(XAUUSD, DAY0, 2650, (t) => curve.value(t));
  const d1 = aggregate(m1, "D1");
  assert.equal(d1.length, 1);
  for (const tf of ["M5", "M15", "H1", "H4", "D1"] as Timeframe[]) {
    const bars = aggregate(m1, tf);
    assert.equal(bars[0]!.open, m1[0]!.open, `${tf} opens where the day opens`);
    assert.equal(bars.at(-1)!.close, m1.at(-1)!.close, `${tf} closes where the day closes`);
    assert.equal(Math.max(...bars.map((b) => b.high)), d1[0]!.high, `${tf} high matches D1`);
    assert.equal(Math.min(...bars.map((b) => b.low)), d1[0]!.low, `${tf} low matches D1`);
    // Buckets must be strictly ascending and unique — a charting library rejects anything else.
    for (let i = 1; i < bars.length; i++) assert.ok(bars[i]!.time > bars[i - 1]!.time, `${tf} not ascending`);
  }
});

test("minuteBars: 1440 ascending bars, OHLC self-consistent, priced at the symbol's tick", () => {
  const curve = new CurveGenerator("bars-seed", DEFAULT_CONFIG, "market");
  const bars = minuteBars(XAUUSD, DAY0, 2650, (t) => curve.value(t));
  assert.equal(bars.length, 1440);
  const tick = 10 ** -XAUUSD.digits;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    assert.equal(b.time, DAY0 + i * 60);
    assert.ok(b.high >= Math.max(b.open, b.close) - 1e-9, `bar ${i} high below its body`);
    assert.ok(b.low <= Math.min(b.open, b.close) + 1e-9, `bar ${i} low above its body`);
    assert.ok(Math.abs(b.close / tick - Math.round(b.close / tick)) < 1e-6, `bar ${i} off-tick`);
  }
  // Consecutive bars must not gap: each bar's close is the next bar's open (the walk is continuous).
  for (let i = 1; i < bars.length; i++) {
    assert.ok(Math.abs(bars[i]!.open - bars[i - 1]!.close) <= tick + 1e-9, `gap at bar ${i}`);
  }
});

test("the price map is AFFINE in the curve value — what the chart shows is what settlement reads", () => {
  // The fairness claim rests on this: within a day, price is base + scale*(value - open), so the
  // ratio of a price move to the value move settlement scores is the SAME constant everywhere. If
  // this map were curved, two identical-looking chart moves could settle differently.
  const base = 2700, open = 0.31;
  const pairs = [[0.1, 0.2], [0.5, 0.6], [-0.2, -0.1], [0.44, 0.54]];
  const ratios = pairs.map(([a, b]) =>
    (priceOf(XAUUSD, base, open, b!) - priceOf(XAUUSD, base, open, a!)) / (b! - a!));
  for (const r of ratios) assert.ok(Math.abs(r - XAUUSD.scale) < 1e-9, `scale drifted: ${r}`);
  // ...and the direction is never inverted: a rise in value is a rise in price.
  assert.ok(priceOf(XAUUSD, base, open, 0.4) > priceOf(XAUUSD, base, open, 0.3));
});

test("day chaining is continuous: a day's base is the previous day's close (bar the anchor pull)", () => {
  const base = 2650, open = 0.30, close = 0.52;
  const closePrice = priceOf(XAUUSD, base, open, close);
  const next = nextBase(XAUUSD, base, open, close);
  // The pull toward the anchor is what keeps the series from wandering off over years. It must be
  // small enough to read as an ordinary overnight gap — well under one point here.
  assert.ok(Math.abs(next - closePrice) < 1, `rollover gap too large: ${(next - closePrice).toFixed(3)}`);
  assert.ok(Math.abs(next - XAUUSD.anchor) < Math.abs(closePrice - XAUUSD.anchor), "must pull toward the anchor");
});

test("chaining stays bounded over years, and never approaches zero", () => {
  // A pure carry-forward is a random walk and would eventually go negative. Walk ten years of real
  // seeded days and confirm the retention factor holds the series in a sane band.
  let base = XAUUSD.anchor;
  let lo = base, hi = base;
  for (let d = 0; d < 3650; d++) {
    const curve = new CurveGenerator(`chain-day-${d}`, DEFAULT_CONFIG, "market");
    base = nextBase(XAUUSD, base, curve.value(0), curve.value(DAY_S));
    lo = Math.min(lo, base); hi = Math.max(hi, base);
  }
  assert.ok(lo > XAUUSD.anchor * 0.5, `drifted too low over 10 years: ${lo.toFixed(0)}`);
  assert.ok(hi < XAUUSD.anchor * 1.8, `drifted too high over 10 years: ${hi.toFixed(0)}`);
  assert.ok(BASE_RETENTION < 1, "retention must pull in, or the series is an unbounded walk");
});

test("valueOfRate inverts CurveGenerator.rate, so a tick can be priced like history", () => {
  const curve = new CurveGenerator("inv-seed", DEFAULT_CONFIG, "market");
  for (const t of [0, 13.5, 900, 50_000]) {
    assert.ok(Math.abs(valueOfRate(curve.rate(t)) - curve.value(t)) < 1e-12, `inverse failed at t=${t}`);
  }
  assert.equal(valueOfRate(CURVE_BASE_RATE + CURVE_AMPLITUDE), 1);
});

test("toTick rounds to the symbol's precision and never invents digits", () => {
  assert.equal(toTick(XAUUSD, 2650.123456), 2650.12);
  assert.equal(toTick(XAUUSD, 2650.125), 2650.13);
  assert.equal(toTick({ ...XAUUSD, digits: 0 }, 2650.7), 2651);
});

test("tick volume: price CHANGES per bar, and the sum of them at every higher period", () => {
  /**
   * MetaTrader's `Tick Volumes` is the number of price changes inside a bar, which is a figure this
   * feed genuinely has (its quote is quantised to the instrument's tick) and traded volume is not.
   *
   * Two properties matter and both are checked here: a minute's count is a count of CHANGES rather
   * than of samples, so it is below the 60 samples taken and above zero; and a higher period's
   * count is the SUM of the minutes it folds, which is what makes a switch of timeframe show the
   * same activity rather than a different one.
   */
  const curve = new CurveGenerator("tickvol-seed", DEFAULT_CONFIG, "market");
  const m1 = minuteBars(XAUUSD, DAY0, 2650, (t) => curve.value(t));
  for (const [i, b] of m1.entries()) {
    assert.equal(typeof b.tickVolume, "number", `bar ${i} carries no tick volume`);
    assert.ok(b.tickVolume! > 0, `bar ${i} claims the price never moved`);
    assert.ok(b.tickVolume! <= 60, `bar ${i} counts more changes than samples taken`);
  }
  // It is a real histogram: the counts differ bar to bar rather than being a flat 60.
  assert.ok(new Set(m1.map((b) => b.tickVolume)).size > 3, "every bar reported the same count");

  const dayTotal = m1.reduce((n, b) => n + b.tickVolume!, 0);
  for (const tf of ["M5", "M15", "H1", "H4", "D1"] as Timeframe[]) {
    const bars = aggregate(m1, tf);
    assert.equal(
      bars.reduce((n, b) => n + b.tickVolume!, 0),
      dayTotal,
      `${tf} does not carry the day's tick volume`,
    );
  }
});

test("tick volume: a source that does not count them produces bars that do not either", () => {
  // "Not counted" and "counted and zero" must stay different: a zero would draw a column saying
  // the price never moved, which is a claim about the market rather than about the data.
  const src = [
    { time: DAY0, open: 1, high: 2, low: 1, close: 2 },
    { time: DAY0 + 60, open: 2, high: 3, low: 2, close: 3 },
  ];
  const out = aggregate(src, "M5");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.tickVolume, undefined);
});
