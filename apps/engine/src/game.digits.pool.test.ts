import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurveGenerator, SettlementEngine, DEFAULT_CONFIG, DEFAULT_POOL_KNOBS,
  evaluateDigit, digitAt, digitReturnCents, digitPayoutFactor,
  instrumentById, DEFAULT_INSTRUMENT_ID, type DigitKind,
} from "@invest254/shared";
import { GameServer, type ActiveContext } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";
import { PoolController, InMemoryPoolRepo, eatDay } from "./poolcontroller.js";
import { RecoveryService } from "./recovery.js";
import type { SeedManager } from "./daycontext.js";

/**
 * docs/25 applied to DIGITS — the pool brain governs Deriv-style digit contracts through every
 * real-life scenario: win reserve→commit, hard cash cap, exhaustion, the RTP-budget ceiling,
 * marketer exemption, ONE shared budget across rise/fall + digits (central control), pool-OFF
 * control, the one-open-contract rule, and crash recovery from the persisted decision.
 */
const SITE = "site-pool-digits";
const SEED = "deadbeefcafe";
const cfg = { ...DEFAULT_CONFIG };
cfg.minWithdrawalCents = 999_999_999; // withdrawal-line lever is unit-tested in pool.fixed.test.ts
const curve = new CurveGenerator(SEED, cfg);
const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600);
const DAY_START = Date.UTC(2026, 8, 5, 0, 0, 0);
const T0 = Date.UTC(2026, 8, 5, 9, 0, 0); // 12:00 EAT
const STAKE = 25_000;
const inst = instrumentById(DEFAULT_INSTRUMENT_ID);
const FIXED_PAYOUT = digitReturnCents(STAKE, "even", 0, digitPayoutFactor(cfg)); // 47500 (m=1.9)
const TARGET_RTP = Math.min(0.95, Math.max(0.05, 1 - cfg.houseEdge));            // 0.25

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
  return { repo, poolRepo, controller, game, ctx, day, now, advance: (ms: number) => { clock += ms; } };
}

async function openAndSettle(h: ReturnType<typeof makeGame>, userId: string, kind: DigitKind = "even", role = "player") {
  const open = await h.game.openDigitContract({ userId, stakeCents: STAKE, kind, role });
  const res = await h.game.settleDigitContract(open.positionId);
  return { open, res };
}

test("pool WIN: fixed payout reserved at open, committed at settle; digit consistent with the decision", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p1", 100_000_000);
  let win: { open: Awaited<ReturnType<typeof h.game.openDigitContract>>; } | null = null;
  for (let i = 0; i < 200 && !win; i++) {
    const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: "even", role: "player" });
    assert.equal(open.poolControlled, true, "player digit trade is pool-governed");
    const st = await h.poolRepo.poolState(SITE, h.day);
    if (st.reservedCents >= FIXED_PAYOUT) { win = { open }; break; }
    await h.game.settleDigitContract(open.positionId); // a decided loss; settle and try again
  }
  assert.ok(win, "expected at least one pool-decided digit win");
  const balBefore = await h.repo.getBalance("p1");
  const res = await h.game.settleDigitContract(win.open.positionId);
  assert.equal(res.won, true);
  assert.equal(res.payoutCents, FIXED_PAYOUT, "fixed-odds win pays exactly the contract return");
  assert.equal(evaluateDigit("even", 0, res.digit), true, "displayed digit is consistent with the decided WIN");
  assert.equal(await h.repo.getBalance("p1") - balBefore, FIXED_PAYOUT);
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(st.reservedCents, 0, "reservation committed");
  assert.ok(st.paidCents >= FIXED_PAYOUT, "pool paid reflects the win");
});

test("decided LOSS shows a digit that loses the player's prediction", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p1", 100_000_000);
  let sawLoss = false;
  for (let i = 0; i < 30 && !sawLoss; i++) {
    const { res } = await openAndSettle(h, "p1", "odd");
    if (!res.won) {
      sawLoss = true;
      assert.equal(evaluateDigit("odd", 0, res.digit), false, "loss digit must contradict the prediction");
      assert.equal(res.payoutCents, 0);
    }
  }
  assert.ok(sawLoss, "expected a decided loss");
});

test("HARD CAP + RTP CEILING: heavy digit demand never breaches pool or targetRtp × turnover", async () => {
  // Sized realistically: the no-scoop share (15% of the pool) must exceed the fixed 47,500 payout or
  // no single player can EVER win (that stricter behaviour is itself asserted in the exhaustion test).
  const amount = 400_000; // per-player share cap = 60,000 > 47,500
  const h = makeGame(true, amount);
  const users = Array.from({ length: 8 }, (_, k) => `u${k}`);
  for (const u of users) h.repo.seed(u, 100_000_000); // below the (disabled) withdrawal line
  let turnover = 0;
  let wins = 0;
  for (let i = 0; i < 400; i++) {
    turnover += STAKE;
    const { res } = await openAndSettle(h, users[i % users.length]!, "even");
    if (res.won) wins++;
    const st = await h.poolRepo.poolState(SITE, h.day);
    assert.ok(st.paidCents + st.reservedCents <= amount, `cash breach at i=${i}`);
    assert.ok(st.paidCents <= Math.floor(TARGET_RTP * turnover), `RTP breach at i=${i}: ${st.paidCents} > ${Math.floor(TARGET_RTP * turnover)}`);
  }
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.ok(st.paidCents > 0 && wins > 0, "some wins were paid within the budget");
});

