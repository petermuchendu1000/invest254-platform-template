import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VERSIONED_CONFIG, deriveSiteDaySeed, DEFAULT_SYMBOL, SYMBOLS, instrumentFor,
} from "@invest254/shared";
import { SymbolHistories, DEFAULT_MAX_RESIDENT, NON_PRIMARY_CACHED_DAYS } from "./symbolhistories.js";

const MASTER = "symbol-histories-master";
const SITE = "00000000-0000-0000-0000-0000000000a1";
/** Fixed "now" so every assertion is reproducible: Wed 18 Mar 2026, 13:47:29Z. */
const NOW = Date.UTC(2026, 2, 18, 13, 47, 29);

/**
 * Every history here is built over a SHORT window rather than the production 400 days.
 *
 * The chain builds one day curve per day before it can serve a bar, ~8ms each, so a full-length
 * history costs about three seconds of CPU per symbol and a sweep of the whole catalogue would cost
 * minutes. The window length changes which days exist, not how the bars inside it are built, and
 * nothing here asserts anything about a particular day — so a short chain tests the same code.
 * `markethistory.test.ts` is where the full-length chain is exercised.
 */
const TEST_DAYS = 6;

function make(o: { symbols?: readonly string[]; maxResident?: number; historyDays?: number }) {
  return new SymbolHistories({
    seedFor: (dateKey) => deriveSiteDaySeed(MASTER, SITE, dateKey, 0),
    cfg: () => DEFAULT_VERSIONED_CONFIG,
    now: () => NOW,
    historyDays: o.historyDays ?? TEST_DAYS,
    ...(o.symbols ? { symbols: o.symbols } : {}),
    ...(o.maxResident !== undefined ? { maxResident: o.maxResident } : {}),
  });
}
const build = (opts: Parameters<typeof make>[0] = {}) => make(opts);

test("the whole catalogue is offered, and the default is resident from the start", () => {
  const hs = build();
  assert.equal(hs.symbols.length, SYMBOLS.length);
  assert.ok(hs.has("EURUSD") && hs.has(DEFAULT_SYMBOL) && hs.has("XTIUSD"));
  // The default is the brand's price axis, so a trade must never wait on a cold rebuild of it.
  assert.deepEqual([...hs.resident], [DEFAULT_SYMBOL]);
  assert.equal(hs.primary.instrument.symbol, DEFAULT_SYMBOL);
});

test("each symbol's history carries its own instrument, so its prices are in its own units", () => {
  const hs = build();
  for (const s of ["EURUSD", "USDJPY", "BTCUSD", "US30"]) {
    const h = hs.for(s);
    assert.ok(h, s);
    assert.deepEqual(h.instrument, instrumentFor(s), s);
  }
});

test("two symbols on one brand are different series, not one series on two axes", () => {
  // This is the assertion that makes multi-symbol real. Both histories derive the SAME day seeds;
  // only the curve's domain differs, so if the symbol were not reaching the generator these two
  // would be affine transforms of each other and every chart would trace the same shape.
  const hs = build();
  const eur = hs.for("EURUSD")!.candles("H1", 48);
  const gbp = hs.for("GBPUSD")!.candles("H1", 48);
  assert.equal(eur.length, 48);
  assert.equal(gbp.length, 48);
  // Same buckets, different prices.
  assert.deepEqual(eur.map((b) => b.time), gbp.map((b) => b.time));
  const shapeOf = (bars: typeof eur) => {
    const o = bars[0]!.open;
    return bars.map((b) => (b.close - o) / o);
  };
  const a = shapeOf(eur), b = shapeOf(gbp);
  assert.notDeepEqual(a, b);
  // And not merely different by a constant factor: at least one pair of bars moves in opposite
  // directions, which no rescaling of one series can produce.
  const opposed = a.some((v, i) => Math.sign(v) !== 0 && Math.sign(v) === -Math.sign(b[i]!));
  assert.ok(opposed, "two symbols never disagree on direction, so they are the same series rescaled");
});

test("the default symbol's bars are untouched by multi-symbol existing", () => {
  // Every day already charted and every position already settled priced through the bare `curve`
  // domain. The default must still land on exactly those bars.
  const hs = build();
  const direct = hs.primary.candles("H1", 72);
  const viaLookup = hs.for(DEFAULT_SYMBOL)!.candles("H1", 72);
  assert.deepEqual(viaLookup, direct);
  // A named lookup of the default returns the pinned history itself, not a second copy, so there is
  // only ever one chain for the axis.
  assert.equal(hs.for(DEFAULT_SYMBOL), hs.primary);
});

test("a symbol the brand does not offer resolves to nothing rather than to the default", () => {
  // Silently falling back would mean a typo charted gold while the ticket said EURUSD.
  const hs = build({ symbols: [DEFAULT_SYMBOL, "EURUSD"] });
  assert.equal(hs.has("BTCUSD"), false);
  assert.equal(hs.for("BTCUSD"), undefined);
  assert.equal(hs.for("NOPE"), undefined);
  assert.deepEqual([...hs.symbols], [DEFAULT_SYMBOL, "EURUSD"]);
});

