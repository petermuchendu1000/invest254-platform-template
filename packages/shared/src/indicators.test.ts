import test from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "./chart.js";
import {
  accelerator, adx, alligator, ama, atr, awesome, bearsPower, bullsPower, cci, closes, dema,
  demarker, ema, envelopes, fractals, gator, ichimoku, lwma, macd, medianPrice, momentum,
  movingAverage, osma, parabolicSar, rsi, rvi, shiftSeries, smma, stdDev, stochastic, tema, trix,
  williamsR, type Series,
} from "./indicators.js";

/**
 * The indicators are the one part of the terminal a trader can check against another chart, so they
 * are tested two ways: against values computed by hand from the published formula, and against the
 * properties each measure is defined by (bounded range, correct warm-up length, agreement with a
 * simpler case). A number that merely "looks like an indicator" is the failure mode here.
 */

const bar = (o: number, h: number, l: number, c: number, time = 0): Candle => ({ time, open: o, high: h, low: l, close: c });

/** A deterministic, non-degenerate series — a drifting sine, so nothing is constant or monotonic. */
function series(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const mid = 100 + i * 0.15 + Math.sin(i / 3) * 4 + Math.sin(i / 11) * 7;
    const half = 0.6 + Math.abs(Math.sin(i / 5)) * 0.9;
    const open = mid - Math.sin(i / 7) * 0.5;
    const close = mid + Math.sin(i / 4) * 0.5;
    out.push(bar(open, Math.max(open, close) + half, Math.min(open, close) - half, close, i * 60));
  }
  return out;
}

const near = (a: number | null | undefined, b: number, eps = 1e-9, msg = "") =>
  assert.ok(a !== null && a !== undefined && Math.abs(a - b) < eps, `${msg} got ${a}, want ${b}`);

/** Index of the first non-null value — an indicator's warm-up length. */
const firstDefined = (s: Series): number => s.findIndex((v) => v !== null);

// ───────────────────────────── moving averages ─────────────────────────────

test("ema: seeds on the SMA, then applies k = 2/(n+1)", () => {
  const src = [1, 2, 3, 4, 5];
  const e = ema(src, 3);
  assert.deepEqual(e.slice(0, 2), [null, null], "null until three bars exist");
  near(e[2], 2, 1e-12, "seed is the SMA of 1,2,3");
  // k = 0.5: next = 4·0.5 + 2·0.5 = 3; then 5·0.5 + 3·0.5 = 4.
  near(e[3], 3);
  near(e[4], 4);
});

test("smma: Wilder's smoothing, (prev·(n−1) + x)/n after an SMA seed", () => {
  const s = smma([1, 2, 3, 4, 5], 3);
  near(s[2], 2, 1e-12, "seed");
  near(s[3], (2 * 2 + 4) / 3);
  near(s[4], ((2 * 2 + 4) / 3 * 2 + 5) / 3);
});

test("lwma: the newest bar carries the greatest weight", () => {
  // (1·1 + 2·2 + 3·3) / 6 = 14/6
  near(lwma([1, 2, 3], 3)[2], 14 / 6);
  // Order matters, which is the whole point of a weighted average.
  near(lwma([3, 2, 1], 3)[2], (3 * 1 + 2 * 2 + 1 * 3) / 6);
});

test("every MA method agrees with a constant series, and warms up at the same bar", () => {
  const flat = new Array(30).fill(7);
  for (const m of ["sma", "ema", "smma", "lwma"] as const) {
    const out = movingAverage(flat, 10, m);
    near(out.at(-1), 7, 1e-9, m);
    assert.equal(firstDefined(out), 9, `${m} warm-up`);
  }
});

test("shiftSeries: moves values forward, drops what falls off, and never mutates", () => {
  const src: Series = [1, 2, 3, null];
  const before = JSON.stringify(src);
  assert.deepEqual(shiftSeries(src, 1), [null, 1, 2, 3]);
  assert.deepEqual(shiftSeries(src, -1), [2, 3, null, null]);
  assert.deepEqual(shiftSeries(src, 0), [1, 2, 3, null]);
  assert.equal(JSON.stringify(src), before, "input untouched");
});

// ───────────────────────────── trend ─────────────────────────────

test("stdDev: zero on a flat series, and the population σ of a known window", () => {
  assert.equal(stdDev(new Array(10).fill(5), 5).at(-1), 0);
  // 2,4,4,4,5,5,7,9 has population σ = 2.
  near(stdDev([2, 4, 4, 4, 5, 5, 7, 9], 8).at(-1), 2, 1e-12);
});

