import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VERSIONED_CONFIG, TIMEFRAMES, valueOfRate, type VersionedGameConfig } from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { StaticConfigProvider } from "./gameconfig.js";
import { SiteRegistry } from "./siteregistry.js";
import { startMultiEngine, type MultiEngineHandle } from "./multiengine.js";
import { MAX_ANCHORS, MAX_BARS } from "./markethistory.js";
import { DEFAULT_MAX_RESIDENT } from "./symbolhistories.js";
import { WsTestClient, WARM_MS, ticksBudget } from "./wstestkit.js";

/**
 * The candle feed over the wire (Step 2 of the MT5 chart work).
 *
 * Covers the protocol rather than the maths — markethistory.test.ts owns the series itself. What
 * matters here: a candlestick brand can fetch bars and page backwards, a line brand is told plainly
 * that it has none, bad input is rejected instead of guessed at, and the anchor shipped with the
 * bars really does place a live tick on the same axis.
 */

const CANDLE_SITE = "00000000-0000-0000-0000-0000000000c1";
const LINE_SITE = "00000000-0000-0000-0000-0000000000c2";
/** The brand's own tick cadence, which the quote fan-out rides: ceilings for "n more quote frames"
 *  are a multiple of THIS rather than a flat number, so they follow the config if it ever changes. */
const TICK_MS = 60;
const cfg: VersionedGameConfig = { ...DEFAULT_VERSIONED_CONFIG, version: 1, defaultDurationS: 1, tickRateMs: TICK_MS };

/**
 * The shared test client, with this file's ceilings.
 *
 * Every request here can land behind a cold symbol-chain warm — `candles`, `anchors`, `symbols` and
 * `subscribe_symbols` all walk a day's chain for a symbol this brand has not drawn yet, which costs
 * 5s for gold and up to 24s for a second symbol warmed while the brand is already ticking. The old
 * fixed 20_000/30_000 ceilings were therefore inside a factor of 1.25 of the unloaded cost of the
 * very thing they were waiting for; `WARM_MS` is that measured cost scaled for a busy runner.
 */
class Client extends WsTestClient {
  override ask(type: string, data: unknown, expect: string, timeoutMs = WARM_MS): Promise<any> {
    return super.ask(type, data, expect, timeoutMs);
  }
  override next(type: string, timeoutMs = WARM_MS): Promise<any> {
    return super.next(type, timeoutMs);
  }
}

async function boot(): Promise<{ handle: MultiEngineHandle; url: (site: string) => string }> {
  const repo = new InMemoryGameRepository();
  const registry = new SiteRegistry({
    masterSeed: "candles-master-test",
    repo,
    configFor: () => new StaticConfigProvider(cfg),
    seedManagerOpts: { calibrationSamples: 4000 },
    // Only the candlestick brand gets a market curve; the other draws the line wave.
    curveProfileFor: (siteId) => (siteId === LINE_SITE ? "wave" : "market"),
  });
  const handle = await startMultiEngine({
    port: 0,
    registry,
    repo,
    verifier: null,
    resolveSite: (req) => {
      const s = new URL(req.url ?? "/", "http://x").searchParams.get("site");
      if (!s) throw new Error("no site");
      return s;
    },
    onError: () => { /* quiet in tests */ },
  });
  const port = (handle.wss.address() as { port: number }).port;
  return { handle, url: (site) => `ws://127.0.0.1:${port}/?site=${site}` };
}

test("WS candles: a candlestick brand gets closed bars, newest last", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    const m = await c.ask("candles", { tf: "M15", count: 120 }, "candles");
    assert.equal(m.type, "candles", `unexpected error: ${JSON.stringify(m.data)}`);
    assert.equal(m.data.tf, "M15");
    assert.equal(m.data.instrument.symbol, "XAUUSD");
    assert.equal(m.data.instrument.digits, 2);
    assert.equal(m.data.bars.length, 120);
    const bars = m.data.bars;
    for (let i = 1; i < bars.length; i++) {
      assert.equal(bars[i].time - bars[i - 1].time, TIMEFRAMES.M15, `bucket width wrong at ${i}`);
      assert.ok(bars[i].high >= bars[i].low, `inverted bar at ${i}`);
    }
    const nowS = Math.floor(Date.now() / 1000);
    assert.ok(bars.at(-1).time + TIMEFRAMES.M15 <= nowS, "served a bar that has not closed");
  } finally { c.close(); await handle.close(); }
});

