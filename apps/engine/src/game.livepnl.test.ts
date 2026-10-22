import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator, SettlementEngine, DEFAULT_CONFIG, DEFAULT_POOL_KNOBS } from "@invest254/shared";
import { GameServer, type ActiveContext, type UpdateEvent } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";
import { PoolController, InMemoryPoolRepo, eatDay } from "./poolcontroller.js";

/**
 * The floating P/L follows the PRICE, not a timer.
 *
 * It used to be a function of elapsed time and the seed alone: a winner rose monotonically on a
 * smoothstep whatever the price did, a loser decayed the same way, and a pool contract followed a
 * seeded reversing feint. None of the three took the trade's direction, so a buy and a sell opened
 * in the same second drew the same shape.
 *
 * These tests pin the three things that had to stay true while that changed: the value lands on the
 * committed multiplier, early closing can never pay more than the contract settles at, and a
 * position re-armed from an earlier day keeps the day-agnostic path it needs.
 */
const SITE = "site-pnl";
const SEED = "livepnl-seed-0001";
const cfg = { ...DEFAULT_CONFIG };
cfg.minWithdrawalCents = 999_999_999;
const curve = new CurveGenerator(SEED, cfg);
const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600);
const DAY_START = Date.UTC(2026, 7, 16, 0, 0, 0);
const T0 = Date.UTC(2026, 7, 16, 9, 0, 0);

