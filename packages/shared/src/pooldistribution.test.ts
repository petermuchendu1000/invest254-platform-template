import { test } from "node:test";
import assert from "node:assert/strict";
import {
  distributeDynamicPool, emaForecast, targetRtpFor, type BrandDemand,
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
