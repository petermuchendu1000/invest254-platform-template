import {
  CurveGenerator, SettlementEngine, type VersionedGameConfig,
  dateKeyUTC, dayStartMs as dayStartMsForKey, deriveDaySeed, deriveSiteDaySeed, commitment,
} from "@invest254/shared";
import type { GameRepository } from "./wallet.js";
import type { ConfigProvider } from "./gameconfig.js";

/**
 * Everything the engine needs to run, score, and recover a single UTC trading day at a
 * single configuration version — all deterministically derived from
 * (masterSeed, dateKey, seedVersion, config). Building a context is a pure computation
 * (curve + per-direction RTP calibration); the only side effect is `ensureGameDay`, which
 * commits the day's seed hash to the database.
 *
 * The seed — and therefore the published fairness commitment — depends only on
 * (masterSeed, dateKey, seedVersion). Configuration does NOT feed the seed, so an admin
 * changing volatility or RTP never invalidates a commitment already published for the day.
 * It does change how the seed is *priced*, which is why the config version is part of the
 * context identity: a position records its version and is always recovered against it.
 */
export interface DayContext {
  gameDayId: number | null;   // null until the DB row is ensured
  dateKey: string;            // "YYYY-MM-DD" (UTC)
  dayStartMs: number;         // epoch ms of UTC midnight
  seedVersion: number;        // 0 = base seed; >0 after a superadmin-forced rotation (J5)
  seed: string;               // recomputable day seed (hex) — never persisted as plaintext pre-reveal
  seedHash: string;           // SHA-256(seed) — the public commitment
  configVersion: number;      // game_config_versions.version that priced this context
  cfg: VersionedGameConfig;   // the exact parameters baked into curve + settlement below
  curve: CurveGenerator;
  settlement: SettlementEngine;
  /** Multi-tenant: the brand this context belongs to (undefined in single-tenant mode). */
  siteId?: string;
}

export interface SeedManagerOptions {
  /** Calibration sample count for the SettlementEngine. Omit to use the engine default (200k). */
  calibrationSamples?: number;
  /** Cap on cached (day, config) contexts. Prevents unbounded growth under rapid config edits. */
  maxCachedContexts?: number;
}

/**
 * SeedManager owns the lifecycle of daily contexts:
 *  - builds + caches a DayContext per (date key, config version) pair (idempotent),
 *  - commits each day's seed-hash to the DB (so fairness is publishable before reveal),
 *  - exposes the active context synchronously to the hot path via getActive(),
 *  - rotates at the UTC boundary and reveals the previous day's seed,
 *  - re-points the active context when the admin saves new configuration.
 *
 * Determinism is the whole point: the same (masterSeed, dateKey, configVersion,
 * calibrationSamples) always yields byte-identical curve/threshold parameters, so a
 * position's outcome can be recomputed after a crash without reading any secret from the
 * database — provided we recompute it under the config version it was opened with.
 */
export class SeedManager {
  private readonly cache = new Map<string, DayContext>();
  private activeKey: string | null = null;

  constructor(
    private readonly masterSeed: string,
    private readonly config: ConfigProvider,
    private readonly repo: GameRepository,
    private readonly now: () => number = () => Date.now(),
    private readonly opts: SeedManagerOptions = {},
    /**
     * Multi-tenant: when set, seeds are derived per-site (deriveSiteDaySeed) and every game-day
     * row is committed/revealed under this brand. Omitted = single-tenant (legacy) behaviour.
     */
    private readonly siteId?: string,
  ) {
    if (!masterSeed) throw new Error("masterSeed is required");
  }

  private static cacheKey(dateKey: string, configVersion: number): string {
    return `${dateKey}#${configVersion}`;
  }

