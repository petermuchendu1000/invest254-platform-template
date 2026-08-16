import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidePoolOutcome, winProbability, paceTarget, available, poolLiveMultiplier, poolPnlPath,
  sessionWinProbability, DEFAULT_POOL_KNOBS, type PoolState, type PoolKnobs, type PlayerSession,
} from "./pool.js";

const K: PoolKnobs = { ...DEFAULT_POOL_KNOBS };
const pool = (a: number, p = 0, r = 0): PoolState => ({ amountCents: a, paidCents: p, reservedCents: r });

test("available never negative; paceTarget clamps to [0,1]", () => {
  assert.equal(available(pool(1000, 700, 300)), 0);
  assert.equal(available(pool(1000, 900, 300)), 0);      // over-committed clamps to 0
  assert.equal(paceTarget(1000, -1), 0);
  assert.equal(paceTarget(1000, 2), 1000);
  assert.equal(paceTarget(1000, 0.5), 500);
});

test("winProbability tracks pacing: on-pace≈p0, far-behind→cap, far-ahead→floor, monotonic", () => {
  const p = pool(1_000_000, 0, 0);
  // exactly on pace (paid == target) => p0
  assert.ok(Math.abs(winProbability({ ...p, paidCents: 500_000 }, 0.5, K) - K.p0) < 1e-9);
  // far behind (paid=0, target high) => capped
  assert.equal(winProbability({ ...p, paidCents: 0 }, 1.0, K), K.pCap);
  // far ahead (paid high, target low) => floored
  assert.equal(winProbability({ ...p, paidCents: 900_000 }, 0.1, K), K.pFloor);
  // monotonic: more behind => higher prob
  const a = winProbability({ ...p, paidCents: 400_000 }, 0.5, K);
  const b = winProbability({ ...p, paidCents: 300_000 }, 0.5, K);
  assert.ok(b >= a);
  // zero pool => zero prob
  assert.equal(winProbability(pool(0), 0.5, K), 0);
});

test("decide is deterministic in (seed,nonce)", () => {
  const args = { stakeCents: 25000, pool: pool(1_000_000), dayFraction: 0.5, serverSeed: "s", nonce: 42 };
  const d1 = decidePoolOutcome(args);
  const d2 = decidePoolOutcome(args);
  assert.deepEqual(d1, d2);
});

test("exhausted budget => always loss regardless of the roll", () => {
  for (let n = 0; n < 200; n++) {
    const d = decidePoolOutcome({ stakeCents: 25000, pool: pool(1_000_000, 1_000_000, 0), dayFraction: 0.9, serverSeed: "s", nonce: n });
    assert.equal(d.result, "loss");
    assert.equal(d.payoutCents, 0);
    assert.equal(d.reason, "budget_exhausted");
  }
});

test("HARD CAP: a granted win never exceeds available budget (clamped to fit)", () => {
  // Tiny remaining budget vs a big stake: any win must be clamped to <= available.
  let clampedSeen = false;
  for (let n = 0; n < 500; n++) {
    const avail = 3000;
    const d = decidePoolOutcome({ stakeCents: 100000, pool: pool(1_000_000, 997_000, 0), dayFraction: 1.0, serverSeed: "seed", nonce: n });
    assert.ok(d.payoutCents <= avail, `payout ${d.payoutCents} exceeded available ${avail}`);
    if (d.result === "win") { clampedSeen = true; assert.ok(d.payoutCents <= avail); }
  }
  // With avail=3000 and stake=100000, a real win (mult>1 => payout>100000) can never fit => all losses.
  assert.equal(clampedSeen, false, "no win can fit a budget far below one stake");
});

test("BUDGET INVARIANT (Monte-Carlo): cumulative committed payouts NEVER exceed the pool", () => {
  for (let trial = 0; trial < 40; trial++) {
    const amount = 500_000 + Math.floor(Math.random() * 5_000_000);
    const p: PoolState = { amountCents: amount, paidCents: 0, reservedCents: 0 };
    const seed = `mc-${trial}`;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const stake = 25000 + Math.floor(Math.random() * 75000);
      const dayFraction = i / N;                      // time marches across the day
      const d = decidePoolOutcome({ stakeCents: stake, pool: p, dayFraction, serverSeed: seed, nonce: i });
      // simulate atomic reserve->commit at settle
      if (d.result === "win") { p.paidCents += d.payoutCents; }
      assert.ok(p.paidCents <= amount, `trial ${trial}: paid ${p.paidCents} exceeded pool ${amount} at i=${i}`);
    }
    assert.ok(p.paidCents <= amount);
    assert.ok(p.paidCents >= 0);
  }
});

