import { test } from "node:test";
import assert from "node:assert/strict";
import {
  distributeDynamicPool, emaForecast, targetRtpFor, robustExpectedTurnover, type BrandDemand,
} from "./pooldistribution.js";

/**
 * Dynamic pool distribution (docs/25 §15) — proportional-fair water-filling. Every expectation is
 * derived from the model: required_i = clamp(1−houseEdge_i)×forecast_i; Σ alloc ≤ G; proportional
 * rationing when capital-constrained; floor bootstraps active brands; cap prevents hoarding.
 */
const b = (siteId: string, houseEdge: number, forecast: number): BrandDemand => ({ siteId, houseEdge, forecastTurnoverCents: forecast });
const sum = (a: { allocCents: number }[]) => a.reduce((s, x) => s + x.allocCents, 0);
const by = (a: { siteId: string; allocCents: number }[]) => Object.fromEntries(a.map((x) => [x.siteId, x.allocCents]));

test("targetRtpFor clamps 1−houseEdge to [0.05,0.95] (matches the engine)", () => {
  assert.equal(targetRtpFor(0.05), 0.95);
  assert.equal(targetRtpFor(0.75), 0.25);
  assert.equal(targetRtpFor(0), 0.95);      // clamp hi
  assert.equal(targetRtpFor(0.999), 0.05);  // clamp lo
});

test("emaForecast: empty→0, responds to a rising series, seeded (no cold-start 0 bias)", () => {
  assert.equal(emaForecast([]), 0);
  assert.equal(emaForecast([100]), 100);
  const rising = emaForecast([0, 100, 200, 300, 400], 0.4);
  assert.ok(rising > 150 && rising < 400, `EMA of rising series = ${rising}`);
  // higher alpha reacts faster to the latest value
  assert.ok(emaForecast([0, 0, 0, 500], 0.7) > emaForecast([0, 0, 0, 500], 0.2));
});

test("Σ allocations never exceed the global total (rounding-safe)", () => {
  for (const G of [0, 1, 999, 1_700_000, 10_000_000]) {
    const out = distributeDynamicPool([b("a", 0.05, 1_600_000), b("b", 0.05, 900_000), b("c", 0.05, 0)], G);
    assert.ok(sum(out) <= G, `sum ${sum(out)} > G ${G}`);
  }
});

test("capital-constrained (G < Σrequired): proportional rationing by required, dead brands get 0", () => {
  // two whales + a dead brand; G far below need ⇒ split ∝ required (equal houseEdge ⇒ ∝ forecast)
  const out = distributeDynamicPool([b("w1", 0.05, 2_000_000), b("w2", 0.05, 1_000_000), b("dead", 0.05, 0)], 600_000, { floorFrac: 0, capMult: 100 });
  const m = by(out);
  assert.equal(m.dead, 0, "dead brand (0 forecast) gets nothing");
  const ratio = m.w1! / m.w2!;
  assert.ok(Math.abs(ratio - 2) < 0.05, `w1:w2 ≈ 2:1 by demand, got ${ratio.toFixed(2)}`);
  assert.ok(sum(out) <= 600_000 && sum(out) > 600_000 * 0.98, "≈ fully uses the constrained budget");
});

test("floor bootstraps active brands even when demand is tiny vs a whale", () => {
  const G = 1_000_000;
  const out = distributeDynamicPool([b("whale", 0.05, 5_000_000), b("tiny", 0.05, 10_000)], G, { floorFrac: 0.02, capMult: 2.5 });
  const m = by(out);
  assert.ok(m.tiny! >= Math.floor(G * 0.02) - 2, `tiny brand receives at least the floor, got ${m.tiny}`);
  assert.ok(m.whale! > m.tiny!, "whale still gets the lion's share");
});

