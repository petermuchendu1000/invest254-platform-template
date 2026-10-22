import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurveGenerator, SettlementEngine, DEFAULT_CONFIG, DEFAULT_POOL_KNOBS, rtp,
} from "@invest254/shared";
import { GameServer, type ActiveContext, type UpdateEvent, type SettledEvent } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";
import { PoolController, InMemoryPoolRepo, eatDay } from "./poolcontroller.js";

/**
 * SOAK: tens of thousands of contracts through the engine, and the invariants that must survive.
 *
 * The unit tests prove each rule in isolation on a handful of contracts. This file is the opposite
 * bet: run the thing hard enough, over enough entry times, stakes, durations and directions, that a
 * rule which holds "almost always" has nowhere to hide. Every assertion below is something that
 * must be true of EVERY contract, not of the average one, so a single violation in 20,000 fails it.
 *
 * It is deterministic. Every seed, clock and draw is fixed, so a failure here reproduces exactly.
 */
const SITE = "site-soak";
/**
 * A TEN-SECOND contract, pinned rather than read from the shipped default.
 *
 * This soak marches a clock through tens of thousands of contracts back to back, so the horizon it
 * uses decides how much simulated TIME it covers. The shipped default is now fifteen minutes (a
 * stop needs room to be reached), and 20,000 of those would span 208 days against a curve that is
 * built for one: the walk clamps past its day and the economics it is measuring collapse (measured
 * RTP 0.0082 against a 0.25 target, and the suite's own guard reporting that it "ran past the day
 * it was priced for").
 *
 * What this file tests is money conservation and that the committed payout is the payout paid.
 * Neither depends on the horizon, so it pins the short one that lets 20,000 contracts fit inside a
 * single day's curve.
 */
const cfg = { ...DEFAULT_CONFIG, defaultDurationS: 10 };
cfg.minWithdrawalCents = 999_999_999;   // keep the withdrawal-line lever out of the pool decision
const DAY_START = Date.UTC(2026, 7, 16, 0, 0, 0);
const T0 = DAY_START + 9 * 3600_000;

/** A small deterministic generator, so the soak's own choices are reproducible too. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x1_0000_0000; };
}

/**
 * The settlement engine is PRODUCTION-calibrated here: a full UTC day of entry times, 60k samples.
 *
 * The short window other engine tests use (an hour, a few hundred samples) is fine when the test
 * asserts behaviour rather than price. This file asserts the realised RTP and win rate, so an
 * under-calibrated engine would have it measuring the harness instead of the product. Measured:
 * 1h/600 gives RTP 0.2933, a full day gives 0.2466 against a 0.2500 target.
 */
const CALIB_WINDOW_S = 86_400;
const CALIB_SAMPLES = 60_000;

function makeGame(opts: { poolOn?: boolean; poolCents?: number; seed?: string } = {}) {
  const SEED = opts.seed ?? "soak-seed-0001";
  const curve = new CurveGenerator(SEED, cfg);
  const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, CALIB_WINDOW_S, CALIB_SAMPLES);
  const repo = new InMemoryGameRepository();
  const poolRepo = new InMemoryPoolRepo();
  let clock = T0;
  const now = () => clock;
  poolRepo.setPool(SITE, eatDay(T0), opts.poolCents ?? 10_000_000_000);
  const controller = new PoolController(poolRepo, DEFAULT_POOL_KNOBS, now);
  const ctx: ActiveContext = { curve, settlement, dayStartMs: DAY_START, gameDayId: 1, seed: SEED, configVersion: 0, siteId: SITE };
  const pool = opts.poolOn ? { enabled: () => true, controller } : undefined;
  const game = new GameServer(() => ctx, repo, () => cfg, now, undefined, pool);
  const updates: UpdateEvent[] = [];
  const settled: SettledEvent[] = [];
  const errors: string[] = [];
  game.subscribe({
    onUpdate: (u) => updates.push(u),
    onSettled: (e) => settled.push(e),
    onError: (err, where) => errors.push(`${where}: ${err.message}`),
  });
  return {
    repo, poolRepo, game, settlement, curve, updates, settled, errors,
    advance: (ms: number) => { clock += ms; }, now: () => clock,
  };
}

