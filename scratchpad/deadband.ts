/**
 * What does a trader actually SEE on a continuous position, second by second, over its whole life?
 *
 * The payout is clamp(1 + gain*(move - cost), 0, max). Measured over many positions: how much of a
 * position's life is spent pinned at zero, how long before it is ever worth anything, and how often
 * it is ever worth the stake back.
 */
import { CurveGenerator } from "/home/user/invest254/packages/shared/src/curve.js";
import { SettlementEngine, CALIBRATION_WINDOW_S } from "/home/user/invest254/packages/shared/src/settle.js";
import { SeededRng } from "/home/user/invest254/packages/shared/src/prng.js";
import { DEFAULT_CONFIG, rtp, type GameConfig } from "/home/user/invest254/packages/shared/src/config.js";

const H = 900;
const N = 3000;      // positions
const STEP = 5;      // seconds between readings

function study(cfg: GameConfig, label: string) {
  const curve = new CurveGenerator("deadband", cfg, "market");
  const eng = new SettlementEngine(curve, cfg, "calibration", H, CALIBRATION_WINDOW_S, 60_000);
  const rng = new SeededRng("deadband", label);
  let zeroTime = 0, totalTime = 0, everAbove0 = 0, everAbove1 = 0, finalPaid = 0, staked = 0;
  const firstNonZero: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = rng.range(0, CALIBRATION_WINDOW_S);
    const dir = i % 2 ? "buy" : "sell";
    let sawPos = false, sawWin = false, firstT = -1;
    for (let e = 0; e <= H; e += STEP) {
      const v = eng.valueAt(dir, t, e);
      totalTime++;
      if (v <= 0) zeroTime++; else { if (!sawPos) { sawPos = true; firstT = e; } }
      if (v > 1) sawWin = true;
    }
    if (sawPos) { everAbove0++; firstNonZero.push(firstT); }
    if (sawWin) everAbove1++;
    staked += 1; finalPaid += eng.valueAt(dir, t, H);
  }
  const srt = firstNonZero.slice().sort((a, b) => a - b);
  console.log(`\n=== ${label} (edge ${cfg.houseEdge}, winRate ${cfg.targetWinRate}, RTP ${rtp(cfg)}) ===`);
  console.log(`  value at open: ${eng.valueAt("buy", 1000, 0).toFixed(4)}x`);
  console.log(`  share of a position's LIFE pinned at zero: ${(zeroTime / totalTime * 100).toFixed(1)}%`);
  console.log(`  positions ever worth anything at all:      ${(everAbove0 / N * 100).toFixed(1)}%`);
  console.log(`  positions ever worth MORE than the stake:  ${(everAbove1 / N * 100).toFixed(1)}%`);
  if (srt.length) console.log(`  of those, first became non-zero after: median ${srt[srt.length >> 1]}s  p90 ${srt[Math.floor(srt.length * 0.9)]}s`);
  console.log(`  realised RTP at the horizon: ${(finalPaid / staked * 100).toFixed(2)}%  (target ${(rtp(cfg) * 100).toFixed(0)}%)`);
}

study(DEFAULT_CONFIG, "shipped: edge 0.75 / wr 0.125");
// The SAME house edge, with the win rate at the top of its feasible band. The edge is untouched.
for (const wr of [0.16, 0.20, 0.22, 0.24] as const) {
  study({ ...DEFAULT_CONFIG, targetWinRate: wr }, `edge 0.75 / wr ${wr}`);
}