function makeGame(opts: { poolOn?: boolean } = {}) {
  const repo = new InMemoryGameRepository();
  const poolRepo = new InMemoryPoolRepo();
  let clock = T0;
  const now = () => clock;
  poolRepo.setPool(SITE, eatDay(T0), 500_000_000);
  const controller = new PoolController(poolRepo, DEFAULT_POOL_KNOBS, now);
  const ctx: ActiveContext = { curve, settlement, dayStartMs: DAY_START, gameDayId: 1, seed: SEED, configVersion: 0, siteId: SITE };
  const pool = opts.poolOn ? { enabled: () => true, controller } : undefined;
  const game = new GameServer(() => ctx, repo, () => cfg, now, undefined, pool);
  const updates: UpdateEvent[] = [];
  game.subscribe({ onUpdate: (u) => updates.push(u) });
  return { repo, game, updates, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

/** The P/L samples a contract emits as the clock walks its life, one per step. */
async function walk(h: ReturnType<typeof makeGame>, userId: string, direction: "buy" | "sell") {
  h.repo.seed(userId, 100_000_000);
  const { position } = await h.game.openPosition({ userId, stakeCents: 100_000, direction });
  const stepMs = (cfg.defaultDurationS * 1000) / 20;
  const out: Array<{ g: number; pnl: number; move: number }> = [];
  for (let i = 1; i < 20; i++) {
    h.advance(stepMs);
    h.updates.length = 0;
    await h.game.step();
    const u = h.updates.find((x) => x.positionId === position.id);
    if (!u) continue;
    const elapsedS = (h.now() - position.openedAtMs) / 1000;
    out.push({
      g: elapsedS / position.durationS,
      pnl: u.livePnlCents,
      move: settlement.moveAt(direction, position.entryT, elapsedS),
    });
  }
  return { position, samples: out };
}

test("the P/L moves with the price, not with the clock", async () => {
  const h = makeGame();
  const { samples } = await walk(h, "u-price", "buy");
  assert.ok(samples.length >= 10, `only ${samples.length} samples`);
  // Inside the price-driven stretch, every step the move goes down the P/L goes down, and every
  // step it goes up the P/L goes up. The old path could only ever rise (a winner) or only ever
  // fall (a loser), so a single disagreement here would have failed it.
  const early = samples.filter((s) => s.g <= 0.7);
  let down = 0;
  for (let i = 1; i < early.length; i++) {
    const dMove = early[i]!.move - early[i - 1]!.move;
    const dPnl = early[i]!.pnl - early[i - 1]!.pnl;
    if (Math.abs(dMove) < 1e-9) continue;
    assert.equal(Math.sign(dPnl), Math.sign(dMove), `step ${i}: move ${dMove} but P/L ${dPnl}`);
    if (dMove < 0) down += 1;
  }
  // And the price genuinely went against it at some point, or the assertion above is vacuous.
  assert.ok(down > 0, "the price never fell during this contract, so this proves nothing");
});

test("a buy and a sell opened together are mirror images", async () => {
  // The old path took no direction at all and drew both the same.
  const a = await walk(makeGame(), "u-buy", "buy");
  const b = await walk(makeGame(), "u-sell", "sell");
  const n = Math.min(a.samples.length, b.samples.length);
  let opposed = 0;
  for (let i = 1; i < n; i++) {
    if (a.samples[i]!.g > 0.7) break;
    const da = a.samples[i]!.pnl - a.samples[i - 1]!.pnl;
    const db = b.samples[i]!.pnl - b.samples[i - 1]!.pnl;
    if (da !== 0 && db !== 0) { assert.equal(Math.sign(da), -Math.sign(db), `step ${i}`); opposed += 1; }
  }
  assert.ok(opposed > 0, "nothing moved, so nothing was proved");
});

test("whatever the price did, the contract settles on the multiplier it committed to", async () => {
  for (const direction of ["buy", "sell"] as const) {
    const h = makeGame();
    h.repo.seed("u-land", 100_000_000);
    const { position } = await h.game.openPosition({ userId: "u-land", stakeCents: 100_000, direction });
    const before = await h.repo.getBalance("u-land");
    h.advance((cfg.defaultDurationS + 1) * 1000);
    await h.game.step();
    const after = await h.repo.getBalance("u-land");
    assert.equal(after - before, position.outcome.payoutCents, `${direction}: paid something other than the committed payout`);
  }
});

test("closing early can never pay more than the contract would have settled at", async () => {
  // The settlement engine's guarantee, which a price-driven path could otherwise break on a spike:
  // "early-selling can only REDUCE player payout (house edge >= target)".
  //
  // One game, with the clock walked between openings. A fresh game per iteration gave every
  // contract the SAME entry time and therefore the same outcome, so forty of them were forty
  // copies of one losing trade and the cap was never reached at all.
  const h = makeGame();
  let checked = 0;
  for (let i = 0; i < 60; i += 1) {
    const user = `u-sell-${i}`;
    h.repo.seed(user, 100_000_000);
    const { position } = await h.game.openPosition({ userId: user, stakeCents: 100_000, direction: i % 2 ? "buy" : "sell" });
    h.advance(Math.round(cfg.defaultDurationS * 1000 * 0.4));
    await h.game.step();
    if (!position.sellable) { h.advance(cfg.defaultDurationS * 1000); await h.game.step(); continue; }
    checked += 1;
    const e = await h.game.sell(position.id, user);
    assert.ok(e.lockedMultiplier <= position.outcome.multiplier + 1e-9,
      `locked ${e.lockedMultiplier} > committed ${position.outcome.multiplier}`);
    assert.ok(e.payoutCents <= position.outcome.payoutCents, `${e.payoutCents} > ${position.outcome.payoutCents}`);
  }
  assert.ok(checked > 0, "no sellable position came up, so the cap was never exercised");
});

test("a pool contract is free to run above its endpoint, because it cannot be closed early", async () => {
  // Every pool brand refuses a manual close, so there is no payout to protect and the path may show
  // the price running past where the contract will land. That is the reversing feint the old seeded
  // path invented, except this one is the price actually moving.
  const h = makeGame({ poolOn: true });
  const { position } = await walk(h, "u-pool", "buy");
  assert.equal(position.poolControlled, true);
  await assert.rejects(() => h.game.sell(position.id, "u-pool"), /SELL_DISABLED/);
});

test("a position re-armed from an earlier day keeps the day-agnostic path", async () => {
  // Its `entryT` is measured against THAT day's start, so reading today's curve at it would price a
  // second that never happened for this contract. ActiveContext documents the property; this pins it.
  const h = makeGame();
  h.repo.seed("u-old", 100_000_000);
  const { position } = await h.game.openPosition({ userId: "u-old", stakeCents: 100_000, direction: "buy" });
  (position as { gameDayId: number | null }).gameDayId = 999;   // as recovery re-arms it
  h.advance(Math.round(cfg.defaultDurationS * 1000 * 0.5));
  h.updates.length = 0;
  await h.game.step();
  const u = h.updates.find((x) => x.positionId === position.id);
  assert.ok(u, "no update emitted for a re-armed position");
  // The old path at g=0.5 is exactly halfway along the smoothstep for a winner, and exactly half
  // the stake gone for a loser. Either way it is finite and in range, which is all this needs to
  // show: it did not read today's curve at another day's entry time.
  assert.ok(Number.isFinite(u!.liveMultiplier) && u!.liveMultiplier >= 0);
  const expected = position.outcome.result === "win"
    ? settlement.liveWinMultiplier(position.outcome.multiplier, 0.5)
    : 0.5;
  assert.ok(Math.abs(u!.liveMultiplier - expected) < 1e-6, `${u!.liveMultiplier} vs ${expected}`);
});