test("WS candles: `to` pages backwards and the pages join up without gaps or overlap", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    const first = (await c.ask("candles", { tf: "H1", count: 50 }, "candles")).data.bars;
    const older = (await c.ask("candles", { tf: "H1", count: 50, to: first[0].time }, "candles")).data.bars;
    assert.equal(older.length, 50);
    // The older page must end exactly one bucket before the newer page begins.
    assert.ok(older.at(-1).time < first[0].time, "older page overlaps the newer one");
    assert.equal(first[0].time - older.at(-1).time, TIMEFRAMES.H1, "a bar is missing between the pages");
  } finally { c.close(); await handle.close(); }
});

test("WS candles: the anchor places a live tick on the same axis as the bars", async () => {
  // The forming candle is built client-side from the tick stream. If the anchor were wrong it would
  // sit at a different level from the history beside it — the most visible possible bug.
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    const m = await c.ask("candles", { tf: "M1", count: 5 }, "candles");
    const { anchor, instrument, bars } = m.data;
    assert.equal(m.type, "candles", `unexpected error: ${JSON.stringify(m.data)}`);

    // Take a real tick off the live stream and price it exactly as the client will.
    const tick = await c.next("tick");
    const priced = anchor.base + instrument.scale * (valueOfRate(tick.data.rate) - anchor.openValue);

    // It must land on the bars' axis. The last CLOSED minute ended moments ago, so the live price
    // can only have moved by about one minute of the walk — a point or two on this symbol.
    const last = bars.at(-1);
    assert.ok(
      Math.abs(priced - last.close) < 15,
      `live tick priced ${priced.toFixed(2)} but the last bar closed at ${last.close} — the anchor does not match the bars`,
    );
  } finally { c.close(); await handle.close(); }
});

test("WS candles: a line brand is told it has no candles rather than given empty ones", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(LINE_SITE));
  try {
    await c.open();
    const m = await c.ask("candles", { tf: "M15", count: 10 }, "candles");
    assert.equal(m.type, "error");
    assert.equal(m.data.code, "NO_CANDLES");
  } finally { c.close(); await handle.close(); }
});

test("WS candles: bad input is rejected, and an oversized count is clamped not refused", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    assert.equal((await c.ask("candles", { tf: "H5", count: 10 }, "candles")).data.code, "BAD_TIMEFRAME");
    assert.equal((await c.ask("candles", { tf: "M1", count: 0 }, "candles")).data.code, "BAD_COUNT");
    assert.equal((await c.ask("candles", { tf: "M1", count: -5 }, "candles")).data.code, "BAD_COUNT");
    assert.equal((await c.ask("candles", { tf: "M1", count: 10, to: "soon" }, "candles")).data.code, "BAD_TO");
    const big = await c.ask("candles", { tf: "M1", count: MAX_BARS * 4 }, "candles");
    assert.equal(big.type, "candles");
    assert.ok(big.data.bars.length <= MAX_BARS, `expected a clamp, got ${big.data.bars.length} bars`);
  } finally { c.close(); await handle.close(); }
});

// ───────────────────────────── day anchors ─────────────────────────────

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

test("WS anchors: each requested day comes back with its own anchor, and today's matches the candles reply", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    const today = dayKey(Date.now());
    const older = dayKey(Date.now() - 5 * 86_400_000);
    const m = await c.ask("anchors", { days: [today, older] }, "anchors");
    assert.equal(m.type, "anchors", `unexpected error: ${JSON.stringify(m.data)}`);
    assert.equal(m.data.instrument.symbol, "XAUUSD");
    assert.deepEqual(m.data.days.map((d: any) => d.dateKey), [today, older]);
    // The anchor the candles reply ships for today must be the same one this endpoint serves, or the
    // live chart and the trade list would place the same rate at two different prices.
    const fromCandles = (await c.ask("candles", { tf: "H1", count: 2 }, "candles")).data.anchor;
    assert.deepEqual(m.data.days[0], { dateKey: fromCandles.tradeDate, base: fromCandles.base, openValue: fromCandles.openValue });
    // …and an older day is genuinely anchored elsewhere, which is the reason to ask at all.
    assert.notEqual(m.data.days[1].base, m.data.days[0].base);
  } finally { c.close(); await handle.close(); }
});

test("WS anchors: reqId is echoed, so concurrent requests can be told apart", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    const m = await c.ask("anchors", { days: [dayKey(Date.now())], reqId: "a7" }, "anchors");
    assert.equal(m.data.reqId, "a7");
  } finally { c.close(); await handle.close(); }
});

