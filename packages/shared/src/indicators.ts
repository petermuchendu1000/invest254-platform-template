/**
 * MetaTrader 5's analytical indicators.
 *
 * MetaTrader groups its built-ins into Trend, Oscillators, Volumes and Bill Williams, and this file
 * follows that order so a reader can check it against the Navigator tree.
 *
 * WHY THIS IS WRITTEN AND NOT IMPORTED: `lightweight-charts` is a renderer — it draws series and
 * ships no indicators at all. TradingView's own indicators are Pine Script executed on their
 * servers, not a library anyone can take. The FORMULAS, though, are public and old: Wilder (1978)
 * for RSI/ATR/ADX/SAR, Lane for the Stochastic, Williams for %R and the Bill Williams set, Kaufman
 * for AMA, Hosoda for Ichimoku, and MetaQuotes' own documentation for the exact smoothing each of
 * its built-ins uses. So every function below is the published formula, implemented here and tested
 * against hand-computed values in indicators.test.ts.
 *
 * THE VOLUMES GROUP IS ABSENT, deliberately. On Balance Volume, Money Flow Index,
 * Accumulation/Distribution, Force Index, the Chaikin Oscillator, Market Facilitation Index and
 * MetaTrader's own Volumes histogram all read tick or real volume, and this platform's candles are
 * built from a synthetic price curve that has no volume (see shared/candles.ts). An indicator fed an
 * invented volume would draw a confident line that means nothing, so those are not implemented
 * rather than implemented wrongly.
 *
 * CONVENTIONS, uniform across the file:
 *   - every result is INDEX-ALIGNED with the input bars, and `null` wherever the indicator has not
 *     warmed up yet — the same contract as `sma` in chart.ts, so a series can be fed straight to the
 *     chart without any index arithmetic at the call site;
 *   - nothing mutates its input;
 *   - a `shift` (MetaTrader's displacement, as on Ichimoku and the Alligator) moves values FORWARD
 *     in the returned array, which is what "plotted n bars ahead" means on screen.
 */

import type { Candle } from "./chart.js";
import { sma } from "./chart.js";

/** A value per bar, `null` until the indicator has enough history. */
export type Series = Array<number | null>;

const nulls = (n: number): Series => new Array(n).fill(null);

/** Shift a series forward by `n` bars (MetaTrader's displacement); negative shifts backward. */
export function shiftSeries(src: Series, n: number): Series {
  if (n === 0) return src.slice();
  const out = nulls(src.length);
  for (let i = 0; i < src.length; i++) {
    const j = i + n;
    if (j >= 0 && j < src.length) out[j] = src[i] ?? null;
  }
  return out;
}

// ───────────────────────────── moving-average methods ─────────────────────────────

/**
 * The four smoothing methods every MetaTrader indicator offers in its `ma_method` dropdown.
 * `smma` is Wilder's smoothing (the RMA), which is what RSI, ATR and ADX use internally.
 */
export type MaMethod = "sma" | "ema" | "smma" | "lwma";

