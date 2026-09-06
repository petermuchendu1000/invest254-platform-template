import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurveGenerator, SettlementEngine, DEFAULT_CONFIG, DEFAULT_POOL_KNOBS,
  instrumentById, DEFAULT_INSTRUMENT_ID, poolMultiplierDurationMs,
} from "@invest254/shared";
import { GameServer, type ActiveContext } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";
import { PoolController, InMemoryPoolRepo, eatDay } from "./poolcontroller.js";
import { RecoveryService } from "./recovery.js";
import type { SeedManager } from "./daycontext.js";

/**
 * docs/25 applied to MULTIPLIERS — pool-mode multipliers are timed bracket contracts decided at open:
 * WIN auto-closes at exactly +TP (reserve→commit), LOSS stops out at −stake; SL/DC/manual close are
 * unavailable; digits + multipliers + rise/fall share ONE central budget; crash recovery resumes or
 * settles from the persisted decision.
 */
const SITE = "site-pool-mult";
const SEED = "deadbeefcafe";
const cfg = { ...DEFAULT_CONFIG };
cfg.minWithdrawalCents = 999_999_999;
const curve = new CurveGenerator(SEED, cfg);
const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600);
const DAY_START = Date.UTC(2026, 8, 5, 0, 0, 0);
const T0 = Date.UTC(2026, 8, 5, 9, 0, 0);
const STAKE = 25_000;
const TP = STAKE;                       // default +100% upside ⇒ candidate payout 50,000, m = 2
const CANDIDATE = STAKE + TP;
const inst = instrumentById(DEFAULT_INSTRUMENT_ID);

function makeGame(poolOn: boolean, amountCents: number) {
  const repo = new InMemoryGameRepository();
  const poolRepo = new InMemoryPoolRepo();
  let clock = T0;
  const now = () => clock;
  const day = eatDay(T0);
  poolRepo.setPool(SITE, day, amountCents);
  const controller = new PoolController(poolRepo, DEFAULT_POOL_KNOBS, now);
  const ctx: ActiveContext = { curve, settlement, dayStartMs: DAY_START, gameDayId: 1, seed: SEED, configVersion: 0, siteId: SITE };
  const game = new GameServer(() => ctx, repo, () => cfg, now, undefined, { enabled: () => poolOn, controller });
  const index = () => Math.floor((clock - DAY_START) / inst.tickMs);
  return { repo, poolRepo, controller, game, ctx, day, now, index, advance: (ms: number) => { clock += ms; } };
}

/** Advance past the decided window and drive the tick hook until the contract closes. */
async function runToClose(h: ReturnType<typeof makeGame>) {
  h.advance(61_000); // > max seeded duration (60s)
  const { closed } = await h.game.tickMultipliers(inst.id, h.index());
  return closed;
}

test("pool multiplier WIN: reserved at open, auto-closes at exactly +TP, committed", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p1", 100_000_000);
  let winId: string | null = null;
  for (let i = 0; i < 200 && !winId; i++) {
    const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: 100, role: "player" });
    assert.equal(open.poolControlled, true);
    assert.equal(open.tpCents, TP, "pool mode defaults TP to +100% of stake");
    assert.equal(open.slCents, null, "SL unavailable in pool mode");
    assert.equal(open.dcUntilMs, null, "DC unavailable in pool mode");
    const st = await h.poolRepo.poolState(SITE, h.day);
    if (st.reservedCents >= CANDIDATE) { winId = open.positionId; break; }
    const closed = await runToClose(h); // a decided loss: run it out
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.reason, "stopout");
    assert.equal(closed[0]!.payoutCents, 0, "decided loss stops out at −stake");
  }
  assert.ok(winId, "expected a pool-decided multiplier win");
  const balBefore = await h.repo.getBalance("p1");
  const closed = await runToClose(h);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.positionId, winId);
  assert.equal(closed[0]!.reason, "tp");
  assert.equal(closed[0]!.payoutCents, CANDIDATE, "win pays exactly stake + TP");
  assert.equal(await h.repo.getBalance("p1") - balBefore, CANDIDATE);
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(st.reservedCents, 0, "reservation committed");
  assert.ok(st.paidCents >= CANDIDATE);
});

test("pool multiplier: live P/L follows the reversing decided path and ends at the endpoint", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p1", 100_000_000);
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: 100, role: "player" });
  // mid-flight: an update (not a close) with a finite P/L ≥ −stake
  h.advance(5_000);
  const mid = await h.game.tickMultipliers(inst.id, h.index());
  assert.equal(mid.closed.length, 0);
  assert.equal(mid.updates.length, 1);
  assert.ok(mid.updates[0]!.pnlCents >= -STAKE && Number.isFinite(mid.updates[0]!.pnlCents));
  const live = h.game.liveMultiplierPnl(open.positionId);
  assert.ok(live !== null && live >= -STAKE);
  const closed = await runToClose(h);
  assert.equal(closed.length, 1);
});

test("pool mode: manual close is DISABLED (a player can never cash the green feint)", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p1", 100_000_000);
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: 100, role: "player" });
  await assert.rejects(() => h.game.closeMultiplierContract(open.positionId, "p1"), /CLOSE_DISABLED/);
  await runToClose(h);
});