test("envelopes: band sits a fixed percentage either side of the average", () => {
  const e = envelopes(new Array(20).fill(100), 10, 1).at(-1)!;
  near(e.mid, 100);
  near(e.upper, 101);
  near(e.lower, 99);
});

test("atr: true range counts the gap from the previous close, not just the bar", () => {
  // Bar 2 gaps far above bar 1's close, so its TR is driven by the gap.
  const bars = [bar(10, 11, 9, 10), bar(20, 21, 19.5, 20), bar(20, 21, 19.5, 20)];
  const a = atr(bars, 2);
  // TRs: 2 (first bar's range), max(1.5, |21−10|, |19.5−10|) = 11, then max(1.5, 1, 0.5) = 1.5.
  // SMMA(2) seeds at (2+11)/2 = 6.5, then (6.5 + 1.5)/2 = 4.
  near(a[1], 6.5);
  near(a[2], 4);
});

test("atr: never negative, and zero only when every bar is a point", () => {
  const flat = new Array(30).fill(null).map(() => bar(5, 5, 5, 5));
  assert.equal(atr(flat, 14).at(-1), 0);
  for (const v of atr(series(120), 14)) assert.ok(v === null || v >= 0);
});

test("adx: +DI/−DI are 0–100 and ADX is 0–100 on a real series", () => {
  for (const p of adx(series(200), 14)) {
    if (!p) continue;
    for (const [name, v] of [["adx", p.adx], ["+DI", p.plusDi], ["−DI", p.minusDi]] as const) {
      assert.ok(v >= 0 && v <= 100, `${name} out of range: ${v}`);
    }
  }
});

test("adx: a pure uptrend puts +DI decisively above −DI", () => {
  const up = Array.from({ length: 80 }, (_, i) => bar(i, i + 1, i - 0.5, i + 0.8));
  const last = adx(up, 14).at(-1)!;
  assert.ok(last.plusDi > last.minusDi, `+DI ${last.plusDi} should exceed −DI ${last.minusDi}`);
  assert.ok(last.adx > 50, `a clean trend should read strong, got ${last.adx}`);
});

test("parabolicSar: stays below a rising market and flips when price breaks it", () => {
  const up = Array.from({ length: 40 }, (_, i) => bar(i, i + 1, i - 0.5, i + 0.9));
  const sar = parabolicSar(up, 0.02, 0.2);
  for (let i = 10; i < up.length; i++) assert.ok(sar[i]! <= up[i]!.high, `SAR above the bar at ${i}`);

  // Reverse the market and the dots must cross over to the other side.
  const down = [...up, ...Array.from({ length: 25 }, (_, i) => bar(40 - i, 41 - i, 39 - i, 39.2 - i))];
  const s2 = parabolicSar(down, 0.02, 0.2);
  assert.ok(s2.at(-1)! >= down.at(-1)!.low, "after the reversal SAR should sit above price");
});

test("ichimoku: lines are range midpoints, and the cloud is displaced forward", () => {
  const bars = series(160);
  const p = ichimoku(bars);
  const i = 120;
  let hi = -Infinity, lo = Infinity;
  for (let j = i - 8; j <= i; j++) { hi = Math.max(hi, bars[j]!.high); lo = Math.min(lo, bars[j]!.low); }
  near(p[i]!.tenkan, (hi + lo) / 2, 1e-9, "tenkan is the 9-bar midpoint");

  // Senkou A at i is the tenkan/kijun midpoint from 26 bars earlier — that is the displacement.
  const src = p[i - 26]!;
  if (src.tenkan !== null && src.kijun !== null) near(p[i]!.senkouA, (src.tenkan + src.kijun) / 2, 1e-9);
  // Chikou is the close plotted 26 bars back.
  near(p[i]!.chikou, bars[i + 26]!.close, 1e-9);
});

