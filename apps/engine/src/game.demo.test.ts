import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator, SettlementEngine, DEFAULT_CONFIG, DEFAULT_POOL_KNOBS } from "@invest254/shared";
import { GameServer, type ActiveContext } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";
import { PoolController, InMemoryPoolRepo, eatDay } from "./poolcontroller.js";

/**
 * Decision F (docs/25 §8, migration 0084) — marketer/demo isolation, at the ENGINE layer.
 *
 * Proves: (1) the canonical `loadIsMarketer` predicate is AUTHORITATIVE over the JWT role claim, so
 * the pool exemption can never disagree with the money layer's demo routing; (2) a marketer's game
 * money lives entirely in the non-withdrawable demo bucket — gameplay NEVER touches real_balance;
 * (3) real players are completely unaffected.
 */
const SITE = "site-tamu";
const SEED = "deadbeefcafe";
const cfg = { ...DEFAULT_CONFIG };
cfg.minWithdrawalCents = 999_999_999; // disable the withdrawal-line lever here
const curve = new CurveGenerator(SEED, cfg);
const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600);
const DAY_START = Date.UTC(2026, 7, 16, 0, 0, 0);
const T0 = Date.UTC(2026, 7, 16, 9, 0, 0); // 12:00 EAT

function makeGame(opts: {
  poolOn?: boolean; amountCents?: number;
  isMarketer?: (userId: string) => Promise<boolean>;
} = {}) {
  const repo = new InMemoryGameRepository();
  const poolRepo = new InMemoryPoolRepo();
  let clock = T0;
  const now = () => clock;
  const day = eatDay(T0);
  poolRepo.setPool(SITE, day, opts.amountCents ?? 5_000_000);
  const controller = new PoolController(poolRepo, DEFAULT_POOL_KNOBS, now);
  const ctx: ActiveContext = { curve, settlement, dayStartMs: DAY_START, gameDayId: 1, seed: SEED, configVersion: 0, siteId: SITE };
  const pool = opts.poolOn ? { enabled: () => true, controller } : undefined;
  const game = new GameServer(() => ctx, repo, () => cfg, now, undefined, pool, opts.isMarketer);
  return { repo, poolRepo, controller, game, day, advance: (ms: number) => { clock += ms; } };
}
async function settleAll(h: ReturnType<typeof makeGame>) { h.advance((cfg.defaultDurationS + 1) * 1000); await h.game.step(); }

test("predicate is AUTHORITATIVE: role='player' but classified marketer -> pool-EXEMPT + demo-routed", async () => {
  const h = makeGame({ poolOn: true, isMarketer: async (u) => u === "m1" });
  h.repo.markMarketer("m1");
  h.repo.seedDemo("m1", 10_000_000);   // demo funds only
  // NOTE: no real balance seeded -> proves gameplay uses demo, not real.
  const { position } = await h.game.openPosition({ userId: "m1", stakeCents: 25000, direction: "buy", role: "player" });
  assert.equal(position.poolControlled, false, "classified marketer must be pool-exempt even with role='player'");
  const pool = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(pool.reservedCents, 0, "marketer trade must not reserve pool budget");
  assert.equal(await h.repo.getBalance("m1"), 10_000_000 - 25000, "stake debited from the demo bucket");
});

test("predicate is AUTHORITATIVE: role='marketer' but classified player -> POOL-controlled", async () => {
  const h = makeGame({ poolOn: true, isMarketer: async () => false });
  h.repo.seed("p1", 10_000_000);
  const { position } = await h.game.openPosition({ userId: "p1", stakeCents: 25000, direction: "buy", role: "marketer" });
  assert.equal(position.poolControlled, true, "role='marketer' must NOT exempt when the predicate says player");
});

