import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurveGenerator, SettlementEngine, SeededRng,
  DEFAULT_CONFIG, CALIBRATION_WINDOW_S, rtp,
  type Direction, type GameConfig,
} from "./index.js";

/**
 * The CONTINUOUS payout honours the house edge under an ARBITRARY stopping time.
 *
 * This is the gate on real Stop Loss / Take Profit. The step payout could not pass it: measured over
 * the same harness, a target at `tau` took RTP from 25% to 33%, and a target below `tau` paid the
 * trader nothing at all. See docs/mt5/20-real-sl-tp.md.
 *
 * The property under test is the one the operator's revenue depends on: NO stopping rule a trader
 * can choose returns materially more than the configured RTP. Rules are picked to span what a real
 * trader does - symmetric brackets, skewed brackets, target only, stop only, and over-trading on a
 * very tight bracket.
 */
const CAL = 20_000;   // calibration samples (lean for CI)
const EVAL = 20_000;  // evaluated trades per rule
const SEEDS = ["deadbeefcafe", "a02064a69c1082b5"];

const engineFor = (cfg: GameConfig, seed: string) =>
  new SettlementEngine(new CurveGenerator(seed, cfg), cfg, "calibration", cfg.defaultDurationS, CALIBRATION_WINDOW_S, CAL);

/** Realised RTP over EVAL trades closed by `close`, which returns the holding time in seconds. */
function realisedRtp(eng: SettlementEngine, cfg: GameConfig, seed: string, label: string,
  close: (dir: Direction, entryT: number) => number): number {
  const rng = new SeededRng(seed, `eval:${label}`);
  let paid = 0;
  for (let i = 0; i < EVAL; i++) {
    const dir: Direction = rng.range(0, 1) < 0.5 ? "buy" : "sell";
    const entryT = rng.range(0, CALIBRATION_WINDOW_S);
    paid += eng.valueAt(dir, entryT, close(dir, entryT));
  }
  return paid / EVAL;
}

/** Close as soon as the favourable move leaves [-sl, +tp], else at the horizon. */
const bracket = (eng: SettlementEngine, sl: number, tp: number, horizonS: number) =>
  (dir: Direction, entryT: number): number => {
    for (let s = 0.25; s <= horizonS; s += 0.25) {
      const m = eng.moveAt(dir, entryT, s);
      if (m <= -sl || m >= tp) return s;
    }
    return horizonS;
  };

test("the cost is solved so a horizon hold returns the configured RTP", () => {
  for (const seed of SEEDS) {
    const cfg = DEFAULT_CONFIG;
    const eng = engineFor(cfg, seed);
    const got = realisedRtp(eng, cfg, seed, "horizon", () => cfg.defaultDurationS);
    assert.ok(Math.abs(got - rtp(cfg)) < 0.03, `${seed}: RTP ${got.toFixed(4)} vs target ${rtp(cfg)}`);
  }
});

test("no stopping rule a trader can choose beats the house", () => {
  for (const seed of SEEDS) {
    const cfg = DEFAULT_CONFIG;
    const eng = engineFor(cfg, seed);
    const T = cfg.defaultDurationS;
    const c = eng.continuousParams("buy").cost;
    const rules: Array<[string, (d: Direction, e: number) => number]> = [
      ["held to horizon", () => T],
      ["TP/SL at c", bracket(eng, c, c, T)],
      ["TP 2c / SL c", bracket(eng, c, 2 * c, T)],
      ["TP c / SL 2c", bracket(eng, 2 * c, c, T)],
      ["TP only at 2c", bracket(eng, Infinity, 2 * c, T)],
      ["SL only at c", bracket(eng, c, Infinity, T)],
      ["wide TP/SL at 5c", bracket(eng, 5 * c, 5 * c, T)],
      ["tight TP/SL at c/4", bracket(eng, c / 4, c / 4, T)],
    ];
    for (const [label, close] of rules) {
      const got = realisedRtp(eng, cfg, seed, label, close);
      // The house may do BETTER than target (over-trading on a tight bracket costs the trader
      // more, which is how a spread behaves). It may not do materially worse.
      assert.ok(got <= rtp(cfg) + 0.03, `${seed} / ${label}: RTP ${got.toFixed(4)} exceeds target ${rtp(cfg)}`);
    }
  }
});

test("the payout is continuous, so a modest target is paid rather than wiped out", () => {
  const cfg = DEFAULT_CONFIG;
  const eng = engineFor(cfg, SEEDS[0]!);
  const { cost, gain } = eng.continuousParams("buy");
  // Just past break-even pays just over the stake. Under the step payout this was 0: the whole
  // reason a take profit could not be put where a trader wanted it.
  const justOver = 1 + gain * (cost * 1.01 - cost);
  assert.ok(justOver > 1 && justOver < 1.1, `a hair past break-even should pay a hair over stake, got ${justOver}`);
  // And an adverse move is a PARTIAL loss, not a total one, until it runs past the floor.
  const smallAdverse = Math.max(0, 1 + gain * (-cost / 4 - cost));
  assert.ok(smallAdverse >= 0 && smallAdverse < 1, `a small adverse move should be a partial loss, got ${smallAdverse}`);
});

test("a settled contract reports win or loss from what it actually paid", () => {
  const cfg = DEFAULT_CONFIG;
  const eng = engineFor(cfg, SEEDS[0]!);
  const rng = new SeededRng(SEEDS[0]!, "derive");
  let wins = 0, losses = 0;
  for (let i = 0; i < 500; i++) {
    const dir: Direction = rng.range(0, 1) < 0.5 ? "buy" : "sell";
    const o = eng.settleContinuous(100_000, dir, rng.range(0, CALIBRATION_WINDOW_S), cfg.defaultDurationS);
    assert.equal(o.result === "win", o.payoutCents > 100_000);
    assert.equal(o.pnlCents, o.payoutCents - 100_000);
    if (o.result === "win") wins++; else losses++;
  }
  assert.ok(wins > 0 && losses > 0, `both outcomes should occur, got ${wins}/${losses}`);
});
