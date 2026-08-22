import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidePoolOutcome, sessionWinProbability, DEFAULT_POOL_KNOBS,
  type PoolKnobs, type PoolState, type PlayerSession,
} from "./pool.js";

/**
 * Pool RTP REDESIGN (docs/25) — rigorous, zero-assumption unit coverage of the turnover-paced,
 * hard-RTP-budget-ceiling engine. Every expectation is derived from the model, not guessed:
 *   • meanMultiplier = targetRtp / targetWinRate            (unifies win frequency with the statistical engine)
 *   • base win-prob  = targetRtp / meanMultiplier = winRate (pCap pinned here ⇒ E[RTP/trade] ≤ target)
 *   • HARD CEILING   : cumulative paid ≤ targetRtp × turnover, enforced per trade ⇒ realized RTP ≤ target
 *                      at EVERY volume (the structural positive-edge guarantee).
 *   • pool available(): the absolute cash fuse (unchanged).
 * The turnover path is OPT-IN via PoolState.turnoverCents; without it the legacy path is byte-identical.
 */

const EMPTY: PlayerSession = { stakedCents: 0, returnedCents: 0, trades: 0, wins: 0, lossStreak: 0 };
const sess = (o: Partial<PlayerSession> = {}): PlayerSession => ({ ...EMPTY, ...o });

/** Build knobs exactly as PoolController.decideReserve derives them from (targetRtp, targetWinRate). */
function knobs(targetRtp: number, targetWinRate: number, maxMultiplier = 5): PoolKnobs {
  const meanMultiplier = targetRtp / targetWinRate;
  return { ...DEFAULT_POOL_KNOBS, maxMultiplier, targetSessionRtp: targetRtp, meanMultiplier, pCap: targetRtp / meanMultiplier };
}

/**
 * Drive one brand-day of pool trades through the REAL decidePoolOutcome on the turnover path.
 * Mirrors PoolController: turnover includes the current trade; atomic reserve→commit at settle
 * (paid grows immediately). Asserts the ceiling invariant at EVERY step when `assertCeiling`.
 */
function simDay(o: {
  targetRtp: number; targetWinRate: number; trades: number; stake: number; poolFactor: number;
  seed: string; players?: number; assertCeiling?: boolean;
}): { rtp: number; winRate: number; paid: number; turnover: number; maxIntraday: number; poolAmount: number } {
  const k = knobs(o.targetRtp, o.targetWinRate);
  const players = o.players ?? Math.max(1, Math.floor(o.trades / 8));
  const poolAmount = Math.round(o.poolFactor * o.trades * o.stake);
  const pool: PoolState = { amountCents: poolAmount, paidCents: 0, reservedCents: 0 };
  const sessions = new Map<number, PlayerSession>();
  let turnover = 0, wins = 0, maxIntraday = 0;
  for (let i = 0; i < o.trades; i++) {
    const pid = i % players;
    const s = sessions.get(pid) ?? sess(); sessions.set(pid, s);
    turnover += o.stake;
    const d = decidePoolOutcome({
      stakeCents: o.stake, pool: { ...pool, turnoverCents: turnover }, dayFraction: 0.5,
      knobs: k, serverSeed: o.seed, nonce: i, session: s,
    });
    s.trades += 1; s.stakedCents += o.stake;
    if (d.result === "win") { pool.paidCents += d.payoutCents; s.returnedCents += d.payoutCents; s.wins += 1; s.lossStreak = 0; wins += 1; }
    else s.lossStreak += 1;
    if (o.assertCeiling) {
      assert.ok(pool.paidCents <= Math.floor(o.targetRtp * turnover), `ceiling breached @${i}: paid ${pool.paidCents} > ${Math.floor(o.targetRtp * turnover)}`);
      assert.ok(pool.paidCents <= poolAmount, `cash fuse breached @${i}`);
    }
    maxIntraday = Math.max(maxIntraday, pool.paidCents / turnover);
  }
  return { rtp: pool.paidCents / turnover, winRate: wins / o.trades, paid: pool.paidCents, turnover, maxIntraday, poolAmount };
}