test("ama: adapts its smoothing to how efficiently price is moving", () => {
  // The claim is about RESPONSIVENESS, not about ending nearer the last price — on a ramp AMA has a
  // predictable steady-state lag, and the right test is that the lag is the one the formula implies.
  //
  // A straight line is perfectly efficient (ER = 1), so the constant is the fast one, (2/3)² = 4/9,
  // and on a slope-1 ramp the steady-state lag settles at (1 − sc)/sc = 1.25 bars of price.
  const trend = Array.from({ length: 120 }, (_, i) => i);
  const scFast = (2 / 3) ** 2;
  near(trend.at(-1)! - ama(trend, 10, 2, 30).at(-1)!, (1 - scFast) / scFast, 1e-6, "lag on a clean trend");

  // A series that returns to where it started every period is perfectly INefficient (ER = 0), so the
  // constant collapses to (2/31)² ≈ 0.0042 and AMA barely responds to a swing of 10.
  const chop = Array.from({ length: 120 }, (_, i) => (i % 2 ? 10 : 0));
  const a = ama(chop, 10, 2, 30);
  const step = Math.abs(a.at(-1)! - a.at(-2)!);
  assert.ok(step < 0.1, `an inefficient market should barely move AMA, moved ${step} on a swing of 10`);
});

test("dema and tema remove the lag an EMA carries on a straight trend", () => {
  // Both are built to cancel first-order lag exactly, so on a LINEAR ramp both land on the price and
  // neither can beat the other — asserting TEMA < DEMA here would be asserting noise.
  const trend = Array.from({ length: 150 }, (_, i) => 100 + i);
  const last = trend.at(-1)!;
  assert.ok(Math.abs(ema(trend, 20).at(-1)! - last) > 9, "a plain EMA lags a ramp badly");
  near(dema(trend, 20).at(-1), last, 1e-6, "DEMA cancels the lag");
  near(tema(trend, 20).at(-1), last, 1e-6, "TEMA cancels it too");
});

test("tema leads dema where the trend is accelerating", () => {
  // Second-order lag is what separates them, so it only shows on a curve.
  const curve = Array.from({ length: 150 }, (_, i) => 100 + i * i * 0.01);
  const last = curve.at(-1)!;
  const d = Math.abs(dema(curve, 20).at(-1)! - last);
  const t = Math.abs(tema(curve, 20).at(-1)! - last);
  assert.ok(t < d, `TEMA (${t}) should lead DEMA (${d}) on an accelerating trend`);
});

// ───────────────────────────── oscillators ─────────────────────────────

test("rsi: 100 when nothing falls, 0 when nothing rises, and always 0–100", () => {
  assert.equal(rsi(Array.from({ length: 40 }, (_, i) => i), 14).at(-1), 100);
  assert.equal(rsi(Array.from({ length: 40 }, (_, i) => 100 - i), 14).at(-1), 0);
  for (const v of rsi(closes(series(200)), 14)) {
    if (v !== null) assert.ok(v >= 0 && v <= 100, `out of range: ${v}`);
  }
});

test("rsi: warms up exactly `period` bars in", () => {
  assert.equal(firstDefined(rsi(closes(series(60)), 14)), 14);
});

test("macd: line is the fast/slow EMA spread and the histogram is line − signal", () => {
  const src = closes(series(120));
  const f = ema(src, 12), s = ema(src, 26);
  const m = macd(src, 12, 26, 9);
  const i = 100;
  near(m[i]!.macd, f[i]! - s[i]!, 1e-9);
  near(m[i]!.histogram, m[i]!.macd - m[i]!.signal, 1e-9);
  // osma IS the histogram — MetaTrader lists it separately, so they must not drift apart.
  near(osma(src, 12, 26, 9)[i], m[i]!.histogram, 1e-12);
});

test("macd: MetaTrader's SMA signal differs from the conventional EMA one", () => {
  const src = closes(series(150));
  const withEma = macd(src, 12, 26, 9, "ema").at(-1)!;
  const withSma = macd(src, 12, 26, 9, "sma").at(-1)!;
  near(withEma.macd, withSma.macd, 1e-12, "the MACD line itself is the same either way");
  assert.notEqual(withEma.signal, withSma.signal, "the signal line should actually differ");
});

test("momentum: 100 means unchanged over the lookback", () => {
  near(momentum(new Array(30).fill(50), 14).at(-1), 100);
  near(momentum([...new Array(15).fill(10), 20], 15).at(-1), 200);
});

test("cci: zero when price never leaves its mean; signed by direction", () => {
  const flat = new Array(30).fill(null).map(() => bar(10, 10, 10, 10));
  assert.equal(cci(flat, 14).at(-1), 0);
  const rising = Array.from({ length: 60 }, (_, i) => bar(i, i + 1, i - 1, i));
  assert.ok(cci(rising, 14).at(-1)! > 0, "a rising market reads positive");
});

