/**
 * ONE PLAYER, END TO END — the instrument for choosing the payout cap.
 *
 * A cap is only "ideal" relative to two things it trades off, and neither can be read off a formula:
 *
 *   the TRADER  MetaTrader does not cap a profit at all. Every time the cap binds, a trader who was
 *               right about the price is paid less than the price says, which is the one thing a
 *               terminal cannot do and still be believed. So the question is not what the cap is,
 *               it is HOW OFTEN IT BINDS.
 *   the HOUSE   the cap is the only bound on a single trade's payout, so it bounds the variance the
 *               house carries. Removing it entirely is not free.
 *
 * This runs a real player against the REAL engine: a bankroll, a stake rule, a sequence of trades,
 * each opened at its own entry and settled by `SettlementEngine.valueAt` exactly as the live engine
 * settles one. It reports what the player lived through and what the house took, per cap.
 */
import { CurveGenerator } from "/home/user/invest254/packages/shared/src/curve.js";
import { SettlementEngine, CALIBRATION_WINDOW_S } from "/home/user/invest254/packages/shared/src/settle.js";
import { SeededRng } from "/home/user/invest254/packages/shared/src/prng.js";
import { TERMINAL_CONFIG, rtp, checkFeasible, type GameConfig } from "/home/user/invest254/packages/shared/src/config.js";

const H = TERMINAL_CONFIG.defaultDurationS;
const CAL = 60_000;
const START = 100_000;       // cents: a 1,000.00 bankroll
const STAKE = 2_500;         // cents: 25.00 a trade, the brand minimum
const MAX_TRADES = 400;      // a long session; most players stop or bust first
const PLAYERS = 400;

interface Run {
  bust: boolean; trades: number; endBank: number; peak: number; trough: number;
  capHits: number; staked: number; paid: number;
}

function journey(cfg: GameConfig, eng: SettlementEngine, rng: SeededRng): Run {
  let bank = START, staked = 0, paid = 0, capHits = 0, trades = 0;
  let peak = START, trough = START;
  while (trades < MAX_TRADES && bank >= STAKE) {
    bank -= STAKE; staked += STAKE;
    const t = rng.range(0, CALIBRATION_WINDOW_S);
    const dir = rng.next() < 0.5 ? "buy" : "sell";
    const mult = eng.valueAt(dir, t, H);
    // The cap binds when the price earned more than the cap allows.
    if (mult >= cfg.maxMultiplier - 1e-9) capHits++;
    const payout = Math.round(STAKE * mult);
    bank += payout; paid += payout; trades++;
    if (bank > peak) peak = bank;
    if (bank < trough) trough = bank;
  }
  return { bust: bank < STAKE, trades, endBank: bank, peak, trough, capHits, staked, paid };
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const med = (a: number[]) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]!; };

console.log(`terminal economy: edge ${TERMINAL_CONFIG.houseEdge}  winRate ${TERMINAL_CONFIG.targetWinRate}  RTP ${rtp(TERMINAL_CONFIG)}`);
console.log(`one player: ${START / 100} bankroll, ${STAKE / 100} a trade, up to ${MAX_TRADES} trades, ${PLAYERS} players per cap\n`);
console.log(" cap |  value@open | cap binds | house take | median trades | busted | median end bank | best run");
for (const cap of [1.5, 2, 3, 5, 10, 25, 100, 1000]) {
  const cfg: GameConfig = { ...TERMINAL_CONFIG, maxMultiplier: cap };
  const f = checkFeasible(cfg);
  if (!f.ok) { console.log(`${String(cap).padStart(4)} | INFEASIBLE: ${f.reason}`); continue; }
  const runs: Run[] = [];
  let open = 0;
  for (let s = 0; s < 8; s++) {
    const eng = new SettlementEngine(new CurveGenerator(`journey-${s}`, cfg, "market"), cfg, "calibration", H, CALIBRATION_WINDOW_S, CAL);
    open += eng.valueAt("buy", 1000, 0);
    for (let p = 0; p < PLAYERS / 8; p++) runs.push(journey(cfg, eng, new SeededRng(`journey-${s}`, `p${p}`)));
  }
  const staked = runs.reduce((a, r) => a + r.staked, 0);
  const paid = runs.reduce((a, r) => a + r.paid, 0);
  const capRate = runs.reduce((a, r) => a + r.capHits, 0) / runs.reduce((a, r) => a + r.trades, 0);
  console.log(
    `${String(cap).padStart(4)} | ${(open / 8).toFixed(4)}x    |` +
    ` ${(capRate * 100).toFixed(2).padStart(6)}%   |` +
    ` ${((1 - paid / staked) * 100).toFixed(2).padStart(7)}%   |` +
    ` ${String(med(runs.map((r) => r.trades))).padStart(10)}    |` +
    ` ${(runs.filter((r) => r.bust).length / runs.length * 100).toFixed(1).padStart(5)}% |` +
    ` ${(med(runs.map((r) => r.endBank)) / 100).toFixed(2).padStart(13)}   |` +
    ` ${(Math.max(...runs.map((r) => r.peak)) / 100).toFixed(2)}`,
  );
}
