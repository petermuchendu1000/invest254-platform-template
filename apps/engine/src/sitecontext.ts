import {
  CurveGenerator, SettlementEngine, deriveSiteDaySeed, siteCommitment,
  type VersionedGameConfig,
} from "@invest254/shared";

/**
 * Per-site pricing context — the multiplexed engine's core building block.
 *
 * The single-tenant engine builds ONE (curve, settlement) from ONE day seed. The multiplexed
 * engine builds one of these PER SITE, so every brand has an independent curve and an RTP
 * calibrated to its OWN economy. This composes the existing, proven CurveGenerator +
 * SettlementEngine with the per-site seed from packages/shared — no change to either class, so
 * all their guarantees (smoothness, RTP calibration, provable fairness) carry over per brand.
 *
 * Determinism: identical (masterSeed, siteId, dateKey, seedVersion, config) always yields
 * byte-identical parameters, so crash recovery can re-price a position under its site + version
 * without reading any secret — exactly as the single-tenant engine does, now per brand.
 */
export interface SiteContext {
  siteId: string;
  dateKey: string;
  seedVersion: number;
  seed: string;        // per-site day seed (server-side only)
  seedHash: string;    // public commitment for this brand+day
  cfg: VersionedGameConfig;
  curve: CurveGenerator;
  settlement: SettlementEngine;
}

export interface BuildSiteContextArgs {
  masterSeed: string;      // platform master seed, or the brand's own (sites.master_seed_ref)
  siteId: string;
  dateKey: string;         // UTC "YYYY-MM-DD"
  cfg: VersionedGameConfig;
  seedVersion?: number;    // >0 after a system-owner-forced rotation for this brand+day
  /** Calibration sample count (smaller in tests for speed; engine default is 200k). */
  calibrationSamples?: number;
}

/** Build a fully-calibrated pricing context for one brand-day. Pure (no I/O). */
export function buildSiteContext(a: BuildSiteContextArgs): SiteContext {
  const seedVersion = a.seedVersion ?? 0;
  const seed = deriveSiteDaySeed(a.masterSeed, a.siteId, a.dateKey, seedVersion);
  const seedHash = siteCommitment(seed);
  const curve = new CurveGenerator(seed, a.cfg);
  const settlement = a.calibrationSamples
    ? new SettlementEngine(curve, a.cfg, "calibration", a.cfg.defaultDurationS, 3600, a.calibrationSamples)
    : new SettlementEngine(curve, a.cfg);
  return { siteId: a.siteId, dateKey: a.dateKey, seedVersion, seed, seedHash, cfg: a.cfg, curve, settlement };
}
