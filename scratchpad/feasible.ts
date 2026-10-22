/**
 * With the continuous payout's WIN RATE pinned (cost = tau), what mean payouts are reachable at all?
 *
 * payout = clamp(1 + gain*(m - tau), 0, M). At gain -> 0 every payout is 1, so the mean is 1. At
 * gain -> infinity it is M above tau and 0 below, so the mean is M * winRate. The mean is continuous
 * and monotone in between, so the REACHABLE range is (M*winRate, 1). An RTP outside that cannot be
 * delivered by any linear payout that also honours the win rate. Swept numerically rather than
 * argued.
 */
import { CurveGenerator } from "/home/user/invest254/packages/shared/src/curve.js";
import { SettlementEngine, CALIBRATION_WINDOW_S } from "/home/user/invest254/packages/shared/src/settle.js";
import { SeededRng } from "/home/user/invest254/packages/shared/src/prng.js";
import { DEFAULT_CONFIG, rtp } from "/home/user/invest254/packages/shared/src/config.js";

const H = 900, N = 100_000, CFG = DEFAULT_CONFIG, M = CFG.maxMultiplier;
const eng = new SettlementEngine(new CurveGenerator("feas", CFG, "market"), CFG, "calibration", H, CALIBRATION_WINDOW_S, 50_000);
const rng = new SeededRng("feas", "s");
const asc = Float64Array.from({ length: N }, () => eng.moveAt("buy", rng.range(0, CALIBRATION_WINDOW_S), H)).sort();
const q = (p: number) => asc[Math.min(N - 1, Math.floor(p * (N - 1)))]!;

console.log(`cap M = ${M}   target RTP = ${rtp(CFG)}\n`);
console.log("winRate | tau      | mean at gain-> 0 | mean at gain->inf (= M*wr) | is RTP 0.25 reachable?");
for (const w of [0.02, 0.04, 0.05, 0.08, 0.125, 0.20, 0.24]) {
  const tau = q(1 - w);
  const meanAt = (g: number) => { let s = 0; for (let i = 0; i < N; i++) s += Math.max(0, Math.min(1 + g * (asc[i]! - tau), M)); return s / N; };
  const lo = meanAt(1e6), hi = meanAt(1e-9);
  const reach = rtp(CFG) > lo && rtp(CFG) < hi;
  console.log(`${w.toFixed(3).padStart(7)} | ${tau.toFixed(5)} | ${hi.toFixed(4).padStart(16)} | ${lo.toFixed(4).padStart(26)} | ${reach ? "YES" : "NO"}`);
}
console.log(`\nSo a continuous payout honouring BOTH the RTP and the win rate needs  M * winRate < RTP.`);
console.log(`At cap ${M} and RTP ${rtp(CFG)} that is winRate < ${(rtp(CFG) / M).toFixed(4)}; the shipped target is ${CFG.targetWinRate}.`);