// ── 1. Twenty thousand contracts, every invariant on every one ───────────────────────────────────

test("20,000 contracts: the money is conserved and the committed payout is what is paid", async () => {
  const h = makeGame();
  const rnd = lcg(7);
  const N = 20_000;
  const START = 1_000_000_000_000;
  /**
   * Contracts run CONCURRENTLY, across one day, which is the only way twenty thousand of them fit.
   *
   * Opening them one after another and waiting out each expiry walks the clock about thirteen days
   * past the day's start, and `entryT` is measured from there — so most of the sample lands in a
   * region the calibration never saw. The first version of this test did exactly that and read an
   * RTP of 0.0127 against a target of 0.25, which looked like an engine fault and was a harness
   * one. A real trading day is 86,400 seconds and that is where entry times have to stay.
   */
  const CONCURRENT = 40;
  const users = Array.from({ length: CONCURRENT }, (_, i) => `u${i}`);
  for (const u of users) h.repo.seed(u, START);

  let staked = 0;
  let wins = 0;
  let opened = 0;
  while (opened < N) {
    const batch = Math.min(CONCURRENT, N - opened);
    for (let k = 0; k < batch; k++) {
      // Vary the stake: a rule that only holds at the minimum is not a rule.
      const stakeCents = Math.max(cfg.minStakeCents, Math.round(cfg.minStakeCents * (1 + rnd() * 40)));
      const { position } = await h.game.openPosition({ userId: users[k]!, stakeCents, direction: rnd() < 0.5 ? "buy" : "sell" });
      staked += stakeCents;
      opened += 1;
      if (position.outcome.result === "win") wins += 1;
      // The committed outcome must be internally consistent on every single contract.
      assert.ok(position.outcome.payoutCents >= 0, `#${opened} negative payout`);
      assert.equal(position.outcome.pnlCents, position.outcome.payoutCents - stakeCents, `#${opened} pnl != payout - stake`);
      if (position.outcome.result === "loss") assert.equal(position.outcome.payoutCents, 0, `#${opened} a loss paid out`);
      if (position.outcome.result === "win") {
        assert.ok(position.outcome.multiplier > 1, `#${opened} a win at multiplier ${position.outcome.multiplier}`);
        assert.ok(position.outcome.multiplier <= cfg.maxMultiplier + 1e-9, `#${opened} multiplier over the cap`);
      }
    }
    h.advance(cfg.defaultDurationS * 1000 + 1);
    await h.game.step();
  }
  assert.equal(h.errors.length, 0, `engine errors: ${h.errors.slice(0, 3).join(" | ")}`);
  assert.equal(h.settled.length, N, `settled ${h.settled.length} of ${N}`);
  // And the whole run stayed inside the trading day it was calibrated for.
  assert.ok((h.now() - DAY_START) / 1000 < 86_400, "the soak ran past the day it was priced for");

  const paid = h.settled.reduce((a, e) => a + e.payoutCents, 0);
  // The ledger has to agree with the arithmetic to the cent, over twenty thousand round trips.
  const total = (await Promise.all(users.map((u) => h.repo.getBalance(u)))).reduce((a, b) => a + b, 0);
  assert.equal(total, START * CONCURRENT - staked + paid, "balances drifted from stake/payout");
  // And every settlement paid exactly what its contract committed to at open.
  for (const e of h.settled) {
    assert.equal(e.payoutCents, e.position.outcome.payoutCents, `${e.position.id} paid off-contract`);
  }

  // The realised RTP and win rate land on the configured targets. This is the calibration working
  // over a sample big enough to see it: a drift here means the settlement engine is mispriced.
  const realisedRtp = paid / staked;
  const target = rtp(cfg);
  assert.ok(Math.abs(realisedRtp - target) < 0.03, `RTP ${realisedRtp.toFixed(4)} vs target ${target.toFixed(4)}`);
  const winRate = wins / N;
  assert.ok(Math.abs(winRate - cfg.targetWinRate) < 0.03, `win rate ${winRate.toFixed(4)} vs ${cfg.targetWinRate}`);
});