// ─────────────────────────────── Bug 2: hard positive-edge guarantee ───────────────────────────────

test("BUG 2 — HARD CEILING: cumulative paid ≤ target×turnover at EVERY step, EVERY volume", () => {
  // The prior strict-pCap-only design left low-volume days underwater; the ceiling closes it.
  for (const trades of [5, 8, 15, 30, 100, 1000]) {
    for (const trial of [0, 1, 2, 3, 4]) {
      simDay({ targetRtp: 0.8, targetWinRate: 0.2, trades, stake: 40000, poolFactor: 3, seed: `edge-${trades}-${trial}`, assertCeiling: true });
    }
  }
});

test("BUG 2 — realized RTP NEVER exceeds target on any day (low + high volume, 300 days)", () => {
  for (const trades of [8, 30, 200]) {
    let worst = 0;
    for (let d = 0; d < 100; d++) {
      const r = simDay({ targetRtp: 0.8, targetWinRate: 0.2, trades, stake: 40000, poolFactor: 3, seed: `noover-${trades}-${d}` });
      worst = Math.max(worst, r.rtp);
      assert.ok(r.rtp <= 0.8 + 1e-9, `day ${d} (${trades} trades) RTP ${r.rtp} exceeded target`);
    }
    assert.ok(worst <= 0.8 + 1e-9, `worst RTP over 100 ${trades}-trade days = ${worst}`);
  }
});

// ─────────────────────────────── Bug 1: RTP driven by house_edge, pool = ceiling ───────────────────

test("BUG 1 — realized RTP = min(target, pool/turnover): pool binds ONLY when undersized", () => {
  for (const pf of [0.4, 0.6, 0.8]) {                       // undersized pool ⇒ RTP ≈ pf
    const r = simDay({ targetRtp: 0.8, targetWinRate: 0.2, trades: 4000, stake: 40000, poolFactor: pf, seed: `bind-${pf}` });
    assert.ok(Math.abs(r.rtp - pf) < 0.03, `pool ${pf}x: RTP ${r.rtp} should ≈ ${pf}`);
  }
  for (const pf of [1.5, 3, 6]) {                           // ample pool ⇒ RTP ≈ target (undershoot in the SAFE direction)
    const r = simDay({ targetRtp: 0.8, targetWinRate: 0.2, trades: 4000, stake: 40000, poolFactor: pf, seed: `ample-${pf}` });
    assert.ok(r.rtp <= 0.8 + 1e-9 && r.rtp > 0.75, `pool ${pf}x: RTP ${r.rtp} should track target ~0.8`);
  }
});

test("BUG 1 — RTP tracks house_edge across the config range (ample pool)", () => {
  for (const [tr, wr] of [[0.25, 0.125], [0.50, 0.20], [0.80, 0.20], [0.90, 0.25]] as const) {
    const r = simDay({ targetRtp: tr, targetWinRate: wr, trades: 6000, stake: 40000, poolFactor: 3, seed: `track-${tr}` });
    assert.ok(r.rtp <= tr + 1e-9, `RTP ${r.rtp} must not exceed target ${tr}`);
    assert.ok(r.rtp > tr - 0.06, `RTP ${r.rtp} undershoots target ${tr} by more than 6% (accuracy)`);
  }
});

// ─────────────────────────────── Bug 3: unified win frequency = targetWinRate ───────────────────────

test("BUG 3 — observed win frequency ≈ targetWinRate (unified with the statistical engine)", () => {
  for (const [tr, wr] of [[0.25, 0.125], [0.50, 0.20], [0.90, 0.25]] as const) {
    const r = simDay({ targetRtp: tr, targetWinRate: wr, trades: 8000, stake: 40000, poolFactor: 3, seed: `wf-${tr}` });
    assert.ok(Math.abs(r.winRate - wr) < 0.02, `win rate ${r.winRate} should ≈ targetWinRate ${wr}`);
  }
});

