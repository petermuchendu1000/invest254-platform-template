import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator } from "./curve.js";
import { SettlementEngine, CALIBRATION_WINDOW_S } from "./settle.js";
import { SeededRng } from "./prng.js";
import {
  DEFAULT_CONFIG, TERMINAL_CONFIG, defaultConfigForProfile, rtp, checkFeasible,
  continuousOpenValueCeiling, continuousWinRateExpressible,
} from "./config.js";

/**
 * The TERMINAL (spread) economy, and the two measured facts that forced it.
 *
 * A candlestick brand prices a position continuously, which is what lets a stop and a target mean
 * anything. The step economy's 75% house edge cannot price one: the best a trader could ever be
 * shown on opening is the RTP, so at that edge every position starts at a near-total loss and spends
 * half its life worth exactly nothing. These tests pin the bound, the shape, and the edge, so none
 * of the three can drift without someone being told.
 */

const H = TERMINAL_CONFIG.defaultDurationS;
const CAL = 60_000;
const engineFor = (cfg: typeof TERMINAL_CONFIG, seed: string) =>
  new SettlementEngine(new CurveGenerator(seed, cfg, "market"), cfg, "calibration", H, CALIBRATION_WINDOW_S, CAL);

test("a position's value AT OPEN tracks the RTP, so a low RTP cannot open near the stake", () => {
  /**
   * The reason the step economy cannot run a terminal, and the bound is NEARLY an identity rather
   * than a hard inequality. The move distribution is centred on zero, so the value at open is the
   * value at the modal point. The floor at zero is convex, so by Jensen the mean payout is at least
   * the payout at the mean move, which puts the open value at or below the RTP; the CAP is concave
   * and pulls the other way, so a config whose cap binds often can sit a little above it. Measured
   * worst case across this range: +1.6% at a 0.5 edge.
   *
   * What matters for the product is the direction: the open value cannot be dragged far above the
   * RTP, so there is no house edge at which a terminal both keeps 75% and opens near the stake.
   */
  for (const houseEdge of [0.75, 0.5, 0.3, 0.1, 0.05]) {
    const cfg = { ...TERMINAL_CONFIG, houseEdge, targetWinRate: Math.min(0.7, rtp({ houseEdge }) * 0.78) };
    if (!checkFeasible(cfg).ok) continue;
    const open = engineFor(cfg, `ceiling-${houseEdge}`).valueAt("buy", 1000, 0);
    const ceiling = continuousOpenValueCeiling(cfg);
    assert.ok(
      open <= ceiling * 1.05 + 0.01,
      `edge ${houseEdge}: opened at ${open.toFixed(4)}x, materially above its RTP ceiling ${ceiling}`,
    );
  }
  // The claim that actually decides the config: at the step economy's edge, nothing can open near
  // the stake, whatever the win rate is set to.
  for (const targetWinRate of [0.05, 0.10, 0.125, 0.20]) {
    const cfg = { ...DEFAULT_CONFIG, targetWinRate };
    if (!checkFeasible(cfg).ok) continue;
    const open = engineFor(cfg, `step-${targetWinRate}`).valueAt("buy", 1000, 0);
    assert.ok(open < 0.30, `a 75% edge opened at ${open.toFixed(4)}x with win rate ${targetWinRate}; it must stay near its 0.25 RTP`);
  }
});

test("the step economy is NOT expressible as a continuous payout, which is why terminals need their own", () => {
  // maxMultiplier * targetWinRate < RTP is the condition; the step config fails it by a wide margin
  // (5 * 0.125 = 0.625 against an RTP of 0.25), so its win rate cannot be honoured continuously.
  assert.equal(continuousWinRateExpressible(DEFAULT_CONFIG), false);
  // And the terminal config does not pretend otherwise: it is chosen for its SHAPE, not for this.
  assert.equal(
    DEFAULT_CONFIG.maxMultiplier * DEFAULT_CONFIG.targetWinRate > rtp(DEFAULT_CONFIG), true,
    "the step economy's winners alone would pay more than its whole RTP",
  );
});

test("TERMINAL_CONFIG opens a position near the stake, instead of near zero", () => {
  const term = engineFor(TERMINAL_CONFIG, "shape-terminal").valueAt("buy", 1000, 0);
  const step = engineFor(DEFAULT_CONFIG, "shape-step").valueAt("buy", 1000, 0);
  assert.ok(term > 0.80, `a terminal position must open close to the stake, got ${term.toFixed(4)}x`);
  assert.ok(step < 0.10, `the step economy opens near zero, which is the whole reason for this config (got ${step.toFixed(4)}x)`);
});

test("and it spends almost none of its life worth nothing", () => {
  /**
   * The figure a trader actually lives with. On the step economy 50.9% of a position's life is
   * pinned at exactly zero, so the P/L is a flat line that occasionally jumps; here it tracks the
   * price.
   */
  const eng = engineFor(TERMINAL_CONFIG, "deadband");
  const rng = new SeededRng("deadband", "t");
  let zero = 0, total = 0;
  for (let i = 0; i < 400; i++) {
    const t = rng.range(0, CALIBRATION_WINDOW_S);
    const dir = i % 2 ? "buy" : "sell";
    for (let e = 0; e <= H; e += 10) { if (eng.valueAt(dir, t, e) <= 0) zero++; total++; }
  }
  const pct = zero / total * 100;
  assert.ok(pct < 10, `a terminal position should rarely be worth nothing, got ${pct.toFixed(1)}% of its life`);
});

test("THE EDGE IS INTACT: the terminal economy pays exactly what it is configured to", () => {
  /**
   * The one property that must never move. Measured across independent seeds, because a single
   * seed's realised RTP carries the sampling error of its own day and would have to be read with a
   * tolerance wide enough to hide a real drift.
   */
  const per: number[] = [];
  for (let s = 0; s < 6; s++) {
    const eng = engineFor(TERMINAL_CONFIG, `edge-${s}`);
    const rng = new SeededRng(`edge-${s}`, "eval");
    let paid = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) paid += eng.valueAt(i % 2 ? "buy" : "sell", rng.range(0, CALIBRATION_WINDOW_S), H);
    per.push(paid / N);
  }
  const mean = per.reduce((a, b) => a + b, 0) / per.length;
  const target = rtp(TERMINAL_CONFIG);
  assert.ok(Math.abs(mean - target) < 0.01, `realised RTP ${(mean * 100).toFixed(2)}% against a ${(target * 100).toFixed(0)}% target`);
});

test("a LINE brand keeps the step economy, untouched", () => {
  // The spread economy is for the curve that settles continuously. A line brand's contract is
  // committed at open and has nothing for a level to act on, so its edge is not this config's to
  // change.
  assert.deepEqual(defaultConfigForProfile("wave"), DEFAULT_CONFIG);
  assert.deepEqual(defaultConfigForProfile("market"), TERMINAL_CONFIG);
  assert.equal(DEFAULT_CONFIG.houseEdge, 0.75, "the step economy's edge is unchanged");
});

test("TERMINAL_CONFIG is feasible, and differs from the step economy ONLY in its economics", () => {
  assert.equal(checkFeasible(TERMINAL_CONFIG).ok, true);
  const { houseEdge: _h, targetWinRate: _w, ...termRest } = TERMINAL_CONFIG;
  const { houseEdge: _h2, targetWinRate: _w2, ...stepRest } = DEFAULT_CONFIG;
  assert.deepEqual(termRest, stepRest, "only the edge and the win rate may differ: the curve, horizon and limits are shared");
});
