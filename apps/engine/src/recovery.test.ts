import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VERSIONED_CONFIG, priceAtRate, axisDateKey, XAUUSD, type PriceAxis } from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { GameServer, type SettledEvent } from "./game.js";
import { SeedManager } from "./daycontext.js";
import { RecoveryService } from "./recovery.js";
import { StaticConfigProvider } from "./gameconfig.js";

const MASTER = "recovery-test-master";
// Small calibration sample count keeps the test fast; determinism is unaffected because
// open-time and recovery-time both build contexts with the SAME (master, key, samples).
const OPTS = { calibrationSamples: 4000 };

test("recovery: settles expired, re-arms in-flight, deterministically and idempotently", async () => {
  /**
   * A TEN-SECOND contract, pinned rather than read from the shipped default.
   *
   * This test is about recovery mechanics: an expired position is settled, an in-flight one is
   * re-armed, both idempotently. Its clock arithmetic encodes that term directly (`recoverAtMs =
   * C1 + 10000 + 1`, "P1 expired (opened C1, 10s)"), so it has always meant ten seconds rather than
   * whatever the default happens to be. The shipped default is now fifteen minutes, because a stop
   * needs room to be reached, and reading it here would leave P1 still running at the recovery
   * instant and settle nothing.
   */
  const cfg = { ...DEFAULT_VERSIONED_CONFIG, defaultDurationS: 10 };
  const config = new StaticConfigProvider(cfg);
  const repo = new InMemoryGameRepository();
  repo.seed("u1", 100000);
  repo.seed("u2", 100000);
  const clock = { ms: 0 };

  // --- pre-crash: a SeedManager + GameServer open two positions on the same UTC day ---
  const seeds1 = new SeedManager(MASTER, config, repo, () => clock.ms, OPTS);
  await seeds1.init();
  const game1 = new GameServer(() => seeds1.getActive(), repo, () => cfg, () => clock.ms);

  const C1 = 1000; // open P1 (will be expired by recovery time)
  clock.ms = C1;
  const { position: p1 } = await game1.openPosition({ userId: "u1", stakeCents: 25000, direction: "buy" });

  const C2 = C1 + 5000; // open P2 5s later (still in-flight at recovery time)
  clock.ms = C2;
  const { position: p2 } = await game1.openPosition({ userId: "u2", stakeCents: 25000, direction: "sell" });

  const balU1AfterOpen = await repo.getBalance("u1");
  const balU2AfterOpen = await repo.getBalance("u2");
  assert.equal(balU1AfterOpen, 75000);
  assert.equal(balU2AfterOpen, 75000);
  assert.equal((await repo.listOpenPositions()).length, 2);

  // expected hold-to-expiry payout for the expired P1, recomputed independently
  const ctx = await seeds1.contextFor("1970-01-01");
  const oP1 = ctx.settlement.settle(25000, "buy", (C1 - ctx.dayStartMs) / 1000);
  const expectedP1Payout = oP1.result === "win" ? Math.round(25000 * oP1.multiplier) : 0;

  // --- crash: discard game1/seeds1; a fresh process boots with only the durable repo ---
  const recoverAtMs = C1 + 10000 + 1; // P1 expired (opened C1, 10s), P2 in-flight (expires C2+10000)
  clock.ms = recoverAtMs;
  const seeds2 = new SeedManager(MASTER, config, repo, () => clock.ms, OPTS);
  await seeds2.init();
  const game2 = new GameServer(() => seeds2.getActive(), repo, () => cfg, () => clock.ms);
  const recovery = new RecoveryService(repo, seeds2, game2, () => clock.ms);

  const report = await recovery.recover();
  assert.equal(report.scanned, 2);
  assert.equal(report.settled, 1);  // P1 expired -> finalised now
  assert.equal(report.rearmed, 1);  // P2 in-flight -> resumed
  assert.equal(report.failed, 0);

  // P1 settled deterministically to the recomputed outcome
  assert.equal(await repo.getBalance("u1"), 75000 + expectedP1Payout);
  // P2 is back on the live server, still open
  assert.ok(game2.getPosition(p2.id));
  assert.equal(game2.getPosition(p2.id)!.status, "open");
  assert.equal(game2.openCount(), 1);

  // recovery is idempotent: a second pass settles nothing new and re-arms nothing
  const report2 = await recovery.recover();
  assert.equal(report2.scanned, 1);            // only P2 still open in the DB
  assert.equal(report2.settled + report2.rearmed, 0);
  assert.equal(report2.noop, 1);               // P2 already tracked -> no-op
  assert.equal(await repo.getBalance("u1"), 75000 + expectedP1Payout); // no double credit

  // P2 settles normally at its expiry through the live tick loop
  clock.ms = p2.expiresAtMs;
  let settled: any; game2.subscribe({ onSettled: (e) => (settled = e) });
  await game2.step();
  assert.equal(game2.getPosition(p2.id)!.status, "settled");
  assert.ok(settled && settled.position.id === p2.id);
  assert.equal((await repo.listOpenPositions()).length, 0);

  // a P1 settle attempt would be an idempotent no-op (already settled in the DB)
  const reSettle = await repo.settlePosition({ positionId: p1.id, exitRate: 0, result: "loss", multiplier: 0, payoutCents: 0 });
  assert.equal(reSettle.settled, false);
});

