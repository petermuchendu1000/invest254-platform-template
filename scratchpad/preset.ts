/**
 * Choosing the terminal (spread) preset by measurement.
 *
 * At a fixed house edge the win rate is still free, and it decides the SHAPE: value at open, how
 * much of a position's life is worth nothing, and how often it is ever in profit. This sweeps the
 * band for the chosen edge so the shipped pair is the measured best rather than the first one tried.
 */
import { CurveGenerator } from "/home/user/invest254/packages/shared/src/curve.js";
import { SettlementEngine, CALIBRATION_WINDOW_S } from "/home/user/invest254/packages/shared/src/settle.js";
import { SeededRng } from "/home/user/invest254/packages/shared/src/prng.js";
import { DEFAULT_CONFIG, rtp, checkFeasible, type GameConfig } from "/home/user/invest254/packages/shared/src/config.js";

const H = 900, SEEDS = 6, PER = 400, STEP = 10;

function measure(cfg: GameConfig) {
  let zero = 0, total = 0, everWin = 0, n = 0, paid = 0, atOpen = 0, winAtHorizon = 0;
  for (let s = 0; s < SEEDS; s++) {
    const eng = new SettlementEngine(new CurveGenerator(`preset-${s}`, cfg, "market"), cfg, "calibration", H, CALIBRATION_WINDOW_S, 60_000);
    atOpen += eng.valueAt("buy", 1000, 0);
    const rng = new SeededRng(`preset-${s}`, "m");
    for (let i = 0; i < PER; i++) {
      const t = rng.range(0, CALIBRATION_WINDOW_S);
      const dir = i % 2 ? "buy" : "sell";
      let win = false;
      for (let e = 0; e <= H; e += STEP) { const v = eng.valueAt(dir, t, e); total++; if (v <= 0) zero++; if (v > 1) win = true; }
      const final = eng.valueAt(dir, t, H);
      if (win) everWin++; if (final > 1) winAtHorizon++;
      paid += final; n++;
    }
  }
  return {
    open: atOpen / SEEDS, zeroPct: zero / total * 100, everWinPct: everWin / n * 100,
    rtp: paid / n, winAtHorizonPct: winAtHorizon / n * 100,
  };
}

console.log("edge  wr    feasible | value@open | %life at 0 | %ever in profit | %in profit at horizon | realised RTP (target)");
for (const [edge, wrs] of [[0.10, [0.20, 0.30, 0.40, 0.50, 0.60, 0.70]], [0.05, [0.30, 0.50, 0.65]], [0.20, [0.30, 0.45, 0.60]]] as const) {
  for (const wr of wrs) {
    const cfg: GameConfig = { ...DEFAULT_CONFIG, houseEdge: edge, targetWinRate: wr };
    const f = checkFeasible(cfg);
    if (!f.ok) { console.log(`${edge.toFixed(2)}  ${wr.toFixed(2)}  NO (${f.reason})`); continue; }
    const m = measure(cfg);
    console.log(`${edge.toFixed(2)}  ${wr.toFixed(2)}  yes      | ${m.open.toFixed(4)}x    | ${m.zeroPct.toFixed(1).padStart(6)}%    | ${m.everWinPct.toFixed(1).padStart(8)}%       | ${m.winAtHorizonPct.toFixed(1).padStart(10)}%          | ${(m.rtp*100).toFixed(2)}% (${(rtp(cfg)*100).toFixed(0)}%)`);
  }
}
