import { GameServer, type LoadOverride } from "./game.js";
import { SeedManager, type SeedManagerOptions } from "./daycontext.js";
import { RecoveryService, type RecoveryReport } from "./recovery.js";
import type { GameRepository } from "./wallet.js";
import type { PendingOrderStore } from "./pending.js";
import { affectsPricing, type ConfigProvider } from "./gameconfig.js";
import type { PoolController } from "./poolcontroller.js";
import { deriveSiteDaySeed, type CurveProfile } from "@invest254/shared";
import { MarketHistory } from "./markethistory.js";
import { SymbolHistories } from "./symbolhistories.js";
import { withPriceStamp } from "./pricestamp.js";

/**
 * SiteRegistry — the multiplexed engine's per-brand runtime manager.
 *
 * The single-tenant engine builds ONE SeedManager + ONE GameServer. Here we build one of each
 * PER SITE, lazily and cached, so a single engine process runs every brand's authoritative curve
 * and settlement independently. Each runtime:
 *   - derives per-site day seeds (SeedManager is constructed with the siteId, so it decorrelates
 *     brands and commits/reveals game-day rows under that brand — see daycontext.ts),
 *   - prices with that brand's live config (its own ConfigProvider),
 *   - stamps every position it opens with the site (GameServer reads ctx.siteId).
 *
 * This reuses the proven GameServer/SeedManager unchanged except for the additive site plumbing,
 * so their guarantees (atomic settle, crash recovery, RTP calibration, fairness) hold per brand.
 */
export interface SiteRuntime {
  siteId: string;
  seeds: SeedManager;
  game: GameServer;
  config: ConfigProvider;
  /**
   * Candle history for the chart — only on brands whose curve profile is `market`.
   *
   * Line brands draw the raw wave and have no candles, so asking for them is a client error rather
   * than an empty result, which is why this is undefined rather than an empty history.
   *
   * This is the DEFAULT symbol's history, which is also the brand's price axis. A caller that wants
   * a particular symbol asks `histories` instead; this stays because the price axis, the recovery
   * path and every single-symbol caller written before multi-symbol all mean this one.
   */
  history?: MarketHistory;
  /**
   * Every symbol's history for this brand, built on demand and capped. Present exactly when
   * `history` is, since both exist only on a candlestick brand.
   */
  histories?: SymbolHistories;
  /**
   * The repository every path that opens or settles for this brand must trade through.
   *
   * It is the shared repository with display-price stamping bolted on (migration 0180) on a
   * candlestick brand, and the shared repository itself on a line brand. Anything that settles
   * outside the GameServer — crash recovery, notably — uses this rather than the raw repo, or the
   * positions it closes would be the only ones in the table with no exit price.
   */
  tradeRepo: GameRepository;
}

export interface SiteRegistryOptions {
  /** Platform master seed; used when a brand has no dedicated master (sites.master_seed_ref). */
  masterSeed: string;
  repo: GameRepository;
  /** Build (or fetch) the live config provider for a brand. */
  configFor: (siteId: string) => ConfigProvider | Promise<ConfigProvider>;
  now?: () => number;
  loadOverride?: LoadOverride;
  /** Optional per-brand master seed (from sites.master_seed_ref); falls back to `masterSeed`. */
  masterSeedFor?: (siteId: string) => string | undefined;
  seedManagerOpts?: SeedManagerOptions;
  /** Price-curve SHAPE for a brand (from its sites.chart_style): `wave` for line brands, `market`
   *  for TradingView candlestick/bars/area brands. Resolved once when the brand's runtime is built.
   *  Omitted (or a resolver error) = `market`. */
  curveProfileFor?: (siteId: string) => CurveProfile | Promise<CurveProfile>;
  /** docs/25: shared pool controller (stateless bar its repo; site passed per-call). When set, a
   *  brand whose poolModeFor(siteId) is true has its non-marketer trades governed by the controller. */
  poolController?: PoolController;
  poolModeFor?: (siteId: string) => boolean;
  /** Canonical marketer/demo classifier (migration 0084) shared by every brand's GameServer, so the
   *  pool exemption matches the money layer's demo routing. Absent -> GameServer falls back to role. */
  loadIsMarketer?: (userId: string) => Promise<boolean>;
  /** Surface live-config rebuild failures (defaults to console.error). */
  onError?: (err: Error, ctx: string) => void;
}