test("the expiry a trader picks does not move the outcome horizon, and that is worth knowing", async () => {
  /**
   * A finding this soak turned up rather than a rule it defends.
   *
   * `SettlementEngine.settle` reads `this.durationS` — the duration the engine was CONSTRUCTED
   * with — not the duration of the contract being settled. So a 120s contract is decided on the
   * same horizon as a 10s one: the Expiry control changes how long the player waits and the shape
   * of the live path, and does not change what the contract is worth.
   *
   * It is not a money fault: every contract is still priced by a correctly calibrated engine, and
   * the RTP test above holds. It is a product question, pinned here so a change to it is deliberate
   * rather than accidental.
   */
  const h = makeGame();
  h.repo.seed("d", 1_000_000_000);
  const outcomes: Array<{ durationS: number; result: string; multiplier: number }> = [];
  for (const durationS of [10, 30, 60, 120]) {
    const { position } = await h.game.openPosition({ userId: "d", stakeCents: cfg.minStakeCents, direction: "buy", durationS });
    outcomes.push({ durationS, result: position.outcome.result, multiplier: position.outcome.multiplier });
    h.advance(durationS * 1000 + 1);
    await h.game.step();
  }
  // Opened at four different moments, so the outcomes may differ; what is pinned is the horizon.
  assert.equal(outcomes.length, 4);
  // Two contracts opened at the SAME instant with different durations get the same outcome, which
  // is the thing that shows the horizon is the engine's and not the contract's.
  const g = makeGame();
  g.repo.seed("x", 1_000_000_000);
  g.repo.seed("y", 1_000_000_000);
  const short = await g.game.openPosition({ userId: "x", stakeCents: cfg.minStakeCents, direction: "buy", durationS: 10 });
  const long = await g.game.openPosition({ userId: "y", stakeCents: cfg.minStakeCents, direction: "buy", durationS: 120 });
  assert.equal(short.position.outcome.result, long.position.outcome.result);
  assert.equal(short.position.outcome.multiplier, long.position.outcome.multiplier);
});

// ── 2. The live path, over every contract it is drawn for ────────────────────────────────────────

test("5,000 contracts: the live value lands on the contract and never exceeds its cap", async () => {
  const h = makeGame();
  const rnd = lcg(11);
  const user = "walker";
  h.repo.seed(user, 1_000_000_000_000);
  let sampled = 0;
  let sellableSeen = 0;

  for (let i = 0; i < 5_000; i++) {
    h.advance(Math.round(1 + rnd() * 3_000));
    const durationS = [10, 30, 60][Math.floor(rnd() * 3)]!;
    const { position } = await h.game.openPosition({
      userId: user, stakeCents: cfg.minStakeCents * 2,
      direction: rnd() < 0.5 ? "buy" : "sell", durationS,
    });
    if (position.sellable) sellableSeen += 1;
    // Walk the contract and check every emitted value.
    for (const frac of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      h.advance(Math.round(durationS * 1000 * 0.2));
      h.updates.length = 0;
      await h.game.step();
      const u = h.updates.find((x) => x.positionId === position.id);
      if (!u) continue;
      sampled += 1;
      assert.ok(Number.isFinite(u.liveMultiplier), `#${i} non-finite live value`);
      assert.ok(u.liveMultiplier >= 0, `#${i} negative live value ${u.liveMultiplier}`);
      assert.ok(u.liveMultiplier <= cfg.maxMultiplier + 1e-9, `#${i} live value over the cap`);
      // A contract that can be closed early must never SHOW more than it will pay, or the close
      // would lock a value above the settlement and break the house edge.
      if (position.sellable) {
        assert.ok(u.liveMultiplier <= position.outcome.multiplier + 1e-9,
          `#${i} at ${frac}: live ${u.liveMultiplier} > committed ${position.outcome.multiplier}`);
      }
      assert.equal(u.livePnlCents, Math.round(position.stakeCents * u.liveMultiplier) - position.stakeCents,
        `#${i} P/L does not follow the multiplier`);
    }
    h.advance(durationS * 1000 + 1);
    await h.game.step();
  }
  assert.ok(sampled > 15_000, `only ${sampled} live samples`);
  assert.ok(sellableSeen > 0, "no sellable contract in 5,000, so the cap was never exercised");
  assert.equal(h.errors.length, 0, h.errors.slice(0, 3).join(" | "));
});