/** Exponential MA. Seeded with the SMA of the first `period` values, as MetaTrader seeds it. */
export function ema(src: readonly number[], period: number): Series {
  const out = nulls(src.length);
  if (period <= 0 || src.length < period) return out;
  const k = 2 / (period + 1);
  let acc = 0;
  for (let i = 0; i < period; i++) acc += src[i]!;
  let prev = acc / period;
  out[period - 1] = prev;
  for (let i = period; i < src.length; i++) {
    prev = src[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Smoothed (Wilder's) MA — the RMA. First value is the SMA; thereafter
 * `(prev · (period − 1) + x) / period`, i.e. an EMA with k = 1/period.
 */
export function smma(src: readonly number[], period: number): Series {
  const out = nulls(src.length);
  if (period <= 0 || src.length < period) return out;
  let acc = 0;
  for (let i = 0; i < period; i++) acc += src[i]!;
  let prev = acc / period;
  out[period - 1] = prev;
  for (let i = period; i < src.length; i++) {
    prev = (prev * (period - 1) + src[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Linear-weighted MA: the newest bar carries weight `period`, the oldest weight 1. */
export function lwma(src: readonly number[], period: number): Series {
  const out = nulls(src.length);
  if (period <= 0) return out;
  const wsum = (period * (period + 1)) / 2;
  for (let i = period - 1; i < src.length; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += src[i - j]! * (period - j);
    out[i] = acc / wsum;
  }
  return out;
}

/** Any of the four methods, chosen at runtime — MetaTrader's `ma_method` parameter. */
export function movingAverage(src: readonly number[], period: number, method: MaMethod = "sma"): Series {
  switch (method) {
    case "ema": return ema(src, period);
    case "smma": return smma(src, period);
    case "lwma": return lwma(src, period);
    default: return sma(src, period);
  }
}

// ───────────────────────────── price inputs ─────────────────────────────

export const closes = (bars: readonly Candle[]): number[] => bars.map((b) => b.close);
export const highs = (bars: readonly Candle[]): number[] => bars.map((b) => b.high);
export const lows = (bars: readonly Candle[]): number[] => bars.map((b) => b.low);
/** MetaTrader's PRICE_MEDIAN — (high + low) / 2. The Bill Williams set is built on it. */
export const medianPrice = (bars: readonly Candle[]): number[] => bars.map((b) => (b.high + b.low) / 2);
/** PRICE_TYPICAL — (high + low + close) / 3. CCI's input. */
export const typicalPrice = (bars: readonly Candle[]): number[] => bars.map((b) => (b.high + b.low + b.close) / 3);

// ───────────────────────────── trend ─────────────────────────────

/** Population standard deviation over a rolling window — MetaTrader's Standard Deviation. */
export function stdDev(src: readonly number[], period = 20): Series {
  const out = nulls(src.length);
  for (let i = period - 1; i < src.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += src[j]!;
    mean /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) { const d = src[j]! - mean; v += d * d; }
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

export interface Band { upper: number; mid: number; lower: number }

/** Envelopes — a moving average with a percentage band either side of it. */
export function envelopes(
  src: readonly number[],
  period = 14,
  deviationPct = 0.1,
  method: MaMethod = "sma",
): Array<Band | null> {
  const mid = movingAverage(src, period, method);
  return mid.map((m) => (m === null ? null : { mid: m, upper: m * (1 + deviationPct / 100), lower: m * (1 - deviationPct / 100) }));
}

/**
 * Average True Range (Wilder). True range is the widest of: this bar's range, and the gap from the
 * previous close to this bar's high or low — so an opening gap counts as range, which is the whole
 * point of the measure.
 */
export function atr(bars: readonly Candle[], period = 14): Series {
  if (bars.length === 0) return [];
  const tr: number[] = [bars[0]!.high - bars[0]!.low];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!, p = bars[i - 1]!;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  return smma(tr, period);
}

export interface AdxPoint { adx: number; plusDi: number; minusDi: number }

/**
 * Average Directional Movement Index (Wilder): how strongly price is trending, and which way.
 *
 * A bar's directional movement is whichever of the two extensions is larger — a higher high (+DM) or
 * a lower low (−DM) — and never both. Each is Wilder-smoothed, normalised by the smoothed true
 * range into +DI/−DI, and ADX is the smoothed spread between them.
 */
export function adxWilder(bars: readonly Candle[], period = 14): Array<AdxPoint | null> {
  const n = bars.length;
  const out: Array<AdxPoint | null> = new Array(n).fill(null);
  if (n < 2) return out;

  const plusDm: number[] = [0], minusDm: number[] = [0], tr: number[] = [bars[0]!.high - bars[0]!.low];
  for (let i = 1; i < n; i++) {
    const b = bars[i]!, p = bars[i - 1]!;
    const up = b.high - p.high;
    const down = p.low - b.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }

  const sTr = smma(tr, period), sPlus = smma(plusDm, period), sMinus = smma(minusDm, period);
  const dx: number[] = new Array(n).fill(0);
  const dxValid: boolean[] = new Array(n).fill(false);
  const di: Array<{ p: number; m: number } | null> = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const t = sTr[i], p = sPlus[i], m = sMinus[i];
    if (t === null || t === undefined || p === null || p === undefined || m === null || m === undefined || t === 0) continue;
    const pdi = (100 * p) / t, mdi = (100 * m) / t;
    di[i] = { p: pdi, m: mdi };
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
    dxValid[i] = true;
  }

  // ADX is the Wilder average of DX, started from the first bar DX exists on.
  const first = dxValid.indexOf(true);
  if (first < 0) return out;
  const smoothed = smma(dx.slice(first), period);
  for (let i = 0; i < n; i++) {
    const d = di[i];
    const a = i >= first ? smoothed[i - first] : null;
    if (d && a !== null && a !== undefined) out[i] = { adx: a, plusDi: d.p, minusDi: d.m };
  }
  return out;
}

/**
 * Parabolic SAR (Wilder): the stop-and-reverse dots that trail a trend and tighten as it extends.
 *
 * The acceleration factor steps up by `step` on each new extreme and is capped at `max`; on a flip
 * the SAR restarts at the prior extreme. MetaTrader also clamps the new SAR so it can never sit
 * inside the last two bars' range, which is what stops it printing a stop that price has already
 * passed through.
 */
export function parabolicSar(bars: readonly Candle[], step = 0.02, max = 0.2): Series {
  const n = bars.length;
  const out = nulls(n);
  if (n < 2) return out;

  let rising = bars[1]!.close >= bars[0]!.close;
  let af = step;
  let ep = rising ? bars[0]!.high : bars[0]!.low;
  let sar = rising ? bars[0]!.low : bars[0]!.high;
  out[1] = sar;

  for (let i = 2; i < n; i++) {
    const b = bars[i]!, p1 = bars[i - 1]!, p2 = bars[i - 2]!;
    sar = sar + af * (ep - sar);
    if (rising) {
      sar = Math.min(sar, p1.low, p2.low);
      if (b.low < sar) { rising = false; sar = ep; ep = b.low; af = step; }
      else if (b.high > ep) { ep = b.high; af = Math.min(af + step, max); }
    } else {
      sar = Math.max(sar, p1.high, p2.high);
      if (b.high > sar) { rising = true; sar = ep; ep = b.high; af = step; }
      else if (b.low < ep) { ep = b.low; af = Math.min(af + step, max); }
    }
    out[i] = sar;
  }
  return out;
}

export interface IchimokuPoint {
  tenkan: number | null;
  kijun: number | null;
  senkouA: number | null;
  senkouB: number | null;
  chikou: number | null;
}

/**
 * Ichimoku Kinko Hyo (9 / 26 / 52).
 *
 * Each of the three lines is the midpoint of its window's high–low range, not an average of closes.
 * The two Senkou spans — the cloud — are plotted `kijun` bars AHEAD, and Chikou is the close plotted
 * the same distance BEHIND; both displacements are applied here, so the arrays are already in the
 * positions MetaTrader draws them.
 */
export function ichimoku(bars: readonly Candle[], tenkanP = 9, kijunP = 26, senkouP = 52): Array<IchimokuPoint> {
  const n = bars.length;
  const mid = (period: number): Series => {
    const out = nulls(n);
    for (let i = period - 1; i < n; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - period + 1; j <= i; j++) { hi = Math.max(hi, bars[j]!.high); lo = Math.min(lo, bars[j]!.low); }
      out[i] = (hi + lo) / 2;
    }
    return out;
  };
  const tenkan = mid(tenkanP);
  const kijun = mid(kijunP);
  const rawA = tenkan.map((t, i) => (t === null || kijun[i] === null || kijun[i] === undefined ? null : (t + kijun[i]!) / 2));
  const senkouA = shiftSeries(rawA, kijunP);
  const senkouB = shiftSeries(mid(senkouP), kijunP);
  const chikou = shiftSeries(bars.map((b) => b.close), -kijunP);
  return bars.map((_, i) => ({
    tenkan: tenkan[i] ?? null,
    kijun: kijun[i] ?? null,
    senkouA: senkouA[i] ?? null,
    senkouB: senkouB[i] ?? null,
    chikou: chikou[i] ?? null,
  }));
}

/**
 * Kaufman's Adaptive Moving Average: fast when price travels in a straight line, slow when it
 * thrashes. The efficiency ratio is net movement over total movement, and it scales the smoothing
 * constant between the fast and slow bounds.
 */
export function ama(src: readonly number[], period = 10, fast = 2, slow = 30): Series {
  const n = src.length;
  const out = nulls(n);
  if (n <= period) return out;
  const fastSc = 2 / (fast + 1), slowSc = 2 / (slow + 1);
  let prev = src[period - 1]!;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    const change = Math.abs(src[i]! - src[i - period]!);
    let volatility = 0;
    for (let j = i - period + 1; j <= i; j++) volatility += Math.abs(src[j]! - src[j - 1]!);
    const er = volatility === 0 ? 0 : change / volatility;
    const sc = (er * (fastSc - slowSc) + slowSc) ** 2;
    prev = prev + sc * (src[i]! - prev);
    out[i] = prev;
  }
  return out;
}

/** Double Exponential MA — 2·EMA − EMA(EMA), which cuts the lag an EMA carries. */
export function dema(src: readonly number[], period = 14): Series {
  const e1 = ema(src, period);
  const defined = e1.filter((v): v is number => v !== null);
  const e2 = ema(defined, period);
  const offset = e1.length - defined.length;
  return e1.map((v, i) => {
    const b = e2[i - offset];
    return v === null || b === null || b === undefined ? null : 2 * v - b;
  });
}

/** Triple Exponential MA — 3·EMA − 3·EMA² + EMA³. */
export function tema(src: readonly number[], period = 14): Series {
  const e1 = ema(src, period);
  const d1 = e1.filter((v): v is number => v !== null);
  const e2 = ema(d1, period);
  const d2 = e2.filter((v): v is number => v !== null);
  const e3 = ema(d2, period);
  const off1 = e1.length - d1.length;
  const off2 = off1 + (e2.length - d2.length);
  return e1.map((v, i) => {
    const b = e2[i - off1], c = e3[i - off2];
    return v === null || b === null || b === undefined || c === null || c === undefined ? null : 3 * v - 3 * b + c;
  });
}

// ───────────────────────────── oscillators ─────────────────────────────

/** Relative Strength Index (Wilder). Average gain and loss are Wilder-smoothed, not simple means. */
export function rsi(src: readonly number[], period = 14): Series {
  const n = src.length;
  const out = nulls(n);
  if (n <= period) return out;
  const gains: number[] = [0], losses: number[] = [0];
  for (let i = 1; i < n; i++) {
    const d = src[i]! - src[i - 1]!;
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  // Wilder seeds on bars 1..period, so the smoothing starts one bar in.
  const g = smma(gains.slice(1), period), l = smma(losses.slice(1), period);
  for (let i = 0; i < g.length; i++) {
    const gv = g[i], lv = l[i];
    if (gv === null || gv === undefined || lv === null || lv === undefined) continue;
    out[i + 1] = lv === 0 ? 100 : 100 - 100 / (1 + gv / lv);
  }
  return out;
}

export interface MacdPoint { macd: number; signal: number; histogram: number }

/**
 * Moving Average Convergence/Divergence.
 *
 * `signalMethod` exists because the two worlds disagree: MetaTrader's own built-in smooths the
 * signal line with an SMA, while TradingView and most published MACD use an EMA. Defaulting to EMA
 * matches what a trader coming from any other chart expects to see; pass `"sma"` for MetaTrader's.
 */
export function macd(
  src: readonly number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
  signalMethod: MaMethod = "ema",
): Array<MacdPoint | null> {
  const f = ema(src, fast), s = ema(src, slow);
  const line: Series = src.map((_, i) => {
    const a = f[i], b = s[i];
    return a === null || a === undefined || b === null || b === undefined ? null : a - b;
  });
  const defined = line.filter((v): v is number => v !== null);
  const sig = movingAverage(defined, signalPeriod, signalMethod);
  const offset = line.length - defined.length;
  return line.map((m, i) => {
    const sv = sig[i - offset];
    if (m === null || sv === null || sv === undefined) return null;
    return { macd: m, signal: sv, histogram: m - sv };
  });
}

/** Moving Average of Oscillator — the MACD histogram, which MetaTrader lists as its own indicator. */
export function osma(src: readonly number[], fast = 12, slow = 26, signalPeriod = 9): Series {
  return macd(src, fast, slow, signalPeriod).map((p) => (p ? p.histogram : null));
}

/** Momentum — this close as a percentage of the close `period` bars ago. */
export function momentum(src: readonly number[], period = 14): Series {
  return src.map((v, i) => {
    const past = src[i - period];
    return i < period || past === undefined || past === 0 ? null : (v / past) * 100;
  });
}

/** Commodity Channel Index — typical price's distance from its mean, in mean-deviation units. */
export function cci(bars: readonly Candle[], period = 14): Series {
  const tp = typicalPrice(bars);
  const mean = sma(tp, period);
  return tp.map((v, i) => {
    const m = mean[i];
    if (m === null || m === undefined) return null;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j]! - m);
    dev /= period;
    return dev === 0 ? 0 : (v - m) / (0.015 * dev);
  });
}

/** Williams' Percent Range — where the close sits in the period's range, as 0 (top) to −100. */
export function williamsR(bars: readonly Candle[], period = 14): Series {
  const out = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) { hi = Math.max(hi, bars[j]!.high); lo = Math.min(lo, bars[j]!.low); }
    out[i] = hi === lo ? 0 : (-100 * (hi - bars[i]!.close)) / (hi - lo);
  }
  return out;
}

export interface StochasticPoint { k: number; d: number }

/**
 * Stochastic Oscillator (Lane). `slowing` smooths raw %K — MetaTrader's default 5/3/3 means a 5-bar
 * range, 3-bar slowing, and a 3-bar %D — so the "fast" stochastic is simply slowing = 1.
 */
export function stochastic(bars: readonly Candle[], kPeriod = 5, slowing = 3, dPeriod = 3): Array<StochasticPoint | null> {
  const n = bars.length;
  const raw: number[] = [];
  const rawIdx: number[] = [];
  for (let i = kPeriod - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { hi = Math.max(hi, bars[j]!.high); lo = Math.min(lo, bars[j]!.low); }
    raw.push(hi === lo ? 100 : (100 * (bars[i]!.close - lo)) / (hi - lo));
    rawIdx.push(i);
  }
  const k = sma(raw, slowing);
  const kDefined = k.filter((v): v is number => v !== null);
  const d = sma(kDefined, dPeriod);
  const dOffset = k.length - kDefined.length;

  const out: Array<StochasticPoint | null> = new Array(n).fill(null);
  for (let i = 0; i < raw.length; i++) {
    const kv = k[i], dv = d[i - dOffset];
    if (kv !== null && kv !== undefined && dv !== null && dv !== undefined) out[rawIdx[i]!] = { k: kv, d: dv };
  }
  return out;
}

/**
 * DeMarker — demand measured from the new ground each bar breaks, rather than from its close.
 * A bar that fails to make a new high contributes nothing to DeMax, and vice versa.
 */
export function demarker(bars: readonly Candle[], period = 14): Series {
  const n = bars.length;
  const deMax: number[] = [0], deMin: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = bars[i]!.high - bars[i - 1]!.high;
    const down = bars[i - 1]!.low - bars[i]!.low;
    deMax.push(up > 0 ? up : 0);
    deMin.push(down > 0 ? down : 0);
  }
  const a = sma(deMax, period), b = sma(deMin, period);
  return bars.map((_, i) => {
    const x = a[i], y = b[i];
    if (x === null || x === undefined || y === null || y === undefined) return null;
    return x + y === 0 ? 0 : x / (x + y);
  });
}

/** Bears Power — how far below the trend the sellers managed to push the bar's low. */
export function bearsPower(bars: readonly Candle[], period = 13): Series {
  const e = ema(closes(bars), period);
  return bars.map((b, i) => (e[i] === null || e[i] === undefined ? null : b.low - e[i]!));
}

/** Bulls Power — how far above the trend the buyers managed to push the bar's high. */
export function bullsPower(bars: readonly Candle[], period = 13): Series {
  const e = ema(closes(bars), period);
  return bars.map((b, i) => (e[i] === null || e[i] === undefined ? null : b.high - e[i]!));
}

export interface RviPoint { rvi: number; signal: number }

/**
 * Relative Vigor Index: the close's position within the bar's own range, on the premise that a
 * strong market closes near its high. Both halves are weighted 1-2-2-1 over four bars before the
 * average, which is what damps the single-bar noise this would otherwise be full of.
 */
export function rvi(bars: readonly Candle[], period = 10): Array<RviPoint | null> {
  const n = bars.length;
  const num: number[] = [], den: number[] = [], idx: number[] = [];
  for (let i = 3; i < n; i++) {
    const w = (f: (c: Candle) => number) =>
      f(bars[i]!) + 2 * f(bars[i - 1]!) + 2 * f(bars[i - 2]!) + f(bars[i - 3]!);
    num.push(w((c) => c.close - c.open) / 6);
    den.push(w((c) => c.high - c.low) / 6);
    idx.push(i);
  }
  const a = sma(num, period), b = sma(den, period);
  const line: number[] = [], lineIdx: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === null || x === undefined || y === null || y === undefined) continue;
    line.push(y === 0 ? 0 : x / y);
    lineIdx.push(idx[i]!);
  }
  const out: Array<RviPoint | null> = new Array(n).fill(null);
  for (let i = 3; i < line.length; i++) {
    const sig = (line[i]! + 2 * line[i - 1]! + 2 * line[i - 2]! + line[i - 3]!) / 6;
    out[lineIdx[i]!] = { rvi: line[i]!, signal: sig };
  }
  return out;
}