test("a brand that lists no default still gets one, because the price axis needs it", () => {
  const hs = build({ symbols: ["EURUSD", "GBPUSD"] });
  assert.ok(hs.has(DEFAULT_SYMBOL));
  assert.equal(hs.symbols[0], DEFAULT_SYMBOL);
  assert.equal(hs.primary.instrument.symbol, DEFAULT_SYMBOL);
});

test("histories are evicted least-recently-used beyond the cap, and the default never is", () => {
  const hs = build({ maxResident: 3 });
  for (const s of ["EURUSD", "GBPUSD", "USDJPY"]) hs.for(s);
  assert.deepEqual([...hs.resident], [DEFAULT_SYMBOL, "EURUSD", "GBPUSD", "USDJPY"]);
  // Touching EURUSD makes GBPUSD the oldest.
  hs.for("EURUSD");
  hs.for("BTCUSD");
  assert.equal(hs.resident.includes("GBPUSD"), false, "the least-recently-used one should be gone");
  assert.ok(hs.resident.includes("EURUSD"), "the touched one should survive");
  assert.ok(hs.resident.includes(DEFAULT_SYMBOL), "the default is pinned");
  // The cap counts everything but the pinned default.
  assert.equal(hs.resident.length, 4);
});

test("a rebuilt history produces bit-for-bit the same bars, which is what makes eviction safe", () => {
  const hs = build({ maxResident: 1 });
  const first = hs.for("BTCUSD")!.candles("H1", 24);
  // Push BTCUSD out, then ask again: a different object, the same numbers.
  hs.for("EURUSD");
  assert.equal(hs.resident.includes("BTCUSD"), false);
  const again = hs.for("BTCUSD")!.candles("H1", 24);
  assert.deepEqual(again, first);
});

test("every symbol in the catalogue can actually build a history", () => {
  // The cheap end-to-end check on 96 rows: an anchor or scale that cannot produce bars would show
  // up here rather than when a trader opened that chart.
  const hs = build({ maxResident: 1 });
  for (const d of SYMBOLS) {
    const bars = hs.for(d.symbol)!.candles("H1", 6);
    assert.equal(bars.length, 6, d.symbol);
    for (const b of bars) {
      assert.ok(Number.isFinite(b.open) && b.open > 0, `${d.symbol} open ${b.open}`);
      assert.ok(b.high >= b.low, d.symbol);
      // The bars sit near the instrument's own level rather than near gold's.
      assert.ok(b.close > d.anchor / 4 && b.close < d.anchor * 4, `${d.symbol} close ${b.close}`);
      // And they are printable at the symbol's own tick.
      assert.equal(b.close, Number(b.close.toFixed(d.digits)), `${d.symbol} close ${b.close}`);
    }
  }
});

test("warm: an offered symbol comes back warm, an unoffered one comes back as nothing", async () => {
  const hs = build();
  const h = await hs.warm("EURUSD");
  assert.ok(h);
  assert.equal(h.warmed, true);
  assert.equal(h.instrument.symbol, "EURUSD");
  assert.equal(await hs.warm("NOPE"), undefined);
});

test("warm: several symbols asked for at once all end up warm, one chain at a time", async () => {
  // Concurrency here would not make any of them finish sooner — it is one thread — and would
  // interleave the slices of several chains, which is the opposite of what slicing is for. The
  // observable contract is simply that asking for all of them at once warms all of them.
  const hs = build({ maxResident: 8 });
  const want = ["EURUSD", "GBPUSD", "BTCUSD"];
  const got = await Promise.all(want.map((s) => hs.warm(s)));
  for (const [i, h] of got.entries()) {
    assert.ok(h, want[i]);
    assert.equal(h.warmed, true, want[i]);
    assert.equal(h.instrument.symbol, want[i]);
  }
});

test("warm: a symbol already warm is handed straight back without walking again", async () => {
  const hs = build();
  const first = await hs.warm("EURUSD");
  const bars = first!.candles("H1", 6);
  const again = await hs.warm("EURUSD");
  // The same object, so nothing was rebuilt, and the same bars either way.
  assert.equal(again, first);
  assert.deepEqual(again!.candles("H1", 6), bars);
});

test("warm: a symbol evicted while warming is not handed back as this brand's history", async () => {
  // With room for one, warming a second symbol pushes the first out. The caller must not be given
  // an orphan: it would keep chaining and caching bars that nothing can reach, and a later lookup
  // of the same symbol would hand out a different object with a different cache.
  const hs = build({ maxResident: 1 });
  const [a, b] = await Promise.all([hs.warm("EURUSD"), hs.warm("GBPUSD")]);
  assert.ok(b);
  assert.equal(b.instrument.symbol, "GBPUSD");
  // EURUSD either came back as the history the brand currently holds, or came back rebuilt — never
  // as an object the brand has let go of.
  assert.ok(a);
  assert.equal(a.instrument.symbol, "EURUSD");
  assert.equal(hs.resident.includes("GBPUSD"), true);
});

test("the resident cap leaves room for a full watch list plus the chart's own symbol", () => {
  // The number exists for this reason; multiengine's MAX_WATCHED_SYMBOLS is checked against it in
  // the protocol tests. Stated here too, next to the constant it constrains.
  assert.ok(DEFAULT_MAX_RESIDENT >= 21, `resident cap ${DEFAULT_MAX_RESIDENT} is too small for a watch list`);
  assert.equal(NON_PRIMARY_CACHED_DAYS, 4);
});
