import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type VersionedGameConfig } from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { GameServer } from "./game.js";
import { SeedManager } from "./daycontext.js";
import { RecoveryService } from "./recovery.js";
import { StaticConfigProvider } from "./gameconfig.js";
import { InMemoryUserOverridesRepository } from "./overrides.js";

/**
 * Recovery faithfulness (audit rec #5 / docs/28 §4.4): a crash-recovered statistical WIN must settle
 * at the SAME multiplier the GameServer committed at open — which uses settleVariable(nonce, seed),
 * NOT the curve-derived settle(). Before the fix, recovery used settle(), so a recovered win paid a
 * DIFFERENT amount than the player was shown. This test forces a win and proves parity + divergence
 * from settle().
 */
const MASTER = "recovery-faithful-master";
const OPTS = { calibrationSamples: 4000 };
// High win-rate config so a win lands quickly (feasible: (1-0.05)/0.9 = 1.055 in (1,5]).
const cfg: VersionedGameConfig = { ...DEFAULT_CONFIG, houseEdge: 0.05, targetWinRate: 0.9, version: 0 };

test("recovered statistical WIN reproduces the committed settleVariable multiplier (not settle())", async () => {
  const config = new StaticConfigProvider(cfg);
  const repo = new InMemoryGameRepository();
  repo.seed("u1", 100_000_000);
  const clock = { ms: 1_000 };
  const seeds1 = new SeedManager(MASTER, config, repo, () => clock.ms, OPTS);
  await seeds1.init();
  const game1 = new GameServer(() => seeds1.getActive(), repo, () => cfg, () => clock.ms);

  // find an IN-FLIGHT winner; settle any losses first so only the winner is open at crash time
  let winner: any = null; let base = 1_000;
  for (let i = 0; i < 40 && !winner; i++) {
    clock.ms = base + i * 60_000;
    const { position } = await game1.openPosition({ userId: "u1", stakeCents: 25000, direction: "buy" });
    if (position.outcome.result === "win") { winner = position; break; }
    clock.ms += (cfg.defaultDurationS + 1) * 1000; await game1.step(); // expire+settle the loss
  }
  assert.ok(winner, "expected an in-flight winning position");
  const committedMult = winner.outcome.multiplier;
  const committedPayout = winner.outcome.payoutCents;
  assert.ok(committedMult > 1 && committedPayout > 25000, "winner pays a real profit");

  // what settle() (the OLD recovery path) would have produced for the SAME position
  const dateKey = new Date(winner.openedAtMs).toISOString().slice(0, 10);
  const ctx = await seeds1.contextFor(dateKey);
  const settleOnly = ctx.settlement.settle(25000, "buy", winner.entryT);
  assert.equal(settleOnly.result, "win", "settle() agrees it's a win (same tau threshold)...");
  assert.notEqual(
    Math.round(25000 * settleOnly.multiplier), committedPayout,
    "...but settle()'s multiplier DIFFERS from the committed settleVariable draw (that was the bug)",
  );

  // crash: fresh process, only the durable repo survives; recover after the winner expires
  const balBefore = await repo.getBalance("u1");
  clock.ms = winner.expiresAtMs + 1;
  const seeds2 = new SeedManager(MASTER, config, repo, () => clock.ms, OPTS);
  await seeds2.init();
  const game2 = new GameServer(() => seeds2.getActive(), repo, () => cfg, () => clock.ms);
  const rec = new RecoveryService(repo, seeds2, game2, () => clock.ms);
  const report = await rec.recover();
  assert.equal(report.settled, 1, "the expired winner is settled by recovery");

  const balAfter = await repo.getBalance("u1");
  assert.equal(balAfter - balBefore, committedPayout,
    "recovery credits EXACTLY the committed (settleVariable) payout the player was shown");
});

test("recovered OVERRIDE win reproduces the committed per-user settleVariable payout", async () => {
  // A per-user pricing override must recover under the SAME userSettlement + settleVariable draw.
  const config = new StaticConfigProvider(cfg);
  const repo = new InMemoryGameRepository();
  repo.seed("ov1", 100_000_000);
  const ovRepo = new InMemoryUserOverridesRepository();
  // feasible pricing override: (1-0.05)/0.9 = 1.055 in (1, maxMultiplier]
  ovRepo.set({ userId: "ov1", winRate: 0.9, houseEdge: 0.05, tradeDurationS: null, maxWinMultiplier: null, minStakeCents: null, maxStakeCents: null, notes: null, updatedBy: null, updatedAtMs: 0 });
  const loadOverride = (uid: string) => ovRepo.getForUser(uid);
  const clock = { ms: 1_000 };
  const seeds1 = new SeedManager(MASTER, config, repo, () => clock.ms, OPTS);
  await seeds1.init();
  const game1 = new GameServer(() => seeds1.getActive(), repo, () => cfg, () => clock.ms, loadOverride);

  let winner: any = null;
  for (let i = 0; i < 40 && !winner; i++) {
    clock.ms = 1_000 + i * 60_000;
    const { position } = await game1.openPosition({ userId: "ov1", stakeCents: 25000, direction: "buy" });
    if (position.outcome.result === "win") { winner = position; break; }
    clock.ms += (cfg.defaultDurationS + 1) * 1000; await game1.step();
  }
  assert.ok(winner, "expected an in-flight overridden winner");
  const committedPayout = winner.outcome.payoutCents;

  const balBefore = await repo.getBalance("ov1");
  clock.ms = winner.expiresAtMs + 1;
  const seeds2 = new SeedManager(MASTER, config, repo, () => clock.ms, OPTS);
  await seeds2.init();
  const game2 = new GameServer(() => seeds2.getActive(), repo, () => cfg, () => clock.ms, loadOverride);
  // RecoveryService MUST receive the same override provider (param 5) to reprice identically.
  const rec = new RecoveryService(repo, seeds2, game2, () => clock.ms, loadOverride);
  const report = await rec.recover();
  assert.equal(report.settled, 1);
  assert.equal(await repo.getBalance("ov1") - balBefore, committedPayout,
    "recovered override win matches the committed per-user settleVariable payout");
});
