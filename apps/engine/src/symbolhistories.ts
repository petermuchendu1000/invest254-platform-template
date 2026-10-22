import {
  DEFAULT_SYMBOL, SYMBOLS, instrumentFor, type VersionedGameConfig,
} from "@invest254/shared";
import { MarketHistory, type MarketHistoryOptions } from "./markethistory.js";

/**
 * One brand's candle history, per symbol.
 *
 * `MarketHistory` is built for exactly one instrument: it walks a chain of days forward from
 * genesis, carrying each day's close into the next day's base, and that chain is only valid for the
 * symbol whose curve produced it. Multi-symbol therefore means one history object per symbol, not
 * one history answering for many — and this class owns the set.
 *
 * ## Why there is a cap
 *
 * A resident history is not free. The chain keeps every day's 24 hourly bars for the life of the
 * brand (~1KB a day, so ~400KB over the 400-day window) and caches minute bars for the days a chart
 * is actually looking at (~46KB a day, 16 days by default). Call it 1.1MB per symbol per brand.
 * The catalogue carries ninety-odd symbols and one engine process runs every brand, so holding all
 * of them for all brands is hundreds of megabytes of bars nobody is looking at.
 *
 * So histories are built on first use and evicted least-recently-used beyond `maxResident`. Evicting
 * one costs nothing but CPU on the next request: the chain is deterministic from the day seeds, so a
 * rebuilt history produces bit-for-bit the same bars. That is the whole reason this is safe to
 * evict and a live position is not.
 *
 * The DEFAULT symbol is pinned and never evicted. It is the one the brand's price axis stamps
 * execution prices against, so a cold rebuild of it would sit in the path of a trade rather than a
 * chart request.
 */
export interface SymbolHistoriesOptions {
  /** Day-seed derivation for this brand, shared by every symbol — the symbol separates inside the curve. */
  seedFor: (dateKey: string) => string;
  cfg: () => VersionedGameConfig;
  now?: () => number;
  /**
   * The symbols this brand offers, in the order its Market Watch should list them.
   *
   * Defaults to the whole catalogue. Per-brand subsets are a database question (see
   * docs/mt5/12-multi-symbol-scope.md item 7); this is the seam they will arrive through.
   */
  symbols?: readonly string[];
  /** How many symbols' histories to hold resident at once, excluding the pinned default. */
  maxResident?: number;
  /** Passed to every history this brand builds. See `MarketHistoryOptions.historyDays`. */
  historyDays?: number;
}

/**
 * How many symbols one brand holds resident by default.
 *
 * This number has to stay ABOVE the number of symbols a client may watch at once
 * (`MAX_WATCHED_SYMBOLS` in multiengine.ts), and the relationship is not a nicety. A watched symbol
 * is touched on every tick, so a watch list longer than the resident set would evict and rebuild
 * every symbol on it continuously, and because a rebuilt history starts cold, not one of them would
 * ever be warm enough to quote. The quotes would simply never arrive.
 */
export const DEFAULT_MAX_RESIDENT = 24;

/**
 * Days of minute bars a NON-primary history keeps.
 *
 * The primary symbol keeps `MarketHistory`'s own default, because it is the one the chart is
 * usually on. A symbol that is only being quoted needs no minute bars at all, and a symbol being
 * charted needs the few days around the view; four is enough to page without turning 24 resident
 * histories into several hundred megabytes of bars (~46KB a day each).
 */
export const NON_PRIMARY_CACHED_DAYS = 4;

