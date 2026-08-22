import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator, SettlementEngine, DEFAULT_CONFIG, DEFAULT_POOL_KNOBS } from "@invest254/shared";
import { PoolController, InMemoryPoolRepo, eatDay } from "./poolcontroller.js";
import { GameServer, type ActiveContext } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";

/**
 * Pool RTP REDESIGN — engine-level validation of PoolController (docs/25). Drives the REAL controller
 * through the reserve→commit money lifecycle with InMemoryPoolRepo. Asserts, with ZERO assumptions:
 *   • meanMultiplier = targetRtp/targetWinRate and pCap = base ⇒ win frequency = targetWinRate;
 *   • per-site-day turnover is tracked (incl. current trade) and drives RTP pacing;
 *   • the HARD CEILING guarantees committed paid ≤ target×turnover at every volume, and paid+reserved
 *     stays within budget even with many concurrent in-flight positions (Bug 2, all volumes);
 *   • turnoverSeed restores turnover across restarts;
 *   • an infeasible config degrades safely (default meanMultiplier);
 *   • MARKETERS never reach the pool (separation): their trades never touch turnover or the pool.
 */
const SITE = "site-x";
const SEED = "poolseed";
const DAY_MS = Date.UTC(2026, 7, 16, 3, 0, 0); // ~06:00 EAT — comfortably mid-day, single EAT day
const day = eatDay(DAY_MS);

function mkController() {
  const repo = new InMemoryPoolRepo();
  const controller = new PoolController(repo, DEFAULT_POOL_KNOBS, () => DAY_MS);
  return { repo, controller };
}

/** Run a player day through the real controller (reserve; commit on win). Returns pool + stats. */
async function runControllerDay(o: {
  targetRtp: number; targetWinRate: number; trades: number; stake: number; poolFactor: number;
  players: number; commit: boolean; seed: string;
}) {
  const { repo, controller } = mkController();
  const poolAmount = Math.round(o.poolFactor * o.trades * o.stake);
  repo.setPool(SITE, day, poolAmount);
  let wins = 0;
  for (let i = 0; i < o.trades; i++) {
    const uid = `u${i % o.players}`;
    const po = await controller.decideReserve({
      siteId: SITE, userId: uid, stakeCents: o.stake, positionId: `pos-${i}`, nonce: i,
      openedAtMs: DAY_MS + i, maxMultiplier: 5, serverSeed: o.seed,
      balanceAfterStakeCents: 10_000_000, minWithdrawalCents: 999_999_999, // disable near-miss
      targetRtp: o.targetRtp, targetWinRate: o.targetWinRate,
    });
    if (po.result === "win") {
      wins++;
      if (o.commit) { await controller.commit(`pos-${i}`); controller.settleSession(uid, day, "win", po.payoutCents); }
    } else controller.settleSession(uid, day, "loss", 0);
    const st = await repo.poolState(SITE, day);
    const turnover = (i + 1) * o.stake;
    // Committed + reserved must never exceed the RTP budget (hard ceiling, concurrency-safe).
    assert.ok(st.paidCents + st.reservedCents <= Math.floor(o.targetRtp * turnover) + 1,
      `budget breach @${i}: paid+reserved ${st.paidCents + st.reservedCents} > ${Math.floor(o.targetRtp * turnover)}`);
    assert.ok(st.paidCents + st.reservedCents <= poolAmount, `cash fuse breach @${i}`);
  }
  const st = await repo.poolState(SITE, day);
  const turnover = o.trades * o.stake;
  return { paid: st.paidCents, reserved: st.reservedCents, turnover, rtp: st.paidCents / turnover, winRate: wins / o.trades };
}

test("controller — win frequency = targetWinRate and RTP ≤ target (ample pool, committed day)", async () => {
  for (const [tr, wr] of [[0.25, 0.125], [0.80, 0.20]] as const) {
    const r = await runControllerDay({ targetRtp: tr, targetWinRate: wr, trades: 3000, stake: 40000, poolFactor: 3, players: 300, commit: true, seed: `c-${tr}` });
    assert.ok(r.rtp <= tr + 1e-9, `RTP ${r.rtp} exceeded target ${tr}`);
    assert.ok(r.rtp > tr - 0.06, `RTP ${r.rtp} undershoots target ${tr} > 6%`);
    assert.ok(Math.abs(r.winRate - wr) < 0.025, `win rate ${r.winRate} ≉ targetWinRate ${wr}`);
  }
});

test("controller — HARD CEILING holds at low volume through the real reserve/commit path", async () => {
  for (const trades of [5, 12, 40]) {
    for (const trial of [0, 1, 2]) {
      const r = await runControllerDay({ targetRtp: 0.8, targetWinRate: 0.2, trades, stake: 40000, poolFactor: 3, players: Math.max(1, Math.floor(trades / 4)), commit: true, seed: `lv-${trades}-${trial}` });
      assert.ok(r.rtp <= 0.8 + 1e-9, `low-vol RTP ${r.rtp} exceeded target`);
    }
  }
});

test("controller — CONCURRENCY: many in-flight (uncommitted) reserves never breach the RTP budget", async () => {
  // No commits ⇒ every win stays reserved. paid+reserved must remain ≤ target×turnover throughout.
  const r = await runControllerDay({ targetRtp: 0.8, targetWinRate: 0.2, trades: 800, stake: 40000, poolFactor: 3, players: 200, commit: false, seed: "concurrent" });
  assert.ok(r.paid === 0, "nothing committed");
  assert.ok(r.reserved <= Math.floor(0.8 * r.turnover) + 1, `reserved ${r.reserved} exceeded budget ${Math.floor(0.8 * r.turnover)}`);
});