/** TRIX — the rate of change of a triple-smoothed EMA, in percent. */
export function trix(src: readonly number[], period = 14): Series {
  const e1 = ema(src, period);
  const d1 = e1.filter((v): v is number => v !== null);
  const e2 = ema(d1, period);
  const d2 = e2.filter((v): v is number => v !== null);
  const e3 = ema(d2, period);
  const offset = (e1.length - d1.length) + (e2.length - d2.length);
  const out = nulls(src.length);
  for (let i = 1; i < e3.length; i++) {
    const cur = e3[i], prev = e3[i - 1];
    if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) continue;
    out[i + offset] = ((cur - prev) / prev) * 100;
  }
  return out;
}

// ───────────────────────────── Bill Williams ─────────────────────────────

/** Awesome Oscillator — a 5-bar versus 34-bar median-price spread. */
export function awesome(bars: readonly Candle[], fast = 5, slow = 34): Series {
  const m = medianPrice(bars);
  const f = sma(m, fast), s = sma(m, slow);
  return bars.map((_, i) => {
    const a = f[i], b = s[i];
    return a === null || a === undefined || b === null || b === undefined ? null : a - b;
  });
}

/** Accelerator Oscillator — the Awesome Oscillator minus its own 5-bar average. */
export function accelerator(bars: readonly Candle[], smoothing = 5): Series {
  const ao = awesome(bars);
  const defined = ao.filter((v): v is number => v !== null);
  const avg = sma(defined, smoothing);
  const offset = ao.length - defined.length;
  return ao.map((v, i) => {
    const a = avg[i - offset];
    return v === null || a === null || a === undefined ? null : v - a;
  });
}

