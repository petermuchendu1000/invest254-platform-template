import {
  CurveGenerator, XAUUSD, DAY_S, TIMEFRAMES, aggregate, dayExtremes, minuteBars, nextBase, nextBucketS,
  dateKeyUTC, dayStartMs, type Candle, type DayAnchor, type MarketSymbol, type PriceAxis,
  type Tick, type Timeframe, type VersionedGameConfig,
} from "@invest254/shared";

/**
 * Candle history for one brand.
 *
 * The chart needs a continuous price series, but the engine reseeds the curve every UTC day, so the
 * days have to be chained: each day's base price is carried from the previous day's close (see
 * candles.ts). That makes history a walk FORWARD from a fixed genesis day, and this class owns that
 * walk — building each day's curve once, keeping the two numbers the chain needs, and caching the
 * minute bars for the days a chart is actually looking at.
 *
 * It is deliberately independent of SeedManager. SeedManager exists to price LIVE rounds: it caches
 * per (day, config) because a position must settle under the config it opened with, it commits seed
 * hashes to the database, and it holds at most a handful of days. History is the opposite workload —
 * hundreds of past days, read-only, display-only, and priced by whatever config is current because
 * nothing about a historical candle settles anything.
 */

/** Days before today that history reaches back to. 400 covers the full year a chart offers. */
export const HISTORY_DAYS = 400;
/** Largest window a single request may ask for, in bars. Clients page backwards for more. */
export const MAX_BARS = 5000;
/**
 * Largest number of day anchors one request may ask for.
 *
 * A page of trade history spans a handful of days in practice; the cap is what stops a client
 * asking the engine to walk and hold the whole year in one call.
 */
export const MAX_ANCHORS = 64;
/**
 * Days chained per slice when warming asynchronously.
 *
 * Two, because a day costs ~8ms and sixteen is about one frame: short enough that nothing else the
 * engine is doing waits noticeably on it. Warming 400 days is then ~200 slices, and the yields cost
 * nothing next to the work between them.
 */
const WARM_SLICE_DAYS = 2;

export interface MarketHistoryOptions {
  /** Instrument the prices are expressed in. Defaults to XAUUSD. */
  instrument?: MarketSymbol;
  /** Cap on days of minute bars held in memory (~46KB each). */
  maxCachedDays?: number;
  /**
   * How many days back the chain reaches. Defaults to `HISTORY_DAYS`.
   *
   * It is an option because the chain is not free: it builds one day curve per day before the first
   * bar can be served, ~8ms each, so the production 400 days costs about three seconds of CPU the
   * first time a symbol is charted. A caller that knows it only needs a short window — a test, or a
   * brand offering a long tail of symbols nobody scrolls a year of — can say so instead of paying
   * for a year. The window is the only thing that changes: the bars inside it are identical either
   * way, because each day's prices depend on the chain before it, not on how far back it started.
   *
   * That last sentence is not quite true at the seam, and the difference is the point of the
   * re-anchoring already documented on `chainThrough`: a shorter chain starts from the instrument's
   * anchor on a later day, so the two windows do not agree on prices. Changing it for a brand is
   * therefore a visible change to that brand's history, not a tuning knob.
   */
  historyDays?: number;
  now?: () => number;
}

/** What the chain needs from a day, and what a chart needs to draw it. */
interface DaySlice {
  dateKey: string;
  dayStartS: number;
  /** Base price at this day's open — the previous day's close, pulled slightly toward the anchor. */
  base: number;
  /** The NEXT day's base, i.e. this day's close after the anchor pull. Carries the chain forward. */
  nextBase: number;
  /**
   * The curve's value at this day's open — the second half of the day's price anchor, since
   * price = base + scale * (value(t) - openValue). It falls out of the chaining pass for free, and
   * keeping it is what lets an OLD day's anchor be served without rebuilding that day's curve.
   */
  openValue: number;
  /**
   * The day's 24 H1 bars, built on first use and then kept for the life of the chain (~1KB a day).
   *
   * Every timeframe from H1 up is a whole number of hours, so all of them — including D1, W1 and
   * MN1 — fold from these exactly, and keeping them is what makes scrolling a year of dailies
   * instant after the first pass.
   *
   * They used to be built eagerly, in the chaining pass. That made the chain pay for 1440 samples
   * and a fold on all 400 days whether or not anything asked for them, and the chain is walked in
   * full before the first bar can be served: measured at ~15ms a day, ~6s a symbol. Half of that was
   * bars nobody had asked for. The chain genuinely needs only the day's opening and closing curve
   * value, which are two samples, so that is all it takes now.
   */
  h1?: Candle[];
  /** The day's 1440 M1 bars. Only the sub-hour timeframes need these, so they are evictable. */
  m1?: Candle[];
}