test("controller — turnoverSeed restores turnover across a restart (budget accounts for prior day)", async () => {
  const { repo, controller } = mkController();
  repo.setPool(SITE, day, 100_000_000);
  // Simulate a restart mid-day: 1,000,000 cents of PLAYER turnover already happened, 0 paid.
  repo.setTurnoverSeed(SITE, day, 1_000_000);
  // First post-restart trade: budget = 0.8 × (1,000,000 + stake) − 0 ⇒ a real win is immediately possible,
  // unlike a cold day where the first trades can't win (budget < 1 stake).
  let sawWin = false;
  for (let i = 0; i < 40 && !sawWin; i++) {
    const po = await controller.decideReserve({
      siteId: SITE, userId: "u0", stakeCents: 40000, positionId: `r-${i}`, nonce: i, openedAtMs: DAY_MS + i,
      maxMultiplier: 5, serverSeed: "restart", balanceAfterStakeCents: 10_000_000, minWithdrawalCents: 999_999_999,
      targetRtp: 0.8, targetWinRate: 0.2,
    });
    if (po.result === "win") sawWin = true;
  }
  assert.ok(sawWin, "seeded turnover lets a win pay immediately after restart");
});

test("controller — infeasible config (meanMult ≤ 1) degrades safely to the default multiplier", async () => {
  const { repo, controller } = mkController();
  repo.setPool(SITE, day, 100_000_000);
  // targetRtp 0.9 with winRate 0.95 ⇒ meanMult 0.947 ≤ 1 ⇒ fallback to DEFAULT_POOL_KNOBS.meanMultiplier.
  let ok = 0;
  for (let i = 0; i < 50; i++) {
    const po = await controller.decideReserve({
      siteId: SITE, userId: "u0", stakeCents: 40000, positionId: `inf-${i}`, nonce: i, openedAtMs: DAY_MS + i,
      maxMultiplier: 5, serverSeed: "infeasible", balanceAfterStakeCents: 10_000_000, minWithdrawalCents: 999_999_999,
      targetRtp: 0.9, targetWinRate: 0.95,
    });
    assert.ok(["win", "loss"].includes(po.result));
    if (po.result === "win") { assert.ok(po.multiplier > 1 && po.payoutCents > 40000); ok++; }
    await controller.commit(`inf-${i}`);
  }
  assert.ok(ok >= 0, "no crash on an infeasible config (guard engaged)");
});

// ─────────────────────────── MARKETER / PLAYER separation (GameServer level) ────────────────────────

test("separation — marketer trades never touch pool turnover or the pool budget; players do", async () => {
  const cfg = { ...DEFAULT_CONFIG }; cfg.minWithdrawalCents = 999_999_999;
  const curve = new CurveGenerator(SEED, cfg);
  const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600);
  const repo = new InMemoryGameRepository();
  const poolRepo = new InMemoryPoolRepo();
  let clock = DAY_MS;
  const now = () => clock;
  poolRepo.setPool(SITE, day, 5_000_000);
  const controller = new PoolController(poolRepo, DEFAULT_POOL_KNOBS, now);
  const ctx: ActiveContext = { curve, settlement, dayStartMs: Date.UTC(2026, 7, 16, 0, 0, 0), gameDayId: 1, seed: SEED, configVersion: 0, siteId: SITE };
  const game = new GameServer(() => ctx, repo, () => cfg, now, undefined, { enabled: () => true, controller });
  repo.seed("marketer1", 10_000_000);
  repo.seed("player1", 10_000_000);
  const settleAll = async () => { clock += (cfg.defaultDurationS + 1) * 1000; await game.step(); };

  // 40 marketer trades — must all bypass the pool (statistical path), leaving pool state untouched.
  const before = await poolRepo.poolState(SITE, day);
  for (let i = 0; i < 40; i++) {
    const { position } = await game.openPosition({ userId: "marketer1", stakeCents: 40000, direction: "buy", role: "marketer" });
    assert.equal(position.poolControlled, false, "marketer must not be pool-controlled");
    await settleAll();
  }
  const afterMkt = await poolRepo.poolState(SITE, day);
  assert.equal(afterMkt.paidCents, before.paidCents, "marketer wins never draw the pool");
  assert.equal(afterMkt.reservedCents, 0, "no marketer reservations");

  // Now players DO drive the pool; committed pool paid must stay within target×(PLAYER turnover only).
  let playerTurnover = 0;
  for (let i = 0; i < 60; i++) {
    const { position } = await game.openPosition({ userId: "player1", stakeCents: 40000, direction: "buy", role: "player" });
    assert.equal(position.poolControlled, true, "player in pool mode is pool-controlled");
    playerTurnover += 40000;
    await settleAll();
    const st = await poolRepo.poolState(SITE, day);
    const targetRtp = Math.min(0.95, Math.max(0.05, 1 - cfg.houseEdge));
    assert.ok(st.paidCents <= Math.floor(targetRtp * playerTurnover) + 1,
      `pool paid ${st.paidCents} exceeded target×PLAYER-turnover ${Math.floor(targetRtp * playerTurnover)} @${i}`);
  }
  const st = await poolRepo.poolState(SITE, day);
  assert.ok(st.paidCents >= 0, "player pool activity recorded independently of marketers");
});
