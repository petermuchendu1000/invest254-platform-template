import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurveGenerator, SettlementEngine, DEFAULT_CONFIG, DEFAULT_POOL_KNOBS,
  instrumentById, DEFAULT_INSTRUMENT_ID, digitPayoutFactor, decideDigitAtWinRate,
} from "@invest254/shared";
import { GameServer, type ActiveContext, type LoadOverride } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";
import { PoolController, InMemoryPoolRepo, eatDay } from "./poolcontroller.js";
import { RecoveryService } from "./recovery.js";
import type { SeedManager } from "./daycontext.js";

/**
 * DEMO parity on the deriv-ui (docs/25): a demo/marketer account is pool-EXEMPT, and used to take the
 * raw contract odds on digits/multipliers — so it lost far more there than on the rise/fall line-graph,
 * where its outcome is decided at the enforced cohort win-rate. This proves the SAME win-frequency
 * control now governs the deriv-ui statistical path: a marketer wins at ~winRate on digits AND
 * multipliers, at FIXED odds, WITHOUT ever touching the real-cash pool; real players are unchanged;
 * and crash recovery settles to the identical decision.
 */
const SITE = "site-derivwr";
const SEED = "deadbeefcafe";
const cfg = { ...DEFAULT_CONFIG };
cfg.minWithdrawalCents = 999_999_999;
const curve = new CurveGenerator(SEED, cfg);
const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600);
const DAY_START = Date.UTC(2026, 8, 20, 0, 0, 0);
const T0 = Date.UTC(2026, 8, 20, 9, 0, 0);
const STAKE = 25_000;
const WR = 0.8;
const inst = instrumentById(DEFAULT_INSTRUMENT_ID);

const marketerOverride: LoadOverride = async (uid) =>
  uid === "m1"
    ? { userId: "m1", winRate: WR, houseEdge: null, tradeDurationS: null, maxWinMultiplier: null, minStakeCents: null, maxStakeCents: null, notes: null, updatedBy: null, updatedAtMs: 0 }
    : null;
const isM1: (u: string) => Promise<boolean> = async (u) => u === "m1";

function makeGame(poolOn = true, amountCents = 5_000_000) {
  const repo = new InMemoryGameRepository();
  const poolRepo = new InMemoryPoolRepo();
  let clock = T0;
  const now = () => clock;
  const day = eatDay(T0);
  poolRepo.setPool(SITE, day, amountCents);
  const controller = new PoolController(poolRepo, DEFAULT_POOL_KNOBS, now);
  const ctx: ActiveContext = { curve, settlement, dayStartMs: DAY_START, gameDayId: 1, seed: SEED, configVersion: 0, siteId: SITE };
  const game = new GameServer(() => ctx, repo, () => cfg, now, marketerOverride, { enabled: () => poolOn, controller }, isM1);
  const index = () => Math.floor((clock - DAY_START) / inst.tickMs);
  return { repo, poolRepo, controller, game, ctx, day, now, index, advance: (ms: number) => { clock += ms; } };
}

test("marketer DIGITS win at ~winRate (not the 10% natural 'matches' odds), at fixed odds, pool untouched", async () => {
  const h = makeGame();
  h.repo.markMarketer("m1");
  h.repo.seedDemo("m1", 100_000_000_000);
  const N = 3000;
  let wins = 0;
  const winPayout = Math.round((STAKE * 0.95) / 0.1); // 'matches' fixed odds = stake × factor / 0.1 = 9.5×
  for (let i = 0; i < N; i++) {
    const open = await h.game.openDigitContract({ userId: "m1", stakeCents: STAKE, kind: "matches", target: 3, role: "player" });
    assert.equal(open.poolControlled, true, "a marketer digit is decided (pre-committed), like the pool path");
    const s = await h.game.settleDigitContract(open.positionId);
    if (s.won) { wins++; assert.equal(s.payoutCents, winPayout, "a marketer win pays the contract's fixed odds"); }
  }
  const rate = wins / N;
  assert.ok(Math.abs(rate - WR) < 0.03, `marketer 'matches' win rate ${rate.toFixed(3)} ≈ ${WR} (natural is 0.10)`);
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(st.reservedCents, 0, "marketer digits never reserve the pool");
  assert.equal(st.paidCents, 0, "marketer digit wins never draw the pool");
});