test("WS anchors: a line brand is told it has none; bad input is rejected; the batch is capped", async () => {
  const { handle, url } = await boot();
  const line = new Client(url(LINE_SITE));
  // Opened one at a time: a client built up front can finish connecting while the first is being
  // driven, and the handshake it is waiting for has then already happened.
  const candle = new Client(url(CANDLE_SITE));
  try {
    await line.open();
    assert.equal((await line.ask("anchors", { days: [dayKey(Date.now())] }, "anchors")).data.code, "NO_CANDLES");
    await candle.open();
    assert.equal((await candle.ask("anchors", { days: "today" }, "anchors")).data.code, "BAD_DAYS");
    assert.equal((await candle.ask("anchors", {}, "anchors")).data.code, "BAD_DAYS");
    // Unknown days are absent rather than fatal, so one stale row cannot break a whole page.
    const mixed = await candle.ask("anchors", { days: ["1999-01-01", dayKey(Date.now())] }, "anchors");
    assert.deepEqual(mixed.data.days.map((d: any) => d.dateKey), [dayKey(Date.now())]);
    const many = Array.from({ length: 300 }, (_, i) => dayKey(Date.now() - i * 86_400_000));
    const big = await candle.ask("anchors", { days: many }, "anchors");
    assert.ok(big.data.days.length <= MAX_ANCHORS, `expected a cap, got ${big.data.days.length}`);
  } finally { line.close(); candle.close(); await handle.close(); }
});

/**
 * Multi-symbol over the wire (docs/mt5/12-multi-symbol-scope.md item 5a).
 *
 * The protocol had no concept of a second instrument: one history per brand, and the symbol was
 * whatever that history happened to be. These cover the three things that changed — a symbol may be
 * named on a request, an unoffered one is refused rather than substituted, and the brand's list is
 * fetchable so Market Watch has something real to show.
 */

test("WS symbols: a candlestick brand lists its catalogue, and names the one it draws by default", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    const m = await c.ask("symbols", { reqId: "s1" }, "symbols");
    assert.equal(m.type, "symbols");
    assert.equal(m.data.reqId, "s1", "reqId must come back so concurrent requests can be told apart");
    assert.equal(m.data.defaultSymbol, "XAUUSD");
    assert.ok(Array.isArray(m.data.symbols) && m.data.symbols.length >= 90, `${m.data.symbols?.length} symbols`);
    // The default is in the list, so a client need not special-case it.
    assert.ok(m.data.symbols.some((s: any) => s.symbol === m.data.defaultSymbol));
    // Every row carries what a list has to print beside a symbol, and no prices: a quote is the
    // tick stream's job, and sending a stale one here would be a quote nothing could age.
    for (const s of m.data.symbols) {
      assert.equal(typeof s.symbol, "string");
      assert.ok(s.description.length > 3, s.symbol);
      assert.ok(String(s.group).length > 0, s.symbol);
      assert.ok(s.digits >= 2 && s.digits <= 5, `${s.symbol} ${s.digits}`);
      assert.equal(s.bid, undefined);
      assert.equal(s.ask, undefined);
    }
    // The groups MetaTrader's Symbols tree shows, all present.
    const groups = new Set(m.data.symbols.map((s: any) => s.group));
    for (const g of ["Forex\\Majors", "Forex\\Minors", "Forex\\Exotics", "Metals", "Crypto", "Indices", "Energies"]) {
      assert.ok(groups.has(g), `missing group ${g}`);
    }
  } finally { c.close(); await handle.close(); }
});

test("WS symbols: a line brand is told it has none, like the candles", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(LINE_SITE));
  try {
    await c.open();
    const m = await c.ask("symbols", { reqId: "s2" }, "symbols");
    assert.equal(m.type, "error");
    assert.equal(m.data.code, "NO_CANDLES");
    assert.equal(m.data.reqId, "s2");
  } finally { c.close(); await handle.close(); }
});