/**
 * A restart must hand the position back the way it was OPENED, levels and all.
 *
 * This is the half of the bug that lived in recovery itself. Even once the levels were persisted, a
 * re-armed position came back with `continuous: false`, which silently moved it from the continuous
 * payout it was opened under to the committed step contract and made a loser impossible to close by
 * hand. Because the engine restarts on every deploy, that happened to real trades routinely.
 *
 * The test crashes a brand that HAS a price axis and checks the recovered position on three counts:
 * it is continuous again, it still carries the stop and the target, and the stop still fires on a
 * tick with nothing watching.
 */
test("recovery re-arms a continuous position WITH its levels, and the stop still fires", async () => {
  const cfg = { ...DEFAULT_VERSIONED_CONFIG, defaultDurationS: 900 };
  const config = new StaticConfigProvider(cfg);
  const repo = new InMemoryGameRepository();
  repo.seed("u1", 100_000);
  const clock = { ms: 0 };
  // A fixed anchor, so a curve rate maps to a chart price the same way every run.
  const axis: PriceAxis = {
    instrument: XAUUSD,
    anchorFor: (dateKey: string) => (dateKey === axisDateKey(0) ? { base: 3000, openValue: 0 } : null),
  };

  const seeds1 = new SeedManager(MASTER, config, repo, () => clock.ms, OPTS);
  await seeds1.init();
  const game1 = new GameServer(() => seeds1.getActive(), repo, () => cfg, () => clock.ms, undefined, undefined, undefined, () => axis);
  clock.ms = 1000;
  const { position } = await game1.openPosition({ userId: "u1", stakeCents: 25_000, direction: "buy" });
  assert.equal(position.continuous, true, "the brand has an axis, so the trade opened continuous");

  const ctx1 = seeds1.getActive();
  const entryPrice = priceAtRate(axis, clock.ms, ctx1.curve.rate(position.entryT))!;
  /**
   * A stop the price DEMONSTRABLY reaches, read from the path rather than guessed.
   *
   * The walk is a martingale, so over any short window it is perfectly ordinary for the price never
   * to trade below its open. Placing the stop at the lowest price the curve actually visits inside
   * the horizon makes the assertion about the engine's level check rather than about a coin flip.
   */
  let low = Infinity;
  for (let dt = 1; dt <= 300; dt++) {
    const p = priceAtRate(axis, clock.ms + dt * 1000, ctx1.curve.rate(position.entryT + dt))!;
    if (p < low) low = p;
  }
  assert.ok(low < entryPrice, "this seed's price does go against a buy inside the window");
  const sl = (entryPrice + low) / 2; // between the entry and the low: reached, but not instantly
  game1.setLevels(position.id, "u1", sl, null);
  await Promise.resolve();
  await Promise.resolve();

  // --- crash: a fresh process boots with only the durable repository ---
  const seeds2 = new SeedManager(MASTER, config, repo, () => clock.ms, OPTS);
  await seeds2.init();
  const game2 = new GameServer(() => seeds2.getActive(), repo, () => cfg, () => clock.ms, undefined, undefined, undefined, () => axis);
  const report = await new RecoveryService(repo, seeds2, game2, () => clock.ms).recover();
  assert.equal(report.rearmed, 1, "the in-flight position is re-armed");

  const back = game2.getPosition(position.id)!;
  assert.ok(back, "the position is on the live server again");
  assert.equal(back.continuous, true, "it is priced the way it was OPENED, not as a committed contract");
  assert.equal(back.slPrice, sl, "the stop the trader set survived the restart");
  assert.equal(back.sellable, true, "and it can still be closed by hand, winner or loser");

  // The stop fires on a tick, after the restart, with nothing watching.
  let settled: SettledEvent | undefined;
  game2.subscribe({ onSettled: (e) => (settled = e) });
  for (let dt = 1; dt <= 300 && !settled; dt++) {
    clock.ms = 1000 + dt * 1000;
    await game2.step();
  }
  assert.ok(settled, "the recovered stop closed the position");
  assert.equal(settled!.position.id, position.id);
  assert.equal(settled!.closedBy, "sl", "and it closed BECAUSE of the stop, not at the horizon");
});
