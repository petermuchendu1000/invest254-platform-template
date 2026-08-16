import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator, SettlementEngine, DEFAULT_CONFIG, DEFAULT_POOL_KNOBS } from "@invest254/shared";
import { GameServer, type ActiveContext } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";
import { PoolController, InMemoryPoolRepo, eatDay } from "./poolcontroller.js";
import { SeedManager } from "./daycontext.js";
import { StaticConfigProvider } from "./gameconfig.js";
import { RecoveryService } from "./recovery.js";
import { DEFAULT_VERSIONED_CONFIG } from "@invest254/shared";

/**
 * docs/25 Phase 3b — the pool BRAIN inside the real GameServer, simulating every real-life scenario:
 * win+commit, hard-cap invariant under heavy demand, pool exhaustion, marketer exemption,
 * override-ignored-for-players, SELL disabled, reversing live path, pool-OFF control, and crash recovery.
 */
const SITE = "site-tamu";
const SEED = "deadbeefcafe";
const cfg = { ...DEFAULT_CONFIG };
const curve = new CurveGenerator(SEED, cfg);
const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600); // small samples = fast
const DAY_START = Date.UTC(2026, 7, 16, 0, 0, 0);
const T0 = Date.UTC(2026, 7, 16, 9, 0, 0);        // 12:00 EAT -> dayFraction 0.5

function makeGame(poolOn: boolean, amountCents: number, opts: { loadOverride?: any } = {}) {
  const repo = new InMemoryGameRepository();
  const poolRepo = new InMemoryPoolRepo();
  let clock = T0;
  const now = () => clock;
  const day = eatDay(T0);
  poolRepo.setPool(SITE, day, amountCents);
  const controller = new PoolController(poolRepo, DEFAULT_POOL_KNOBS, now);
  const ctx: ActiveContext = { curve, settlement, dayStartMs: DAY_START, gameDayId: 1, seed: SEED, configVersion: 0, siteId: SITE };
  const game = new GameServer(() => ctx, repo, () => cfg, now, opts.loadOverride, { enabled: () => poolOn, controller });
  return { repo, poolRepo, controller, game, day, advance: (ms: number) => { clock += ms; }, now: () => clock };
}
async function settleAll(g: ReturnType<typeof makeGame>) { g.advance((cfg.defaultDurationS + 1) * 1000); await g.game.step(); }

test("pool WIN: reserve at open -> commit at settle -> wallet credited, pool paid == payout", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p1", 10_000_000);
  // open until we get a pool-decided win (deterministic per nonce; a few tries suffice mid-day)
  let winPos: any = null;
  for (let i = 0; i < 60 && !winPos; i++) {
    const { position } = await h.game.openPosition({ userId: "p1", stakeCents: 25000, direction: "buy", role: "player" });
    if (position.poolControlled && position.outcome.result === "win") winPos = position; else await settleAll(h);
  }
  assert.ok(winPos, "expected at least one pool win");
  assert.equal(winPos.poolControlled, true);
  const st0 = await h.poolRepo.poolState(SITE, h.day);
  assert.ok(st0.reservedCents >= winPos.outcome.payoutCents, "win is reserved before settle");
  const balBefore = await h.repo.getBalance("p1");
  await settleAll(h);
  const balAfter = await h.repo.getBalance("p1");
  assert.equal(balAfter - balBefore, winPos.outcome.payoutCents, "wallet credited the decided payout");
  const st1 = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(st1.reservedCents, 0, "reservation released after commit");
  assert.ok(st1.paidCents >= winPos.outcome.payoutCents, "pool paid reflects the win");
});

test("HARD CAP invariant: under heavy demand, cumulative paid NEVER exceeds the pool", async () => {
  const amount = 200000;                                  // KES 2,000 pool
  const h = makeGame(true, amount);
  h.repo.seed("p", 1_000_000_000);
  let wins = 0;
  for (let i = 0; i < 500; i++) {
    const { position } = await h.game.openPosition({ userId: "p", stakeCents: 25000, direction: i % 2 ? "buy" : "sell", role: "player" });
    if (position.outcome.result === "win") wins++;
    await settleAll(h);
    const st = await h.poolRepo.poolState(SITE, h.day);
    assert.ok(st.paidCents + st.reservedCents <= amount, `breach at i=${i}: paid+reserved ${st.paidCents + st.reservedCents} > ${amount}`);
  }
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.ok(st.paidCents <= amount && st.paidCents > 0, `paid ${st.paidCents} within (0, ${amount}]`);
  assert.ok(wins > 0, "some wins were paid within budget");
});

test("EXHAUSTION: once the pool is spent, further player trades all lose", async () => {
  const h = makeGame(true, 60000);                        // tiny pool
  h.repo.seed("p", 1_000_000_000);
  for (let i = 0; i < 200; i++) { await h.game.openPosition({ userId: "p", stakeCents: 25000, direction: "buy", role: "player" }); await settleAll(h); }
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.ok(st.paidCents <= 60000);
  // now clearly exhausted -> next 20 trades must all be losses
  let lateWins = 0;
  for (let i = 0; i < 20; i++) { const { position } = await h.game.openPosition({ userId: "p", stakeCents: 25000, direction: "buy", role: "player" }); if (position.outcome.result === "win") lateWins++; await settleAll(h); }
  assert.equal(lateWins, 0, "no wins once the budget is exhausted");
});