test("EXHAUSTION: zero pool ⇒ every player digit trade loses", async () => {
  const h = makeGame(true, 0);
  h.repo.seed("p", 100_000_000);
  for (let i = 0; i < 25; i++) {
    const { res } = await openAndSettle(h, "p", "even");
    assert.equal(res.won, false, "no pool cash -> no player wins");
  }
});

test("MARKETER exemption: statistical fair digit; pool untouched", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("m", 100_000_000);
  const before = await h.poolRepo.poolState(SITE, h.day);
  for (let i = 0; i < 20; i++) {
    const open = await h.game.openDigitContract({ userId: "m", stakeCents: STAKE, kind: "even", role: "marketer" });
    assert.equal(open.poolControlled, false, "marketer digit trade bypasses the pool");
    const res = await h.game.settleDigitContract(open.positionId);
    const fair = digitAt(SEED, inst.id, open.settleIndex);
    assert.equal(res.digit, fair, "marketer settles on the provably-fair uniform digit");
    assert.equal(res.won, fair % 2 === 0);
  }
  const after = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(after.paidCents, before.paidCents, "marketer wins never draw the pool");
  assert.equal(after.reservedCents, 0);
});

test("CENTRAL BUDGET: rise/fall and digits draw from ONE pool — combined paid ≤ pool", async () => {
  const amount = 250_000;
  const h = makeGame(true, amount);
  h.repo.seed("p", 5_000_000_000);
  for (let i = 0; i < 120; i++) {
    if (i % 2 === 0) {
      await openAndSettle(h, "p", "even");
    } else {
      const { position } = await h.game.openPosition({ userId: "p", stakeCents: STAKE, direction: "buy", role: "player" });
      h.advance((cfg.defaultDurationS + 1) * 1000);
      await h.game.step();
      void position;
    }
    const st = await h.poolRepo.poolState(SITE, h.day);
    assert.ok(st.paidCents + st.reservedCents <= amount, `combined breach at i=${i}`);
  }
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.ok(st.paidCents <= amount);
});

test("pool OFF: digits settle on the provably-fair uniform digit; pool untouched", async () => {
  const h = makeGame(false, 5_000_000);
  h.repo.seed("p", 100_000_000);
  const open = await h.game.openDigitContract({ userId: "p", stakeCents: STAKE, kind: "even", role: "player" });
  assert.equal(open.poolControlled, false);
  const res = await h.game.settleDigitContract(open.positionId);
  assert.equal(res.digit, digitAt(SEED, inst.id, open.settleIndex));
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(st.paidCents, 0); assert.equal(st.reservedCents, 0);
});

test("one open digit contract per (user, instrument): a second open is rejected", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p", 100_000_000);
  const open = await h.game.openDigitContract({ userId: "p", stakeCents: STAKE, kind: "even", role: "player" });
  await assert.rejects(
    () => h.game.openDigitContract({ userId: "p", stakeCents: STAKE, kind: "odd", role: "player" }),
    /CONTRACT_EXISTS/,
  );
  await h.game.settleDigitContract(open.positionId); // after settle, a new one opens fine
  await h.game.openDigitContract({ userId: "p", stakeCents: STAKE, kind: "odd", role: "player" });
});

test("CRASH RECOVERY: an in-flight pool-decided digit settles from its STORED decision + commits", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p", 100_000_000);
  // open until an in-flight decided WIN exists (reserved > 0), do NOT settle it
  let winOpen: Awaited<ReturnType<typeof h.game.openDigitContract>> | null = null;
  for (let i = 0; i < 200 && !winOpen; i++) {
    const open = await h.game.openDigitContract({ userId: "p", stakeCents: STAKE, kind: "even", role: "player" });
    const st = await h.poolRepo.poolState(SITE, h.day);
    if (st.reservedCents >= FIXED_PAYOUT) { winOpen = open; break; }
    await h.game.settleDigitContract(open.positionId);
  }
  assert.ok(winOpen, "need an in-flight pool-decided digit win");
  const decision = await h.controller.getDecision(winOpen.positionId);
  assert.ok(decision && decision.result === "win" && decision.payoutCents === FIXED_PAYOUT, "decision persisted at open");

  // crash: fresh GameServer (empty maps) + recovery over the same repos
  const ctx = h.ctx;
  const seedsStub = { contextFor: async () => ({ ...ctx, cfg }) } as unknown as SeedManager;
  const fresh = new GameServer(() => ctx, h.repo, () => cfg, h.now, undefined, { enabled: () => true, controller: h.controller });
  const rec = new RecoveryService(h.repo, seedsStub, fresh, h.now, undefined, SITE, h.controller);
  const balBefore = await h.repo.getBalance("p");
  const report = await rec.recover();
  assert.equal(report.settled, 1);
  assert.equal(await h.repo.getBalance("p") - balBefore, FIXED_PAYOUT, "recovered payout == stored decision");
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(st.reservedCents, 0, "reservation committed on recovery");
  // idempotent second pass
  const again = await rec.recover();
  assert.equal(again.scanned, 0);
});
