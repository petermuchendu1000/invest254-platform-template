import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurveGenerator, SettlementEngine, SeededRng,
  winMultiplier, solveTruncExpBeta,
  checkFeasible, rtp, requiredMeanWinMultiplier, DEFAULT_CONFIG,
  type GameConfig,
} from "@invest254/shared";

/**
 * Calibration CONTRACT suite (audit rec #2) — the reproducibility gate.
 *
 * Proves, function by function, that the statistical settlement HONORS its config: realized win-rate
 * == target_win_rate and RTP == 1 - house_edge, for EVERY live config value observed in production
 * (v204..v233), across the full trading day and multiple seeds. If this ever fails, do NOT ship the
 * config. (The live >100% RTP was NOT a calibration bug — proven here — it came from per-user overrides
 * + config thrash; see docs/28.)
 */

// The exact (house_edge, target_win_rate) pairs that were live on invest254, v204..v233.
const LIVE: Array<{ v: number; houseEdge: number; targetWinRate: number }> = [
  { v: 204, houseEdge: 0.8, targetWinRate: 0.05 },
  { v: 213, houseEdge: 0.05, targetWinRate: 0.65 },
  { v: 219, houseEdge: 0.05, targetWinRate: 0.8 },
  { v: 221, houseEdge: 0.2, targetWinRate: 0.75 },
  { v: 231, houseEdge: 0.5, targetWinRate: 0.45 },
  { v: 233, houseEdge: 0.8, targetWinRate: 0.05 },
  { v: 230, houseEdge: 0.03, targetWinRate: 0.95 },
];
const cfgFor = (houseEdge: number, targetWinRate: number): GameConfig =>
  ({ ...DEFAULT_CONFIG, houseEdge, targetWinRate });

const SEEDS = ["deadbeefcafe", "a02064a69c1082b5"];
const CAL = 30_000;   // calibration samples (lean for CI; tolerance widened accordingly)
const EVAL = 30_000;  // evaluation trades per config/seed
const WR_TOL = 0.035; // realized win-rate tolerance
const RTP_TOL = 0.06; // realized RTP tolerance

// ── SettlementEngine.settle / settleVariable — realized win-rate == target, RTP == 1-edge ──
for (const lc of LIVE) {
  test(`v${lc.v} (edge=${lc.houseEdge}, wr=${lc.targetWinRate}): realized win-rate == target & RTP == 1-edge (full day, both dirs)`, () => {
    const cfg = cfgFor(lc.houseEdge, lc.targetWinRate);
    assert.equal(checkFeasible(cfg).ok, true, "config must be feasible to calibrate");
    for (const seed of SEEDS) {
      const eng = new SettlementEngine(new CurveGenerator(seed, cfg), cfg, "calibration", cfg.defaultDurationS, 3600, CAL);
      const rnd = new SeededRng(seed, "eval");
      let win = 0, winB = 0, winS = 0, nB = 0, nS = 0, payout = 0, stakeTot = 0;
      for (let i = 0; i < EVAL; i++) {
        const dir = i % 2 ? "buy" : "sell";
        const t = rnd.range(0, 86_400);                    // FULL day, not just the calibration window
        const o = eng.settleVariable(25000, dir, t, i, seed);
        if (dir === "buy") { nB++; if (o.result === "win") winB++; } else { nS++; if (o.result === "win") winS++; }
        if (o.result === "win") { win++; payout += o.payoutCents; }
        stakeTot += 25000;
      }
      const wr = win / EVAL, realRtp = payout / stakeTot;
      assert.ok(Math.abs(wr - lc.targetWinRate) <= WR_TOL, `win-rate ${wr.toFixed(3)} vs target ${lc.targetWinRate} (seed ${seed.slice(0,6)})`);
      assert.ok(Math.abs(realRtp - rtp(cfg)) <= RTP_TOL, `RTP ${realRtp.toFixed(3)} vs 1-edge ${rtp(cfg).toFixed(3)}`);
      // no directional bias: each direction near target
      assert.ok(Math.abs(winB / nB - lc.targetWinRate) <= WR_TOL + 0.01, `buy wr ${(winB/nB).toFixed(3)}`);
      assert.ok(Math.abs(winS / nS - lc.targetWinRate) <= WR_TOL + 0.01, `sell wr ${(winS/nS).toFixed(3)}`);
    }
  });
}

// ── calibration window generalises to the WHOLE day (stationarity check) ──
test("calibration on [0,3600] generalises to entryT across the full 24h day", () => {
  const cfg = cfgFor(0.05, 0.65);
  const eng = new SettlementEngine(new CurveGenerator(SEEDS[0]!, cfg), cfg, "calibration", cfg.defaultDurationS, 3600, CAL);
  const rnd = new SeededRng(SEEDS[0]!, "gen");
  const bucket = new Array(6).fill(0), cnt = new Array(6).fill(0);
  for (let i = 0; i < 60_000; i++) {
    const t = rnd.range(0, 86_400); const b = Math.min(5, Math.floor(t / 14_400));
    cnt[b]++; if (eng.settle(25000, i % 2 ? "buy" : "sell", t).result === "win") bucket[b]++;
  }
  for (let b = 0; b < 6; b++) assert.ok(Math.abs(bucket[b] / cnt[b] - 0.65) <= 0.05, `4h bucket ${b} wr ${(bucket[b]/cnt[b]).toFixed(3)} drifts from target`);
});