test("WS candles: naming a symbol returns THAT instrument's bars, not the default's rescaled", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    const gold = await c.ask("candles", { tf: "H1", count: 24 }, "candles");
    const euro = await c.ask("candles", { tf: "H1", count: 24, symbol: "EURUSD" }, "candles");
    assert.equal(gold.data.instrument.symbol, "XAUUSD");
    assert.equal(euro.data.instrument.symbol, "EURUSD");
    assert.equal(euro.data.instrument.digits, 5);
    // The prices are in the named instrument's own units.
    assert.ok(euro.data.bars.every((b: any) => b.close > 0.5 && b.close < 2), "EURUSD bars should sit near 1");
    assert.ok(gold.data.bars.every((b: any) => b.close > 1000), "XAUUSD bars should sit near 2650");
    // Same buckets, and a genuinely different shape rather than one series on two axes.
    //
    // Compared on the buckets the two replies SHARE, not on the two windows as a whole. Each reply
    // is the most recent `count` H1 buckets as of the moment IT was served, and warming a second
    // symbol on an already-ticking brand costs most of `WARM_MS` (25s), so an H1 boundary falling
    // between these two asks slides one window forward by exactly one bar. That is not the two
    // symbols disagreeing about bucketing — which is the only thing this assertion is for — so the
    // old `deepEqual` of the whole windows turned CI red whenever a run straddled the hour
    // (BUGLOG #158: observed on 2026-10-22, gold ending 09:00 UTC and EURUSD ending 10:00).
    const at = (bars: any[]) => new Map<number, any>(bars.map((b) => [b.time, b]));
    const euroAt = at(euro.data.bars), goldAt = at(gold.data.bars);
    const hourly = (bars: any[]) => bars.every((b, i) => i === 0 || b.time - bars[i - 1]!.time === 3600);
    assert.ok(hourly(euro.data.bars) && hourly(gold.data.bars), "both series must be a contiguous H1 grid");
    const shared: number[] = euro.data.bars.map((b: any) => b.time).filter((t: number) => goldAt.has(t));
    // One bar of slack for the boundary above; anything less means the grids genuinely differ.
    assert.ok(shared.length >= euro.data.bars.length - 1,
      `the two symbols must bucket alike: ${shared.length} shared of ${euro.data.bars.length}`);
    const shape = (byTime: Map<number, any>) => {
      const first = byTime.get(shared[0]!)!;
      return shared.map((t) => (byTime.get(t)!.close - first.open) / first.open);
    };
    const a = shape(euroAt), b = shape(goldAt);
    assert.ok(a.some((v, i) => Math.sign(v) !== 0 && Math.sign(v) === -Math.sign(b[i]!)),
      "the two symbols never disagree on direction, so they are the same series rescaled");
    // The anchor comes from the named symbol's own day, or a live tick would land off its axis.
    assert.ok(euro.data.anchor.base > 0.5 && euro.data.anchor.base < 2);
    assert.notEqual(euro.data.anchor.base, gold.data.anchor.base);
  } finally { c.close(); await handle.close(); }
});

test("WS candles: an unoffered symbol is refused, never silently served the default", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    // Serving gold's bars under the name EURUSD would be the worst possible failure here: the chart
    // would look right and be a different instrument.
    for (const symbol of ["NOPE", "", "xauusd"]) {
      const m = await c.ask("candles", { tf: "H1", count: 5, symbol, reqId: "u1" }, "candles");
      assert.equal(m.type, "error", symbol);
      assert.equal(m.data.code, "UNKNOWN_SYMBOL", symbol);
      assert.equal(m.data.reqId, "u1", symbol);
    }
    // And null means "no symbol named", which is the pre-multi-symbol request.
    const dflt = await c.ask("candles", { tf: "H1", count: 5, symbol: null }, "candles");
    assert.equal(dflt.data.instrument.symbol, "XAUUSD");
  } finally { c.close(); await handle.close(); }
});

test("WS anchors: a named symbol's anchors price that symbol's own days", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    const bars = await c.ask("candles", { tf: "H1", count: 2, symbol: "EURUSD" }, "candles");
    const day = bars.data.anchor.tradeDate;
    const m = await c.ask("anchors", { days: [day], symbol: "EURUSD" }, "anchors");
    assert.equal(m.data.instrument.symbol, "EURUSD");
    assert.equal(m.data.days.length, 1);
    // The same day's anchor, whichever request asked for it.
    assert.equal(m.data.days[0].base, bars.data.anchor.base);
    assert.equal(m.data.days[0].openValue, bars.data.anchor.openValue);
    // And a different symbol's anchor for the same day is NOT this one.
    const gold = await c.ask("anchors", { days: [day] }, "anchors");
    assert.equal(gold.data.instrument.symbol, "XAUUSD");
    assert.notEqual(gold.data.days[0].base, m.data.days[0].base);
    // An unoffered symbol is refused here too.
    const bad = await c.ask("anchors", { days: [day], symbol: "NOPE", reqId: "a9" }, "anchors");
    assert.equal(bad.type, "error");
    assert.equal(bad.data.code, "UNKNOWN_SYMBOL");
    assert.equal(bad.data.reqId, "a9");
  } finally { c.close(); await handle.close(); }
});

