import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VERSIONED_CONFIG, type VersionedGameConfig, type Direction, CALIBRATION_WINDOW_S } from "@invest254/shared";
import { buildSiteContext } from "./sitecontext.js";

const MASTER = "platform-master-xyz";
const SITE_A = "00000000-0000-0000-0000-000000000001";
const SITE_B = "00000000-0000-0000-0000-0000000000b2";
const DAY = "2026-02-10";
const SAMPLES = 30_000; // calibration sample count (kept modest for test speed)

// Site A: default economy (house edge 0.75 -> RTP 0.25).
const cfgA: VersionedGameConfig = { ...DEFAULT_VERSIONED_CONFIG, version: 1 };
// Site B: a much tighter economy (house edge 0.90 -> RTP 0.10), feasible win rate.
const cfgB: VersionedGameConfig = { ...DEFAULT_VERSIONED_CONFIG, version: 1, houseEdge: 0.90, targetWinRate: 0.05 };

/** Held-out realized RTP over many random entry times, both directions (hold-to-expiry). */
/**
 * Realised RTP, sampled over the window the engine was CALIBRATED on.
 *
 * It used to draw its entries from the first hour of the day. That was only accidentally valid
 * while a contract lasted ten seconds: entries that close ten seconds apart barely overlap, so an
 * hour held tens of thousands of near-independent samples. The horizon is now fifteen minutes (a
 * stop needs room to be reached), and entries drawn from one hour then all look through very nearly
 * the SAME window, so the estimate is dominated by whatever that one window did: measured RTP 0.425
 * against a 0.25 target. Sampling the whole calibration window keeps the draws independent at any
 * horizon the config can express.
 */
function realizedRtp(ctx: ReturnType<typeof buildSiteContext>, n = 40_000): number {
  const stake = 100_000;
  let paid = 0;
  const dirs: Direction[] = ["buy", "sell"];
  for (let i = 0; i < n; i++) {
    const entryT = Math.random() * CALIBRATION_WINDOW_S;
    const dir = dirs[i % 2]!;
    paid += ctx.settlement.settle(stake, dir, entryT).payoutCents;
  }
  return paid / (n * stake);
}

test("two brands get decorrelated curves from the same master + day", () => {
  const a = buildSiteContext({ masterSeed: MASTER, siteId: SITE_A, dateKey: DAY, cfg: cfgA, calibrationSamples: SAMPLES });
  const b = buildSiteContext({ masterSeed: MASTER, siteId: SITE_B, dateKey: DAY, cfg: cfgA, calibrationSamples: SAMPLES });
  assert.notEqual(a.seed, b.seed);
  assert.notEqual(a.seedHash, b.seedHash);

  // Sample across the whole day; the two brands must not track each other.
  let diff = 0, n = 0;
  for (let t = 0; t < 86_400; t += 60) { diff += Math.abs(a.curve.value(t) - b.curve.value(t)); n++; }
  assert.ok(diff / n > 0.05, `curves too similar (mean |Δ| ${(diff / n).toFixed(4)})`);

  // The separation above is the consequence; INDEPENDENCE is the property. The `market` curve is a
  // random walk, so two independent brands start from independent levels and drift apart as sqrt(t)
  // — in the first minutes of a day they can happen to sit close together, which says nothing about
  // whether they share structure. Correlating the INCREMENTS tests the real thing, and it is the
  // assertion that would actually catch a shared or derived seed: identical paths correlate at 1.
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
  for (let t = 0; t + 10 < 86_400; t += 10) {
    const x = a.curve.value(t + 10) - a.curve.value(t);
    const y = b.curve.value(t + 10) - b.curve.value(t);
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; m++;
  }
  const corr = (sxy / m - (sx / m) * (sy / m))
    / Math.sqrt((sxx / m - (sx / m) ** 2) * (syy / m - (sy / m) ** 2));
  assert.ok(Math.abs(corr) < 0.05, `brands' increments are correlated (r = ${corr.toFixed(4)})`);
});

test("each brand calibrates RTP to its OWN economy, independently", () => {
  const a = buildSiteContext({ masterSeed: MASTER, siteId: SITE_A, dateKey: DAY, cfg: cfgA, calibrationSamples: SAMPLES });
  const b = buildSiteContext({ masterSeed: MASTER, siteId: SITE_B, dateKey: DAY, cfg: cfgB, calibrationSamples: SAMPLES });
  const rtpA = realizedRtp(a);
  const rtpB = realizedRtp(b);
  // Site A ~ 0.25, Site B ~ 0.10 — each tracks its own config, well separated.
  assert.ok(Math.abs(rtpA - 0.25) < 0.04, `site A RTP ${rtpA.toFixed(3)} not ~0.25`);
  assert.ok(Math.abs(rtpB - 0.10) < 0.04, `site B RTP ${rtpB.toFixed(3)} not ~0.10`);
  assert.ok(rtpA > rtpB + 0.05, `brands' RTPs must be independent (A ${rtpA.toFixed(3)} vs B ${rtpB.toFixed(3)})`);
});

test("deterministic rebuild — crash-recovery equivalence per brand", () => {
  const a1 = buildSiteContext({ masterSeed: MASTER, siteId: SITE_A, dateKey: DAY, cfg: cfgA, calibrationSamples: SAMPLES });
  const a2 = buildSiteContext({ masterSeed: MASTER, siteId: SITE_A, dateKey: DAY, cfg: cfgA, calibrationSamples: SAMPLES });
  assert.equal(a1.seed, a2.seed);
  // Same committed outcome for a fixed (dir, entryT) — what recovery relies on.
  const o1 = a1.settlement.settle(100_000, "buy", 123.4);
  const o2 = a2.settlement.settle(100_000, "buy", 123.4);
  assert.deepEqual({ r: o1.result, p: o1.payoutCents }, { r: o2.result, p: o2.payoutCents });
});

test("forced seed rotation changes a brand's curve without touching others", () => {
  const base = buildSiteContext({ masterSeed: MASTER, siteId: SITE_A, dateKey: DAY, cfg: cfgA, calibrationSamples: SAMPLES });
  const rotated = buildSiteContext({ masterSeed: MASTER, siteId: SITE_A, dateKey: DAY, cfg: cfgA, seedVersion: 1, calibrationSamples: SAMPLES });
  assert.notEqual(base.seed, rotated.seed);
  assert.notEqual(base.curve.value(10), rotated.curve.value(10));
});

test("a per-brand master seed also fully decorrelates brands", () => {
  const a = buildSiteContext({ masterSeed: "master-A", siteId: SITE_A, dateKey: DAY, cfg: cfgA, calibrationSamples: SAMPLES });
  const b = buildSiteContext({ masterSeed: "master-B", siteId: SITE_A, dateKey: DAY, cfg: cfgA, calibrationSamples: SAMPLES });
  assert.notEqual(a.seed, b.seed);
});