test("marketer money isolation: real_balance is NEVER touched by gameplay (win or loss)", async () => {
  const h = makeGame({ poolOn: false, isMarketer: async (u) => u === "m1" });
  h.repo.markMarketer("m1");
  h.repo.seedDemo("m1", 10_000_000);
  h.repo.seed("m1", 500_000);                 // leftover real cash that must stay frozen
  // Force the real bucket to be observed before/after a batch of trades.
  const realBefore = 500_000;
  for (let i = 0; i < 40; i++) {
    await h.game.openPosition({ userId: "m1", stakeCents: 25000, direction: i % 2 ? "buy" : "sell", role: "marketer" });
    await settleAll(h);
  }
  // getBalance returns the DEMO bucket for a marketer; assert real stayed exactly frozen via the ledger.
  const realStakes = h.repo.ledger.filter((l) => l.userId === "m1" && l.balanceKind === "real" && l.type !== "seed");
  assert.equal(realStakes.length, 0, "no real-bucket stake/payout ledger entries for a marketer");
  const demoMoves = h.repo.ledger.filter((l) => l.userId === "m1" && l.balanceKind === "demo" && l.type !== "seed");
  assert.ok(demoMoves.length > 0, "all marketer gameplay flows through the demo bucket");
  // real leftover is untouched (only the seed entry exists for real)
  const realSeed = h.repo.ledger.filter((l) => l.userId === "m1" && l.balanceKind === "real");
  assert.deepEqual(realSeed.map((l) => l.amount), [realBefore], "real bucket has only its seed; gameplay never added/removed real");
});

test("marketer cannot stake from real even when demo is short (no dip into real)", async () => {
  const h = makeGame({ poolOn: false, isMarketer: async (u) => u === "m1" });
  h.repo.markMarketer("m1");
  h.repo.seedDemo("m1", 1000);                 // below min stake
  h.repo.seed("m1", 10_000_000);               // plenty of real — must be untouchable
  await assert.rejects(
    () => h.game.openPosition({ userId: "m1", stakeCents: 25000, direction: "buy", role: "marketer" }),
    /INSUFFICIENT_FUNDS/,
    "a demo-short marketer must be refused, never draw real",
  );
});

test("real player unaffected: stake+payout on real bucket; demo stays 0", async () => {
  const h = makeGame({ poolOn: false, isMarketer: async () => false });
  h.repo.seed("p1", 10_000_000);
  for (let i = 0; i < 20; i++) {
    await h.game.openPosition({ userId: "p1", stakeCents: 25000, direction: "buy", role: "player" });
    await settleAll(h);
  }
  const demoMoves = h.repo.ledger.filter((l) => l.userId === "p1" && l.balanceKind === "demo");
  assert.equal(demoMoves.length, 0, "a real player never touches the demo bucket");
  const realMoves = h.repo.ledger.filter((l) => l.userId === "p1" && l.balanceKind === "real" && l.type !== "seed");
  assert.ok(realMoves.length > 0, "real player's gameplay flows through the real bucket");
});

test("pool brand: classified marketer never draws the pool across many trades (budget protected)", async () => {
  const h = makeGame({ poolOn: true, amountCents: 200000, isMarketer: async (u) => u === "m1" });
  h.repo.markMarketer("m1");
  h.repo.seedDemo("m1", 1_000_000_000);
  for (let i = 0; i < 100; i++) {
    const { position } = await h.game.openPosition({ userId: "m1", stakeCents: 25000, direction: i % 2 ? "buy" : "sell", role: "player" });
    assert.equal(position.poolControlled, false);
    await settleAll(h);
  }
  const pool = await h.poolRepo.poolState(SITE, h.day);
  assert.equal(pool.paidCents, 0, "marketer wins never draw the daily pool");
  assert.equal(pool.reservedCents, 0);
});

test("back-compat: with NO predicate injected, role='marketer' still exempts (legacy behaviour)", async () => {
  const h = makeGame({ poolOn: true });   // no isMarketer provider
  h.repo.seed("m1", 10_000_000);
  const { position } = await h.game.openPosition({ userId: "m1", stakeCents: 25000, direction: "buy", role: "marketer" });
  assert.equal(position.poolControlled, false, "falls back to the role claim when no predicate is wired");
});
