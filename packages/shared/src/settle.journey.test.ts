import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator } from "./curve.js";
import { SettlementEngine, CALIBRATION_WINDOW_S } from "./settle.js";
import { SeededRng } from "./prng.js";
import { TERMINAL_CONFIG, rtp, checkFeasible, type GameConfig } from "./config.js";
import type { Direction } from "./types.js";

/**
 * ONE PLAYER, END TO END — the guarantee the continuous payout has to earn.
 *
 * A step contract committed its outcome at open, so no closing rule could touch it. A continuously
 * priced position is worth something different at every moment and the trader now CHOOSES the
 * moment, which is the whole point of a real stop and a real target. That hands them a decision the
 * old contract never had, so the house edge has to be re-established against it rather than assumed:
 * if any rule a trader could actually run returns more than the configured RTP, the edge is not what
 * the config says whenever people use stops.
 *
 * Every policy here reads the SAME trades: the position's value is walked once and each rule applies
 * to that one path, so they are compared on identical ground rather than on their own samples. The
 * per-seed spread gives a standard error, because a pooled figure cannot tell a small leak from a
 * sampling swing.
 */

const CFG = TERMINAL_CONFIG;
const H = CFG.defaultDurationS, STEP = 10, N = H / STEP;
const SEEDS = 8, PER = 1_500;
const CAL = 40_000;

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

interface Policy { name: string; close: (path: Float64Array) => number }
/** Rules a trader could actually run: each sees only the value so far, never the future. */
const POLICIES: Policy[] = [
  { name: "hold to horizon", close: (p) => p[N]! },
  { name: "take profit +50%", close: (p) => { for (let i = 1; i <= N; i++) if (p[i]! >= 1.5) return p[i]!; return p[N]!; } },
  { name: "stop at 0.5x", close: (p) => { for (let i = 1; i <= N; i++) if (p[i]! <= 0.5) return p[i]!; return p[N]!; } },
  { name: "TP +50% / SL 0.5x", close: (p) => { for (let i = 1; i <= N; i++) { if (p[i]! >= 1.5 || p[i]! <= 0.5) return p[i]!; } return p[N]!; } },
  { name: "trailing 20% off the peak", close: (p) => { let pk = p[0]!; for (let i = 1; i <= N; i++) { if (p[i]! > pk) pk = p[i]!; if (pk > 1 && p[i]! <= pk * 0.8) return p[i]!; } return p[N]!; } },
  { name: "close the moment it is up", close: (p) => { for (let i = 1; i <= N; i++) if (p[i]! > 1) return p[i]!; return p[N]!; } },
];

/** Realised return per seed, for every policy, plus the highest multiplier anything realised. */
function runPolicies(cfg: GameConfig): { per: number[][]; maxMultiplier: number; capBinds: number[] } {
  const per: number[][] = POLICIES.map(() => []);
  const capBinds = POLICIES.map(() => 0);
  let maxMult = 0, trades = 0;
  const path = new Float64Array(N + 1);
  for (let s = 0; s < SEEDS; s++) {
    const eng = new SettlementEngine(new CurveGenerator(`journey-${s}`, cfg, "market"), cfg, "calibration", H, CALIBRATION_WINDOW_S, CAL);
    const rng = new SeededRng(`journey-${s}`, "trade");
    const sums = POLICIES.map(() => 0);
    for (let i = 0; i < PER; i++) {
      const t = rng.range(0, CALIBRATION_WINDOW_S);
      const dir: Direction = rng.next() < 0.5 ? "buy" : "sell";
      for (let k = 0; k <= N; k++) path[k] = eng.valueAt(dir, t, k * STEP);
      POLICIES.forEach((p, k) => {
        const m = p.close(path);
        sums[k]! += m;
        if (m >= cfg.maxMultiplier - 1e-9) capBinds[k]!++;
        if (m > maxMult) maxMult = m;
      });
      trades++;
    }
    POLICIES.forEach((_, k) => per[k]!.push(sums[k]! / PER));
  }
  return { per, maxMultiplier: maxMult, capBinds: capBinds.map((c) => c / trades) };
}

test("NO closing policy a trader could run beats the configured house edge", () => {
  const { per } = runPolicies(CFG);
  const target = rtp(CFG);
  for (let k = 0; k < POLICIES.length; k++) {
    const m = mean(per[k]!), se = sd(per[k]!) / Math.sqrt(SEEDS);
    const drift = m - target;
    assert.ok(
      drift < 0.03,
      `${POLICIES[k]!.name}: realised ${(m * 100).toFixed(2)}% against a ${(target * 100).toFixed(0)}% target ` +
      `(+${(drift * 100).toFixed(2)}pp, SE ${(se * 100).toFixed(3)}pp) — a trader can out-trade the house`,
    );
  }
});

test("and using a STOP costs the trader, the way it costs one at a real broker", () => {
  /**
   * Not a nicety: it is the reason a stop can be offered at all. A rule that cut losses for free
   * would be the house paying for the trader's risk management, and every trader would run it.
   */
  const { per } = runPolicies(CFG);
  const byName = (n: string) => mean(per[POLICIES.findIndex((p) => p.name === n)]!);
  const hold = byName("hold to horizon");
  for (const name of ["stop at 0.5x", "TP +50% / SL 0.5x"]) {
    assert.ok(
      byName(name) < hold,
      `${name} returned ${(byName(name) * 100).toFixed(2)}% against ${(hold * 100).toFixed(2)}% for holding: a stop must not pay`,
    );
  }
});

test("the shipped cap NEVER binds, so it caps nobody's profit", () => {
  /**
   * MetaTrader does not cap a profit at all, so every time ours binds it pays a trader less than the
   * price says. Measured against an effectively unlimited cap, the highest multiplier ANY policy
   * realises is about 4.1x, so a cap of 5 sits above the whole reachable range: it bounds the
   * house's tail without ever being the thing a trader runs into.
   */
  const uncapped = runPolicies({ ...CFG, maxMultiplier: 1_000 });
  assert.ok(
    uncapped.maxMultiplier < CFG.maxMultiplier,
    `an uncapped payout reached ${uncapped.maxMultiplier.toFixed(3)}x, at or above the ${CFG.maxMultiplier}x cap`,
  );
  const shipped = runPolicies(CFG);
  for (let k = 0; k < POLICIES.length; k++) {
    assert.equal(shipped.capBinds[k], 0, `${POLICIES[k]!.name} hit the cap on ${(shipped.capBinds[k]! * 100).toFixed(2)}% of trades`);
  }
});

test("a cap set too LOW silently charges more than the configured edge", () => {
  /**
   * The failure mode that makes the cap worth a test rather than a constant. Truncating the payout
   * takes money out of the mean the calibration is trying to hit, and once the cap binds often
   * enough the solve cannot get back to the target: measured at a 1.5x cap the house takes about
   * 25% where 10% was configured. An operator lowering this knob would be changing the edge without
   * being told.
   */
  const cfg: GameConfig = { ...CFG, maxMultiplier: 1.5 };
  assert.equal(checkFeasible(cfg).ok, true, "1.5 is a configurable cap, which is why this matters");
  const { per } = runPolicies(cfg);
  const held = mean(per[0]!);
  assert.ok(
    held < rtp(CFG) - 0.05,
    `a 1.5x cap returned ${(held * 100).toFixed(2)}%, close to the configured ${(rtp(CFG) * 100).toFixed(0)}% — ` +
    `this test exists because it does NOT, and the gap is the operator's blind spot`,
  );
});
