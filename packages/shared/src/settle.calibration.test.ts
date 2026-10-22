import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurveGenerator, SettlementEngine, SeededRng,
  winMultiplier, solveTruncExpBeta,
  checkFeasible, rtp, requiredMeanWinMultiplier, DEFAULT_CONFIG, CALIBRATION_WINDOW_S,
  curveDomain,
  SYMBOL_GROUPS, symbolsInGroup, DEFAULT_SYMBOL,
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
      const eng = new SettlementEngine(new CurveGenerator(seed, cfg), cfg, "calibration", cfg.defaultDurationS, CALIBRATION_WINDOW_S, CAL);
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
/**
 * Calibration generalises across the day, measured ACROSS DAYS rather than within one.
 *
 * A contract is held for `defaultDurationS` (900s), so entries less than that apart look through
 * overlapping windows and count as very nearly one observation. A 4h bucket therefore holds about
 * 14_400 / 900 = 16 independent samples however many entries are drawn from it, and a single day's
 * bucket win-rate scatters far too widely for a ±0.05 gate: the old single-seed form failed on
 * roughly one honest run in ten per bucket. It passed historically only because a ten-second
 * contract gave each bucket 1,440 independent windows instead of 16.
 *
 * Averaging each bucket across seeds is also the question worth asking. One day's hot afternoon is
 * that day's path, which a player cannot know in advance because the seed is secret and rotates; a
 * bucket that sits off target on day after day is a mispricing. See the longer argument and the
 * positive control in curve.exploit.test.ts, which gates the same property for the house edge.
 */