/**
 * Per-symbol LIVE quotes (item 5b).
 *
 * The chart could already fetch any symbol's history; what was missing was its live edge. These
 * cover the subscription (a set the client owns, capped, with unoffered symbols refused), the seed
 * reply that makes a quote pricable, and the one invariant that matters most: the default symbol's
 * quote is the SAME number the brand's own tick carries, so a client showing both cannot see them
 * disagree.
 */

test("WS quotes: the watch list is a set the client owns, capped, with unoffered symbols refused", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    const m = await c.ask("subscribe_symbols", {
      // A duplicate, an unoffered symbol, and more than the cap allows, all in one request.
      symbols: ["EURUSD", "EURUSD", "NOPE", ...Array.from({ length: 25 }, (_, i) => `FILL${i}`)],
      reqId: "w1",
    }, "subscribed_symbols");
    assert.equal(m.data.reqId, "w1");
    // The duplicate collapsed to one subscription, not two.
    assert.deepEqual(m.data.symbols, ["EURUSD"]);
    assert.ok(m.data.rejected.includes("NOPE"), "an unoffered symbol must be named as rejected");
    assert.ok(m.data.max >= 1 && m.data.max <= 64, `max ${m.data.max}`);
    // Rejected rather than silently dropped: a client has to be able to tell the trader that a
    // symbol it asked for is not coming. Every DISTINCT symbol asked for is accounted for in one
    // list or the other — the repeat of EURUSD is absorbed, not rejected, because asking twice for
    // the same symbol is one subscription rather than one subscription and one failure.
    assert.equal(m.data.symbols.length + m.data.rejected.length, 27);
    assert.equal(new Set([...m.data.symbols, ...m.data.rejected]).size, 27);

    // A second request REPLACES the list rather than adding to it.
    const r2 = await c.ask("subscribe_symbols", { symbols: ["GBPUSD"] }, "subscribed_symbols");
    assert.deepEqual(r2.data.symbols, ["GBPUSD"]);

    const off = await c.ask("unsubscribe_symbols", { reqId: "w2" }, "subscribed_symbols");
    assert.deepEqual(off.data.symbols, []);
    assert.equal(off.data.reqId, "w2");
  } finally { c.close(); await handle.close(); }
});

test("WS quotes: a subscribed symbol is seeded with what makes its ticks pricable, then streams", async () => {
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    // The seed is sent only once EURUSD's chain has warmed, and that warm is the whole cost of this
    // test: 24s unloaded against the old 30_000 ceiling, which is why a busy runner saw zero frames
    // and timed out here. Same condition, a ceiling sized off that measurement.
    const seeded = c.collect(["symbol_quote"], (s) => s.length >= 1, "the EURUSD seed quote", WARM_MS);
    await c.ask("subscribe_symbols", { symbols: ["EURUSD"] }, "subscribed_symbols");
    const [q] = await seeded;
    assert.equal(q.data.symbol, "EURUSD");
    // A rate alone is unusable: the anchor is what turns it into a price.
    assert.equal(q.data.instrument.symbol, "EURUSD");
    assert.equal(q.data.instrument.digits, 5);
    assert.ok(q.data.anchor.base > 0.5 && q.data.anchor.base < 2, `base ${q.data.anchor.base}`);
    assert.equal(typeof q.data.anchor.tradeDate, "string");
    assert.equal(typeof q.data.anchor.openValue, "number");
    assert.ok(Number.isFinite(q.data.rate));
    // And the quote really does price on that axis.
    const price = q.data.anchor.base + q.data.instrument.scale * (valueOfRate(q.data.rate) - q.data.anchor.openValue);
    assert.ok(price > 0.5 && price < 2, `EURUSD priced at ${price}`);

    // Then the live stream, carrying only what changes.
    const ticks = await c.collect(["symbol_ticks"], (s) => s.length >= 3, "3 EURUSD quote frames", ticksBudget(3, TICK_MS));
    for (const m of ticks) {
      assert.equal(m.data.quotes.length, 1);
      assert.equal(m.data.quotes[0].symbol, "EURUSD");
      assert.ok(Number.isFinite(m.data.quotes[0].rate));
      assert.ok(Number.isFinite(m.data.quotes[0].delta));
      // The stream does not repeat the instrument or the anchor: those came with the seed.
      assert.equal(m.data.quotes[0].instrument, undefined);
      assert.equal(m.data.quotes[0].anchor, undefined);
    }
    // The rate moves, so this is a feed rather than a constant.
    assert.ok(new Set(ticks.map((m) => m.data.quotes[0].rate)).size > 1);
  } finally { c.close(); await handle.close(); }
});