export interface AlligatorPoint { jaw: number | null; teeth: number | null; lips: number | null }

/**
 * Alligator — three displaced smoothed averages of the median price (13/8, 8/5, 5/3). The
 * displacements are applied, so jaw, teeth and lips sit where MetaTrader draws them.
 */
export function alligator(
  bars: readonly Candle[],
  jawP = 13, jawShift = 8,
  teethP = 8, teethShift = 5,
  lipsP = 5, lipsShift = 3,
): Array<AlligatorPoint> {
  const m = medianPrice(bars);
  const jaw = shiftSeries(smma(m, jawP), jawShift);
  const teeth = shiftSeries(smma(m, teethP), teethShift);
  const lips = shiftSeries(smma(m, lipsP), lipsShift);
  return bars.map((_, i) => ({ jaw: jaw[i] ?? null, teeth: teeth[i] ?? null, lips: lips[i] ?? null }));
}

export interface GatorPoint { upper: number; lower: number }

/** Gator Oscillator — the gaps between the Alligator's lines; the lower bar is drawn negative. */
export function gator(bars: readonly Candle[]): Array<GatorPoint | null> {
  return alligator(bars).map((a) => {
    if (a.jaw === null || a.teeth === null || a.lips === null) return null;
    return { upper: Math.abs(a.jaw - a.teeth), lower: -Math.abs(a.teeth - a.lips) };
  });
}

