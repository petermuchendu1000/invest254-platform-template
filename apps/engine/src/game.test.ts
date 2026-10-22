import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator, SettlementEngine, DEFAULT_CONFIG } from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { GameServer } from "./game.js";

function makeRig() {
  /**
   * These tests are about the COMMITTED contract: stake debited, outcome revealed at its term,
   * settlement idempotent. They pin the ten-second term they were written for rather than reading
   * the shipped default, which is now an hour because a position ends at its stop or its target
   * instead of on a timer (see docs/mt5/20-real-sl-tp.md). What is under test here did not change.
   */
  const cfg = { ...DEFAULT_CONFIG, defaultDurationS: 10 };
  const curve = new CurveGenerator("engine-day", cfg);
  const eng = new SettlementEngine(curve, cfg);
  const repo = new InMemoryGameRepository();
  const clock = { ms: 0 };
  const ctx = { curve, settlement: eng, dayStartMs: 0, gameDayId: null, configVersion: 1 };
  const gs = new GameServer(() => ctx, repo, () => cfg, () => clock.ms);
  let winT = -1, loseT = -1;
  for (let t = 0; t < 3600 && (winT < 0 || loseT < 0); t += 0.05) {
    const o = eng.settle(25000, "buy", t);
    if (o.result === "win" && winT < 0) winT = t;
    if (o.result === "loss" && loseT < 0) loseT = t;
  }
  return { cfg, curve, eng, repo, clock, gs, winT, loseT };
}

test("winning position: stake debited, auto-settle credits once (idempotent)", async () => {
  const { repo, clock, gs, winT } = makeRig();
  repo.seed("u1", 100000);
  clock.ms = Math.round(winT * 1000);
  const { position: p, balance } = await gs.openPosition({ userId: "u1", stakeCents: 25000, direction: "buy" });
  assert.equal(balance, 75000);
  assert.equal(p.outcome.result, "win");
  clock.ms = p.expiresAtMs;
  let settled: any; gs.subscribe({ onSettled: (e) => (settled = e) });
  await gs.step();
  assert.ok(settled.payoutCents > 25000);
  assert.equal(await repo.getBalance("u1"), 75000 + settled.payoutCents);
  const after = await repo.getBalance("u1");
  clock.ms += 5000; await gs.step();
  assert.equal(await repo.getBalance("u1"), after);
});

test("losing position: payout 0, not sellable, stake lost", async () => {
  const { repo, clock, gs, loseT } = makeRig();
  repo.seed("u2", 100000);
  clock.ms = Math.round(loseT * 1000);
  const { position: p } = await gs.openPosition({ userId: "u2", stakeCents: 25000, direction: "buy" });
  assert.equal(p.outcome.result, "loss");
  await assert.rejects(() => gs.sell(p.id, "u2"), /NOT_SELLABLE/);
  clock.ms = p.expiresAtMs;
  let settled: any; gs.subscribe({ onSettled: (e) => (settled = e) });
  await gs.step();
  assert.equal(settled.payoutCents, 0);
  assert.equal(await repo.getBalance("u2"), 75000);
});

test("insufficient funds rejected; min stake enforced", async () => {
  const { repo, clock, gs, winT } = makeRig();
  repo.seed("u3", 10000);
  clock.ms = Math.round(winT * 1000);
  await assert.rejects(() => gs.openPosition({ userId: "u3", stakeCents: 25000, direction: "buy" }), /INSUFFICIENT_FUNDS/);
  assert.equal(await repo.getBalance("u3"), 10000);
  repo.seed("u3b", 100000);
  await assert.rejects(() => gs.openPosition({ userId: "u3b", stakeCents: 24999, direction: "buy" }), /STAKE_BELOW_MIN/);
});

test("manual SELL locks multiplier in [1, final]; double-sell rejected", async () => {
  const { repo, clock, gs, winT } = makeRig();
  repo.seed("u5", 100000);
  clock.ms = Math.round(winT * 1000);
  const { position: p } = await gs.openPosition({ userId: "u5", stakeCents: 25000, direction: "buy" });
  clock.ms = p.openedAtMs + 5000;
  const e = await gs.sell(p.id, "u5");
  assert.ok(e.lockedMultiplier >= 1 && e.lockedMultiplier <= p.outcome.multiplier + 1e-9);
  assert.equal(e.payoutCents, Math.round(25000 * e.lockedMultiplier));
  await assert.rejects(() => gs.sell(p.id, "u5"), /ALREADY_SETTLED/);
});

test("concurrent settle credits exactly once", async () => {
  const { repo, clock, gs, winT } = makeRig();
  repo.seed("u6", 100000);
  clock.ms = Math.round(winT * 1000);
  const { position: p } = await gs.openPosition({ userId: "u6", stakeCents: 25000, direction: "buy" });
  clock.ms = p.expiresAtMs;
  await Promise.all([gs.step(), gs.step()]);
  const credits = repo.ledger.filter((l) => l.type === "payout" && l.refTable === "positions" && l.refId === p.id);
  assert.equal(credits.length, 1);
});
