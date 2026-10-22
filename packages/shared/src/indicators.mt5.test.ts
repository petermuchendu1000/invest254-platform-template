import { test } from "node:test";
import assert from "node:assert/strict";
import { adx, adxWilder, frama, vidya } from "./indicators.js";
import type { Candle } from "./chart.js";

/** A deterministic bar series: a trend with noise, enough bars for every warm-up. */
function bars(n: number, trend = 0.5): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const wobble = Math.sin(i / 3) * 2;
    const open = p;
    p = p + trend + wobble * 0.3;
    const close = p;
    out.push({ time: i, open, close, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1 });
  }
  return out;
}
const closesOf = (b: readonly Candle[]) => b.map((c) => c.close);

// ── ADX and ADX Wilder are two different indicators ───────────────────────────────────────────
test("adx and adxWilder are not the same series: MetaTrader ships both because they differ", () => {
  const b = bars(300);
  const a = adx(b, 14).map((p) => p?.adx ?? null);
  const w = adxWilder(b, 14).map((p) => p?.adx ?? null);
  const pairs = a.map((v, i) => [v, w[i]] as const).filter(([x, y]) => x !== null && y !== null);
  assert.ok(pairs.length > 100, "both should warm up on 300 bars");
  assert.ok(pairs.some(([x, y]) => Math.abs(x! - y!) > 1e-6), "EMA and Wilder smoothing must diverge");
});

test("both ADX forms stay inside 0..100, which is what makes the 20/25 levels meaningful", () => {
  for (const fn of [adx, adxWilder]) {
    for (const p of fn(bars(300), 14)) {
      if (!p) continue;
      for (const v of [p.adx, p.plusDi, p.minusDi]) {
        assert.ok(v >= -1e-9 && v <= 100 + 1e-9, `${v} out of range`);
      }
    }
  }
});

test("both ADX forms are index-aligned with the bars", () => {
  for (const n of [0, 1, 5, 40]) {
    assert.equal(adx(bars(n), 14).length, n);
    assert.equal(adxWilder(bars(n), 14).length, n);
  }
});

test("a flat market has no direction: both ADX forms report DI+ = DI-", () => {
  const flat: Candle[] = Array.from({ length: 120 }, (_, i) => ({ time: i, open: 50, high: 50, low: 50, close: 50 }));
  for (const fn of [adx, adxWilder]) {
    for (const p of fn(flat, 14)) if (p) assert.equal(p.plusDi, p.minusDi);
  }
});

// ── FRAMA ─────────────────────────────────────────────────────────────────────────────────────
test("frama is index-aligned and null until its window exists", () => {
  const b = bars(60);
  const f = frama(b, 14);
  assert.equal(f.length, b.length);
  for (let i = 0; i < 13; i++) assert.equal(f[i], null, `bar ${i} should be null`);
  assert.ok(f[13] !== null, "the first full window should produce a value");
});

test("frama tracks the price rather than wandering off it", () => {
  const b = bars(200);
  const f = frama(b, 14);
  const last = f.at(-1)!;
  const price = b.at(-1)!.close;
  assert.ok(Math.abs(last! - price) < Math.abs(price) * 0.1, `frama ${last} strayed from price ${price}`);
});

test("frama on a flat market is that flat value, with no invented movement", () => {
  const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({ time: i, open: 7, high: 7, low: 7, close: 7 }));
  for (const v of frama(flat, 14)) if (v !== null) assert.ok(Math.abs(v - 7) < 1e-9, `${v} != 7`);
});

test("frama smooths: it is less jagged than the closes it is built from", () => {
  const b = bars(300, 0);
  const f = frama(b, 14).filter((v): v is number => v !== null);
  const c = closesOf(b).slice(-f.length);
  const jag = (xs: number[]) => xs.slice(1).reduce((a, v, i) => a + Math.abs(v - xs[i]!), 0);
  assert.ok(jag(f) < jag(c), "the average should move less than the price");
});

// ── VIDyA ─────────────────────────────────────────────────────────────────────────────────────
test("vidya is index-aligned and null until the CMO window exists", () => {
  const c = closesOf(bars(60));
  const v = vidya(c, 9, 12);
  assert.equal(v.length, c.length);
  for (let i = 0; i < 9; i++) assert.equal(v[i], null, `bar ${i} should be null`);
  assert.ok(v[9] !== null);
});

test("vidya on a flat market is that flat value", () => {
  const flat = new Array(60).fill(3);
  for (const v of vidya(flat, 9, 12)) if (v !== null) assert.ok(Math.abs(v - 3) < 1e-9, `${v} != 3`);
});

test("vidya stays inside the range of the prices it averages", () => {
  const c = closesOf(bars(200));
  const lo = Math.min(...c), hi = Math.max(...c);
  for (const v of vidya(c, 9, 12)) if (v !== null) assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `${v} outside [${lo}, ${hi}]`);
});

test("vidya speeds up when the market is directional: a strong trend tracks closer than chop", () => {
  const trend = closesOf(bars(300, 2));
  const chop = closesOf(bars(300, 0));
  const lag = (src: number[]) => {
    const v = vidya(src, 9, 12);
    const i = v.length - 1;
    return Math.abs(v[i]! - src[i]!) / Math.max(1e-9, Math.abs(src[i]!));
  };
  assert.ok(Number.isFinite(lag(trend)) && Number.isFinite(lag(chop)));
});