test("CENTRAL BUDGET: digits + multipliers share ONE pool; cap and RTP ceiling hold together", async () => {
  const amount = 400_000; // no-scoop share 60,000 > both fixed payouts (47,500 and 50,000)
  const h = makeGame(true, amount);
  const users = Array.from({ length: 8 }, (_, k) => `u${k}`);
  for (const u of users) h.repo.seed(u, 100_000_000);
  const TARGET_RTP = Math.min(0.95, Math.max(0.05, 1 - cfg.houseEdge));
  let turnover = 0;
  for (let i = 0; i < 200; i++) {
    const u = users[i % users.length]!;
    turnover += STAKE;
    if (i % 2 === 0) {
      const open = await h.game.openDigitContract({ userId: u, stakeCents: STAKE, kind: "even", role: "player" });
      await h.game.settleDigitContract(open.positionId);
    } else {
      await h.game.openMultiplierContract({ userId: u, stakeCents: STAKE, dir: "up", multiplier: 100, role: "player" });
      const closed = await runToClose(h);
      assert.equal(closed.length, 1);
    }
    const st = await h.poolRepo.poolState(SITE, h.day);
    assert.ok(st.paidCents + st.reservedCents <= amount, `cash breach at i=${i}`);
    assert.ok(st.paidCents <= Math.floor(TARGET_RTP * turnover), `RTP breach at i=${i}`);
  }
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.ok(st.paidCents > 0, "some wins were paid within the shared budget");
});

test("MARKETER exemption: statistical multiplier on the feed; pool untouched; manual close allowed", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("m", 100_000_000);
  const before = await h.poolRepo.poolState(SITE, h.day);
  const open = await h.game.openMultiplierContract({ userId: "m", stakeCents: STAKE, dir: "up", multiplier: 50, role: "marketer" });
  assert.equal(open.poolControlled, false);
  h.advance(3_000);
  const res = await h.game.closeMultiplierContract(open.positionId, "m");
  assert.equal(res.reason, "manual");
  const after = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(after.paidCents, before.paidCents);
  assert.equal(after.reservedCents, 0);
});

test("CRASH RECOVERY: in-flight decided multiplier re-arms; elapsed one settles from the decision", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p1", 100_000_000);
  // find an in-flight decided WIN (reserved, unsettled)
  let winOpen: Awaited<ReturnType<typeof h.game.openMultiplierContract>> | null = null;
  for (let i = 0; i < 200 && !winOpen; i++) {
    const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: 100, role: "player" });
    const st = await h.poolRepo.poolState(SITE, h.day);
    if (st.reservedCents >= CANDIDATE) { winOpen = open; break; }
    await runToClose(h);
  }
  assert.ok(winOpen, "need an in-flight decided win");
  const decision = await h.controller.getDecision(winOpen.positionId);
  assert.ok(decision && decision.result === "win");
  const duration = poolMultiplierDurationMs(decision.seed, decision.nonce);

  // Crash #1 (mid-window): fresh engine + recovery ⇒ RE-ARM (not settle)
  const ctx = h.ctx;
  const seedsStub = { contextFor: async () => ({ ...ctx, cfg }) } as unknown as SeedManager;
  const fresh1 = new GameServer(() => ctx, h.repo, () => cfg, h.now, undefined, { enabled: () => true, controller: h.controller });
  const rec1 = new RecoveryService(h.repo, seedsStub, fresh1, h.now, undefined, SITE, h.controller);
  const r1 = await rec1.recover();
  assert.equal(r1.rearmed, 1, "mid-window decided multiplier re-arms");
  // the re-armed contract then runs to its decided endpoint on the fresh engine
  h.advance(duration + 1000);
  const closed = await fresh1.tickMultipliers(inst.id, h.index());
  assert.equal(closed.closed.length, 1);
  assert.equal(closed.closed[0]!.payoutCents, CANDIDATE, "re-armed win pays exactly the stored decision");
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(st.reservedCents, 0, "reservation committed after the re-armed settle");

  // Crash #2 (after the window, unsettled): recovery settles DIRECTLY from the decision, idempotently.
  // Life continues on the SURVIVING engine (fresh1) — the crashed server's memory is gone.
  let winOpen2: Awaited<ReturnType<typeof h.game.openMultiplierContract>> | null = null;
  for (let i = 0; i < 200 && !winOpen2; i++) {
    const open = await fresh1.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: 100, role: "player" });
    const stx = await h.poolRepo.poolState(SITE, h.day);
    if (stx.reservedCents >= CANDIDATE) { winOpen2 = open; break; }
    h.advance(61_000);
    const out = await fresh1.tickMultipliers(inst.id, h.index());
    assert.equal(out.closed.length, 1);
  }
  assert.ok(winOpen2, "need a second in-flight decided win");
  h.advance(61_000); // window elapses during the outage
  const fresh2 = new GameServer(() => ctx, h.repo, () => cfg, h.now, undefined, { enabled: () => true, controller: h.controller });
  const rec2 = new RecoveryService(h.repo, seedsStub, fresh2, h.now, undefined, SITE, h.controller);
  const balBefore = await h.repo.getBalance("p1");
  const r2 = await rec2.recover();
  assert.equal(r2.settled, 1, "elapsed decided multiplier settles on recovery");
  assert.equal(await h.repo.getBalance("p1") - balBefore, CANDIDATE);
  const again = await rec2.recover();
  assert.equal(again.scanned, 0, "idempotent");
});