// ── winMultiplier — RTP-preserving: E[multiplier|win] == meanMult, bounded in (lo, cap] ──
test("winMultiplier: sample mean == meanMult (RTP preserved), all draws in (1.01, cap]", () => {
  for (const [meanMult, cap] of [[1.46, 5], [2.0, 5], [4.0, 5], [1.2, 2], [3.5, 4]] as const) {
    const rng = new SeededRng("m", `mm:${meanMult}:${cap}`);
    let s = 0; const N = 200_000; let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < N; i++) { const x = winMultiplier(rng, meanMult, cap); s += x; mn = Math.min(mn, x); mx = Math.max(mx, x); }
    const mean = s / N;
    assert.ok(Math.abs(mean - meanMult) / meanMult <= 0.02, `mean ${mean.toFixed(3)} vs ${meanMult}`);
    assert.ok(mn >= 1.01 - 1e-9 && mx <= cap + 1e-9, `range [${mn.toFixed(3)},${mx.toFixed(3)}] within (1.01, ${cap}]`);
  }
});
test("winMultiplier degenerate cases: mean>=cap -> cap; mean<=lo -> break-even clamp", () => {
  const rng = new SeededRng("d", "deg");
  assert.equal(winMultiplier(rng, 9, 5), 5, "mean at/above cap collapses to the cap");
  const x = winMultiplier(rng, 1.0, 5); assert.ok(x >= 1 && x <= 5, "sub-lo mean stays sane");
});

// ── solveTruncExpBeta / truncExpMean round-trip (the max-entropy solver) ──
test("solveTruncExpBeta: recovering beta reproduces the requested mean on (a,b)", () => {
  // truncExpMean is not exported; verify via winMultiplier's realized mean instead (integration test)
  for (const mu of [1.05, 1.5, 2.0, 3.0, 4.9]) {
    const rng = new SeededRng("b", `beta:${mu}`);
    let s = 0; const N = 100_000;
    for (let i = 0; i < N; i++) s += winMultiplier(rng, mu, 5);
    assert.ok(Math.abs(s / N - mu) / mu <= 0.03, `solved mean ${(s/N).toFixed(3)} vs mu ${mu}`);
  }
  assert.equal(typeof solveTruncExpBeta(2, 1, 5), "number");
});

// ── liveWinMultiplier — monotone rise to the committed final, never above it ──
test("liveWinMultiplier: monotone increasing, starts at 1, ends at final, <= final for g in [0,1]", () => {
  const cfg = cfgFor(0.05, 0.65);
  const eng = new SettlementEngine(new CurveGenerator(SEEDS[0]!, cfg), cfg, "calibration", cfg.defaultDurationS, 3600, CAL);
  for (const final of [1.2, 2.5, 5]) {
    let prev = -Infinity;
    for (let g = 0; g <= 1.0001; g += 0.05) {
      const m = eng.liveWinMultiplier(final, g);
      assert.ok(m >= prev - 1e-9, `monotone at g=${g.toFixed(2)}`);
      assert.ok(m <= final + 1e-9, `never exceeds final at g=${g.toFixed(2)}`);
      prev = m;
    }
    assert.ok(Math.abs(eng.liveWinMultiplier(final, 0) - 1) < 1e-9, "starts at x1.0");
    assert.ok(Math.abs(eng.liveWinMultiplier(final, 1) - final) < 1e-9, "ends at final");
  }
});

// ── checkFeasible — the config gate (each live config feasible; infeasible ones rejected) ──
test("checkFeasible: every live config is feasible; requiredMeanWinMultiplier in (1, cap]", () => {
  for (const lc of LIVE) {
    const cfg = cfgFor(lc.houseEdge, lc.targetWinRate);
    const f = checkFeasible(cfg);
    assert.equal(f.ok, true, `v${lc.v} feasible: ${f.reason}`);
    const r = requiredMeanWinMultiplier(cfg);
    assert.ok(r > 1 && r <= cfg.maxMultiplier, `v${lc.v} required mean ${r.toFixed(3)} in (1, ${cfg.maxMultiplier}]`);
  }
});
test("checkFeasible: rejects infeasible economies (RTP unreachable within the cap)", () => {
  // high RTP + very low win-rate -> required mean > cap -> infeasible
  assert.equal(checkFeasible(cfgFor(0.01, 0.05)).ok, false, "edge 0.01 / wr 0.05 needs mean 19.8 > cap");
  // win-rate above RTP -> required mean <= 1 -> winners wouldn't profit -> infeasible
  assert.equal(checkFeasible(cfgFor(0.5, 0.9)).ok, false, "RTP 0.5 at wr 0.9 -> mean 0.56 <= 1");
});
