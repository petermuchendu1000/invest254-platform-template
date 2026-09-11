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

// ── Real-time (intra-day) reallocation ─────────────────────────────────────────────────────────
// docs/25 §15.1 — the daily allocator (above) sets each brand's budget once, at the EAT-day start.
// Real-time reallocation reacts WITHIN the day as demand shifts (triggered by confirmed deposits),
// moving the platform's UNDISTRIBUTED reserve to whichever brands are now under-served — WITHOUT ever
// reducing a brand's already-granted budget. This monotone (never-decrease) online allocation is
// "progressive filling" toward the water-fill ideal (max-min fair; cf. Bertsekas & Gallager, *Data
// Networks*, §6.5.2), which converges to the same fair point the batch allocator would compute, but
// safely: a brand that has already reserved/paid wins against its budget can never have it clawed back
// (the DB invariant amount ≥ paid+reserved is preserved by construction, since new ≥ committed).

/** A brand's current intra-day budget alongside its demand, for real-time top-up. */
export interface BrandCommit extends BrandDemand {
  /** Today's withdrawal_pool.amount_cents already granted to this brand (0 if no day row yet). */
  committedTodayCents: number;
}

/** Per-brand result of a real-time top-up: how much reserve to ADD to today's budget (never negative). */
export interface HeadroomGrant {
  siteId: string;
  committedCents: number;
  idealCents: number;
  /** Reserve capital added this pass (≥ 0). */
  grantCents: number;
  /** committedCents + grantCents — the new today budget to apply (monotone ≥ committed). */
  newAmountCents: number;
}

/**
 * Distribute the platform's UNDISTRIBUTED reserve (envelope − Σ committed) onto under-served brands,
 * proportionally to each brand's remaining deficit (ideal − committed), capped at that deficit. PURE +
 * deterministic. Monotone: grantCents ≥ 0 for every brand (never claws back). Σ newAmount ≤ envelope
 * whenever Σ committed ≤ envelope (the normal case). If a brand is already at/over its ideal, or the
 * reserve is exhausted, it gets 0 — nothing is ever reduced.
 */
export function grantsFromIdeal(
  items: { siteId: string; idealCents: number; committedCents: number }[],
  envelopeCents: number,
): HeadroomGrant[] {
  const rows = items.map((it) => {
    const committed = Math.max(0, Math.floor(it.committedCents || 0));
    const ideal = Math.max(0, Math.floor(it.idealCents || 0));
    return { siteId: it.siteId, committed, ideal, deficit: Math.max(0, ideal - committed), grant: 0 };
  });
  const G = Math.max(0, Math.floor(envelopeCents));
  const committedSum = rows.reduce((s, r) => s + r.committed, 0);
  let headroom = Math.max(0, G - committedSum);

  for (let iter = 0; iter < 16 && headroom > 0; iter++) {
    const elig = rows.filter((r) => r.grant < r.deficit);
    const S = elig.reduce((s, r) => s + (r.deficit - r.grant), 0);
    if (S <= 0) break;
    const snapshot = headroom;
    let moved = 0;
    for (const r of elig) {
      const want = Math.floor(snapshot * ((r.deficit - r.grant) / S));
      const give = Math.min(want, r.deficit - r.grant);
      r.grant += give; moved += give;
    }
    headroom -= moved;
    if (moved === 0) {
      // integer-rounding remainder: hand the last cents to the largest remaining deficit, then stop.
      const r = elig.slice().sort((a, b) => (b.deficit - b.grant) - (a.deficit - a.grant))[0];
      if (r) { const give = Math.min(headroom, r.deficit - r.grant); r.grant += give; headroom -= give; }
      break;
    }
  }

  return rows.map((r) => ({
    siteId: r.siteId, committedCents: r.committed, idealCents: r.ideal,
    grantCents: r.grant, newAmountCents: r.committed + r.grant,
  }));
}

/**
 * Real-time reallocation from live demand: compute the water-fill IDEAL for the full envelope, then
 * top up under-served brands from the reserve (never-clawback). Convenience wrapper that ties the
 * batch allocator (`distributeDynamicPool`) to `grantsFromIdeal`, so the intra-day and daily paths
 * share one fairness definition.
 */
export function redistributeHeadroom(
  brands: BrandCommit[],
  envelopeCents: number,
  params: DistributeParams = {},
): HeadroomGrant[] {
  const ideal = distributeDynamicPool(
    brands.map((b) => ({ siteId: b.siteId, houseEdge: b.houseEdge, forecastTurnoverCents: b.forecastTurnoverCents })),
    envelopeCents, params);
  const idealById = new Map(ideal.map((a) => [a.siteId, a.allocCents]));
  return grantsFromIdeal(
    brands.map((b) => ({ siteId: b.siteId, idealCents: idealById.get(b.siteId) ?? 0, committedCents: b.committedTodayCents })),
    envelopeCents);
}