test("cap prevents hoarding: a whale is capped at capMult×required, surplus redistributed", () => {
  // G is ample vs a single whale's need ⇒ whale capped, the rest flows to the other brand.
  const out = distributeDynamicPool([b("whale", 0.05, 1_000_000), b("mid", 0.05, 400_000)], 10_000_000, { floorFrac: 0, capMult: 2.0 });
  const m = by(out);
  const whaleRequired = 0.95 * 1_000_000;
  assert.ok(m.whale! <= Math.ceil(whaleRequired * 2.0) + 2, `whale capped at 2×required (${whaleRequired * 2}), got ${m.whale}`);
  assert.ok(m.mid! > 0, "mid brand funded from the redistributed surplus");
});

test("full funding when G ≥ Σrequired: each brand covered up to its cap; excess stays reserved", () => {
  const out = distributeDynamicPool([b("a", 0.05, 100_000), b("c", 0.05, 300_000)], 5_000_000, { floorFrac: 0.01, capMult: 3 });
  for (const r of out) {
    assert.ok(r.allocCents >= r.requiredCents, `${r.siteId} alloc ${r.allocCents} < required ${r.requiredCents}`);
    assert.ok(r.allocCents <= Math.ceil(r.requiredCents * 3) + 2, `${r.siteId} alloc ${r.allocCents} exceeded cap`);
  }
  assert.ok(sum(out) < 5_000_000, "excess beyond total capped need is left undistributed (reserve)");
});

test("per-brand house_edge drives required (higher edge ⇒ lower target RTP ⇒ less pool)", () => {
  // same forecast, different edges: the 25%-RTP brand needs far less pool than the 95%-RTP brand.
  const out = distributeDynamicPool([b("lowedge", 0.05, 1_000_000), b("highedge", 0.75, 1_000_000)], 5_000_000, { floorFrac: 0, capMult: 5 });
  const m = by(out);
  assert.ok(m.lowedge! > m.highedge! * 2.5, `95%-RTP brand needs ~3.8× the 25%-RTP brand: got ${m.lowedge} vs ${m.highedge}`);
});

test("determinism + edge cases (G=0, no brands, all-zero forecast)", () => {
  const brands = [b("a", 0.05, 500_000), b("b", 0.05, 200_000)];
  assert.deepEqual(distributeDynamicPool(brands, 1_000_000), distributeDynamicPool(brands, 1_000_000));
  assert.deepEqual(distributeDynamicPool(brands, 0).map((x) => x.allocCents), [0, 0]);
  assert.deepEqual(distributeDynamicPool([], 1_000_000), []);
  assert.deepEqual(distributeDynamicPool([b("x", 0.05, 0), b("y", 0.05, 0)], 1_000_000).map((x) => x.allocCents), [0, 0]);
});

// ── Anti-starvation floor (docs/25 §15.2) — the fix for the invest254 outage incident ──────────────
const bx = (siteId: string, houseEdge: number, forecast: number, expected: number): BrandDemand =>
  ({ siteId, houseEdge, forecastTurnoverCents: forecast, expectedTurnoverCents: expected });