test("MARKETER exemption: marketer trades bypass the pool entirely (statistical path)", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("m", 10_000_000);
  const before = await h.poolRepo.poolState(SITE, h.day);
  for (let i = 0; i < 30; i++) { const { position } = await h.game.openPosition({ userId: "m", stakeCents: 25000, direction: "buy", role: "marketer" }); assert.equal(position.poolControlled, false, "marketer is not pool-controlled"); await settleAll(h); }
  const after = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(after.paidCents, before.paidCents, "marketer wins never draw the pool");
  assert.equal(after.reservedCents, 0);
});

test("OVERRIDES ignored for players in pool mode; still applied to marketers", async () => {
  const loadOverride = async (uid: string) => ({ userId: uid, winRate: 0.99, houseEdge: 0.02, tradeDurationS: null, maxWinMultiplier: null, minStakeCents: null, maxStakeCents: null, notes: null, updatedBy: null, updatedAtMs: 0 });
  const h = makeGame(true, 5_000_000, { loadOverride });
  h.repo.seed("player", 10_000_000); h.repo.seed("mkt", 10_000_000);
  const { position: pp } = await h.game.openPosition({ userId: "player", stakeCents: 25000, direction: "buy", role: "player" });
  assert.equal(pp.poolControlled, true, "player override ignored -> governed by the pool");
  const { position: mp } = await h.game.openPosition({ userId: "mkt", stakeCents: 25000, direction: "buy", role: "marketer" });
  assert.equal(mp.poolControlled, false, "marketer keeps the statistical (override-driven) path");
});

test("SELL is disabled brand-wide in pool mode", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p", 10_000_000);
  const { position } = await h.game.openPosition({ userId: "p", stakeCents: 25000, direction: "buy", role: "player" });
  await assert.rejects(() => h.game.sell(position.id, "p"), /SELL_DISABLED/);
});

test("reversing live path: a decided LOSS shows green before collapsing to 0", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p", 10_000_000);
  let lossPos: any = null;
  for (let i = 0; i < 60 && !lossPos; i++) { const { position } = await h.game.openPosition({ userId: "p", stakeCents: 25000, direction: "buy", role: "player" }); if (position.outcome.result === "loss") lossPos = position; else await settleAll(h); }
  assert.ok(lossPos, "expected a pool loss");
  // sample the live path this position renders
  const vals: number[] = [];
  for (let k = 0; k <= 20; k++) vals.push(h.controller.live({ result: "loss", multiplier: 0, payoutCents: 0 }, SEED, lossPos.nonce, k / 20));
  assert.ok(Math.max(...vals) > 1.05, "loss flashes a fake profit (green) mid-trade");
  assert.equal(vals[vals.length - 1], 0, "loss ends at 0");
});

test("pool OFF: behaves statistically (control) — trades price from the curve, SELL allowed path", async () => {
  const h = makeGame(false, 5_000_000);
  h.repo.seed("p", 10_000_000);
  const { position } = await h.game.openPosition({ userId: "p", stakeCents: 25000, direction: "buy", role: "player" });
  assert.equal(position.poolControlled, false, "pool off -> statistical outcome");
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(st.paidCents, 0); assert.equal(st.reservedCents, 0);   // pool untouched when off
});

test("CRASH RECOVERY: an in-flight pool win is recovered from its stored decision, then committed", async () => {
  const h = makeGame(true, 5_000_000);
  h.repo.seed("p", 10_000_000);
  // open pool wins until one is in-flight (do NOT settle it)
  let win: any = null;
  for (let i = 0; i < 60 && !win; i++) { const { position } = await h.game.openPosition({ userId: "p", stakeCents: 25000, direction: "buy", role: "player" }); if (position.poolControlled && position.outcome.result === "win") win = position; else await settleAll(h); }
  assert.ok(win, "need an in-flight pool win");
  const reservedBefore = (await h.poolRepo.poolState(SITE, h.day)).reservedCents;
  assert.ok(reservedBefore >= win.outcome.payoutCents);

  // simulate a crash+restart: brand-new GameServer + SeedManager sharing the SAME repos, then recover
  const seeds = new SeedManager(SEED, new StaticConfigProvider(DEFAULT_VERSIONED_CONFIG), h.repo, h.now, {}, SITE);
  await seeds.init();
  const fresh = new GameServer(() => seeds.getActive(), h.repo, () => cfg, h.now, undefined, { enabled: () => true, controller: h.controller });
  h.advance((cfg.defaultDurationS + 1) * 1000);          // let it expire during the outage
  const rec = new RecoveryService(h.repo, seeds, fresh, h.now, undefined, SITE, h.controller);
  const balBefore = await h.repo.getBalance("p");
  const report = await rec.recover();
  assert.ok(report.settled >= 1, "recovered position settled");
  const balAfter = await h.repo.getBalance("p");
  assert.equal(balAfter - balBefore, win.outcome.payoutCents, "recovered win credited exactly the decided payout (from the stored decision, not the curve)");
  const st = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(st.reservedCents, 0, "reservation committed on recovery");
});
