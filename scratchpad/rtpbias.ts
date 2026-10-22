/**
 * Is the realised RTP above target systematically, or is 2,400 samples just too few?
 *
 * The preset sweep measured the realised RTP above the configured one in all twelve rows, which is
 * not what noise looks like (p ~ 0.0002 if unbiased). A house that pays more than it configured is a
 * defect whatever its size, so this re-measures with the sample count the calibration itself uses
 * and across independent seeds, with a standard error, so "above" can be told from "above by more
 * than the measurement can resolve".
 */
import { CurveGenerator } from "/home/user/invest254/packages/shared/src/curve.js";
import { SettlementEngine, CALIBRATION_WINDOW_S } from "/home/user/invest254/packages/shared/src/settle.js";
import { SeededRng } from "/home/user/invest254/packages/shared/src/prng.js";
import { DEFAULT_CONFIG, rtp, type GameConfig } from "/home/user/invest254/packages/shared/src/config.js";

const H = 900, SEEDS = 24, PER = 50_000;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

for (const [edge, wr] of [[0.10, 0.70], [0.10, 0.40], [0.75, 0.125]] as const) {
  const cfg: GameConfig = { ...DEFAULT_CONFIG, houseEdge: edge, targetWinRate: wr };
  const per: number[] = [];
  for (let s = 0; s < SEEDS; s++) {
    const eng = new SettlementEngine(new CurveGenerator(`bias-${s}`, cfg, "market"), cfg, "calibration", H, CALIBRATION_WINDOW_S, 200_000);
    const rng = new SeededRng(`bias-${s}`, "eval");
    let paid = 0;
    for (let i = 0; i < PER; i++) paid += eng.valueAt(i % 2 ? "buy" : "sell", rng.range(0, CALIBRATION_WINDOW_S), H);
    per.push(paid / PER);
  }
  const m = mean(per), se = sd(per) / Math.sqrt(SEEDS), target = rtp(cfg);
  console.log(`edge ${edge} wr ${wr}:  realised ${(m*100).toFixed(3)}%  target ${(target*100).toFixed(1)}%  drift ${((m-target)*100>=0?'+':'')}${((m - target)*100).toFixed(3)}pp  SE ${(se*100).toFixed(3)}pp  t=${((m-target)/se).toFixed(2)}`);
}