  /** Pure build (no I/O): derive seed, hash, curve and calibrated settlement for a day at a config. */
  private build(dateKey: string, seedVersion: number, cfg: VersionedGameConfig): DayContext {
    const seed = this.siteId
      ? deriveSiteDaySeed(this.masterSeed, this.siteId, dateKey, seedVersion)
      : deriveDaySeed(this.masterSeed, dateKey, seedVersion);
    const seedHash = commitment(seed);
    const curve = new CurveGenerator(seed, cfg);
    const settlement = this.opts.calibrationSamples
      ? new SettlementEngine(curve, cfg, "calibration", cfg.defaultDurationS, 3600, this.opts.calibrationSamples)
      : new SettlementEngine(curve, cfg);
    return {
      gameDayId: null, dateKey, dayStartMs: dayStartMsForKey(dateKey), seedVersion, seed, seedHash,
      configVersion: cfg.version, cfg, curve, settlement,
      ...(this.siteId !== undefined ? { siteId: this.siteId } : {}),
    };
  }

  /** Evict the least-recently-inserted contexts, never the active one. */
  private evict(): void {
    const max = this.opts.maxCachedContexts ?? 16;
    if (this.cache.size <= max) return;
    for (const key of this.cache.keys()) {
      if (this.cache.size <= max) break;
      if (key === this.activeKey) continue;
      this.cache.delete(key);
    }
  }

  /**
   * Get (or build+cache) the context for a date key at a configuration version, ensuring its
   * DB row commits the matching seed hash. `configVersion` omitted means "the config in force
   * now"; recovery passes the version stored on the position instead.
   *
   * The active seed version is read from the durable `seed_overrides` (0 if none), so a
   * superadmin-forced rotation (J5) is honored for any day this process has not yet built.
   * A (day, config) pair already cached/committed is never silently re-seeded under live
   * positions — the cache is authoritative for this process.
   */
  async contextFor(dateKey: string, configVersion?: number | null): Promise<DayContext> {
    const cfg = await this.config.forVersion(configVersion ?? null);
    const key = SeedManager.cacheKey(dateKey, cfg.version);
    let ctx = this.cache.get(key);
    if (!ctx) {
      const version = await this.repo.getSeedVersion(dateKey, this.siteId);
      ctx = this.build(dateKey, version, cfg);
      this.cache.set(key, ctx);
      this.evict();
    }
    if (ctx.gameDayId === null) ctx.gameDayId = await this.repo.ensureGameDay(dateKey, ctx.seedHash, this.siteId);
    return ctx;
  }

  /**
   * Initialise (or re-point) the active context to the current UTC day at the current config
   * version. Idempotent, and the single entry point for both the UTC-midnight rotation and an
   * admin config change — in each case the *next* round is priced by the new context while any
   * position already in flight keeps the context it committed to.
   */
  async init(): Promise<DayContext> {
    const key = dateKeyUTC(this.now());
    const ctx = await this.contextFor(key);
    this.activeKey = SeedManager.cacheKey(key, ctx.configVersion);
    return ctx;
  }

  /** Synchronous active-context accessor for the hot path. Throws if not initialised/ready. */
  getActive(): DayContext {
    if (!this.activeKey) throw new Error("SeedManager not initialised — call init() first");
    const ctx = this.cache.get(this.activeKey);
    if (!ctx || ctx.gameDayId === null) throw new Error("active day context is not ready");
    return ctx;
  }

  /**
   * Advance to the current UTC day and reveal the seed of the day we just left (if any
   * and if it is now in the past). Safe to call repeatedly; only reveals once per day.
   */
  async rotate(): Promise<{ active: DayContext; revealed: string | null }> {
    const prev = this.activeKey ? this.cache.get(this.activeKey) : undefined;
    const prevKey = prev?.dateKey ?? null;
    const active = await this.init();
    let revealed: string | null = null;
    if (prevKey && prevKey !== active.dateKey && prev) {
      if (await this.repo.revealSeed(prevKey, prev.seed, this.siteId)) revealed = prevKey;
    }
    return { active, revealed };
  }
}