test("robustExpectedTurnover: outage (trailing zeros) does NOT collapse it, unlike the reactive EMA", () => {
  assert.equal(robustExpectedTurnover([]), 0);
  assert.equal(robustExpectedTurnover([0, 0, 0, 0]), 0);
  // 3 busy days then ~2 weeks of outage zeros (the exact incident shape).
  const series = [8_000_000, 9_000_000, 10_000_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const robust = robustExpectedTurnover(series);
  assert.ok(robust >= 8_000_000, `robust estimate collapsed under outage: ${robust}`);
  // the reactive EMA (what the allocator used to rely on) DOES collapse — this is why the pool starved.
  assert.ok(emaForecast(series, 0.4) < 1_000_000, "EMA should collapse (demonstrates the root cause)");
});

test("guaranteed floor: a brand whose reactive forecast collapsed to 0 is NOT starved", () => {
  // invest254 post-outage: forecast=0 but demonstrated demand (expectedTurnover) ~8M keeps the floor up.
  const out = distributeDynamicPool([bx("inv", 0.05, 0, 8_000_000)], 20_000_000, { floorFrac: 0.015, capMult: 2.5 });
  const m = by(out);
  assert.equal(m.inv, 7_600_000, `floor = round(0.95×8M); got ${m.inv}`); // was ~83k under the old allocator
  assert.ok(sum(out) <= 20_000_000);
});

test("even a HUGE envelope no longer clamps to the old 2.5×collapsed-forecast cap", () => {
  // The old bug: with forecast≈0, cap=2.5×required≈0 → invest254 capped at ~83k even for a 1B envelope.
  // Now the floor (from expectedTurnover) guarantees a viable pool regardless of the collapsed forecast.
  const out = distributeDynamicPool([bx("inv", 0.05, 0, 8_000_000)], 1_000_000_000, { floorFrac: 0.015, capMult: 2.5 });
  assert.ok(by(out).inv! >= 7_600_000, `still starved: ${by(out).inv}`);
});

test("configuredFloorCents is an absolute minimum for ACTIVE brands, never for dead brands", () => {
  const out = distributeDynamicPool(
    [b("a", 0.05, 100_000),                       // active (forecast>0), no expectedTurnover
     b("dead", 0.05, 0)],                          // never any demand
    50_000_000, { floorFrac: 0, capMult: 2.5, configuredFloorCents: 1_000_000 });
  const m = by(out);
  assert.ok(m.a! >= 1_000_000, `active brand must get the configured floor, got ${m.a}`);
  assert.equal(m.dead, 0, "a brand that never had demand gets no floor (no wasted capital)");
});

test("floors rationed proportionally when Σ floors exceed the envelope (Σ alloc ≤ G)", () => {
  const out = distributeDynamicPool(
    [bx("a", 0.05, 0, 4_000_000), bx("b", 0.05, 0, 4_000_000)],   // each floor = 3.8M, Σ=7.6M
    3_000_000, { floorFrac: 0, capMult: 2.5 });                    // envelope only 3M
  const m = by(out);
  assert.ok(sum(out) <= 3_000_000, `overspent: ${sum(out)}`);
  assert.ok(Math.abs(m.a! - m.b!) <= 2, "equal floors rationed equally");
  assert.ok(m.a! > 1_400_000 && m.a! < 1_600_000, `~half the envelope each, got ${m.a}`);
});

test("floor is a MINIMUM: a healthy brand still gets demand-based top-up above its floor", () => {
  const out = distributeDynamicPool(
    [bx("big", 0.05, 5_000_000, 5_000_000),   // healthy: required 4.75M, gets water-fill above floor
     bx("small", 0.05, 0, 1_000_000)],         // collapsed forecast: floor 950k guaranteed
    20_000_000, { floorFrac: 0, capMult: 2.5 });
  const m = by(out);
  assert.ok(m.small! >= 950_000 - 2, `small floor not honoured: ${m.small}`);
  assert.ok(m.big! > m.small!, "healthy brand still gets the larger demand-based share");
  assert.ok(m.big! > 4_750_000, `big should exceed its required via water-fill, got ${m.big}`);
  assert.ok(sum(out) <= 20_000_000);
});

test("back-compat: omitting expectedTurnover + configuredFloor reproduces the legacy allocation exactly", () => {
  const brands = [b("a", 0.05, 1_000_000), b("c", 0.05, 300_000), b("dead", 0.05, 0)];
  const withFloorParamsButNoData = distributeDynamicPool(brands, 5_000_000, { floorFrac: 0.01, capMult: 3, configuredFloorCents: 0 });
  const legacy = distributeDynamicPool(brands, 5_000_000, { floorFrac: 0.01, capMult: 3 });
  assert.deepEqual(withFloorParamsButNoData, legacy, "configuredFloor=0 + no expectedTurnover must be a no-op");
  assert.equal(by(legacy).dead, 0);
});
