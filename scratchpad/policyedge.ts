/**
 * Can a trader with real stops beat the configured house edge?
 *
 * This is the question the whole continuous payout turns on. A step contract committed its outcome
 * at open, so no closing rule could touch it; a continuous one is worth something different at every
 * moment, and a trader now chooses the moment. If some implementable rule returns more than the
 * configured RTP, the edge is not what the config says whenever players use stops.
 *
 * Measured per seed so the spread across days gives a standard error: a single pooled number cannot
 * tell a 3pp leak from a 3pp sampling swing. The path is computed once per trade and every policy
 * reads the same one, so the policies are compared on identical trades rather than on their own
 * samples.
 */
import { CurveGenerator } from "/home/user/invest254/packages/shared/src/curve.js";
import { SettlementEngine, CALIBRATION_WINDOW_S } from "/home/user/invest254/packages/shared/src/settle.js";
import { SeededRng } from "/home/user/invest254/packages/shared/src/prng.js";
import { TERMINAL_CONFIG, rtp, type Direction } from "/home/user/invest254/packages/shared/src/config.js";

const CFG = TERMINAL_CONFIG, H = CFG.defaultDurationS, STEP = 5, N = H / STEP;
const SEEDS = 30, PER = 4_000;

type P = { name: string; f: (path: Float64Array) => number };
const POLICIES: P[] = [
  { name: "hold to horizon", f: (p) => p[N]! },
  { name: "take profit +10%", f: (p) => { for (let i = 1; i <= N; i++) if (p[i]! >= 1.10) return p[i]!; return p[N]!; } },
  { name: "take profit +50%", f: (p) => { for (let i = 1; i <= N; i++) if (p[i]! >= 1.50) return p[i]!; return p[N]!; } },
  { name: "take profit x2", f: (p) => { for (let i = 1; i <= N; i++) if (p[i]! >= 2) return p[i]!; return p[N]!; } },
  { name: "stop at 0.5x", f: (p) => { for (let i = 1; i <= N; i++) if (p[i]! <= 0.5) return p[i]!; return p[N]!; } },
  { name: "TP +50% / SL 0.5x", f: (p) => { for (let i = 1; i <= N; i++) { if (p[i]! >= 1.5 || p[i]! <= 0.5) return p[i]!; } return p[N]!; } },
  { name: "TP +20% / SL 0.8x", f: (p) => { for (let i = 1; i <= N; i++) { if (p[i]! >= 1.2 || p[i]! <= 0.8) return p[i]!; } return p[N]!; } },
  { name: "trailing 20% off peak", f: (p) => { let pk = p[0]!; for (let i = 1; i <= N; i++) { if (p[i]! > pk) pk = p[i]!; if (pk > 1 && p[i]! <= pk * 0.8) return p[i]!; } return p[N]!; } },
  { name: "trailing 5% off peak", f: (p) => { let pk = p[0]!; for (let i = 1; i <= N; i++) { if (p[i]! > pk) pk = p[i]!; if (pk > 1 && p[i]! <= pk * 0.95) return p[i]!; } return p[N]!; } },
  { name: "close the moment it is up", f: (p) => { for (let i = 1; i <= N; i++) if (p[i]! > 1) return p[i]!; return p[N]!; } },
  { name: "ORACLE (unreachable)", f: (p) => { let b = p[0]!; for (let i = 1; i <= N; i++) if (p[i]! > b) b = p[i]!; return b; } },
];

const per: number[][] = POLICIES.map(() => []);
for (let s = 0; s < SEEDS; s++) {
  const eng = new SettlementEngine(new CurveGenerator(`pe-${s}`, CFG, "market"), CFG, "calibration", H, CALIBRATION_WINDOW_S, 60_000);
  const rng = new SeededRng(`pe-${s}`, "t");
  const sums = POLICIES.map(() => 0);
  const path = new Float64Array(N + 1);
  for (let i = 0; i < PER; i++) {
    const t = rng.range(0, CALIBRATION_WINDOW_S);
    const dir: Direction = rng.next() < 0.5 ? "buy" : "sell";
    for (let k = 0; k <= N; k++) path[k] = eng.valueAt(dir, t, k * STEP);
    POLICIES.forEach((p, k) => { sums[k]! += p.f(path); });
  }
  POLICIES.forEach((_, k) => per[k]!.push(sums[k]! / PER));
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const target = rtp(CFG);
console.log(`terminal economy, ${SEEDS} seeds x ${PER} trades = ${SEEDS * PER} trades per policy. Configured RTP ${(target * 100).toFixed(1)}%\n`);
console.log("policy                          |   RTP   |  drift  |   SE   |    t   | verdict");
POLICIES.forEach((p, k) => {
  const m = mean(per[k]!), se = sd(per[k]!) / Math.sqrt(SEEDS), t = (m - target) / se;
  const verdict = p.name.startsWith("ORACLE") ? "upper bound, needs the future"
    : t > 3 ? "LEAK" : t < -3 ? "house ahead" : "no edge (within noise)";
  console.log(`${p.name.padEnd(31)} | ${(m * 100).toFixed(2).padStart(6)}% | ${((m - target) * 100 >= 0 ? "+" : "")}${((m - target) * 100).toFixed(2).padStart(6)}pp | ${(se * 100).toFixed(3).padStart(5)}pp | ${t.toFixed(2).padStart(6)} | ${verdict}`);
});