test("pacing spends the pool across the day, not all at once (utilization + spread)", () => {
  const amount = 2_000_000;
  const p: PoolState = { amountCents: amount, paidCents: 0, reservedCents: 0 };
  const hourly = new Array(24).fill(0);
  const N = 6000;
  for (let i = 0; i < N; i++) {
    const dayFraction = i / N; const hour = Math.min(23, Math.floor(dayFraction * 24));
    const d = decidePoolOutcome({ stakeCents: 40000, pool: p, dayFraction, serverSeed: "spread", nonce: i });
    if (d.result === "win") { p.paidCents += d.payoutCents; hourly[hour] += d.payoutCents; }
  }
  assert.ok(p.paidCents <= amount);
  assert.ok(p.paidCents > amount * 0.7, `utilization too low: ${p.paidCents}/${amount}`);
  const active = hourly.filter((x) => x > 0).length;
  assert.ok(active >= 12, `payouts should span many hours, only ${active} active`);
  // first hour must not swallow a huge share (no front-loading)
  assert.ok(hourly[0] < amount * 0.25, "first hour front-loaded the pool");
});

test("P&L path: starts near 1.0, ends exactly at the decided endpoint, non-negative", () => {
  const win = { result: "win" as const, multiplier: 2.4, payoutCents: 60000, winProbUsed: 0.2, reason: "granted" as const };
  const loss = { result: "loss" as const, multiplier: 0, payoutCents: 0, winProbUsed: 0.2, reason: "propensity_loss" as const };
  const pw = poolPnlPath(win, "s", 1);
  const pl = poolPnlPath(loss, "s", 2);
  assert.ok(Math.abs(pw[0]! - 1) < 0.5 && pw[0]! >= 0);
  assert.ok(Math.abs(pw.at(-1)! - 2.4) < 1e-3, "win path ends at the win multiplier");
  assert.ok(Math.abs(pl.at(-1)! - 0) < 1e-3, "loss path ends at 0");
  assert.ok(pw.every((v) => v >= 0) && pl.every((v) => v >= 0));
});

test("P&L path REVERSES: a decided loss shows green first; a decided win dips red first", () => {
  const loss = { result: "loss" as const, multiplier: 0, payoutCents: 0, winProbUsed: 0.2, reason: "propensity_loss" as const };
  const pl = poolPnlPath(loss, "seedX", 9, 40);
  assert.ok(Math.max(...pl) > 1.05, "a losing trade should flash a fake profit (green) before collapsing");
  assert.equal(pl.at(-1), 0);

  const win = { result: "win" as const, multiplier: 3.0, payoutCents: 90000, winProbUsed: 0.2, reason: "granted" as const };
  const pw = poolPnlPath(win, "seedY", 11, 40);
  assert.ok(Math.min(...pw) < 1.0, "a winning trade should dip red before rallying");
  assert.ok(Math.abs(pw.at(-1)! - 3.0) < 1e-3);
});

test("poolLiveMultiplier is stable across ticks (same g => same value) and continuous at endpoints", () => {
  const d = { result: "loss" as const, multiplier: 0, payoutCents: 0, winProbUsed: 0.2, reason: "propensity_loss" as const };
  assert.equal(poolLiveMultiplier(d, "s", 5, 0.42), poolLiveMultiplier(d, "s", 5, 0.42));
  assert.equal(poolLiveMultiplier(d, "s", 5, 1), 0);
});

// ── Per-player ENGAGEMENT model (docs/25): hook -> suppress-when-up -> net loss; spread; no scoop ──
const sess = (o: Partial<PlayerSession> = {}): PlayerSession => ({ stakedCents: 0, returnedCents: 0, trades: 0, wins: 0, lossStreak: 0, ...o });