export class SymbolHistories {
  private readonly offered: readonly string[];
  private readonly built = new Map<string, MarketHistory>();
  /** Least-recently-used first, and never contains the pinned default. */
  private readonly lru: string[] = [];
  private readonly maxResident: number;
  /** The tail of this brand's warm queue, so only one chain is walked at a time. */
  private warming: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SymbolHistoriesOptions) {
    const offered = opts.symbols ?? SYMBOLS.map((s) => s.symbol);
    // A brand that offers nothing still has to chart something, and the price axis needs the
    // default resident regardless, so the default is always offered.
    this.offered = offered.includes(DEFAULT_SYMBOL) ? offered : [DEFAULT_SYMBOL, ...offered];
    this.maxResident = Math.max(1, opts.maxResident ?? DEFAULT_MAX_RESIDENT);
    // Built eagerly, because the brand's price axis is this one and a trade must not wait on it.
    this.built.set(DEFAULT_SYMBOL, this.build(DEFAULT_SYMBOL)!);
  }

  /** The symbols this brand offers, in listing order. */
  get symbols(): readonly string[] { return this.offered; }

  /** Whether this brand offers the symbol at all. An unoffered symbol is a client error. */
  has(symbol: string): boolean { return this.offered.includes(symbol); }

  /** The default symbol's history: the brand's price axis, always resident. */
  get primary(): MarketHistory { return this.built.get(DEFAULT_SYMBOL)!; }

  /** Which symbols are resident right now. Exposed for tests and metrics, not for callers. */
  get resident(): readonly string[] { return [...this.built.keys()]; }

  /**
   * This brand's history for one symbol, built on demand.
   *
   * Returns undefined for a symbol the brand does not offer, rather than silently falling back to
   * the default — a typo must not quietly chart a different instrument.
   */
  for(symbol: string): MarketHistory | undefined {
    if (!this.has(symbol)) return undefined;
    const existing = this.built.get(symbol);
    if (existing) {
      this.touch(symbol);
      return existing;
    }
    const made = this.build(symbol);
    if (!made) return undefined;
    this.built.set(symbol, made);
    this.touch(symbol);
    this.evictBeyondCap();
    return made;
  }

  /**
   * The symbol's history, with its chain already walked to today.
   *
   * Warming is ~2.2 seconds of CPU per cold symbol, so the warms are QUEUED: one at a time for this
   * brand, in the order they were asked for. Running several at once would not make any of them
   * finish sooner — it is one thread — and would interleave 2.2-second stalls instead of yielding
   * between slices, which is the whole point of warming asynchronously.
   *
   * A symbol already warm resolves immediately without joining the queue, so the common case of a
   * client resubscribing to what it already watches costs nothing.
   */
  async warm(symbol: string): Promise<MarketHistory | undefined> {
    const h = this.for(symbol);
    if (!h || h.warmed) return h;
    // Chain onto whatever is already warming for this brand, so the slices never interleave.
    const run = this.warming.then(() => h.warm(), () => h.warm());
    this.warming = run.catch(() => { /* a failed warm must not poison the queue */ });
    await run;
    // The symbol may have been evicted while it warmed, in which case the caller should ask again
    // rather than be handed a history that is no longer this brand's.
    return this.built.get(symbol) === h ? h : this.for(symbol);
  }

  private touch(symbol: string): void {
    if (symbol === DEFAULT_SYMBOL) return;
    const at = this.lru.indexOf(symbol);
    if (at >= 0) this.lru.splice(at, 1);
    this.lru.push(symbol);
  }

  private evictBeyondCap(): void {
    while (this.lru.length > this.maxResident) {
      const evict = this.lru.shift()!;
      this.built.delete(evict);
    }
  }

  private build(symbol: string): MarketHistory | undefined {
    const instrument = instrumentFor(symbol);
    if (!instrument) return undefined;
    const o: MarketHistoryOptions = {
      instrument,
      ...(this.opts.now ? { now: this.opts.now } : {}),
      ...(this.opts.historyDays !== undefined ? { historyDays: this.opts.historyDays } : {}),
      ...(symbol === DEFAULT_SYMBOL ? {} : { maxCachedDays: NON_PRIMARY_CACHED_DAYS }),
    };
    return new MarketHistory(this.opts.seedFor, this.opts.cfg, o);
  }
}
