/**
 * Dynamic pool distribution (docs/25 §15) — demand-based allocation of the platform's global
 * withdrawal-pool total across brands. PURE + deterministic: no I/O, no clock. Selected empirically
 * (see the algorithm study) as **weighted proportional-fair water-filling** over each brand's demand.
 *
 * MODEL — tied to the RTP-redesigned engine (docs/25 §14), which pays realized RTP = min(target,
 * pool/turnover). The pool a brand NEEDS to fully fund its target RTP is therefore:
 *     required_i = targetRtp_i × forecastTurnover_i ,  targetRtp_i = clamp(1 − house_edge_i)
 * We allocate the global total G across brands to cover `required` as fairly and efficiently as
 * possible:
 *   1. FLOOR: brands with any recent demand (forecast > 0) get a small guaranteed floor (bootstrap /
 *      anti-starvation), never above their own cap.
 *   2. WATER-FILL: distribute the remainder PROPORTIONALLY to `required`, each brand capped at
 *      capMult × required so no brand hoards beyond its need + headroom; freed capital is
 *      redistributed to brands still under their cap (iterated to convergence).
 *   3. SURPLUS: if G exceeds total capped need, the leftover is spread as a proportional buffer.
 * When G < Σ required (capital-constrained — the common case), this reduces to proportional
 * rationing: alloc_i ≈ G × required_i / Σ required. Σ alloc ≤ G always.
 *
 * Demand is forecast per brand with an EMA over recent daily pool turnover (fast enough to track
 * activations/spikes within days, smooth enough to avoid day-to-day thrash).
 */

export interface BrandDemand {
  siteId: string;
  /** Brand's site_game_config.house_edge (0..1). targetRtp = clamp(1 − houseEdge). */
  houseEdge: number;
  /** EMA-forecast of the brand's daily POOL turnover (staked cents by non-marketer players). */
  forecastTurnoverCents: number;
}

export interface PoolAllocation {
  siteId: string;
  allocCents: number;
  requiredCents: number;
  forecastTurnoverCents: number;
  targetRtp: number;
}

export interface DistributeParams {
  /** Guaranteed floor per active brand, as a fraction of the global total. Default 0.015 (1.5%). */
  floorFrac?: number;
  /** Per-brand cap as a multiple of required (headroom for spikes; prevents hoarding). Default 2.5. */
  capMult?: number;
  /** targetRtp clamp, matching the engine (game.ts). Default [0.05, 0.95]. */
  rtpClampLo?: number;
  rtpClampHi?: number;
}

/** targetRtp for a brand = clamp(1 − houseEdge), matching the engine's pool RTP clamp. */
export function targetRtpFor(houseEdge: number, lo = 0.05, hi = 0.95): number {
  const r = 1 - (Number.isFinite(houseEdge) ? houseEdge : 0);
  return Math.min(hi, Math.max(lo, r));
}

/**
 * EMA of a daily series (oldest→newest). alpha in (0,1]: higher reacts faster, lower is smoother.
 * Returns 0 for an empty series. Seeded with the first observation to avoid a cold-start bias to 0.
 */
export function emaForecast(daily: number[], alpha = 0.4): number {
  if (!daily.length) return 0;
  const a = Math.min(1, Math.max(0.01, alpha));
  let ema = daily[0]!;
  for (const x of daily) ema = a * x + (1 - a) * ema;
  return ema;
}

/**
 * Allocate `totalCents` across `brands` by demand. Σ allocations ≤ totalCents. Deterministic.
 * Brands with forecast 0 receive 0 (no capital wasted on idle brands) — a daily re-run picks up a
 * newly-active brand within the EMA's response window.
 */
export function distributeDynamicPool(
  brands: BrandDemand[],
  totalCents: number,
  params: DistributeParams = {},
): PoolAllocation[] {
  const floorFrac = params.floorFrac ?? 0.015;
  const capMult = params.capMult ?? 2.5;
  const lo = params.rtpClampLo ?? 0.05;
  const hi = params.rtpClampHi ?? 0.95;
  const G = Math.max(0, Math.floor(totalCents));

  const rows = brands.map((b) => {
    const targetRtp = targetRtpFor(b.houseEdge, lo, hi);
    const forecast = Math.max(0, b.forecastTurnoverCents || 0);
    const required = targetRtp * forecast;
    return { siteId: b.siteId, targetRtp, forecast, required, cap: required * capMult, alloc: 0 };
  });

  const totalRequired = rows.reduce((s, r) => s + r.required, 0);
  if (G <= 0 || totalRequired <= 0) {
    return rows.map((r) => ({ siteId: r.siteId, allocCents: 0, requiredCents: Math.round(r.required), forecastTurnoverCents: Math.round(r.forecast), targetRtp: r.targetRtp }));
  }

  const floor = Math.floor(G * floorFrac);
  let remaining = G;
  // 1) floors to active brands (never above their own cap)
  for (const r of rows) {
    if (r.forecast > 0) { const g = Math.min(floor, Math.floor(r.cap)); r.alloc += g; remaining -= g; }
  }
  remaining = Math.max(0, remaining);

  // 2) water-fill proportional to required, respecting caps; redistribute overflow (iterate)
  for (let iter = 0; iter < 12 && remaining > 0; iter++) {
    const elig = rows.filter((r) => r.required > 0 && r.alloc < r.cap - 1);
    const S = elig.reduce((s, r) => s + r.required, 0);
    if (S <= 0) break;
    const snapshot = remaining;
    let moved = 0;
    for (const r of elig) {
      const want = Math.floor(snapshot * (r.required / S));
      const room = Math.max(0, Math.floor(r.cap - r.alloc));
      const give = Math.min(want, room);
      r.alloc += give; moved += give;
    }
    remaining -= moved;
    if (moved === 0) break;
  }

  // 3) Any capital remaining here means G exceeds the total CAPPED need (Σ capMult×required). Rather
  //    than dump it into brands beyond their cap (hoarding), it stays UNDISTRIBUTED as a platform
  //    reserve: Σ alloc ≤ min(G, Σ cap). The operator's total is a ceiling, not a mandate to spend.

  // Rounding safety: never exceed G.
  const sum = rows.reduce((s, r) => s + r.alloc, 0);
  if (sum > G && sum > 0) { const k = G / sum; for (const r of rows) r.alloc = Math.floor(r.alloc * k); }

  return rows.map((r) => ({
    siteId: r.siteId, allocCents: Math.max(0, Math.floor(r.alloc)),
    requiredCents: Math.round(r.required), forecastTurnoverCents: Math.round(r.forecast), targetRtp: r.targetRtp,
  }));
}
