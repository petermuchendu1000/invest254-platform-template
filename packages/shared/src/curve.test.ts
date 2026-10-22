import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator } from "./curve.js";
import { SettlementEngine } from "./settle.js";
import { SeededRng } from "./prng.js";
import { DEFAULT_CONFIG, rtp } from "./config.js";

/** Max |second central difference| of f over a window, sampling at step dt. */
function maxSecondDiff(f: (t: number) => number, t0: number, t1: number, dt: number): number {
  let m = 0;
  for (let t = t0 + dt; t < t1 - dt; t += dt) {
    const d2 = Math.abs(f(t + dt) - 2 * f(t) + f(t - dt));
    if (d2 > m) m = d2;
  }
  return m;
}

test("curve is deterministic for the same seed", () => {
  const a = new CurveGenerator("day-seed-1", DEFAULT_CONFIG);
  const b = new CurveGenerator("day-seed-1", DEFAULT_CONFIG);
  for (let t = 0; t < 50; t += 1.3) assert.equal(a.value(t), b.value(t));
});

test("curve stays bounded in (-1,1)", () => {
  const c = new CurveGenerator("day-seed-1", DEFAULT_CONFIG);
  for (let t = 0; t < 600; t += 0.05) {
    const v = c.value(t);
    assert.ok(v > -1 && v < 1, `out of bounds at t=${t}: ${v}`);
  }
});

/**
 * SMOOTHNESS PROOF (no pointed curves).
 * For a C2 function, the second central difference scales ~ f''*dt^2, so refining
 * dt by 10x must shrink max|d2| by ~100x. A pointed (C0) curve only shrinks ~10x.
 * We require the smooth curve's ratio to be clearly quadratic (>40) and validate
 * the test discriminates by checking a triangle wave fails (ratio <20).
 */
test("PROOF: curve is C2-smooth — second difference shrinks quadratically", () => {
  const c = new CurveGenerator("day-seed-1", DEFAULT_CONFIG);
  const f = (t: number) => c.value(t);
  const coarse = maxSecondDiff(f, 0, 60, 0.01);
  const fine = maxSecondDiff(f, 0, 60, 0.001);
  const ratio = coarse / fine;
  assert.ok(ratio > 40, `expected quadratic shrink (~100x), got ${ratio.toFixed(1)}x`);
});

test("VALIDATION: a pointed triangle wave fails the same smoothness test (~10x)", () => {
  // triangle wave, period 4s, amplitude 1 — has slope discontinuities (pointed peaks)
  const tri = (t: number) => { const p = ((t % 4) + 4) % 4; return p < 2 ? p - 1 : 3 - p; };
  const coarse = maxSecondDiff(tri, 0, 60, 0.01);
  const fine = maxSecondDiff(tri, 0, 60, 0.001);
  const ratio = coarse / fine;
  assert.ok(ratio < 20, `pointed wave should only shrink ~linearly, got ${ratio.toFixed(1)}x`);
});

test("curve has green dominance: spends more time above baseline", () => {
  const c = new CurveGenerator("day-seed-1", DEFAULT_CONFIG);
  let above = 0, total = 0;
  for (let t = 0; t < 1200; t += 0.05) { total++; if (c.value(t) > 0) above++; }
  assert.ok(above / total >= 0.5, `expected >=50% time green, got ${(100 * above / total).toFixed(1)}%`);
});

// ── `wave` profile (line brands): irregular but still deterministic, bounded and C2-smooth ──
test("wave profile: deterministic, bounded, and C2-smooth (no cusps)", () => {
  const a = new CurveGenerator("day-seed-1", DEFAULT_CONFIG, "wave");
  const b = new CurveGenerator("day-seed-1", DEFAULT_CONFIG, "wave");
  for (let t = 0; t < 50; t += 1.3) assert.equal(a.value(t), b.value(t));
  for (let t = 0; t < 600; t += 0.05) { const v = a.value(t); assert.ok(v > -1 && v < 1, `out of bounds at t=${t}: ${v}`); }
  const coarse = maxSecondDiff((t) => a.value(t), 0, 60, 0.01);
  const fine = maxSecondDiff((t) => a.value(t), 0, 60, 0.001);
  assert.ok(coarse / fine > 40, `wave must be C2-smooth; got ${(coarse / fine).toFixed(1)}x`);
});

// ── the `wave` profile crosses the centre both ways (roughly even) — the suspenseful rise/fall look ──
test("wave profile crosses the centre line both ways (not one-sided)", () => {
  const c = new CurveGenerator("day-seed-1", DEFAULT_CONFIG, "wave");
  let above = 0, total = 0;
  for (let t = 0; t < 1200; t += 0.05) { total++; if (c.value(t) > 0) above++; }
  const frac = above / total;
  assert.ok(frac > 0.3 && frac < 0.7, `expected a roughly even split around centre, got ${(100 * frac).toFixed(1)}% above`);
});

// ── fairness holds on the `wave` curve: the settlement engine re-calibrates win-rate + RTP to it ──
test("wave profile: realized win-rate == target and RTP == 1-edge (calibration adapts)", () => {
  const cfg = { ...DEFAULT_CONFIG, houseEdge: 0.2, targetWinRate: 0.5 };
  const seed = "wave-fairness-seed";
  const eng = new SettlementEngine(new CurveGenerator(seed, cfg, "wave"), cfg, "calibration", cfg.defaultDurationS, 3600, 30_000);
  const rnd = new SeededRng(seed, "eval");
  let win = 0, payout = 0, stake = 0; const N = 30_000;
  for (let i = 0; i < N; i++) {
    const o = eng.settleVariable(25000, i % 2 ? "buy" : "sell", rnd.range(0, 86_400), i, seed);
    if (o.result === "win") { win++; payout += o.payoutCents; }
    stake += 25000;
  }
  assert.ok(Math.abs(win / N - cfg.targetWinRate) <= 0.035, `win-rate ${(win / N).toFixed(3)} vs ${cfg.targetWinRate}`);
  assert.ok(Math.abs(payout / stake - rtp(cfg)) <= 0.06, `RTP ${(payout / stake).toFixed(3)} vs ${rtp(cfg).toFixed(3)}`);
});