export interface Fractal { up: boolean; down: boolean }

/**
 * Fractals — a bar whose high is the highest of a centred window (and the mirror for lows).
 *
 * The last `half` bars can never be fractals yet: the window needs bars that have not happened. That
 * is a property of the indicator, not a gap to fill, so they stay false.
 */
export function fractals(bars: readonly Candle[], window = 5): Fractal[] {
  const half = Math.floor(window / 2);
  return bars.map((_, i) => {
    if (i < half || i + half >= bars.length) return { up: false, down: false };
    let up = true, down = true;
    for (let j = i - half; j <= i + half; j++) {
      if (j === i) continue;
      if (bars[j]!.high >= bars[i]!.high) up = false;
      if (bars[j]!.low <= bars[i]!.low) down = false;
    }
    return { up, down };
  });
}

/**
 * Average Directional Movement Index, MetaTrader's `iADX`.
 *
 * MetaTrader ships TWO of these and they are not the same indicator. Its own ADX.mq5 smooths DI+,
 * DI- and the main line with an EXPONENTIAL moving average over the raw True Range, while ADXW.mq5
 * smooths the True Range, both DIs and the main line with Wilder's SMMA. MetaQuotes documents the
 * two as distinct entries in the Navigator but publishes no formula for either; the difference
 * above is read off the source it ships with the terminal (see the MQL5 forum thread "Difference
 * between ADX and ADX Wilder").
 *
 * This matters here because what this codebase called "Average Directional Movement" was smoothed
 * with SMMA throughout, which makes it `adxWilder`. It is now named that, and this is the other one.
 */