test("marketer MULTIPLIERS win at ~winRate, fixed +TP upside, pool untouched", async () => {
  const h = makeGame();
  h.repo.markMarketer("m1");
  h.repo.seedDemo("m1", 100_000_000_000);
  const N = 1500;
  let wins = 0;
  for (let i = 0; i < N; i++) {
    const open = await h.game.openMultiplierContract({ userId: "m1", stakeCents: STAKE, dir: "up", multiplier: 100, role: "player" });
    assert.equal(open.poolControlled, true, "a marketer multiplier is decided");
    assert.equal(open.slCents, null, "decided ⇒ no SL");
    h.advance(61_000);
    const { closed } = await h.game.tickMultipliers(inst.id, h.index());
    assert.equal(closed.length, 1);
    if (closed[0]!.reason === "tp") { wins++; assert.equal(closed[0]!.payoutCents, STAKE + STAKE, "win pays stake + TP"); }
    else assert.equal(closed[0]!.payoutCents, 0, "loss stops out at −stake");
  }
  const rate = wins / N;
  assert.ok(Math.abs(rate - WR) < 0.04, `marketer multiplier win rate ${rate.toFixed(3)} ≈ ${WR}`);
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(st.reservedCents, 0, "marketer multipliers never reserve the pool");
  assert.equal(st.paidCents, 0, "marketer multiplier wins never draw the pool");
});

test("real player is UNCHANGED: their deriv-ui contracts still go through the pool", async () => {
  const h = makeGame();
  h.repo.seed("p1", 100_000_000);
  const openD = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: "matches", target: 3, role: "player" });
  assert.equal(openD.poolControlled, true, "a real player's digit is pool-decided");
  const openM = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: 100, role: "player" });
  assert.equal(openM.poolControlled, true, "a real player's multiplier is pool-decided");
  // The pool controller recorded a decision for each (win OR loss) — the real-money path is untouched.
  assert.ok((await h.controller.getDecision(openD.positionId)) !== null, "the pool decided the real player's digit");
  assert.ok((await h.controller.getDecision(openM.positionId)) !== null, "the pool decided the real player's multiplier");
});

test("crash recovery settles a marketer DIGIT to the identical (seed, nonce, winRate) decision", async () => {
  const h = makeGame();
  h.repo.markMarketer("m1");
  h.repo.seedDemo("m1", 100_000_000_000);
  const open = await h.game.openDigitContract({ userId: "m1", stakeCents: STAKE, kind: "matches", target: 3, role: "player" });
  const balAfterStake = await h.repo.getBalance("m1"); // stake already debited
  const row = (await h.repo.listOpenPositions()).find((r) => r.id === open.positionId)!;
  const expected = decideDigitAtWinRate(SEED, row.nonce, "matches", 3, WR, STAKE, digitPayoutFactor(cfg));

  const seedsStub = { contextFor: async () => ({ ...h.ctx, cfg }) } as unknown as SeedManager;
  const fresh = new GameServer(() => h.ctx, h.repo, () => cfg, h.now, marketerOverride, { enabled: () => true, controller: h.controller }, isM1);
  const rec = new RecoveryService(h.repo, seedsStub, fresh, h.now, marketerOverride, SITE, h.controller, isM1);
  const report = await rec.recover();
  assert.equal(report.settled, 1, "recovery settles the in-flight marketer digit, never strands it");
  assert.equal(await h.repo.getBalance("m1"), balAfterStake + (expected.won ? expected.payoutCents : 0),
    "recovery pays exactly the deterministic win-rate decision");
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(st.paidCents, 0, "recovery of a marketer contract never draws the pool");
});
