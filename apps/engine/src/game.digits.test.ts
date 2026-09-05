import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator, SettlementEngine, DEFAULT_CONFIG, lastDigit, type DigitKind } from "@invest254/shared";
import { GameServer, type ActiveContext } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";

/**
 * Phase 2 — engine DIGIT contract path (demo-first, additive; the rise/fall path is untouched).
 *
 * Fairness parity: the settled digit is the last digit of the SAME authoritative seed-derived quote
 * the client renders, so the test recomputes it from the deterministic CurveGenerator and asserts
 * the money movement (stake debit on open, fair house-edge payout on settle) exactly.
 */
const SEED = "deadbeefcafe";
const cfg = { ...DEFAULT_CONFIG };
const curve = new CurveGenerator(SEED, cfg);
const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600);
const DAY_START = Date.UTC(2026, 8, 5, 0, 0, 0);
const T_OPEN = Date.UTC(2026, 8, 5, 9, 0, 0);
const SETTLE_DELAY_MS = 1000; // 1-tick digit contract
const STAKE = 25_000;
const START = 10_000_000;
const factor = Math.min(0.999, Math.max(0.5, 1 - cfg.houseEdge));

function makeGame() {
  let clock = T_OPEN;
  const now = () => clock;
  const ctx: ActiveContext = { curve, settlement, dayStartMs: DAY_START, gameDayId: 1, seed: SEED, configVersion: 0, siteId: "site-x" };
  const repo = new InMemoryGameRepository();
  const game = new GameServer(() => ctx, repo, () => cfg, now);
  return { repo, game, advance: (ms: number) => { clock += ms; }, settleRateAt: (ms: number) => curve.rate((ms - DAY_START) / 1000) };
}

/** The digit that WILL settle SETTLE_DELAY_MS after open (recomputed from the shared curve). */
function settledDigit(h: ReturnType<typeof makeGame>): number {
  return lastDigit(h.settleRateAt(T_OPEN + SETTLE_DELAY_MS));
}

test("digit contract: stake debits on open, fair payout credits a WIN", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const digit = settledDigit(h);
  const winKind: DigitKind = digit % 2 === 0 ? "even" : "odd"; // guaranteed to win against that digit

  const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: winKind });
  assert.equal(await h.repo.getBalance("p1"), START - STAKE, "stake debited immediately on open");

  h.advance(SETTLE_DELAY_MS);
  const res = await h.game.settleDigitContract(open.positionId);
  assert.equal(res.digit, digit, "settled digit = last digit of the authoritative quote");
  assert.equal(res.won, true);
  const expectedPayout = Math.round((STAKE * factor) / 0.5); // even/odd prob 0.5
  assert.equal(res.payoutCents, expectedPayout);
  assert.equal(await h.repo.getBalance("p1"), START - STAKE + expectedPayout, "payout credited on win");
});

test("digit contract: a LOSS pays 0 and leaves the balance down by the stake", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const digit = settledDigit(h);
  const loseKind: DigitKind = digit % 2 === 0 ? "odd" : "even"; // guaranteed to lose

  const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: loseKind });
  h.advance(SETTLE_DELAY_MS);
  const res = await h.game.settleDigitContract(open.positionId);
  assert.equal(res.won, false);
  assert.equal(res.payoutCents, 0);
  assert.equal(await h.repo.getBalance("p1"), START - STAKE, "loss: only the stake is gone");
});

test("digit contract: over/under settle against the same digit and are house-edge priced", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const digit = settledDigit(h);
  // Choose a barrier that makes 'over' win iff digit>barrier; assert payout matches the analytic price.
  const barrier = 3;
  const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: "over", target: barrier });
  h.advance(SETTLE_DELAY_MS);
  const res = await h.game.settleDigitContract(open.positionId);
  assert.equal(res.won, digit > barrier);
  const prob = (9 - barrier) / 10;
  assert.equal(res.payoutCents, res.won ? Math.round((STAKE * factor) / prob) : 0);
});

test("digit contract settlement is idempotent (double-settle is a no-op)", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: "even" });
  h.advance(SETTLE_DELAY_MS);
  await h.game.settleDigitContract(open.positionId);
  const balAfter = await h.repo.getBalance("p1");
  await assert.rejects(() => h.game.settleDigitContract(open.positionId), /CONTRACT_NOT_FOUND/);
  assert.equal(await h.repo.getBalance("p1"), balAfter, "balance unchanged by a second settle attempt");
});