export function adx(bars: readonly Candle[], period = 14): Array<AdxPoint | null> {
  const n = bars.length;
  const out: Array<AdxPoint | null> = new Array(n).fill(null);
  if (n < 2) return out;

  const plusDm: number[] = [0], minusDm: number[] = [0], tr: number[] = [bars[0]!.high - bars[0]!.low];
  for (let i = 1; i < n; i++) {
    const b = bars[i]!, p = bars[i - 1]!;
    const up = b.high - p.high;
    const down = p.low - b.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }

  // The DIs are the exponentially smoothed directional movements over the RAW true range.
  const ePlus = ema(plusDm, period), eMinus = ema(minusDm, period), eTr = ema(tr, period);
  const dx: number[] = new Array(n).fill(0);
  const dxValid: boolean[] = new Array(n).fill(false);
  const di: Array<{ p: number; m: number } | null> = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const t = eTr[i], p = ePlus[i], m = eMinus[i];
    if (t === null || t === undefined || p === null || p === undefined || m === null || m === undefined || t === 0) continue;
    const pdi = (100 * p) / t, mdi = (100 * m) / t;
    di[i] = { p: pdi, m: mdi };
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
    dxValid[i] = true;
  }

  const first = dxValid.indexOf(true);
  if (first < 0) return out;
  const smoothed = ema(dx.slice(first), period);
  for (let i = 0; i < n; i++) {
    const d = di[i];
    const a = i >= first ? smoothed[i - first] : null;
    if (d && a !== null && a !== undefined) out[i] = { adx: a, plusDi: d.p, minusDi: d.m };
  }
  return out;
}