test("williamsR: 0 at the top of the range, −100 at the bottom, never outside", () => {
  const up = Array.from({ length: 40 }, (_, i) => bar(i, i + 1, i - 1, i + 1));
  near(williamsR(up, 14).at(-1), 0, 1e-9, "closing at the high");
  const down = Array.from({ length: 40 }, (_, i) => bar(-i, 1 - i, -1 - i, -1 - i));
  near(williamsR(down, 14).at(-1), -100, 1e-9, "closing at the low");
  for (const v of williamsR(series(200), 14)) {
    if (v !== null) assert.ok(v >= -100 && v <= 0, `out of range: ${v}`);
  }
});

test("stochastic: 0–100, and slowing = 1 is the fast stochastic", () => {
  const bars = series(200);
  for (const p of stochastic(bars, 5, 3, 3)) {
    if (!p) continue;
    assert.ok(p.k >= 0 && p.k <= 100 && p.d >= 0 && p.d <= 100, `out of range: ${p.k}/${p.d}`);
  }
  // With no slowing, %K is the raw range position of the latest bar.
  const fast = stochastic(bars, 5, 1, 3);
  const i = 150;
  let hi = -Infinity, lo = Infinity;
  for (let j = i - 4; j <= i; j++) { hi = Math.max(hi, bars[j]!.high); lo = Math.min(lo, bars[j]!.low); }
  near(fast[i]!.k, (100 * (bars[i]!.close - lo)) / (hi - lo), 1e-9);
});

test("demarker: bounded 0–1, and 1 when every bar makes a new high and no new low", () => {
  const up = Array.from({ length: 40 }, (_, i) => bar(i, i + 1, i, i + 0.5));
  near(demarker(up, 14).at(-1), 1, 1e-9);
  for (const v of demarker(series(200), 14)) {
    if (v !== null) assert.ok(v >= 0 && v <= 1, `out of range: ${v}`);
  }
});

test("bears/bulls power straddle the trend they are measured from", () => {
  const bars = series(120);
  const e = ema(closes(bars), 13);
  const i = 100;
  near(bearsPower(bars, 13)[i], bars[i]!.low - e[i]!, 1e-9);
  near(bullsPower(bars, 13)[i], bars[i]!.high - e[i]!, 1e-9);
  assert.ok(bullsPower(bars, 13)[i]! > bearsPower(bars, 13)[i]!, "a high is above a low");
});

test("rvi: positive when every bar closes at its high, with a signal line that follows", () => {
  const strong = Array.from({ length: 60 }, (_, i) => bar(i, i + 1, i - 0.2, i + 1));
  const last = rvi(strong, 10).at(-1)!;
  assert.ok(last.rvi > 0, `closing on the high should read positive, got ${last.rvi}`);
  assert.ok(Number.isFinite(last.signal));
});

test("trix: zero on a flat series, positive on a rising one", () => {
  near(trix(new Array(120).fill(50), 14).at(-1), 0, 1e-9);
  assert.ok(trix(Array.from({ length: 120 }, (_, i) => 100 + i), 14).at(-1)! > 0);
});

// ───────────────────────────── Bill Williams ─────────────────────────────

test("awesome: the 5/34 median-price spread, zero on a flat market", () => {
  const bars = series(160);
  const m = medianPrice(bars);
  const i = 120;
  let f = 0, s = 0;
  for (let j = i - 4; j <= i; j++) f += m[j]!;
  for (let j = i - 33; j <= i; j++) s += m[j]!;
  near(awesome(bars)[i], f / 5 - s / 34, 1e-9);
  near(awesome(new Array(80).fill(null).map(() => bar(1, 2, 0, 1))).at(-1), 0, 1e-12);
});

test("accelerator: the Awesome Oscillator less its own 5-bar average", () => {
  const bars = series(160);
  const ao = awesome(bars);
  const i = 140;
  let avg = 0;
  for (let j = i - 4; j <= i; j++) avg += ao[j]!;
  near(accelerator(bars)[i], ao[i]! - avg / 5, 1e-9);
});

test("alligator: three displaced smoothed averages, each lagging the next", () => {
  const bars = series(160);
  const a = alligator(bars);
  const m = medianPrice(bars);
  const i = 140;
  // The lips are the 5-period SMMA displaced 3 bars, so bar i carries the value from bar i−3.
  near(a[i]!.lips, smma(m, 5)[i - 3]!, 1e-9);
  near(a[i]!.teeth, smma(m, 8)[i - 5]!, 1e-9);
  near(a[i]!.jaw, smma(m, 13)[i - 8]!, 1e-9);
});

test("gator: upper is never negative, lower never positive", () => {
  for (const g of gator(series(200))) {
    if (!g) continue;
    assert.ok(g.upper >= 0, `upper ${g.upper}`);
    assert.ok(g.lower <= 0, `lower ${g.lower}`);
  }
});