export class MarketHistory {
  private readonly inst: MarketSymbol;
  private readonly now: () => number;
  private readonly maxCachedDays: number;
  private readonly historyDays: number;
  /** dateKey -> slice, for the contiguous run of days from `genesisKey` forward. */
  private readonly days = new Map<string, DaySlice>();
  /** Insertion order of dateKeys whose `bars` are populated, for eviction. */
  private readonly barOrder: string[] = [];
  private chainedTo: string | null = null;
  /** Today's curve, kept so a live quote is a lookup rather than a rebuild. */
  private liveCurve: { dateKey: string; curve: CurveGenerator } | null = null;
  /**
   * Today's high and low SO FAR, and the second the walk has reached.
   *
   * Carried rather than recomputed because `dayRange` is called on every fan-out tick for every
   * watched symbol: holding the walk's position lets each call extend it by the seconds that have
   * passed, which is sixty samples rather than a day's worth. Dropped when the UTC day turns, which
   * is also when the price axis re-anchors.
   */
  private range: { dateKey: string; throughS: number; high: number; low: number } | null = null;

  constructor(
    private readonly seedFor: (dateKey: string) => string,
    private readonly cfg: () => VersionedGameConfig,
    opts: MarketHistoryOptions = {},
  ) {
    this.inst = opts.instrument ?? XAUUSD;
    this.now = opts.now ?? (() => Date.now());
    this.maxCachedDays = opts.maxCachedDays ?? 16;
    this.historyDays = Math.max(1, Math.floor(opts.historyDays ?? HISTORY_DAYS));
  }

  get instrument(): MarketSymbol { return this.inst; }

  /**
   * The day's curve, in this history's OWN seed domain.
   *
   * The symbol is passed to the generator, which is what makes two symbols on one brand genuinely
   * different series rather than one series with two axes. XAUUSD and the no-symbol caller keep the
   * bare `curve` domain (see `curveDomain`), so every day already generated and every position
   * already settled reconstructs to exactly the same numbers.
   */
  private curveFor(dateKey: string): CurveGenerator {
    return new CurveGenerator(this.seedFor(dateKey), this.cfg(), "market", this.inst.symbol);
  }

  /** The first day history offers — `historyDays` before today, in UTC. */
  private genesisKey(): string {
    return dateKeyUTC(this.now() - this.historyDays * DAY_S * 1000);
  }

  /**
   * Extend the chain forward until `through` has a base price, building each missing day's curve
   * once. Days are walked in order because each base depends on the previous day's close.
   *
   * The genesis day moves forward as real time passes, so the chain is rebuilt from a new start when
   * that happens. That re-anchors the series at the instrument's anchor price rather than letting it
   * drift with no floor, and it is invisible in practice: a chart only ever shows a window.
   */
  private chainThrough(through: string, withBars?: ReadonlySet<string> | "all"): void {
    const genesis = this.genesisKey();
    if (this.chainedTo === null || !this.days.has(genesis)) {
      this.days.clear();
      this.barOrder.length = 0;
      this.chainedTo = null;
    }
    let key = this.chainedTo === null ? genesis : nextKey(this.chainedTo);
    let base = this.chainedTo === null ? this.inst.anchor : this.days.get(this.chainedTo)!.nextBase;
    while (key <= through) {
      const curve = this.curveFor(key);
      const dayStartS = dayStartMs(key) / 1000;
      // The chain needs two numbers from the day and nothing else: the curve's value at the open,
      // which anchors the price axis, and its value at the close, which carries the base forward.
      // Bars are built only when something asks for them (see `hoursFor`, `minutesFor`).
      const openValue = curve.value(0);
      const slice: DaySlice = {
        dateKey: key, dayStartS, base, openValue,
        nextBase: nextBase(this.inst, base, openValue, curve.value(DAY_S)),
      };
      this.days.set(key, slice);
      // The day's curve is in hand and costs ~8ms to build, so a day whose bars this request
      // actually needs is filled here rather than constructing the same curve again later. Without
      // this, a cold request for a year of dailies built 400 curves to chain and 365 more to fold.
      if (withBars === "all" || (withBars !== undefined && withBars.has(key))) {
        slice.h1 = aggregate(this.fillMinutes(slice, curve), "H1");
      }
      base = slice.nextBase;
      this.chainedTo = key;
      key = nextKey(key);
    }
  }