export class SiteRegistry {
  private readonly runtimes = new Map<string, SiteRuntime>();
  private readonly building = new Map<string, Promise<SiteRuntime>>();

  constructor(private readonly opts: SiteRegistryOptions) {}

  private report(err: Error, ctx: string): void {
    if (this.opts.onError) this.opts.onError(err, ctx);
    else console.error(`[registry] ${ctx}:`, err.message);
  }

  /** Get (or lazily build) a brand's runtime. Concurrent calls for the same brand coalesce. */
  async ensure(siteId: string): Promise<SiteRuntime> {
    const existing = this.runtimes.get(siteId);
    if (existing) return existing;
    const inflight = this.building.get(siteId);
    if (inflight) return inflight;

    const p = (async (): Promise<SiteRuntime> => {
      const config = await this.opts.configFor(siteId);
      const master = this.opts.masterSeedFor?.(siteId) || this.opts.masterSeed;
      // Price shape from the brand's chart style (line ⇒ irregular waves, else trending market).
      // A resolver error must never block the brand's runtime, so fall back to `market`.
      let curveProfile: CurveProfile = "market";
      if (this.opts.curveProfileFor) {
        try { curveProfile = await this.opts.curveProfileFor(siteId); }
        catch (err) { this.report(err as Error, `curve-profile ${siteId}`); }
      }
      const seeds = new SeedManager(master, config, this.opts.repo, this.opts.now, this.opts.seedManagerOpts, siteId, curveProfile);
      await seeds.init();
      // Candle history is display-only: it never settles anything, so it derives its own seeds
      // rather than going through SeedManager (which caches per config version, commits game-day
      // rows and holds only a few days — all wrong for reconstructing hundreds of past days).
      // Forced rotations (J5) are read once here so a rotated day's chart shows the day that was
      // actually traded, not the version-0 one that never existed.
      //
      // Built BEFORE the GameServer because it owns this brand's price axis, and the repository the
      // GameServer trades through stamps execution prices against that axis (see below).
      let histories: SymbolHistories | undefined;
      if (curveProfile === "market") {
        let versions = new Map<string, number>();
        try { versions = (await this.opts.repo.listSeedVersions?.(siteId)) ?? versions; }
        catch (err) { this.report(err as Error, `seed-versions ${siteId}`); }
        // One day-seed derivation shared by every symbol. The symbol separates INSIDE the curve
        // (curveDomain), not in the seed, which is what keeps the default symbol reconstructing
        // bit-for-bit while every other symbol gets a genuinely independent series.
        histories = new SymbolHistories({
          seedFor: (dateKey) => deriveSiteDaySeed(master, siteId, dateKey, versions.get(dateKey) ?? 0),
          cfg: () => config.active(),
          ...(this.opts.now ? { now: this.opts.now } : {}),
        });
      }
      const history: MarketHistory | undefined = histories?.primary;
      /**
       * Build the brand's own history NOW, in the background, before any client can ask for it.
       *
       * Nothing warmed at boot, so the first trader to open a chart paid for the whole 400-day
       * chain inside their own request: measured on this container, two seconds before the first
       * bar could even be computed, and the engine's tick loop blocked for most of it. `warm()`
       * yields to the event loop between slices, so doing it here costs the ticks nothing and the
       * first request arrives to a history that is already standing.
       *
       * Not awaited, and failures are reported rather than thrown: a brand whose history could not
       * be warmed still serves its ticks, and the next request simply pays what it used to.
       */
      if (history) {
        void history.warm().catch((err: unknown) => this.report(err as Error, `warm ${siteId}`));
      }
      // On a candlestick brand, record the chart price every trade executed at (migration 0180), so
      // a receipt can print the number the player actually saw instead of "at market". The wrapper
      // writes AFTER the atomic money RPC returns and never awaits the write, so settlement is
      // untouched and unslowed; a line brand has no price axis and is handed the repo unwrapped.
      const tradeRepo: GameRepository = history
        ? withPriceStamp(this.opts.repo, {
            axis: () => history!.axis(),
            onError: (err, ctx) => this.report(err, `${ctx} ${siteId}`),
          })
        : this.opts.repo;
      const game = new GameServer(
        () => seeds.getActive(),
        tradeRepo,
        () => config.active(),
        this.opts.now,
        this.opts.loadOverride,
        this.opts.poolController
          ? { enabled: () => (this.opts.poolModeFor?.(siteId) ?? false), controller: this.opts.poolController }
          : undefined,
        this.opts.loadIsMarketer,
        // The same axis the price stamper uses. It is what lets the engine hold MetaTrader's
        // protective levels itself: a level is a chart PRICE, so every tick converts the current
        // rate to a price and compares. A line brand has no axis, no levels, and keeps the
        // committed contract. See docs/mt5/20-real-sl-tp.md.
        history ? () => history.axis() : undefined,
        // Where pending orders are kept, so a deploy does not disarm an order a trader armed
        // before it (migration 0185). The repository carries the methods when the database does;
        // the in-memory development repository does not, and such a brand holds its orders for the
        // life of the process, which is what every other optional seam here means.
        this.opts.repo as unknown as PendingOrderStore,
        siteId,
      );
      const rt: SiteRuntime = {
        siteId, seeds, game, config, tradeRepo,
        ...(history ? { history } : {}),
        ...(histories ? { histories } : {}),
      };

      // Live config hot-reload (docs/22 Task C). When this brand's economy is edited, price the
      // NEXT round under the new version by rebuilding the seed context, and re-arm the tick loop
      // if the tick rate changed. Positions already in flight keep the version they opened with
      // (SeedManager caches per (day, version)), so nothing in flight is disturbed. Non-pricing
      // edits (stake bounds, min withdrawal) are read live by the GameServer, so we only rebuild
      // seeds when `affectsPricing` — but always re-arm the tick loop, which is cheap.
      config.subscribe?.((next, prev) => {
        void (async () => {
          try {
            if (affectsPricing(prev, next)) await seeds.init();
            game.applyTickRate();
          } catch (err) {
            this.report(err as Error, `config-reload ${siteId}`);
          }
        })();
      });

      this.runtimes.set(siteId, rt);
      return rt;
    })();

    this.building.set(siteId, p);
    try { return await p; } finally { this.building.delete(siteId); }
  }