/**
 * Fractal Adaptive Moving Average (FRAMA), MetaTrader's `iFrAMA`.
 *
 * Ehlers' idea: measure how fractal the recent price path is, and let that set the smoothing. The
 * window is split in half; each half's range per bar is compared with the whole window's range per
 * bar, and the ratio gives a fractal dimension D between 1 (a straight line) and 2 (noise). The
 * smoothing constant is exp(-4.6 * (D - 1)), so a trending market gets a fast average and a choppy
 * one gets a slow average.
 *
 * `period` must be even for the halves to be equal, which is why MetaTrader's default is 14.
 */
export function frama(bars: readonly Candle[], period = 14): Series {
  const n = bars.length;
  const out: Series = new Array(n).fill(null);
  const half = Math.floor(period / 2);
  if (half < 1 || n === 0) return out;

  const rangeOver = (from: number, to: number): number => {
    let hi = -Infinity, lo = Infinity;
    for (let i = from; i <= to; i++) {
      const b = bars[i]!;
      if (b.high > hi) hi = b.high;
      if (b.low < lo) lo = b.low;
    }
    return hi - lo;
  };

  let prev: number | null = null;
  for (let i = period - 1; i < n; i++) {
    const start = i - period + 1;
    const mid = start + half;
    const n1 = rangeOver(mid, i) / half;            // the RECENT half
    const n2 = rangeOver(start, mid - 1) / half;    // the OLDER half
    const n3 = rangeOver(start, i) / period;        // the whole window
    let alpha: number;
    if (n1 > 0 && n2 > 0 && n3 > 0) {
      const d = (Math.log(n1 + n2) - Math.log(n3)) / Math.LN2;
      alpha = Math.exp(-4.6 * (d - 1));
      // MetaTrader clamps the constant so the average can neither freeze nor become the price.
      alpha = Math.min(1, Math.max(0.01, alpha));
    } else {
      alpha = 1; // a flat window carries no information: follow the price rather than invent a lag
    }
    const price = bars[i]!.close;
    prev = prev === null ? price : alpha * price + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/**
 * Variable Index Dynamic Average (VIDyA), MetaTrader's `iVIDyA`.
 *
 * Chande's average: an EMA whose smoothing constant is scaled by the absolute Chande Momentum
 * Oscillator, so the average speeds up when the market is directional and slows when it is not.
 * MetaTrader's defaults are a 9-bar CMO and a 12-bar EMA.
 */
export function vidya(src: readonly number[], cmoPeriod = 9, emaPeriod = 12): Series {
  const n = src.length;
  const out: Series = new Array(n).fill(null);
  if (n === 0 || cmoPeriod < 1 || emaPeriod < 1) return out;
  const f = 2 / (emaPeriod + 1);

  let prev: number | null = null;
  for (let i = cmoPeriod; i < n; i++) {
    let up = 0, down = 0;
    for (let j = i - cmoPeriod + 1; j <= i; j++) {
      const diff = src[j]! - src[j - 1]!;
      if (diff > 0) up += diff; else down -= diff;
    }
    const total = up + down;
    const cmo = total === 0 ? 0 : Math.abs((up - down) / total);
    const k = f * cmo;
    const price = src[i]!;
    prev = prev === null ? price : price * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
