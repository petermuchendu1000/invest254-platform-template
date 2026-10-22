import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VERSIONED_CONFIG, deriveSiteDaySeed, dateKeyUTC, dayStartMs, CurveGenerator,
  valueOfRate, priceAtRate, XAUUSD, DAY_S, TIMEFRAMES, type Timeframe,
} from "@invest254/shared";
import { MarketHistory, HISTORY_DAYS, MAX_BARS, MAX_ANCHORS } from "./markethistory.js";

const MASTER = "history-master-seed";
const SITE_A = "00000000-0000-0000-0000-0000000000a1";
const SITE_B = "00000000-0000-0000-0000-0000000000b2";
/** Fixed "now" so every assertion is reproducible: Wed 18 Mar 2026, 13:47:29Z. */
const NOW = Date.UTC(2026, 2, 18, 13, 47, 29);

const build = (siteId = SITE_A, now = () => NOW) =>
  new MarketHistory((dateKey) => deriveSiteDaySeed(MASTER, siteId, dateKey, 0), () => DEFAULT_VERSIONED_CONFIG, { now });

test("returns the requested number of bars, newest last, strictly ascending", () => {
  const h = build();
  for (const [tf, want] of [["M1", 300], ["M15", 200], ["H1", 150], ["H4", 90], ["D1", 60]] as Array<[Timeframe, number]>) {
    const bars = h.candles(tf, want);
    assert.equal(bars.length, want, `${tf} returned ${bars.length}`);
    for (let i = 1; i < bars.length; i++) {
      assert.ok(bars[i]!.time > bars[i - 1]!.time, `${tf} not ascending at ${i}`);
      assert.ok(bars[i]!.high >= bars[i]!.low, `${tf} inverted bar at ${i}`);
    }
    // Buckets must be exactly one period apart for the fixed-width timeframes.
    if (tf !== "D1") {
      for (let i = 1; i < bars.length; i++) {
        assert.equal(bars[i]!.time - bars[i - 1]!.time, TIMEFRAMES[tf], `${tf} bucket width wrong at ${i}`);
      }
    }
  }
});

test("never returns a bar that has not closed yet", () => {
  // A forming candle drawn as a finished one would show a false high/low and a false close. The live
  // tick stream owns the current bar; history must stop at the last CLOSED one.
  const h = build();
  const nowS = Math.floor(NOW / 1000);
  for (const tf of ["M1", "M15", "H1", "D1"] as Timeframe[]) {
    const last = h.candles(tf, 10).at(-1)!;
    const width = tf === "D1" ? DAY_S : TIMEFRAMES[tf];
    assert.ok(last.time + width <= nowS, `${tf} returned a bar closing at ${last.time + width} > now ${nowS}`);
  }
});

test("history is CONTINUOUS across the UTC midnight reseed", () => {
  // The curve restarts from a fresh seed every day. Chaining the bases is what stops the chart from
  // jumping at midnight; without it the price would snap by tens of points every day.
  const h = build();
  const bars = h.candles("H1", 24 * 5);
  let worst = 0;
  for (let i = 1; i < bars.length; i++) worst = Math.max(worst, Math.abs(bars[i]!.open - bars[i - 1]!.close));
  // A single H1 bar's own range is several points; a rollover must not stand out against that.
  assert.ok(worst < 1.5, `discontinuity of ${worst.toFixed(2)} points across a boundary`);
});

test("timeframes agree with each other — H4 is exactly its four H1 bars", () => {
  const h = build();
  const h1 = h.candles("H1", 400);
  const h4 = h.candles("H4", 100);
  const byStart = new Map(h4.map((b) => [b.time, b]));
  let checked = 0;
  for (const [start, bar] of byStart) {
    const parts = h1.filter((b) => b.time >= start && b.time < start + 14_400);
    if (parts.length !== 4) continue; // edge buckets not fully covered by the H1 window
    checked++;
    assert.equal(bar.open, parts[0]!.open, `H4 ${start} open`);
    assert.equal(bar.close, parts[3]!.close, `H4 ${start} close`);
    assert.equal(bar.high, Math.max(...parts.map((p) => p.high)), `H4 ${start} high`);
    assert.equal(bar.low, Math.min(...parts.map((p) => p.low)), `H4 ${start} low`);
  }
  assert.ok(checked > 50, `expected many fully-covered H4 buckets, checked ${checked}`);
});