  /**
   * The day's H1 bars, folded from its minute bars on first use and then kept.
   *
   * Folding from `minutesFor` rather than sampling the curve again means one curve construction
   * serves both: the minute bars are evictable and the hourly ones are not, so a day that is
   * scrolled past once keeps its cheap summary and drops its expensive detail.
   */
  private hoursFor(dateKey: string): Candle[] {
    const slice = this.days.get(dateKey);
    if (!slice) return [];
    if (slice.h1) return slice.h1;
    slice.h1 = aggregate(this.minutesFor(dateKey), "H1");
    return slice.h1;
  }

  /** Build and cache one day's minute bars from a curve already in hand, evicting the oldest. */
  private fillMinutes(slice: DaySlice, curve: CurveGenerator): Candle[] {
    slice.m1 = minuteBars(this.inst, slice.dayStartS, slice.base, (t) => curve.value(t));
    this.barOrder.push(slice.dateKey);
    while (this.barOrder.length > this.maxCachedDays) {
      const evict = this.barOrder.shift()!;
      const s = this.days.get(evict);
      if (s) delete s.m1;
    }
    return slice.m1;
  }

  /** The day's M1 bars, built on first use and evicted LRU-style. */
  private minutesFor(dateKey: string): Candle[] {
    const slice = this.days.get(dateKey);
    if (!slice) return [];
    if (slice.m1) return slice.m1;
    return this.fillMinutes(slice, this.curveFor(dateKey));
  }

  /**
   * The `count` most recent CLOSED bars at or before `toS` (epoch seconds; defaults to now).
   *
   * Every timeframe is folded from one cached source — hourly bars from H1 up, minute bars below —
   * so the periods always agree with each other and with the live tick stream.
   */
  candles(tf: Timeframe, count: number, toS?: number): Candle[] {
    const want = Math.max(1, Math.min(MAX_BARS, Math.floor(count)));
    const end = Math.min(toS ?? Math.floor(this.now() / 1000), Math.floor(this.now() / 1000));
    const endKey = dateKeyUTC(end * 1000);

    // Days needed for `want` bars of this timeframe, with a little slack for partial buckets.
    const spanS = tf === "MN1" ? 31 * DAY_S : TIMEFRAMES[tf];
    const daysNeeded = Math.min(this.historyDays + 1, Math.ceil((want * spanS) / DAY_S) + 2);

    const genesis = this.genesisKey();
    const keys: string[] = [];
    let key = endKey;
    for (let i = 0; i < daysNeeded && key >= genesis; i++) {
      keys.unshift(key);
      key = prevKey(key);
    }
    // Which days are wanted is known before the chain is walked, which is what lets the walk fill
    // their bars from the curve it is already building for each day.
    this.chainThrough(endKey, new Set(keys));

    const hourly = TIMEFRAMES[tf] >= TIMEFRAMES.H1 || tf === "MN1";
    let src: Candle[] = [];
    for (const k of keys) src = src.concat(hourly ? this.hoursFor(k) : this.minutesFor(k));

    const unit = hourly ? TIMEFRAMES.H1 : 60;
    // A bar that has not finished yet must never be served as if it had: its high, low and close are
    // still moving. The live tick stream owns the forming bar; history stops at the last closed one.
    src = src.filter((b) => b.time + unit <= end);
    const bars = (tf === "M1" || tf === "H1") ? src : aggregate(src, tf);
    return bars.filter((b) => nextBucketS(b.time, tf) <= end).slice(-want);
  }

