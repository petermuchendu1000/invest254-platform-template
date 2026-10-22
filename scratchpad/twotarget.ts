/**
 * The continuous payout has TWO targets and must therefore solve TWO parameters.
 *
 * Today `gain` is inherited from the STEP calibration (mean multiple over step-winners) and only
 * `cost` is solved, against the mean. Nothing constrains the continuous payout's own win rate, which
 * is P(payout > 1) = P(1 + gain*(m - cost) > 1) = P(m > cost). Measured, it lands at 10.8% on the
 * shipped config and at 0.0% once the target win rate passes 0.20: a trader who can never win.
 *
 * That second probability has a closed form: P(m > cost) = targetWinRate makes cost EXACTLY the
 * (1 - targetWinRate) quantile of the moves, which is `tau`, already computed. Then `gain` is the
 * single unknown left, solved so the mean payout equals the RTP. This checks that claim arithmetically
 * against the real sample before any engine code changes.
 */
import { CurveGenerator } from "/home/user/invest254/packages/shared/src/curve.js";
import { SettlementEngine, CALIBRATION_WINDOW_S } from "/home/user/invest254/packages/shared/src/settle.js";
import { SeededRng } from "/home/user/invest254/packages/shared/src/prng.js";
import { DEFAULT_CONFIG, rtp, type GameConfig } from "/home/user/invest254/packages/shared/src/config.js";

const H = 900, N = 200_000;

function trial(cfg: GameConfig, label: string) {
  const curve = new CurveGenerator("twotarget", cfg, "market");
  const eng = new SettlementEngine(curve, cfg, "calibration", H, CALIBRATION_WINDOW_S, N);
  // Redraw the same sample the calibration used, so the solve is measured on its own ground.
  const rng = new SeededRng("calibration", "calib:buy");
  const moves = new Float64Array(N);
  for (let i = 0; i < N; i++) moves[i] = eng.moveAt("buy", rng.range(0, CALIBRATION_WINDOW_S), H);
  const asc = Float64Array.from(moves).sort();
  const quantile = (q: number) => asc[Math.min(N - 1, Math.max(0, Math.floor(q * (N - 1))))]!;
  const M = cfg.maxMultiplier, R = rtp(cfg);

  // cost := tau pins P(payout > 1) = targetWinRate by construction.
  const cost = quantile(1 - cfg.targetWinRate);
  const meanFor = (g: number) => {
    let s = 0;
    for (let i = 0; i < N; i++) s += Math.max(0, Math.min(1 + g * (asc[i]! - cost), M));
    return s / N;
  };
  // Monotone increasing in gain: bisect.
  let lo = 0, hi = 1;
  while (meanFor(hi) < R && hi < 1e9) hi *= 2;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (meanFor(mid) < R) lo = mid; else hi = mid; }
  const gain = (lo + hi) / 2;

  const payout = (m: number) => Math.max(0, Math.min(1 + gain * (m - cost), M));
  let wins = 0, sum = 0, zero = 0;
  for (let i = 0; i < N; i++) { const p = payout(asc[i]!); sum += p; if (p > 1) wins++; if (p <= 0) zero++; }
  const shipped = eng.continuousParams("buy");
  console.log(`\n=== ${label} (edge ${cfg.houseEdge}, targetWinRate ${cfg.targetWinRate}) ===`);
  console.log(`  SHIPPED   gain ${shipped.gain.toFixed(3)}  cost ${shipped.cost.toFixed(5)}  value at open ${Math.max(0, Math.min(1 - shipped.gain * shipped.cost, M)).toFixed(4)}x`);
  console.log(`  TWO-TARGET gain ${gain.toFixed(3)}  cost ${cost.toFixed(5)} (= tau)  value at open ${payout(0).toFixed(4)}x`);
  console.log(`    realised RTP      ${(sum / N).toFixed(4)}   (target ${R})`);
  console.log(`    realised win-rate ${(wins / N).toFixed(4)}   (target ${cfg.targetWinRate})`);
  console.log(`    share of the move distribution paying ZERO: ${(zero / N * 100).toFixed(1)}%`);
}

trial(DEFAULT_CONFIG, "shipped default");
for (const [e, w] of [[0.75, 0.24], [0.5, 0.45], [0.05, 0.65], [0.03, 0.95]] as const)
  trial({ ...DEFAULT_CONFIG, houseEdge: e, targetWinRate: w }, `edge ${e} / wr ${w}`);