test("history matches the LIVE curve exactly — the chart cannot disagree with settlement", () => {
  // This is the fairness-critical one. A candle is only honest if it is the same seeded path the
  // settlement engine scores. Recompute a past minute straight from that day's curve and require the
  // stored bar to match it to the tick.
  const h = build();
  const bars = h.candles("M1", 2000);
  const anchorDay = dateKeyUTC(NOW);
  const checkKeys = new Set(bars.map((b) => dateKeyUTC(b.time * 1000)));
  assert.ok(checkKeys.size >= 2, "window must span more than one seeded day to be a real test");

  for (const dateKey of checkKeys) {
    const curve = new CurveGenerator(deriveSiteDaySeed(MASTER, SITE_A, dateKey, 0), DEFAULT_VERSIONED_CONFIG, "market");
    const dayStartS = dayStartMs(dateKey) / 1000;
    const open0 = curve.value(0);
    const inDay = bars.filter((b) => dateKeyUTC(b.time * 1000) === dateKey);
    // The day's base is implied by its first bar; every other bar must follow from the same curve.
    const first = inDay[0]!;
    const base = first.open - XAUUSD.scale * (curve.value(first.time - dayStartS) - open0);
    for (const b of inDay) {
      const t = b.time - dayStartS;
      const expected = Math.round((base + XAUUSD.scale * (curve.value(t) - open0)) * 100) / 100;
      assert.ok(Math.abs(b.open - expected) <= 0.011, `${dateKey} t=${t}: bar open ${b.open} vs curve ${expected}`);
    }
  }
  assert.ok(anchorDay.length === 10);
});

test("a tick priced through liveAnchor lands on the history's price axis", () => {
  // The live stream sends `rate`; the chart must place it on the same axis as the fetched candles,
  // or the forming candle would sit at a different level from the one beside it.
  const h = build();
  const { dateKey, base, openValue, instrument } = h.liveAnchor(NOW);
  const curve = new CurveGenerator(deriveSiteDaySeed(MASTER, SITE_A, dateKey, 0), DEFAULT_VERSIONED_CONFIG, "market");
  const bars = h.candles("M1", 5);
  const last = bars.at(-1)!;
  const t = last.time - dayStartMs(dateKey) / 1000;
  // Price the tick the way the client will: from the rate it receives, not from the curve directly.
  const fromTick = base + instrument.scale * (valueOfRate(curve.rate(t)) - openValue);
  assert.ok(Math.abs(fromTick - last.open) <= 0.011, `tick priced ${fromTick.toFixed(2)} vs bar open ${last.open}`);
});

test("brands get independent histories from the same master seed", () => {
  const a = build(SITE_A).candles("H1", 120);
  const b = build(SITE_B).candles("H1", 120);
  assert.equal(a.length, b.length);
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i]!.close === b[i]!.close) same++;
  assert.ok(same < a.length * 0.05, `brands share ${same}/${a.length} closes`);
});

test("deterministic: the same brand and clock rebuild byte-identical history", () => {
  assert.deepEqual(build().candles("M15", 200), build().candles("M15", 200));
});

test("request size is capped, and the reach back is bounded by HISTORY_DAYS", () => {
  const h = build();
  assert.ok(h.candles("M1", 10 * MAX_BARS).length <= MAX_BARS, "an oversized request must be clamped");
  assert.ok(h.candles("M1", 0).length >= 1, "a non-positive count must still return something sane");
  // D1 cannot reach further back than the chain exists.
  assert.ok(h.candles("D1", HISTORY_DAYS + 500).length <= HISTORY_DAYS + 1, "reached past the chain");
  assert.ok(h.candles("D1", HISTORY_DAYS).length > 360, "a year of daily bars must be available");
});

test("a year of daily history builds in a reasonable time and caches", () => {
  // The whole reason the curve moved to a bulk keystream. If this regresses, scrolling the chart
  // back a year stalls the engine's event loop for a minute.
  const h = build();
  const t0 = Date.now();
  const first = h.candles("D1", 365).length;
  const cold = Date.now() - t0;
  const t1 = Date.now();
  h.candles("D1", 365);
  const warm = Date.now() - t1;
  assert.ok(first > 360, `expected a year of bars, got ${first}`);
  assert.ok(cold < 20_000, `cold year took ${cold}ms`);
  assert.ok(warm < cold / 2 + 50, `warm year (${warm}ms) should be far cheaper than cold (${cold}ms)`);
});

