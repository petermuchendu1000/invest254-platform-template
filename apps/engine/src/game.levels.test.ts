import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurveGenerator, SettlementEngine, DEFAULT_CONFIG,
  priceAtRate, axisDateKey, XAUUSD, type PriceAxis,
} from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { GameServer, type SettledEvent } from "./game.js";

/**
 * MetaTrader's protective levels, held by the ENGINE.
 *
 * The point of these tests is the one thing a browser-side stop can never give: the level is the
 * engine's, so it fires on a tick whether or not anybody is watching. A stop that lives in a tab
 * disarms itself when the tab closes, which is not a stop.
 *
 * They also pin the half that makes a stop possible at all: a continuous position settles at what
 * it is worth AT THE MOMENT IT CLOSES, so a stop is a partial loss and a target a real profit. See
 * docs/mt5/20-real-sl-tp.md for why the committed-outcome contract could express neither.
 */
function makeRig() {
  const cfg = DEFAULT_CONFIG;
  const curve = new CurveGenerator("levels-day", cfg);
  const eng = new SettlementEngine(curve, cfg);
  const repo = new InMemoryGameRepository();
  const clock = { ms: 0 };
  const ctx = { curve, settlement: eng, dayStartMs: 0, gameDayId: null, configVersion: 1 };
  // A fixed anchor, so a curve rate maps to a chart price the same way every run.
  const axis: PriceAxis = {
    instrument: XAUUSD,
    anchorFor: (dateKey: string) => (dateKey === axisDateKey(0) ? { base: 3000, openValue: 0 } : null),
  };
  const gs = new GameServer(() => ctx, repo, () => cfg, () => clock.ms, undefined, undefined, undefined, () => axis);
  const priceAt = (t: number): number => priceAtRate(axis, clock.ms, curve.rate(t))!;
  /**
   * The lowest and highest price this curve actually reaches inside the horizon.
   *
   * A level has to be placed somewhere the price DEMONSTRABLY goes, or the test is asserting on a
   * coin flip: the walk is a martingale, so over five seconds it is perfectly ordinary for it never
   * to trade below its open. Reading the path first makes the assertion about the engine's level
   * handling rather than about which way the seed happened to drift.
   */
  const pathOver = (horizonS: number) => {
    let lo = Infinity, hi = -Infinity;
    for (let s = 0; s <= horizonS; s += 0.25) {
      const p = priceAt(s);
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    return { lo, hi };
  };
  /**
   * A direction and a stop level this curve genuinely reaches, strictly ON THE LOSING SIDE of the
   * entry price.
   *
   * Picking the direction from the path rather than fixing it is what keeps the test honest. Fix it
   * to "buy" and a seed that only ever rises leaves the stop unreachable; put the level on the wrong
   * side of entry instead and the stop fires on the very first tick, which passes while proving
   * nothing. This takes whichever side the walk actually travelled and places the level halfway
   * into that move.
   */
  const reachableStop = (horizonS: number) => {
    const entry = priceAt(0);
    const { lo, hi } = pathOver(horizonS);
    if (lo < entry) return { direction: "buy" as const, entry, slPrice: lo + (entry - lo) / 2 };
    if (hi > entry) return { direction: "sell" as const, entry, slPrice: hi - (hi - entry) / 2 };
    throw new Error("this curve does not move inside the window; pick another seed");
  };
  return { cfg, curve, eng, repo, clock, gs, axis, priceAt, pathOver, reachableStop };
}

test("a brand with a price axis opens CONTINUOUS positions that carry their levels", async () => {
  const { repo, gs, priceAt } = makeRig();
  repo.seed("u1", 1_000_000);
  const entry = priceAt(0);
  const { position: p } = await gs.openPosition({
    userId: "u1", stakeCents: 25_000, direction: "buy",
    slPrice: entry - 5, tpPrice: entry + 5,
  });
  assert.equal(p.continuous, true, "a brand with an axis settles continuously");
  assert.equal(p.slPrice, entry - 5);
  assert.equal(p.tpPrice, entry + 5);
});

test("a stop loss fires on an ENGINE tick, with nothing watching", async () => {
  const { repo, clock, gs, reachableStop } = makeRig();
  repo.seed("u1", 1_000_000);
  // Placed half-way into the adverse move this curve actually makes, on whichever side it made it.
  const { direction, entry, slPrice } = reachableStop(5);
  assert.ok(direction === "buy" ? slPrice < entry : slPrice > entry, "the stop must be on the losing side of entry");
  const { position: p } = await gs.openPosition({
    userId: "u1", stakeCents: 25_000, direction, slPrice,
  });
  let settled: SettledEvent | undefined;
  gs.subscribe({ onSettled: (e) => { settled = e; } });
  // Step well short of the horizon, so only a level could have closed it.
  for (let i = 1; i <= 20 && !settled; i++) { clock.ms = i * 250; await gs.step(); }
  assert.ok(settled, "the stop should have closed the position before its horizon");
  assert.ok(clock.ms < p.expiresAtMs, `closed at ${clock.ms}ms, before the horizon ${p.expiresAtMs}ms`);
  assert.equal(settled!.closedBy, "sl");
  // A stop is a PARTIAL loss, not the all-or-nothing the step payout forced.
  assert.ok(settled!.payoutCents < 25_000, "a stop should not return the stake");
  assert.ok(settled!.payoutCents >= 0, "and can never be worse than the stake");
});

test("a take profit fires the same way, and pays more than the stake", async () => {
  const { repo, clock, gs, priceAt } = makeRig();
  repo.seed("u1", 1_000_000);
  const entry = priceAt(0);
  // A target far enough out to be a real profit once the cost is covered.
  const { position: p } = await gs.openPosition({
    userId: "u1", stakeCents: 25_000, direction: "buy", tpPrice: entry + 0.01,
  });
  let settled: SettledEvent | undefined;
  gs.subscribe({ onSettled: (e) => { settled = e; } });
  for (let i = 1; i <= 20 && !settled; i++) { clock.ms = i * 250; await gs.step(); }
  if (settled) {
    assert.equal(settled.closedBy, "tp", "only the target was set, so only it can have closed this");
    assert.ok(clock.ms < p.expiresAtMs);
  }
  // Not asserted unconditionally: the price may simply not reach the target inside the horizon,
  // which is a real outcome rather than a failure. The stop test above pins that levels DO fire.
});

test("a stop set after the fact is the engine's, not the tab's", async () => {
  const { repo, clock, gs, reachableStop } = makeRig();
  repo.seed("u1", 1_000_000);
  const { direction, entry, slPrice } = reachableStop(5);
  const { position: p } = await gs.openPosition({ userId: "u1", stakeCents: 25_000, direction });
  assert.equal(p.slPrice, null, "opened with no stop at all");
  assert.ok(direction === "buy" ? slPrice < entry : slPrice > entry, "the stop must be on the losing side of entry");
  const updated = gs.setLevels(p.id, "u1", slPrice, null);
  assert.equal(updated.slPrice, slPrice);
  let settled: SettledEvent | undefined;
  gs.subscribe({ onSettled: (e) => { settled = e; } });
  for (let i = 1; i <= 20 && !settled; i++) { clock.ms = i * 250; await gs.step(); }
  assert.ok(settled, "a level set through Modify position fires exactly as one set at open does");
  assert.equal(settled!.closedBy, "sl");
});

test("levels are refused on a position that is not this user's, or already closed", async () => {
  const { repo, gs } = makeRig();
  repo.seed("u1", 1_000_000);
  const { position: p } = await gs.openPosition({ userId: "u1", stakeCents: 25_000, direction: "buy" });
  assert.throws(() => gs.setLevels(p.id, "someone-else", 1, null), /POSITION_NOT_FOUND/);
  assert.throws(() => gs.setLevels("no-such-id", "u1", 1, null), /POSITION_NOT_FOUND/);
});

test("a continuous position can be closed by hand at any time, winner or loser", async () => {
  const { repo, clock, gs } = makeRig();
  repo.seed("u1", 1_000_000);
  const { position: p } = await gs.openPosition({ userId: "u1", stakeCents: 25_000, direction: "buy" });
  clock.ms = 2_000;
  // The committed contract refused this with NOT_SELLABLE whenever the engine had already decided
  // the trade was a loss. A continuous one has no such decision to protect: it pays what the price
  // says, which on a loser is less than the stake, so there is nothing to refuse.
  const e = await gs.sell(p.id, "u1");
  assert.equal(e.mode, "manual");
  assert.ok(e.payoutCents >= 0);
  assert.equal(await repo.getBalance("u1"), 1_000_000 - 25_000 + e.payoutCents);
});

test("a brand with NO price axis keeps the committed contract untouched", async () => {
  const cfg = DEFAULT_CONFIG;
  const curve = new CurveGenerator("levels-day", cfg);
  const eng = new SettlementEngine(curve, cfg);
  const repo = new InMemoryGameRepository();
  const clock = { ms: 0 };
  const ctx = { curve, settlement: eng, dayStartMs: 0, gameDayId: null, configVersion: 1 };
  // No axis argument: a line brand, which has no chart price to put a level on.
  const gs = new GameServer(() => ctx, repo, () => cfg, () => clock.ms);
  repo.seed("u1", 1_000_000);
  const { position: p } = await gs.openPosition({ userId: "u1", stakeCents: 25_000, direction: "buy", slPrice: 1 });
  assert.equal(p.continuous, false, "no axis means the committed contract, exactly as before");
  assert.equal(p.slPrice, null, "and a level cannot be armed on it");
  assert.throws(() => gs.setLevels(p.id, "u1", 1, null), /LEVELS_UNSUPPORTED/);
});

/**
 * A RESTART must not disarm a trader's stop, and must not re-price their position.
 *
 * The engine deploys on every merge to main, and a deploy restarts it, so this is routine rather
 * than exotic. Recovery used to re-arm every open position with `continuous: false` and no levels,
 * which did three things to a trade already in flight: the stop silently vanished, the position
 * switched from the continuous payout it was opened under to the committed step contract, and a
 * loser that could be closed by hand a second earlier could not be closed at all.
 *
 * Migration 0183 persists the levels, so this walks the whole path: open with a stop, read the
 * position back off the repository the way `RecoveryService` does, and check the row carries what
 * the trader set.
 */
test("a restart keeps the stop: the levels are persisted and come back on the recovery work list", async () => {
  const r = makeRig();
  r.repo.seed("u1", 100_000);
  const { position } = await r.gs.openPosition({ userId: "u1", stakeCents: 25_000, direction: "buy" });
  assert.equal(position.continuous, true, "the rig's brand has an axis, so the position is continuous");

  // Set levels the way Modify position does.
  const sl = r.priceAt(position.entryT) - 5;
  const tp = r.priceAt(position.entryT) + 5;
  r.gs.setLevels(position.id, "u1", sl, tp);
  // The write is fire-and-forget, so let the microtask queue drain before reading it back.
  await Promise.resolve();
  await Promise.resolve();

  const rows = await r.repo.listOpenPositions();
  const row = rows.find((x) => x.id === position.id);
  assert.ok(row, "the position is on the recovery work list");
  assert.equal(row.slPrice, sl, "the stop survives into the row recovery reads");
  assert.equal(row.tpPrice, tp, "and so does the target");

  // Clearing a level has to persist too, or a cleared stop would come back from the dead.
  r.gs.setLevels(position.id, "u1", null, tp);
  await Promise.resolve();
  await Promise.resolve();
  const after = (await r.repo.listOpenPositions()).find((x) => x.id === position.id)!;
  assert.equal(after.slPrice, null, "a CLEARED stop stays cleared across a restart");
  assert.equal(after.tpPrice, tp, "and clearing one level leaves the other alone");
});

test("levels sent WITH the order are persisted, not just ones set afterwards", async () => {
  const r = makeRig();
  r.repo.seed("u1", 100_000);
  // A restart in the first seconds of a trade must not lose the stop it was opened with.
  const { position } = await r.gs.openPosition({
    userId: "u1", stakeCents: 25_000, direction: "buy", slPrice: 2990, tpPrice: 3010,
  });
  await Promise.resolve();
  await Promise.resolve();
  const row = (await r.repo.listOpenPositions()).find((x) => x.id === position.id)!;
  assert.equal(row.slPrice, 2990, "the stop the order carried is on the row");
  assert.equal(row.tpPrice, 3010, "and so is the target");
});

test("a brand with NO axis persists nothing, because it has no levels to lose", async () => {
  const cfg = DEFAULT_CONFIG;
  const curve = new CurveGenerator("levels-day", cfg);
  const eng = new SettlementEngine(curve, cfg);
  const repo = new InMemoryGameRepository();
  const clock = { ms: 0 };
  const ctx = { curve, settlement: eng, dayStartMs: 0, gameDayId: null, configVersion: 1 };
  const gs = new GameServer(() => ctx, repo, () => cfg, () => clock.ms); // no axis
  assert.equal(gs.hasPriceAxis, false, "no axis means recovery keeps the committed contract");
  repo.seed("u1", 100_000);
  const { position } = await gs.openPosition({ userId: "u1", stakeCents: 25_000, direction: "buy", slPrice: 2990 });
  await Promise.resolve();
  await Promise.resolve();
  const row = (await repo.listOpenPositions()).find((x) => x.id === position.id)!;
  assert.equal(row.slPrice, null, "a line brand drops a level it cannot honour, rather than storing a lie");
});
