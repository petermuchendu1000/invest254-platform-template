import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator } from "./curve.js";
import { SettlementEngine } from "./settle.js";
import { SeededRng } from "./prng.js";
import { DEFAULT_CONFIG, rtp } from "./config.js";
import { CALIBRATION_WINDOW_S } from "./settle.js";

/**
 * Entry times are drawn from a FULL day, matching both the calibrator and production (players trade
 * around the clock). A 1-hour window is not a smaller version of the same measurement on the
 * `market` process: a random walk's 10 s increments are independent, so an hour holds only ~360 of
 * them and the realized RTP has a standard error of ~0.035 — wider than any tolerance worth
 * asserting. Over a day it is ~0.0025. See CALIBRATION_WINDOW_S.
 */
function measureRtp(eng: SettlementEngine, dir: "buy" | "sell" | "both", seed: string, n: number, windowS = CALIBRATION_WINDOW_S) {
  const rng = new SeededRng(seed, "measure");
  let stakeSum = 0, payoutSum = 0, wins = 0;
  const stake = 20000; // KES 200
  for (let i = 0; i < n; i++) {
    const d: "buy" | "sell" = dir === "both" ? (rng.next() < 0.5 ? "buy" : "sell") : dir;
    const o = eng.settle(stake, d, rng.range(0, windowS));
    stakeSum += stake; payoutSum += o.payoutCents; if (o.result === "win") wins++;
  }
  return { rtp: payoutSum / stakeSum, winRate: wins / n };
}

test("settleVariable: live config pays a full-range RANDOM multiplier with exact RTP", () => {
  // Live config: house edge 0.85 (RTP 0.15), win rate 0.05, cap ×30, 5s rounds ⇒ meanWinMult 3.0.
  const cfg = { ...DEFAULT_CONFIG, houseEdge: 0.85, targetWinRate: 0.05, maxMultiplier: 30, driftBias: 0, defaultDurationS: 5 };
  const seed = "settle-variable-live";
  const curve = new CurveGenerator(seed, cfg);
  const eng = new SettlementEngine(curve, cfg, "calibration", cfg.defaultDurationS, 3600, 30_000);
  const meanWinTarget = rtp(cfg) / cfg.targetWinRate; // 3.0

  const rng = new SeededRng(seed, "measure");
  const stake = 20000;
  let stakeSum = 0, payoutSum = 0, wins = 0, winMultSum = 0, maxMult = 0;
  const distinctWinMults = new Set<number>();
  const N = 60_000;
  for (let i = 0; i < N; i++) {
    const d: "buy" | "sell" = rng.next() < 0.5 ? "buy" : "sell";
    const o = eng.settleVariable(stake, d, rng.range(0, 3600), i, seed);
    stakeSum += stake; payoutSum += o.payoutCents;
    if (o.result === "win") {
      wins++; winMultSum += o.multiplier; maxMult = Math.max(maxMult, o.multiplier);
      distinctWinMults.add(Math.round(o.multiplier * 100));
    }
  }
  const realizedRtp = payoutSum / stakeSum;
  const meanWin = winMultSum / wins;

  // RTP lands on target (winRate × meanWinMult), within Monte-Carlo noise.
  assert.ok(Math.abs(realizedRtp - rtp(cfg)) < 0.02, `realized RTP ${realizedRtp.toFixed(3)} vs ${rtp(cfg)}`);
  // Winning multiplier mean is the calibrated value (RTP-exact).
  assert.ok(Math.abs(meanWin - meanWinTarget) / meanWinTarget < 0.06, `mean win ×${meanWin.toFixed(2)} vs ×${meanWinTarget}`);
  // Payouts are genuinely RANDOM (not a few hardcoded values) and span the configured range.
  assert.ok(distinctWinMults.size > 200, `expected many distinct win sizes, got ${distinctWinMults.size}`);
  assert.ok(maxMult > 10, `expected the tail to reach large multipliers, got ×${maxMult.toFixed(2)}`);
  assert.ok(maxMult <= cfg.maxMultiplier + 1e-9, `never exceeds the cap, got ×${maxMult}`);
});

test("settleVariable: bigger stake ⇒ proportionally bigger payout at the same multiplier (stake scales linearly)", () => {
  const cfg = { ...DEFAULT_CONFIG, houseEdge: 0.85, targetWinRate: 0.05, maxMultiplier: 30, driftBias: 0, defaultDurationS: 5 };
  const seed = "settle-variable-stake";
  const curve = new CurveGenerator(seed, cfg);
  const eng = new SettlementEngine(curve, cfg, "calibration", cfg.defaultDurationS, 3600, 30_000);
  // Find a winning entry, then confirm payout scales with stake at an identical multiplier draw.
  let t = -1;
  for (let s = 0; s < 3600 && t < 0; s += 0.05) if (eng.settleVariable(25000, "buy", s, 1, seed).result === "win") t = s;
  assert.ok(t >= 0, "found a winning entry");
  const a = eng.settleVariable(25000, "buy", t, 1, seed);
  const b = eng.settleVariable(100000, "buy", t, 1, seed); // 4× stake, same nonce ⇒ same multiplier
  assert.equal(a.multiplier, b.multiplier, "same draw ⇒ same multiplier");
  assert.ok(Math.abs(b.payoutCents - 4 * a.payoutCents) <= 4, "payout scales linearly with stake");
});