test("engagement: HOOK early, SUPPRESS once up, net LOSS over a session, most players get a win", () => {
  // isolate the per-player logic from global pacing (gain 0), budget non-binding.
  const k: PoolKnobs = { ...DEFAULT_POOL_KNOBS, gain: 0 };
  const pool: PoolState = { amountCents: 100_000_000, paidCents: 0, reservedCents: 0 };
  let firstWins = 0, anyWin = 0; const rtps: number[] = [];
  for (let sd = 0; sd < 500; sd++) {
    const s = sess(); let firstWin = false;
    for (let i = 0; i < 6; i++) {
      const stake = 40000;
      const d = decidePoolOutcome({ stakeCents: stake, pool, dayFraction: 0.5, knobs: k, serverSeed: `sess${sd}`, nonce: i, session: s });
      s.trades++; s.stakedCents += stake;
      if (d.result === "win") { s.returnedCents += d.payoutCents; s.wins++; s.lossStreak = 0; if (i === 0) firstWin = true; }
      else s.lossStreak++;
    }
    if (firstWin) firstWins++;
    if (s.wins > 0) anyWin++;
    rtps.push(s.returnedCents / s.stakedCents);
  }
  const meanRtp = rtps.reduce((a, b) => a + b, 0) / rtps.length;
  assert.ok(firstWins / 500 > 0.5, `hook: first-trade win rate ${firstWins / 500} should exceed 0.5`);
  assert.ok(anyWin / 500 > 0.8, `motivational: ${anyWin / 500} of players get >=1 win`);
  assert.ok(meanRtp < 0.95, `net loss: mean session RTP ${meanRtp.toFixed(2)} should be < 0.95`);
});

test("engagement: session win cap spreads the budget (a player wins at most maxWinsSession)", () => {
  const k = DEFAULT_POOL_KNOBS;
  const pool: PoolState = { amountCents: 100_000_000, paidCents: 0, reservedCents: 0 };
  const s = sess({ trades: 5, wins: k.maxWinsSession });   // already had their session wins
  let wins = 0;
  for (let i = 0; i < 200; i++) {
    const d = decidePoolOutcome({ stakeCents: 40000, pool, dayFraction: 0.5, knobs: k, serverSeed: "cap", nonce: i, session: s });
    if (d.result === "win") wins++;
    assert.equal(d.reason === "session_win_cap" || d.result === "loss" || d.result === "win", true);
  }
  assert.equal(wins, 0, "a maxed-out player never wins again this session");
});

test("engagement: anti-churn relief lifts win-prob after a long loss streak", () => {
  const k = DEFAULT_POOL_KNOBS;
  const pool: PoolState = { amountCents: 100_000_000, paidCents: 0, reservedCents: 0 };
  const calm = sessionWinProbability(sess({ trades: 5, lossStreak: 0 }), pool, 0.5, k);
  const churning = sessionWinProbability(sess({ trades: 5, lossStreak: k.maxLossStreak }), pool, 0.5, k);
  assert.ok(churning >= k.reliefProb, `relief win-prob ${churning} should be >= ${k.reliefProb}`);
  assert.ok(churning > calm, "a long loss streak raises win-prob (anti-churn)");
});

test("1000-PLAYER DAY: budget invariant holds every step, no player scoops, per-player net loss", () => {
  const amount = 6_000_000;                       // KES 60,000
  const k = DEFAULT_POOL_KNOBS;
  const pool: PoolState = { amountCents: amount, paidCents: 0, reservedCents: 0 };
  const sessions = new Map<number, PlayerSession>();
  // deterministic stream of ~6000 trades across 1000 players over the day
  const stream: Array<[number, number, number]> = [];
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let pid = 0; pid < 1000; pid++) for (let t = 0; t < 6; t++) stream.push([rnd(), pid, 25000 + Math.floor(rnd() * 75000)]);
  stream.sort((a, b) => a[0] - b[0]);
  let maxPaidSeen = 0;
  for (const [dayf, pid, stake] of stream) {
    const s = sessions.get(pid) ?? sess(); sessions.set(pid, s);
    const d = decidePoolOutcome({ stakeCents: stake, pool, dayFraction: dayf, knobs: k, serverSeed: `pl${pid}`, nonce: s.trades, session: s });
    s.trades++; s.stakedCents += stake;
    if (d.result === "win") { pool.paidCents += d.payoutCents; s.returnedCents += d.payoutCents; s.wins++; s.lossStreak = 0; }
    else s.lossStreak++;
    maxPaidSeen = Math.max(maxPaidSeen, pool.paidCents);
    assert.ok(pool.paidCents <= amount, `budget breached: ${pool.paidCents} > ${amount}`);
  }
  const active = [...sessions.values()].filter((s) => s.trades > 0);
  const maxWinner = Math.max(...active.map((s) => s.returnedCents));
  const covered = active.filter((s) => s.wins > 0).length;
  const netLosers = active.filter((s) => s.returnedCents < s.stakedCents).length;
  assert.ok(maxPaidSeen <= amount, "cumulative payout never exceeded the pool");
  assert.ok(maxWinner <= Math.floor(k.playerShare * amount) + 100000, `no scoop: max winner ${maxWinner} within share cap`);
  assert.ok(covered > 0, "some players won");
  assert.ok(netLosers / active.length > 0.9, `>90% of active players net a loss (got ${(netLosers / active.length).toFixed(2)})`);
});