  /**
   * Chain forward to today in slices, yielding to the event loop between them.
   *
   * The chain is ~2.2 seconds of CPU for the production window, and doing it inside a request
   * handler is 2.2 seconds during which this process serves no other brand. Nothing about the
   * result changes: the same days are built in the same order, and a caller that does not warm
   * first simply pays the whole cost at once inside its first `candles` or `liveAnchor` call.
   *
   * Concurrent calls are safe but wasteful rather than wrong — each would chain the days the other
   * has not reached yet — so a caller with several symbols to warm should queue them (see
   * `SymbolHistories.warm`).
   *
   * ── Why it folds the hourly bars as it goes ("all") ─────────────────────────────────────────────
   *
   * The day's curve is the expensive thing (about 5ms); folding its H1 bars while it is in hand
   * costs about 6ms more, and doing it LATER costs the whole 5ms again. The `withBars` argument
   * existed for exactly this and was never passed, so warming built 400 curves and threw every one
   * away — and the first request for any period of H1 or above then rebuilt them all, inside the
   * WebSocket handler, on the shared event loop. Measured on this container: a cold daily request
   * blocked the tick loop for 3.7 seconds, late-delivering every other trader's prices with it.
   *
   * With this, the cost moves into the slice loop above, which yields to the event loop between
   * slices and runs before any client is served. Every H1-and-above request afterwards is a lookup
   * (0.2 to 17ms). The memory is the H1 bars of 400 days, about 400KB per symbol; the minute bars
   * stay evictable, which is what `fillMinutes` is for.
   */
  async warm(): Promise<void> {
    const today = dateKeyUTC(this.now());
    let cursor = this.genesisKey();
    while (cursor < today) {
      for (let i = 0; i < WARM_SLICE_DAYS && cursor < today; i++) cursor = nextKey(cursor);
      this.chainThrough(cursor, "all");
      /**
       * Yield through a TIMER, not `setImmediate`.
       *
       * `setImmediate` runs in the check phase, which comes after timers but before the loop turns
       * over, so a tight immediate loop keeps handing control back to itself and the tick
       * `setInterval` is served late or not at all. That is not theoretical: with the bars being
       * folded here, warming starved the tick stream badly enough that a brand resolved live
       * emitted fewer than two ticks in 300ms. A zero-delay timer puts this work in the same queue
       * as the ticks and they take turns.
       */
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    }
    this.chainThrough(today, "all");
  }

  /** Whether the chain already reaches today, so a caller can tell a warm history from a cold one. */
  get warmed(): boolean {
    const today = dateKeyUTC(this.now());
    return this.chainedTo === today && this.days.has(this.genesisKey());
  }

  /**
   * This instrument's live quote: the same `Tick` shape the brand's own curve emits.
   *
   * Today's curve is built once and kept, so a quote costs an O(1) lookup into an already
   * materialised walk. It is rebuilt when the UTC day turns, which is also when the price axis
   * re-anchors, so a client reading quotes must re-read `liveAnchor` at the same moment.
   *
   * For the default symbol this agrees exactly with the rate the settlement curve emits — the two
   * derive the same day seed and run the same generator — which is what lets one chart show the
   * history and the live edge without them disagreeing. See markethistory.test.ts.
   */
  liveTick(nowMs?: number, prevRate?: number): Tick {
    const ms = nowMs ?? this.now();
    const key = dateKeyUTC(ms);
    if (!this.liveCurve || this.liveCurve.dateKey !== key) {
      this.liveCurve = { dateKey: key, curve: this.curveFor(key) };
    }
    return this.liveCurve.curve.tick(ms, dayStartMs(key), prevRate);
  }