test("WS quotes: the default symbol's quote is the same number the brand's own tick carries", async () => {
  // The invariant that matters most. A terminal shows the brand tick in one place (the price header)
  // and the watch list in another; if the two derived their rate differently the same instrument
  // would show two prices on one screen.
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    await c.ask("subscribe_symbols", { symbols: ["XAUUSD"] }, "subscribed_symbols");
    const pair = await c.collect(["tick", "symbol_ticks"], (seen) => {
      // Enough once some brand tick and some symbol_ticks share a timestamp.
      const ts = new Set(seen.filter((m) => m.type === "tick").map((m) => m.data.t));
      return seen.some((m) => m.type === "symbol_ticks" && ts.has(m.data.t));
    }, "a brand tick and a quote sharing a timestamp", WARM_MS);
    const quotes = pair.filter((m) => m.type === "symbol_ticks");
    const byT = new Map(pair.filter((m) => m.type === "tick").map((m) => [m.data.t, m.data.rate]));
    const matched = quotes.filter((m) => byT.has(m.data.t));
    assert.ok(matched.length >= 1, "no symbol_ticks shared a timestamp with a brand tick");
    for (const m of matched) {
      assert.equal(m.data.quotes[0].symbol, "XAUUSD");
      assert.equal(m.data.quotes[0].rate, byT.get(m.data.t));
    }
  } finally { c.close(); await handle.close(); }
});

test("WS quotes: a line brand is told it has none, and unsubscribing stops the stream", async () => {
  const { handle, url } = await boot();
  const line = new Client(url(LINE_SITE));
  const candle = new Client(url(CANDLE_SITE));
  try {
    await line.open();
    const m = await line.ask("subscribe_symbols", { symbols: ["EURUSD"], reqId: "l1" }, "subscribed_symbols");
    assert.equal(m.type, "error");
    assert.equal(m.data.code, "NO_CANDLES");
    assert.equal(m.data.reqId, "l1");

    await candle.open();
    await candle.ask("subscribe_symbols", { symbols: ["XAUUSD"] }, "subscribed_symbols");
    await candle.collect(["symbol_ticks"], (s) => s.length >= 1, "the first XAUUSD quote frame", WARM_MS);
    await candle.ask("unsubscribe_symbols", {}, "subscribed_symbols");
    // Nothing more should arrive. The brand keeps ticking, so this is a real silence rather than a
    // stopped clock: wait for several brand ticks and assert no quote came with them.
    // The window is a mark into the frame log rather than a hand-rolled listener, so a quote that
    // arrived between the unsubscribe reply and the listener going on cannot be missed — and it is
    // still a window that STARTS here, so quotes from before the unsubscribe cannot satisfy it.
    const cursor = candle.mark();
    await candle.collect(["tick"], (s) => s.length >= 5, "5 brand ticks after unsubscribing", ticksBudget(5, TICK_MS));
    assert.deepEqual(candle.since(cursor, "symbol_ticks"), []);
  } finally { line.close(); candle.close(); await handle.close(); }
});

test("WS quotes: the watch cap stays below the resident cap, or no quote would ever warm", async () => {
  // Not a protocol test but the reason the protocol's cap is the number it is. A watched symbol is
  // touched every tick, so a list longer than the resident set would evict and rebuild every symbol
  // on it continuously and none would ever be warm enough to quote.
  const { handle, url } = await boot();
  const c = new Client(url(CANDLE_SITE));
  try {
    await c.open();
    const m = await c.ask("subscribe_symbols", { symbols: [] }, "subscribed_symbols");
    assert.ok(m.data.max < DEFAULT_MAX_RESIDENT, `watch cap ${m.data.max} vs resident cap ${DEFAULT_MAX_RESIDENT}`);
  } finally { c.close(); await handle.close(); }
});
