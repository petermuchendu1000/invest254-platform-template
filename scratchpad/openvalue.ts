/**
 * What is a continuous position WORTH the instant it opens, and how far must the price move before
 * it is worth anything at all? `valueAt` is clamp(1 + gain*(move - cost), 0, maxMultiplier), so at
 * move = 0 it is 1 - gain*cost. If that is <= 0 the trader is shown a 100% loss on a price that has
 * not moved.
 */
import { CurveGenerator } from "/home/user/invest254/packages/shared/src/curve.js";
import { SettlementEngine, CALIBRATION_WINDOW_S } from "/home/user/invest254/packages/shared/src/settle.js";
import { DEFAULT_CONFIG, rtp } from "/home/user/invest254/packages/shared/src/config.js";

const CFG = DEFAULT_CONFIG;
console.log(`config: houseEdge ${CFG.houseEdge}  targetWinRate ${CFG.targetWinRate}  RTP ${rtp(CFG)}  maxMult ${CFG.maxMultiplier}  horizon ${CFG.defaultDurationS}s`);
for (const h of [10, 60, 300, 900]) {
  const curve = new CurveGenerator("openval", CFG, "market");
  const eng = new SettlementEngine(curve, CFG, "calibration", h, CALIBRATION_WINDOW_S, 200_000);
  const { gain, cost } = eng.continuousParams("buy");
  const atOpen = Math.max(0, Math.min(1 + gain * (0 - cost), CFG.maxMultiplier));
  // The move at which the position is worth the stake back (break-even) and the cap.
  const breakEven = cost;                       // 1 + gain*(m-cost) = 1  ->  m = cost
  const worthless = cost - 1 / gain;            // 1 + gain*(m-cost) = 0
  const capped = cost + (CFG.maxMultiplier - 1) / gain;
  console.log(`\nhorizon ${h}s  gain ${gain.toFixed(3)}  cost ${cost.toFixed(5)}`);
  console.log(`  value at move=0 (the instant it opens): ${atOpen.toFixed(4)}x  -> P/L ${((atOpen - 1) * 100).toFixed(1)}% of stake`);
  console.log(`  worthless at or below move ${worthless.toFixed(5)}   break-even at ${breakEven.toFixed(5)}   capped at ${capped.toFixed(5)}`);
  // What does a move of that size look like on the chart? One sd of the walk over the horizon.
  // value(t) = b + (1-|b|)*squash(walk*vol); walk sd over h seconds = WALK_SIGMA*sqrt(h).
  const sd = 0.0008 * Math.sqrt(h) * CFG.volatility * (1 - Math.abs(Math.max(-0.9, Math.min(0.9, CFG.driftBias))));
  console.log(`  one standard deviation of the move over ${h}s = ${sd.toFixed(5)}  ->  worthless is ${(worthless / sd).toFixed(2)} sd, break-even ${(breakEven / sd).toFixed(2)} sd`);
}