// ── 3. The pool, run until it is empty ───────────────────────────────────────────────────────────

test("a pool run dry pays nothing it has not got, and never over-reserves", async () => {
  // Fixed odds pay in full or not at all: a partial reserve becomes a loss and the hold is
  // released. Over thousands of contracts against a small pool that path is hit constantly.
  const POOL = 5_000_000;
  const h = makeGame({ poolOn: true, poolCents: POOL });
  const rnd = lcg(13);
  const user = "drain";
  h.repo.seed(user, 1_000_000_000_000);

  let paid = 0;
  for (let i = 0; i < 4_000; i++) {
    h.advance(Math.round(1 + rnd() * 2_000));
    const { position } = await h.game.openPosition({
      userId: user, stakeCents: cfg.minStakeCents * 10, direction: rnd() < 0.5 ? "buy" : "sell",
    });
    assert.equal(position.poolControlled, true, `#${i} escaped the pool`);
    h.advance(cfg.defaultDurationS * 1000 + 1);
    await h.game.step();
  }
  for (const e of h.settled) paid += e.payoutCents;
  assert.equal(h.errors.length, 0, h.errors.slice(0, 3).join(" | "));

  const st = await h.poolRepo.poolState(SITE, eatDay(T0));
  // Nothing may be left held: every contract settled, so every reservation was committed or released.
  assert.equal(st.reservedCents, 0, `${st.reservedCents} cents still reserved after everything settled`);
  // And the pool cannot have paid out more than it held.
  assert.ok(st.paidCents <= st.amountCents, `paid ${st.paidCents} from a pool of ${st.amountCents}`);
  assert.equal(st.paidCents, paid, "the pool's ledger disagrees with what was paid");
});

// ── 4. The states a real session actually gets into ──────────────────────────────────────────────

test("a contract cannot be settled twice, sold twice, or sold by someone else", async () => {
  const h = makeGame();
  h.repo.seed("a", 100_000_000);
  h.repo.seed("b", 100_000_000);
  // Walk until a sellable (already-won) contract comes up.
  let sellable = null as Awaited<ReturnType<typeof h.game.openPosition>>["position"] | null;
  for (let i = 0; i < 200 && !sellable; i++) {
    h.advance(1_000);
    const { position } = await h.game.openPosition({ userId: "a", stakeCents: cfg.minStakeCents, direction: i % 2 ? "buy" : "sell" });
    if (position.sellable) { sellable = position; break; }
    h.advance(cfg.defaultDurationS * 1000 + 1);
    await h.game.step();
  }
  assert.ok(sellable, "no sellable contract came up");
  h.advance(Math.round(cfg.defaultDurationS * 1000 * 0.3));
  await h.game.step();

  // Someone else's contract is not yours to close.
  await assert.rejects(() => h.game.sell(sellable!.id, "b"), /POSITION_NOT_FOUND/);
  const before = await h.repo.getBalance("a");
  const e = await h.game.sell(sellable!.id, "a");
  assert.equal(await h.repo.getBalance("a"), before + e.payoutCents);
  // And it cannot be closed, or settled, a second time.
  await assert.rejects(() => h.game.sell(sellable!.id, "a"), /ALREADY_SETTLED/);
  const settledCount = h.settled.length;
  h.advance(cfg.defaultDurationS * 1000 + 1);
  await h.game.step();
  assert.equal(h.settled.length, settledCount, "an already-settled contract settled again at expiry");
});