// ───────────────────────────── day anchors ─────────────────────────────

test("anchors: a day's anchor prices that day's own bars exactly", () => {
  // The whole point of serving anchors: price = base + scale*(value - openValue) must reproduce the
  // price the chart itself drew for that day. Checked against the day's FIRST H1 bar, whose open is
  // by construction the price at the day's opening tick.
  const h = build();
  const keys = [dateKeyUTC(NOW), dateKeyUTC(NOW - 3 * DAY_S * 1000), dateKeyUTC(NOW - 40 * DAY_S * 1000)];
  const got = h.anchors(keys);
  assert.equal(got.length, 3);
  for (const a of got) {
    const dayStartS = dayStartMs(a.dateKey) / 1000;
    const bars = h.candles("H1", 24, dayStartS + DAY_S - 1);
    const first = bars.find((b) => b.time === dayStartS);
    assert.ok(first, `no opening H1 bar for ${a.dateKey}`);
    // value at the day's open IS openValue, so the reconstructed price is exactly `base`.
    assert.ok(Math.abs(first!.open - a.base) < 0.01, `${a.dateKey}: bar ${first!.open} vs base ${a.base}`);
  }
});

test("anchors: an older day's anchor is NOT today's — which is why this exists", () => {
  const h = build();
  const [today, older] = h.anchors([dateKeyUTC(NOW), dateKeyUTC(NOW - 30 * DAY_S * 1000)]) as [
    { dateKey: string; base: number; openValue: number }, { dateKey: string; base: number; openValue: number },
  ];
  assert.notEqual(today.base, older.base);
  assert.notEqual(today.openValue, older.openValue);
});

test("anchors: agrees with liveAnchor for today, and is reproducible", () => {
  const h = build();
  const live = h.liveAnchor();
  const [a] = h.anchors([live.dateKey]);
  assert.deepEqual(a, { dateKey: live.dateKey, base: live.base, openValue: live.openValue });
  // A second, independently built history derives the identical anchors from the same seeds.
  const again = build().anchors([live.dateKey]);
  assert.deepEqual(again, [a]);
});

test("anchors: duplicates collapse, order is preserved, and the batch is capped", () => {
  const h = build();
  const k0 = dateKeyUTC(NOW), k1 = dateKeyUTC(NOW - DAY_S * 1000);
  assert.deepEqual(h.anchors([k0, k1, k0]).map((a) => a.dateKey), [k0, k1]);
  const many = Array.from({ length: 200 }, (_, i) => dateKeyUTC(NOW - i * DAY_S * 1000));
  assert.equal(h.anchors(many).length, MAX_ANCHORS);
});

test("anchors: a day outside the retained window is absent, not an error", () => {
  const h = build();
  const future = dateKeyUTC(NOW + DAY_S * 1000);
  const tooOld = dateKeyUTC(NOW - (HISTORY_DAYS + 5) * DAY_S * 1000);
  assert.deepEqual(h.anchors([future, tooOld, "not-a-date"]), []);
  // …and a valid day alongside them still comes back.
  assert.deepEqual(h.anchors([future, dateKeyUTC(NOW), tooOld]).map((a) => a.dateKey), [dateKeyUTC(NOW)]);
});

test("anchors: different brands anchor differently (per-site seeds)", () => {
  const key = dateKeyUTC(NOW);
  const [a] = build(SITE_A).anchors([key]);
  const [b] = build(SITE_B).anchors([key]);
  assert.notEqual(a!.openValue, b!.openValue);
});

