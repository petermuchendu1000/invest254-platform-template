import { GameServer, type LoadOverride } from "./game.js";
import { SeedManager, type SeedManagerOptions } from "./daycontext.js";
import { RecoveryService, type RecoveryReport } from "./recovery.js";
import type { GameRepository } from "./wallet.js";
import { affectsPricing, type ConfigProvider } from "./gameconfig.js";
import type { PoolController } from "./poolcontroller.js";

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
      const seeds = new SeedManager(master, config, this.opts.repo, this.opts.now, this.opts.seedManagerOpts, siteId);
      await seeds.init();
      const game = new GameServer(
        () => seeds.getActive(),
        this.opts.repo,
        () => config.active(),
        this.opts.now,
        this.opts.loadOverride,
        this.opts.poolController
          ? { enabled: () => (this.opts.poolModeFor?.(siteId) ?? false), controller: this.opts.poolController }
          : undefined,
        this.opts.loadIsMarketer,
      );
      const rt: SiteRuntime = { siteId, seeds, game, config };

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
      const rec = new RecoveryService(this.opts.repo, rt.seeds, rt.game, this.opts.now, this.opts.loadOverride, siteId, this.opts.poolController);
      out.set(siteId, await rec.recover());
    }
    return out;
  }
}