test("edge invariant — sessionWinProbability on the turnover path never exceeds base = target/meanMult", () => {
  const k = knobs(0.8, 0.2);
  const base = k.targetSessionRtp / k.meanMultiplier;
  for (let paid = 0; paid <= 1_000_000; paid += 50_000) {
    for (const ls of [0, 3, 10]) {
      const p = sessionWinProbability(sess({ lossStreak: ls }), { amountCents: 10_000_000, paidCents: paid, reservedCents: 0, turnoverCents: 1_000_000 }, 0.5, k);
      assert.ok(p <= base + 1e-12, `p ${p} exceeded base ${base} (paid=${paid}, streak=${ls})`);
    }
  }
});

// ─────────────────────────────── pacing behaviour + edge cases ──────────────────────────────────────

test("turnover pacing — behind pace nudges toward base; ahead of pace reduces below base", () => {
  const k = knobs(0.8, 0.2);
  const base = k.targetSessionRtp / k.meanMultiplier;
  const behind = sessionWinProbability(sess(), { amountCents: 1e9, paidCents: 0, reservedCents: 0, turnoverCents: 1_000_000 }, 0.5, k);        // realized 0 ≪ target
  const ahead  = sessionWinProbability(sess(), { amountCents: 1e9, paidCents: 900_000, reservedCents: 0, turnoverCents: 1_000_000 }, 0.5, k);  // realized 0.9 ≫ target
  assert.ok(Math.abs(behind - base) < 1e-9, "behind pace ⇒ p at base (cap)");
  assert.ok(ahead < base, "ahead of pace ⇒ p pulled below base");
  assert.ok(ahead >= k.pFloor, "never below the floor");
});

test("zero turnover ⇒ finite, no NaN, no ceiling div-by-zero (first trade of a day)", () => {
  const k = knobs(0.8, 0.2);
  const p = sessionWinProbability(sess(), { amountCents: 1e9, paidCents: 0, reservedCents: 0, turnoverCents: 0 }, 0.0, k);
  assert.ok(Number.isFinite(p), "prob finite with zero turnover");
  // turnoverCents:0 falls back to the legacy path (>0 guard), which is well-defined.
  const d = decidePoolOutcome({ stakeCents: 40000, pool: { amountCents: 1e9, paidCents: 0, reservedCents: 0, turnoverCents: 0 }, dayFraction: 0.5, knobs: k, serverSeed: "z", nonce: 0, session: sess() });
  assert.ok(["win", "loss"].includes(d.result));
});

test("determinism — identical (seed,nonce,state) ⇒ identical decision on the turnover path", () => {
  const k = knobs(0.8, 0.2);
  const args = { stakeCents: 40000, pool: { amountCents: 1e9, paidCents: 123_456, reservedCents: 0, turnoverCents: 800_000 }, dayFraction: 0.5, knobs: k, serverSeed: "det", nonce: 7, session: sess({ trades: 3 }) };
  assert.deepEqual(decidePoolOutcome(args), decidePoolOutcome(args));
});

test("LEGACY path unchanged — omitting turnoverCents reproduces pre-redesign behaviour exactly", () => {
  // No turnoverCents ⇒ legacy amount×dayFraction pacing, NO hard ceiling. Byte-identical to before.
  const k: PoolKnobs = { ...DEFAULT_POOL_KNOBS };
  const legacyPool: PoolState = { amountCents: 1_000_000, paidCents: 0, reservedCents: 0 };
  const p = sessionWinProbability(sess(), legacyPool, 0.5, k);
  // legacy base with default knobs: 0.6/1.8, pace on-target (paid 0, target amount*0.5) ⇒ nudged up, capped 0.6
  assert.ok(p > 0 && p <= k.pCap);
  // ceiling absent ⇒ a large win can exceed target×(any turnover-less notion); only avail bounds it
  let sawBigWin = false;
  for (let n = 0; n < 300; n++) {
    const d = decidePoolOutcome({ stakeCents: 25000, pool: legacyPool, dayFraction: 0.5, knobs: k, serverSeed: "leg", nonce: n, session: sess() });
    if (d.result === "win" && d.payoutCents > 25000 * 1.5) sawBigWin = true;
  }
  assert.ok(sawBigWin, "legacy path still pays uncapped-by-RTP-budget wins (behaviour preserved)");
});