  /**
   * The highest and lowest price TODAY has reached so far, on this instrument's own price axis.
   *
   * MetaTrader's phone Quotes row prints `L:` and `H:` beneath the Bid and the Ask, and its Details
   * tab carries the same pair. They belong on the quote rather than being derived on the client:
   * the engine already holds the day, and a phone deriving them would have to fetch a day of bars
   * per watched symbol to print two numbers each.
   *
   * SO FAR is the whole point. This curve is deterministic for the entire day the moment its seed
   * is known, so folding the day's bars would return the extremes of a day that has not happened
   * yet: a high the price will reach this evening, printed at breakfast as though it had. The walk
   * stops at the current second, and `dayExtremes` documents the same trap from the other side.
   */
  dayRange(nowMs?: number): { high: number; low: number } {
    const ms = nowMs ?? this.now();
    const key = dateKeyUTC(ms);
    this.chainThrough(key);
    const slice = this.days.get(key);
    if (!this.liveCurve || this.liveCurve.dateKey !== key) {
      this.liveCurve = { dateKey: key, curve: this.curveFor(key) };
    }
    const base = slice?.base ?? this.inst.anchor;
    const curve = this.liveCurve.curve;
    const sample = (t: number) => curve.value(t);
    // Clamped to the day: a clock skewed past midnight must not walk into tomorrow's seconds on
    // today's curve, which would price a second that belongs to a different seed.
    const elapsedS = Math.min(DAY_S, Math.max(0, Math.floor((ms - dayStartMs(key)) / 1000)));

    if (this.range === null || this.range.dateKey !== key) {
      const e = dayExtremes(this.inst, base, sample, 0, elapsedS);
      this.range = { dateKey: key, throughS: elapsedS, ...e };
    } else if (elapsedS > this.range.throughS) {
      const e = dayExtremes(this.inst, base, sample, this.range.throughS + 1, elapsedS, {
        high: this.range.high, low: this.range.low,
      });
      this.range = { dateKey: key, throughS: elapsedS, ...e };
    }
    return { high: this.range.high, low: this.range.low };
  }

  /**
   * What the client needs to place LIVE ticks on the same price axis as the history: the current
   * day's base and opening curve value. price = base + scale * (value(t) - openValue).
   */
  liveAnchor(atMs?: number): { dateKey: string; base: number; openValue: number; instrument: MarketSymbol } {
    const key = dateKeyUTC(atMs ?? this.now());
    this.chainThrough(key);
    const slice = this.days.get(key);
    const base = slice?.base ?? this.inst.anchor;
    return { dateKey: key, base, openValue: slice?.openValue ?? this.curveFor(key).value(0), instrument: this.inst };
  }

  /**
   * Day anchors for a set of UTC dates, so a client can place an OLD rate on the price axis.
   *
   * The axis is re-anchored every UTC midnight, so a rate recorded on an earlier day is meaningless
   * against today's anchor — mapped through today's it yields a price that never happened. A trade
   * list showing historical prices needs the anchor of each trade's OWN day, and this is the only
   * place that knows them: they come out of the same forward chain the candles do, and now cost
   * nothing to serve because the chain already keeps them.
   *
   * Dates outside the retained window are simply absent from the reply rather than an error: a
   * client asking about a trade older than history reaches should fall back, not fail.
   */
  anchors(dateKeys: readonly string[]): Array<{ dateKey: string; base: number; openValue: number }> {
    const genesis = this.genesisKey();
    const today = dateKeyUTC(this.now());
    const out: Array<{ dateKey: string; base: number; openValue: number }> = [];
    const seen = new Set<string>();
    for (const key of dateKeys) {
      if (seen.has(key) || key < genesis || key > today) continue;
      seen.add(key);
      if (out.length >= MAX_ANCHORS) break;
      this.chainThrough(key);
      const slice = this.days.get(key);
      if (slice) out.push({ dateKey: key, base: slice.base, openValue: slice.openValue });
    }
    return out;
  }

  /** One day's anchor, or null when that date is off the chain (before genesis, or in the future). */
  anchorFor(dateKey: string): DayAnchor | null {
    const [a] = this.anchors([dateKey]);
    return a ? { base: a.base, openValue: a.openValue } : null;
  }

  /**
   * This brand's price axis, as the narrow interface the money layer stamps execution prices through.
   *
   * Handing out an object rather than `this` keeps that layer unable to reach the day chain for
   * anything else: a display price is all it may ask for.
   */
  axis(): PriceAxis {
    return { instrument: this.inst, anchorFor: (key) => this.anchorFor(key) };
  }
}

const nextKey = (dateKey: string): string => dateKeyUTC(dayStartMs(dateKey) + DAY_S * 1000);
const prevKey = (dateKey: string): string => dateKeyUTC(dayStartMs(dateKey) - DAY_S * 1000);