  get(siteId: string): SiteRuntime | undefined { return this.runtimes.get(siteId); }
  all(): SiteRuntime[] { return [...this.runtimes.values()]; }
  stopAll(): void { for (const rt of this.runtimes.values()) rt.game.stop(); }

  /**
   * Crash recovery across all brands: group the DB's open positions by site, ensure each brand's
   * runtime, and recover ONLY that brand's positions against its own (site-aware) SeedManager +
   * GameServer. Returns a per-site report.
   */
  async recoverAll(): Promise<Map<string, RecoveryReport>> {
    const open = await this.opts.repo.listOpenPositions();
    const siteIds = new Set<string>();
    for (const row of open) if (row.siteId) siteIds.add(row.siteId);
    const out = new Map<string, RecoveryReport>();
    for (const siteId of siteIds) {
      const rt = await this.ensure(siteId);
      // rt.tradeRepo, not the raw repo: a position settled by recovery must get its exit price
      // stamped like any other, and recovery is precisely the case where "now" is the wrong day to
      // price against (see PgGameRepository.setExecutionPrices).
      const rec = new RecoveryService(rt.tradeRepo, rt.seeds, rt.game, this.opts.now, this.opts.loadOverride, siteId, this.opts.poolController, this.opts.loadIsMarketer);
      out.set(siteId, await rec.recover());
      /**
       * And re-arm the orders that were still waiting (migration 0185).
       *
       * Separate from `RecoveryService`, which reconstructs open POSITIONS from their seeds and
       * nonces; a pending order has no outcome to reconstruct, only a level to watch again. It is
       * never allowed to fail the boot: an engine that refused to start because one order could not
       * be read would take every trader's live position down with it.
       */
      try {
        const armed = await rt.game.pending.recover();
        if (armed > 0) console.log(`[pending] re-armed ${armed} order(s) for ${siteId}`);
      } catch (err) { this.report(err as Error, `pending-recover ${siteId}`); }
    }
    return out;
  }
}