test("fractals: marks a centred local extreme, and never the unfinished tail", () => {
  //                        0          1           2            3           4          5
  const bars = [bar(1, 2, 0, 1), bar(1, 3, 0, 1), bar(1, 9, -9, 1), bar(1, 3, 0, 1), bar(1, 2, 0, 1), bar(1, 2, 0, 1)];
  const f = fractals(bars, 5);
  assert.ok(f[2]!.up, "the centre bar's high tops its window");
  assert.ok(f[2]!.down, "and its low bottoms it");
  assert.ok(!f[0]!.up && !f[1]!.up, "a window that runs off the start cannot be a fractal");
  // The final bars need bars that have not happened yet.
  assert.ok(!f[4]!.up && !f[5]!.up, "the tail is never called early");
});

// ───────────────────────────── shared guarantees ─────────────────────────────

test("every indicator is index-aligned with its input and tolerates short input", () => {
  const bars = series(300);
  const src = closes(bars);
  const lengths: Array<[string, number]> = [
    ["ema", ema(src, 14).length], ["smma", smma(src, 14).length], ["lwma", lwma(src, 14).length],
    ["stdDev", stdDev(src, 20).length], ["envelopes", envelopes(src).length], ["atr", atr(bars).length],
    ["adx", adx(bars).length], ["parabolicSar", parabolicSar(bars).length], ["ichimoku", ichimoku(bars).length],
    ["ama", ama(src).length], ["dema", dema(src).length], ["tema", tema(src).length],
    ["rsi", rsi(src).length], ["macd", macd(src).length], ["osma", osma(src).length],
    ["momentum", momentum(src).length], ["cci", cci(bars).length], ["williamsR", williamsR(bars).length],
    ["stochastic", stochastic(bars).length], ["demarker", demarker(bars).length],
    ["bearsPower", bearsPower(bars).length], ["bullsPower", bullsPower(bars).length],
    ["rvi", rvi(bars).length], ["trix", trix(src).length], ["awesome", awesome(bars).length],
    ["accelerator", accelerator(bars).length], ["alligator", alligator(bars).length],
    ["gator", gator(bars).length], ["fractals", fractals(bars).length],
  ];
  for (const [name, len] of lengths) assert.equal(len, bars.length, `${name} is not index-aligned`);

  // A chart that has only just opened has very few bars; nothing may throw or invent a value.
  for (const n of [0, 1, 2, 5]) {
    const few = series(n);
    const c = closes(few);
    assert.equal(ema(c, 14).length, n);
    assert.equal(atr(few).length, n);
    assert.equal(adx(few).length, n);
    assert.equal(parabolicSar(few).length, n);
    assert.equal(rsi(c).length, n);
    assert.equal(macd(c).length, n);
    assert.equal(stochastic(few).length, n);
    assert.equal(rvi(few).length, n);
    assert.equal(ichimoku(few).length, n);
    assert.equal(fractals(few).length, n);
  }
});

test("no indicator emits NaN or Infinity on a flat market, where every denominator collapses", () => {
  const flat = new Array(200).fill(null).map((_, i) => bar(5, 5, 5, 5, i * 60));
  const src = closes(flat);
  const finite = (name: string, s: Series) => {
    for (const v of s) assert.ok(v === null || Number.isFinite(v), `${name} produced ${v}`);
  };
  finite("ema", ema(src, 14));
  finite("atr", atr(flat));
  finite("rsi", rsi(src));
  finite("cci", cci(flat));
  finite("williamsR", williamsR(flat));
  finite("demarker", demarker(flat));
  finite("trix", trix(src));
  finite("momentum", momentum(src));
  finite("ama", ama(src));
  finite("awesome", awesome(flat));
  finite("sar", parabolicSar(flat));
  for (const p of adx(flat, 14)) if (p) {
    assert.ok(Number.isFinite(p.adx) && Number.isFinite(p.plusDi) && Number.isFinite(p.minusDi), "adx");
  }
  for (const p of stochastic(flat)) if (p) assert.ok(Number.isFinite(p.k) && Number.isFinite(p.d), "stochastic");
  for (const p of rvi(flat)) if (p) assert.ok(Number.isFinite(p.rvi) && Number.isFinite(p.signal), "rvi");
  for (const p of macd(src)) if (p) assert.ok(Number.isFinite(p.macd) && Number.isFinite(p.signal), "macd");
});
