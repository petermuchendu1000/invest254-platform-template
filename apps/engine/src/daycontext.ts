import {
  CurveGenerator, SettlementEngine, CALIBRATION_WINDOW_S, type VersionedGameConfig, type CurveProfile,
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
  seedVersion: number;        // 0 = base seed; >0 after a system-owner-forced rotation (J5)
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
  /**
   * A PREVIOUS master seed, used only to reveal days that were committed under it.
   *
   * WHY THIS HAS TO EXIST: rotating the master seed is otherwise a one-way door that silently
   * destroys the fairness record. `fn_ensure_game_day` is `on conflict do nothing`, so a day's
   * commitment is frozen the moment it is first created, and `fn_reveal_game_day` applies its
   * update only `where server_seed_hash = encode(digest(p_seed,'sha256'),'hex')`. So a day
   * committed under master A can ONLY ever be revealed by a seed derived from master A. Change the
   * master and every already-open day becomes permanently unrevealable — and because there are
   * always open days (one per brand, every day), there is no safe moment to rotate. Measured at the
   * time of writing: 143 open days across 18 brands.
   *
   * The two alternatives are both unacceptable. Leaving those days unrevealed puts a permanent hole
   * in the published fairness record. Rewriting their stored commitment to match a new seed would
   * publish a commitment that does not correspond to the outcomes those days actually produced —
   * falsifying the exact record the mechanism exists to make trustworthy.
   *
   * So the reveal tries the current master first and falls back to this one. Nothing else uses it:
   * new days are always committed under the CURRENT master, so the legacy value cannot extend its
   * own life or influence a single future outcome. Unset = no fallback, behaviour unchanged.
   */
  legacyMasterSeed?: string;
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
    /**
     * Price-curve SHAPE for this brand (see CurveGenerator): `wave` for line brands (irregular
     * rise/fall waves), `market` for the TradingView candlestick/bars/area brands. Fixed for the
     * life of this manager, so every (day, config) context it builds — and every recovery against
     * them — prices under the same shape. Omitted = `market`. It does NOT feed the seed, so the
     * published fairness commitment is unchanged; the SettlementEngine recalibrates to the shape.
     */
    private readonly curveProfile: CurveProfile = "market",
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
    const curve = new CurveGenerator(seed, cfg, this.curveProfile);
    const settlement = this.opts.calibrationSamples
      ? new SettlementEngine(curve, cfg, "calibration", cfg.defaultDurationS, CALIBRATION_WINDOW_S, this.opts.calibrationSamples)
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
   * system-owner-forced rotation (J5) is honored for any day this process has not yet built.
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
    if (ctx.gameDayId === null) {
      const adopted = await this.adoptPublishedContext(dateKey, ctx, cfg);
      if (adopted !== ctx) { ctx = adopted; this.cache.set(key, ctx); }
      ctx.gameDayId = await this.repo.ensureGameDay(dateKey, ctx.seedHash, this.siteId);
    }
    return ctx;
  }

  /**
   * If this day was ALREADY committed under the previous master seed, price it from that seed.
   *
   * This is the other half of supporting a master-seed rotation, and the half that is easy to miss
   * because nothing fails loudly without it. `fn_ensure_game_day` is `on conflict do nothing`, so a
   * day's published commitment is frozen when the day is created. Rotate the master and restart
   * mid-day and the engine would build a DIFFERENT seed for the same day, then quietly keep the old
   * commitment in the database: the brand's whole price curve changes under live positions, and the
   * commitment on display stops describing the day actually being traded. The fairness guarantee
   * would be broken for that day with nothing anywhere saying so — the exact failure the mechanism
   * exists to rule out.
   *
   * So when the stored commitment disagrees with the freshly derived one, and the legacy master
   * reproduces the stored one, the legacy context wins for that day. Tomorrow has no stored
   * commitment, so it is derived from the CURRENT master and the rotation completes by itself. The
   * practical effect is that the master can be rotated at any moment, with no price discontinuity,
   * no orphaned day, and no day whose commitment lies.
   *
   * A disagreement the legacy master cannot explain is left alone deliberately: this is not the
   * place to guess. The fresh context stands, `ensureGameDay` keeps the stored commitment, and the
   * mismatch is logged loudly so an operator sees it. Silently adopting an unverifiable seed would
   * be worse than a noisy inconsistency.
   */
  private async adoptPublishedContext(dateKey: string, fresh: DayContext, cfg: VersionedGameConfig): Promise<DayContext> {
    const legacy = this.opts.legacyMasterSeed;
    if (!legacy) return fresh;
    const published = await this.repo.getCommittedSeedHash(dateKey, this.siteId);
    if (published === null || published === fresh.seedHash) return fresh;  // new day, or already agrees
    const legacySeed = this.siteId
      ? deriveSiteDaySeed(legacy, this.siteId, dateKey, fresh.seedVersion)
      : deriveDaySeed(legacy, dateKey, fresh.seedVersion);
    if (commitment(legacySeed) !== published) {
      console.warn(`[engine] day ${dateKey}${this.siteId ? ` site ${this.siteId}` : ""}: stored commitment matches neither the current nor the legacy master seed; leaving it as published`);
      return fresh;
    }
    const curve = new CurveGenerator(legacySeed, cfg, this.curveProfile);
    const settlement = this.opts.calibrationSamples
      ? new SettlementEngine(curve, cfg, "calibration", cfg.defaultDurationS, CALIBRATION_WINDOW_S, this.opts.calibrationSamples)
      : new SettlementEngine(curve, cfg);
    return { ...fresh, seed: legacySeed, seedHash: published, curve, settlement };
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
      else if (await this.revealWithLegacyMaster(prevKey, prev.seedVersion)) revealed = prevKey;
    }
    return { active, revealed };
  }

  /**
   * Second attempt at a reveal, using the previous master seed (see `legacyMasterSeed`).
   *
   * Reached only when the current master produced a seed the stored commitment rejects, which means
   * exactly one thing: this day was committed before the master was rotated. The RPC is the
   * authority either way — it compares the hash itself and updates nothing on a mismatch — so a
   * wrong guess here is a no-op rather than a corruption, and the day simply stays unrevealed.
   *
   * `seedVersion` is carried over from the day's own context rather than re-read, so a day that had
   * its version bumped by a forced rotation still derives the seed it was actually committed with.
   */
  private async revealWithLegacyMaster(dateKey: string, seedVersion: number): Promise<boolean> {
    const legacy = this.opts.legacyMasterSeed;
    if (!legacy) return false;
    const seed = this.siteId
      ? deriveSiteDaySeed(legacy, this.siteId, dateKey, seedVersion)
      : deriveDaySeed(legacy, dateKey, seedVersion);
    return this.repo.revealSeed(dateKey, seed, this.siteId);
  }
}