test("axis: prices a rate against its OWN day, and refuses a day off the chain", () => {
  const h = build();
  const axis = h.axis();
  const today = dateKeyUTC(NOW);
  const yesterday = dateKeyUTC(NOW - DAY_S * 1000);

  // The axis agrees with the anchor list it comes from.
  const [a] = h.anchors([today]);
  assert.deepEqual(axis.anchorFor(today), { base: a!.base, openValue: a!.openValue });
  assert.equal(axis.instrument.symbol, h.instrument.symbol);

  // Same rate, two days — two prices, because the axis re-anchors at midnight. This is the whole
  // reason a trade's price is stamped at execution instead of recomputed later.
  const rate = 0.21;
  const pToday = priceAtRate(axis, dayStartMs(today) + 3_600_000, rate);
  const pYesterday = priceAtRate(axis, dayStartMs(yesterday) + 3_600_000, rate);
  assert.ok(pToday !== null && pYesterday !== null);
  assert.notEqual(pToday, pYesterday);

  // Rounded to the symbol's tick, and never invented for a day the chain does not cover.
  assert.equal(pToday, Number(pToday!.toFixed(h.instrument.digits)));
  assert.equal(axis.anchorFor(dateKeyUTC(NOW + DAY_S * 1000)), null);
  assert.equal(priceAtRate(axis, NOW + DAY_S * 1000, rate), null);
});

test("the chain's own bar-filling shortcut agrees with building them afterwards", () => {
  // There are now two paths to a day's bars: the chaining walk fills the days a request needs from
  // the curve it is already holding (the cold path), and `hoursFor` folds them from minute bars for
  // a day the chain passed over (the warm path, and the path any later timeframe takes). They must
  // produce the same bars, or which timeframe a client asked for FIRST would change the prices it
  // sees — a bug no single-path test could see.
  const viaChain = build().candles("H1", 72);
  // Walk the chain for something that needs no bars at all, so every day is passed over, then ask.
  const h = build();
  h.liveAnchor();
  const viaFold = h.candles("H1", 72);
  assert.deepEqual(viaFold, viaChain);

  // The same, across the hourly/minute boundary: a day whose minute bars were built by the chain
  // for an M15 request must fold to the same H1 bars as a day the chain skipped.
  const m = build();
  m.candles("M15", 96);
  assert.deepEqual(m.candles("H1", 24), build().candles("H1", 24));
});

test("warm: the chain built in slices is the same chain built in one go", () => {
  // Warming exists to keep the event loop responsive, not to change anything, so the two paths must
  // agree bar for bar. If they ever diverged, a brand's prices would depend on whether a client
  // happened to subscribe before it asked for candles.
  const eager = build().candles("H1", 72);
  const h = build();
  assert.equal(h.warmed, false, "a fresh history is cold");
  return h.warm().then(() => {
    assert.equal(h.warmed, true);
    assert.deepEqual(h.candles("H1", 72), eager);
    // Warming again is a no-op rather than a second walk.
    return h.warm().then(() => { assert.deepEqual(h.candles("H1", 72), eager); });
  });
});

test("warm: the event loop keeps running while the chain is walked", async () => {
  // The whole point. A chain walked inside one synchronous block is ~2.2s during which this process
  // answers nothing; walked in slices, other work interleaves. Counting timer callbacks that fired
  // DURING the warm is the honest way to assert that, since it is exactly what was blocked before.
  const h = build();
  let beats = 0;
  const beat = setInterval(() => { beats += 1; }, 5);
  try {
    await h.warm();
  } finally { clearInterval(beat); }
  assert.equal(h.warmed, true);
  assert.ok(beats > 10, `only ${beats} timer callbacks ran during the warm; the loop was blocked`);
});

test("liveTick: the quote is the same number the day's own curve produces", () => {
  // A watch list and the chart's price header must not derive a rate differently, or the same
  // instrument shows two prices on one screen.
  const h = build();
  const dateKey = dateKeyUTC(NOW);
  const curve = new CurveGenerator(deriveSiteDaySeed(MASTER, SITE_A, dateKey, 0), DEFAULT_VERSIONED_CONFIG, "market");
  const expected = curve.tick(NOW, dayStartMs(dateKey));
  const got = h.liveTick(NOW);
  assert.equal(got.rate, expected.rate);
  assert.equal(got.t, NOW);
  // The delta is against the rate the caller last saw, not against zero, so a stream can colour it.
  assert.equal(h.liveTick(NOW).delta, 0);
  const earlier = h.liveTick(NOW - 5000);
  assert.equal(h.liveTick(NOW, earlier.rate).delta, expected.rate - earlier.rate);
});