test("an unfunded account cannot open, and a near-empty one cannot overdraw", async () => {
  const h = makeGame();
  h.repo.seed("broke", 0);
  await assert.rejects(() => h.game.openPosition({ userId: "broke", stakeCents: cfg.minStakeCents, direction: "buy" }), /INSUFFICIENT_FUNDS/);
  // Exactly enough is enough; a cent less is not.
  h.repo.seed("tight", cfg.minStakeCents);
  const { position } = await h.game.openPosition({ userId: "tight", stakeCents: cfg.minStakeCents, direction: "buy" });
  assert.ok(position);
  assert.equal(await h.repo.getBalance("tight"), 0);
  await assert.rejects(() => h.game.openPosition({ userId: "tight", stakeCents: cfg.minStakeCents, direction: "buy" }), /INSUFFICIENT_FUNDS/);
});

test("the clock jumping forward settles everything that expired, and nothing that did not", async () => {
  // A tab asleep, a container paused, a reconnect after minutes: the next step must catch up
  // without losing a contract or settling one early.
  const h = makeGame();
  const users = Array.from({ length: 50 }, (_, i) => `u${i}`);
  for (const u of users) h.repo.seed(u, 100_000_000);
  const longs: string[] = [];
  for (let i = 0; i < users.length; i++) {
    const durationS = i % 2 === 0 ? 10 : 120;
    const { position } = await h.game.openPosition({ userId: users[i]!, stakeCents: cfg.minStakeCents, direction: "buy", durationS });
    if (durationS === 120) longs.push(position.id);
  }
  h.advance(11_000);          // past every 10s contract, nowhere near the 120s ones
  await h.game.step();
  assert.equal(h.settled.length, 25, `settled ${h.settled.length} after 11s, expected the 25 short ones`);
  for (const e of h.settled) assert.ok(!longs.includes(e.position.id), "a 120s contract settled at 11s");
  h.advance(5 * 60_000);      // long past all of them
  await h.game.step();
  assert.equal(h.settled.length, 50, "the long contracts did not catch up");
  assert.equal(h.errors.length, 0, h.errors.slice(0, 3).join(" | "));
});

test("concurrent steps do not double-settle: the engine refuses to re-enter", async () => {
  const h = makeGame();
  h.repo.seed("c", 100_000_000);
  await h.game.openPosition({ userId: "c", stakeCents: cfg.minStakeCents, direction: "buy" });
  h.advance(cfg.defaultDurationS * 1000 + 1);
  await Promise.all([h.game.step(), h.game.step(), h.game.step(), h.game.step()]);
  assert.equal(h.settled.length, 1, `settled ${h.settled.length} times from four concurrent steps`);
});

test("every brand seed prices to the same targets, so one lucky seed is not what is being measured", async () => {
  // The calibration is per (curve, config). A seed that happened to be kind would make every other
  // assertion here a measurement of that seed rather than of the engine.
  for (const seed of ["soak-a", "soak-b", "soak-c"]) {
    const h = makeGame({ seed });
    const rnd = lcg(17);
    h.repo.seed("s", 1_000_000_000_000);
    let staked = 0;
    for (let i = 0; i < 3_000; i++) {
      h.advance(Math.round(1 + rnd() * 5_000));
      const stakeCents = cfg.minStakeCents * 3;
      await h.game.openPosition({ userId: "s", stakeCents, direction: rnd() < 0.5 ? "buy" : "sell" });
      staked += stakeCents;
      h.advance(cfg.defaultDurationS * 1000 + 1);
      await h.game.step();
    }
    const paid = h.settled.reduce((a, e) => a + e.payoutCents, 0);
    assert.ok(Math.abs(paid / staked - rtp(cfg)) < 0.04, `${seed}: RTP ${(paid / staked).toFixed(4)}`);
    assert.equal(h.errors.length, 0, `${seed}: ${h.errors.slice(0, 2).join(" | ")}`);
  }
});