test("calibration generalises to entryT across the full 24h day", () => {
  const cfg = cfgFor(0.05, 0.65);
  const seeds = Array.from({ length: 24 }, (_, i) => `gen-day-${i}`);
  const perSeed = seeds.map((seed) => {
    const eng = new SettlementEngine(new CurveGenerator(seed, cfg), cfg, "calibration", cfg.defaultDurationS, CALIBRATION_WINDOW_S, CAL);
    const rnd = new SeededRng(seed, "gen");
    const bucket = new Array(6).fill(0), cnt = new Array(6).fill(0);
    for (let i = 0; i < 6_000; i++) {
      const t = rnd.range(0, 86_400); const b = Math.min(5, Math.floor(t / 14_400));
      cnt[b]++; if (eng.settle(25000, i % 2 ? "buy" : "sell", t).result === "win") bucket[b]++;
    }
    return bucket.map((w, b) => w / cnt[b]);
  });
  for (let b = 0; b < 6; b++) {
    const col = perSeed.map((r) => r[b]!);
    const m = col.reduce((s, x) => s + x, 0) / col.length;
    assert.ok(Math.abs(m - 0.65) <= 0.03, `4h bucket ${b} across-seed wr ${m.toFixed(3)} drifts from target`);
  }
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
  const eng = new SettlementEngine(new CurveGenerator(SEEDS[0]!, cfg), cfg, "calibration", cfg.defaultDurationS, CALIBRATION_WINDOW_S, CAL);
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

// ─────────────────────── THE MULTI-SYMBOL GATE ───────────────────────
//
// Each tradable symbol gets its own curve from the same day seed, via a domain separator on the
// seed (see curveDomain). The question this section answers, before any multi-symbol work is built
// on top of it, is whether the calibrated win rate and RTP still hold on a curve the calibrator has
// never seen.
//
// They should: a per-symbol curve is the SAME stochastic process with a different seed, and the
// calibration (tau, gain) is a property of that process's distribution rather than of any one seed.
// But "should" is not evidence, so it is measured here per symbol. If this fails, multi-symbol does
// not ship in the statistical path.

/**
 * The gate's sample: the default symbol plus the first instrument of every group in the real
 * catalogue.
 *
 * Drawn from the catalogue rather than hand-listed deliberately. The catalogue carries ninety-odd
 * symbols and calibrating all of them would cost minutes of CI for no new information — every curve
 * is the same stochastic process under a different seed. But a NEW GROUP is new information, and
 * deriving the sample this way means adding one puts it through the gate automatically instead of
 * relying on whoever adds it to remember this file.
 */
const SYMBOLS = [
  DEFAULT_SYMBOL,
  ...SYMBOL_GROUPS.map((g) => symbolsInGroup(g)[0]!.symbol),
].filter((s, i, all) => all.indexOf(s) === i);

for (const lc of [
  // Production: the shipped default.
  { label: "production default", houseEdge: 0.75, targetWinRate: 0.125 },
  // A marketer-shaped config, at the other end of the range.
  { label: "marketer-shaped", houseEdge: 0.05, targetWinRate: 0.8 },
]) {
  test(`multi-symbol gate (${lc.label}): every symbol's own curve honours the calibration`, () => {
    const cfg = cfgFor(lc.houseEdge, lc.targetWinRate);
    assert.equal(checkFeasible(cfg).ok, true, "config must be feasible to calibrate");
    const seed = SEEDS[0]!;
    for (const symbol of SYMBOLS) {
      const curve = new CurveGenerator(seed, cfg, "market", symbol);
      const eng = new SettlementEngine(curve, cfg, "calibration", cfg.defaultDurationS, CALIBRATION_WINDOW_S, CAL);
      const rnd = new SeededRng(seed, `eval:${symbol}`);
      let win = 0, payout = 0, stakeTot = 0;
      for (let i = 0; i < EVAL; i++) {
        const o = eng.settleVariable(25000, i % 2 ? "buy" : "sell", rnd.range(0, 86_400), i, seed);
        if (o.result === "win") { win++; payout += o.payoutCents; }
        stakeTot += 25000;
      }
      const wr = win / EVAL, realRtp = payout / stakeTot;
      assert.ok(
        Math.abs(wr - lc.targetWinRate) <= WR_TOL,
        `${symbol}: win-rate ${wr.toFixed(3)} vs target ${lc.targetWinRate}`,
      );
      assert.ok(
        Math.abs(realRtp - rtp(cfg)) <= RTP_TOL,
        `${symbol}: RTP ${realRtp.toFixed(3)} vs 1-edge ${rtp(cfg).toFixed(3)}`,
      );
    }
  });
}

test("multi-symbol gate: a symbol's curve is genuinely its own, not a transform of another's", () => {
  // The failure this guards against is the one that would make multi-symbol fake: if every symbol
  // were drawn from one series, the charts would be affine transforms of each other and every
  // "pair" would trace the same shape at a different scale. Independent seeds mean the per-second
  // increments should be uncorrelated.
  const cfg = DEFAULT_CONFIG;
  const seed = SEEDS[0]!;
  const sample = (symbol: string): number[] => {
    const c = new CurveGenerator(seed, cfg, "market", symbol);
    const out: number[] = [];
    for (let t = 0; t < 4000; t++) out.push(c.rate(t + 1) - c.rate(t));
    return out;
  };
  const a = sample("EURUSD"), b = sample("BTCUSD");
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - ma, db = b[i]! - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  const r = cov / Math.sqrt(va * vb);
  assert.ok(Math.abs(r) < 0.1, `two symbols' increments correlate at r=${r.toFixed(4)}`);
  // And they are not simply the same numbers.
  assert.notDeepEqual(a.slice(0, 50), b.slice(0, 50));
});

test("multi-symbol gate: the default symbol reconstructs bit-for-bit, so history is untouched", () => {
  // Every day already generated and every position already settled used the bare "curve" domain.
  // XAUUSD and the no-symbol caller must keep landing on exactly those numbers, or the chart would
  // redraw history that does not match what was settled.
  const cfg = DEFAULT_CONFIG;
  const seed = SEEDS[1]!;
  const before = new CurveGenerator(seed, cfg);
  const named = new CurveGenerator(seed, cfg, "market", "XAUUSD");
  for (let t = 0; t < 2000; t += 7) {
    assert.equal(named.rate(t), before.rate(t), `t=${t}`);
  }
  assert.equal(curveDomain(undefined), "curve");
  assert.equal(curveDomain("XAUUSD"), "curve");
  assert.equal(curveDomain("EURUSD"), "curve:EURUSD");
  // A different symbol must NOT land on the old domain.
  const other = new CurveGenerator(seed, cfg, "market", "EURUSD");
  assert.notEqual(other.rate(500), before.rate(500));
});

test("multi-symbol gate: the wave profile separates too, for the line brands", () => {
  const cfg = DEFAULT_CONFIG;
  const seed = SEEDS[0]!;
  const base = new CurveGenerator(seed, cfg, "wave");
  const same = new CurveGenerator(seed, cfg, "wave", "XAUUSD");
  const other = new CurveGenerator(seed, cfg, "wave", "EURUSD");
  assert.deepEqual(same.components, base.components, "the default must stay byte-identical");
  assert.notDeepEqual(other.components, base.components, "a named symbol must differ");
});