test("REGRESSION: settleVariable wins are not all x1.00 when tau <= 0 (targetWinRate > 0.5)", () => {
  // Repro of the "WIN x1.00 / +KES 0.00" bug: for any targetWinRate above ~0.5 on a
  // near-symmetric curve (driftBias 0) the win threshold tau is NEGATIVE, which used to
  // force the shaped mean multiplier to 1.0 -> every win paid back exactly the stake and
  // RTP silently degraded to the win-rate. This is the live config (edge 0.1, winRate 0.7).
  const cfg = { ...DEFAULT_CONFIG, houseEdge: 0.1, targetWinRate: 0.7, driftBias: 0, defaultDurationS: 5 };
  const seed = "regression-seed-x100";
  const curve = new CurveGenerator(seed, cfg);
  const eng = new SettlementEngine(curve, cfg, "calibration", cfg.defaultDurationS, 3600, 30_000);

  // tau must be negative here — that's the trigger for the old bug.
  assert.ok(eng.params.buy.tau <= 0, `expected tau <= 0, got ${eng.params.buy.tau}`);

  const N = 8000, stake = 20000;
  let wins = 0, payout = 0, sumMult = 0, atOne = 0;
  for (let i = 0; i < N; i++) {
    const dir = i % 2 ? "sell" : "buy";
    const o = eng.settleVariable(stake, dir, (i * 1.37) % 3600, i, seed);
    payout += o.payoutCents;
    if (o.result === "win") { wins++; sumMult += o.multiplier; if (o.multiplier < 1.001) atOne++; }
  }
  const meanWinMult = sumMult / wins;
  const aggRtp = payout / (N * stake);

  // The bug produced 100% of wins at exactly x1.00 and RTP == winRate (~0.70).
  assert.ok(atOne / wins < 0.05, `too many break-even wins: ${(atOne / wins * 100).toFixed(1)}%`);
  assert.ok(meanWinMult > 1.1, `mean winning multiplier collapsed: ${meanWinMult.toFixed(3)}`);
  assert.ok(aggRtp > rtp(cfg) - 0.06, `RTP degraded well below target: ${aggRtp.toFixed(3)} vs ${rtp(cfg)}`);
});

test("PROOF: aggregate RTP ~= 25% on held-out samples", () => {
  const curve = new CurveGenerator("rtp-day-1", DEFAULT_CONFIG);
  const eng = new SettlementEngine(curve, DEFAULT_CONFIG);
  const { rtp: r, winRate } = measureRtp(eng, "both", "holdout-A", 300_000);
  assert.ok(Math.abs(r - rtp(DEFAULT_CONFIG)) < 0.015, `RTP ${r.toFixed(4)} not ~0.25`);
  assert.ok(Math.abs(winRate - DEFAULT_CONFIG.targetWinRate) < 0.02, `winRate ${winRate.toFixed(4)} off`);
});

test("PROOF: per-direction RTP ~= 25% (no directional bias)", () => {
  const curve = new CurveGenerator("rtp-day-1", DEFAULT_CONFIG);
  const eng = new SettlementEngine(curve, DEFAULT_CONFIG);
  const buy = measureRtp(eng, "buy", "holdout-buy", 200_000);
  const sell = measureRtp(eng, "sell", "holdout-sell", 200_000);
  assert.ok(Math.abs(buy.rtp - 0.25) < 0.02, `buy RTP ${buy.rtp.toFixed(4)}`);
  assert.ok(Math.abs(sell.rtp - 0.25) < 0.02, `sell RTP ${sell.rtp.toFixed(4)}`);
});

test("PROOF: calibration generalises across multiple daily seeds", () => {
  for (const seed of ["day-A", "day-B", "day-C"]) {
    const curve = new CurveGenerator(seed, DEFAULT_CONFIG);
    const eng = new SettlementEngine(curve, DEFAULT_CONFIG);
    const { rtp: r } = measureRtp(eng, "both", `holdout-${seed}`, 150_000);
    assert.ok(Math.abs(r - 0.25) < 0.02, `seed ${seed}: RTP ${r.toFixed(4)} not ~0.25`);
  }
});

test("multiplier never exceeds the cap; losses lose exactly the stake", () => {
  const curve = new CurveGenerator("rtp-day-1", DEFAULT_CONFIG);
  const eng = new SettlementEngine(curve, DEFAULT_CONFIG);
  const rng = new SeededRng("edge", "x");
  for (let i = 0; i < 50_000; i++) {
    const o = eng.settle(20000, rng.next() < 0.5 ? "buy" : "sell", rng.range(0, 3600));
    if (o.result === "win") { assert.ok(o.multiplier > 1 && o.multiplier <= DEFAULT_CONFIG.maxMultiplier); assert.ok(o.payoutCents > 20000); }
    else { assert.equal(o.payoutCents, 0); assert.equal(o.pnlCents, -20000); }
  }
});

test("manual SELL is non-gameable: live multiplier is monotone and <= final", () => {
  const curve = new CurveGenerator("rtp-day-1", DEFAULT_CONFIG);
  const eng = new SettlementEngine(curve, DEFAULT_CONFIG);
  const final = 3.2; let prev = -Infinity;
  for (let g = 0; g <= 1.0001; g += 0.05) {
    const m = eng.liveWinMultiplier(final, g);
    assert.ok(m >= prev - 1e-9, `not monotone at g=${g}`);
    assert.ok(m <= final + 1e-9, `exceeds final at g=${g}`);
    prev = m;
  }
  assert.ok(Math.abs(eng.liveWinMultiplier(final, 1) - final) < 1e-9);
  assert.ok(Math.abs(eng.liveWinMultiplier(final, 0) - 1) < 1e-9);
});
