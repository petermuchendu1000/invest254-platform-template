/**
 * The same player, now TRADING rather than holding: does any closing policy beat the house, and does
 * the cap ever bind for one?
 *
 * Holding to the horizon is the easy case. With real stops and targets a trader closes when they
 * choose, so the cap's true test is the multiplier a CLOSING POLICY can realise, and the edge's true
 * test is whether any of them returns more than the configured RTP. The oracle is included as the
 * upper bound no real policy can beat: it sees the whole path and closes at its best moment.
 */
import { CurveGenerator } from "/home/user/invest254/packages/shared/src/curve.js";
import { SettlementEngine, CALIBRATION_WINDOW_S } from "/home/user/invest254/packages/shared/src/settle.js";
import { SeededRng } from "/home/user/invest254/packages/shared/src/prng.js";
import { TERMINAL_CONFIG, rtp, type GameConfig, type Direction } from "/home/user/invest254/packages/shared/src/config.js";

const H = TERMINAL_CONFIG.defaultDurationS, CAL = 60_000, STEP = 5;
const TRADES = 4_000, SEEDS = 8;

type Policy = { name: string; run: (v: (e: number) => number) => number };
const POLICIES: Policy[] = [
  { name: "hold to horizon", run: (v) => v(H) },
  { name: "take profit +10%", run: (v) => { for (let e = STEP; e <= H; e += STEP) if (v(e) >= 1.10) return v(e); return v(H); } },
  { name: "take profit +50%", run: (v) => { for (let e = STEP; e <= H; e += STEP) if (v(e) >= 1.50) return v(e); return v(H); } },
  { name: "take profit x3", run: (v) => { for (let e = STEP; e <= H; e += STEP) if (v(e) >= 3) return v(e); return v(H); } },
  { name: "stop at 0.5x", run: (v) => { for (let e = STEP; e <= H; e += STEP) if (v(e) <= 0.5) return v(e); return v(H); } },
  { name: "TP +50% / SL 0.5x", run: (v) => { for (let e = STEP; e <= H; e += STEP) { const x = v(e); if (x >= 1.5 || x <= 0.5) return x; } return v(H); } },
  { name: "trailing 20% off peak", run: (v) => { let pk = v(0); for (let e = STEP; e <= H; e += STEP) { const x = v(e); if (x > pk) pk = x; if (pk > 1 && x <= pk * 0.8) return x; } return v(H); } },
  { name: "ORACLE: close at the best moment", run: (v) => { let best = v(0); for (let e = STEP; e <= H; e += STEP) best = Math.max(best, v(e)); return best; } },
];

for (const cap of [3, 5, 1000]) {
  const cfg: GameConfig = { ...TERMINAL_CONFIG, maxMultiplier: cap };
  const target = rtp(cfg);
  const sums = POLICIES.map(() => 0);
  const capHits = POLICIES.map(() => 0);
  let maxSeen = 0;
  for (let s = 0; s < SEEDS; s++) {
    const eng = new SettlementEngine(new CurveGenerator(`pol-${s}`, cfg, "market"), cfg, "calibration", H, CALIBRATION_WINDOW_S, CAL);
    const rng = new SeededRng(`pol-${s}`, "t");
    for (let i = 0; i < TRADES / SEEDS; i++) {
      const t = rng.range(0, CALIBRATION_WINDOW_S);
      const dir: Direction = rng.next() < 0.5 ? "buy" : "sell";
      const v = (e: number) => eng.valueAt(dir, t, e);
      POLICIES.forEach((p, k) => {
        const m = p.run(v);
        sums[k] += m;
        if (m >= cap - 1e-9) capHits[k]!++;
        if (m > maxSeen) maxSeen = m;
      });
    }
  }
  console.log(`\n=== cap ${cap}  (configured RTP ${(target * 100).toFixed(0)}%) ===`);
  console.log(`  highest multiplier ANY policy realised: ${maxSeen.toFixed(3)}x`);
  POLICIES.forEach((p, k) => {
    const r = sums[k]! / TRADES;
    const flag = r > target + 0.01 ? "  <-- BEATS THE HOUSE" : "";
    console.log(`  ${p.name.padEnd(32)} RTP ${(r * 100).toFixed(2).padStart(6)}%   cap bound ${(capHits[k]! / TRADES * 100).toFixed(2).padStart(5)}% of trades${flag}`);
  });
}