test("liveTick: the quote lands on the same price axis as the bars", () => {
  // A rate is unusable without the anchor it belongs to; this is the arithmetic a client performs.
  const h = build();
  const bars = h.candles("M1", 3);
  const a = h.liveAnchor(NOW);
  const price = a.base + a.instrument.scale * (valueOfRate(h.liveTick(NOW).rate) - a.openValue);
  const lastBar = bars[bars.length - 1]!;
  // Within a minute of the last closed bar, so the two cannot be far apart on a gold-sized axis.
  assert.ok(Math.abs(price - lastBar.close) < 50, `quote ${price} vs last bar ${lastBar.close}`);
  assert.equal(a.instrument.symbol, "XAUUSD");
});

// ── The day's range so far, which MetaTrader's phone Quotes row prints as `L:` and `H:` ──────────

test("the day range brackets the live price, and both sit on the price axis", () => {
  const h = build();
  const r = h.dayRange();
  // `priceAtRate` takes the moment the rate was recorded, so it can pick that day's anchor.
  const live = priceAtRate(h.axis(), NOW, h.liveTick().rate)!;
  assert.ok(r.low <= live && live <= r.high, `${r.low} <= ${live} <= ${r.high}`);
  // Prices, not curve values: a client must be able to print them beside the quote unchanged.
  assert.ok(Math.abs(r.high - XAUUSD.anchor) < XAUUSD.anchor, `${r.high} is not on the price axis`);
});

test("it reports the day SO FAR, never a high the price has not reached yet", () => {
  // This is the trap the whole thing exists around: the curve is deterministic for the full day the
  // moment its seed is known, so folding the day's bars would hand back the evening's high at
  // breakfast and print it as though it had happened.
  const key = dateKeyUTC(NOW);
  const dayStart = dayStartMs(key);
  const early = build(SITE_A, () => dayStart + 60_000).dayRange();
  const later = build(SITE_A, () => dayStart + 12 * 3600_000).dayRange();
  const whole = build(SITE_A, () => dayStart + DAY_S * 1000 - 1000).dayRange();
  assert.ok(later.high >= early.high && later.low <= early.low, "an hour later cannot narrow the range");
  assert.ok(whole.high >= later.high && whole.low <= later.low, "the full day cannot narrow it either");
  // And it genuinely moves: a range that never widened would pass the two lines above vacuously.
  assert.ok(whole.high > early.high || whole.low < early.low, "the range never widened at all");
});

test("extending it tick by tick gives the same answer as asking once at the end", () => {
  // The fan-out asks on every tick for every watched symbol, so the walk is extended rather than
  // rebuilt. The two paths must not disagree, or a row's range would depend on when it was opened.
  const dayStart = dayStartMs(dateKeyUTC(NOW));
  let clock = dayStart;
  const stepped = new MarketHistory(
    (dateKey) => deriveSiteDaySeed(MASTER, SITE_A, dateKey, 0),
    () => DEFAULT_VERSIONED_CONFIG,
    { now: () => clock },
  );
  let last = stepped.dayRange();
  for (let i = 0; i < 40; i++) {
    clock += 137_000;
    last = stepped.dayRange();
  }
  const atOnce = build(SITE_A, () => clock).dayRange();
  assert.deepEqual(last, atOnce);
});

test("two sites get different ranges, because they are different series", () => {
  const a = build(SITE_A).dayRange();
  const b = build(SITE_B).dayRange();
  assert.notDeepEqual(a, b);
});

test("the range survives the UTC day turning, by starting the new day over", () => {
  const key = dateKeyUTC(NOW);
  const nextDayStart = dayStartMs(key) + DAY_S * 1000;
  let clock = nextDayStart - 1000; // one second before midnight
  const h = new MarketHistory(
    (dateKey) => deriveSiteDaySeed(MASTER, SITE_A, dateKey, 0),
    () => DEFAULT_VERSIONED_CONFIG,
    { now: () => clock },
  );
  const lastNight = h.dayRange();
  clock = nextDayStart + 1000; // one second after
  const morning = h.dayRange();
  // A second into a new day the range is a second wide, not yesterday's whole span carried over.
  assert.ok(morning.high - morning.low < lastNight.high - lastNight.low,
    `${morning.high - morning.low} should be far narrower than ${lastNight.high - lastNight.low}`);
  assert.ok(morning.high >= morning.low);
});
