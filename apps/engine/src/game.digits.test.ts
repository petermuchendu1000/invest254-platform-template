import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurveGenerator, SettlementEngine, DEFAULT_CONFIG, type DigitKind,
  InstrumentFeed, instrumentById, DEFAULT_INSTRUMENT_ID, digitAt, digitPayoutFactor,
} from "@invest254/shared";
import { GameServer, type ActiveContext } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";

/**
 * Phase 2 — engine DIGIT contract path, now server-authoritative & provably fair over PER-INSTRUMENT
 * feeds (the rise/fall path is untouched). The settled digit is `digitAt(seed, instrument,
 * settleIndex)` — the SAME pure function the client verifies from the revealed seed — so the test
 * recomputes it and asserts the money movement (stake debit on open, factor-priced payout on settle)
 * exactly. Payout uses the DIGIT factor (NOT the rise/fall houseEdge).
 */
const SEED = "deadbeefcafe";
const cfg = { ...DEFAULT_CONFIG };
const curve = new CurveGenerator(SEED, cfg);
const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600);
const DAY_START = Date.UTC(2026, 8, 5, 0, 0, 0);
const T_OPEN = Date.UTC(2026, 8, 5, 9, 0, 0);
const STAKE = 25_000;
const START = 10_000_000;
const factor = digitPayoutFactor(cfg); // 0.95 default (5% edge) — NOT 1 − houseEdge
const inst = instrumentById(DEFAULT_INSTRUMENT_ID);

function makeGame() {
  let clock = T_OPEN;
  const now = () => clock;
  const ctx: ActiveContext = { curve, settlement, dayStartMs: DAY_START, gameDayId: 1, seed: SEED, configVersion: 0, siteId: "site-x" };
  const repo = new InMemoryGameRepository();
  const game = new GameServer(() => ctx, repo, () => cfg, now);
  return { repo, game, advance: (ms: number) => { clock += ms; } };
}

const openIndexAt = (openMs: number) => Math.floor((openMs - DAY_START) / inst.tickMs);
/** The digit that WILL settle for a 1-tick contract opened at `openMs` (recomputed from the seed). */
function settledDigit(openMs: number): number {
  return digitAt(SEED, inst.id, openIndexAt(openMs) + 1);
}

test("digit contract: stake debits on open, fair payout credits a WIN", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const digit = settledDigit(T_OPEN);
  const winKind: DigitKind = digit % 2 === 0 ? "even" : "odd";

  const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: winKind });
  assert.equal(open.settleIndex, open.openIndex + 1, "1-tick contract");
  assert.equal(await h.repo.getBalance("p1"), START - STAKE, "stake debited immediately on open");

  const res = await h.game.settleDigitContract(open.positionId);
  assert.equal(res.digit, digit, "settled digit = digitAt(seed, instrument, settleIndex)");
  assert.equal(res.won, true);
  const expectedPayout = Math.round((STAKE * factor) / 0.5); // even/odd prob 0.5
  assert.equal(res.payoutCents, expectedPayout);
  assert.equal(await h.repo.getBalance("p1"), START - STAKE + expectedPayout, "payout credited on win");
});

test("digit contract: a LOSS pays 0 and leaves the balance down by the stake", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const digit = settledDigit(T_OPEN);
  const loseKind: DigitKind = digit % 2 === 0 ? "odd" : "even";

  const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: loseKind });
  const res = await h.game.settleDigitContract(open.positionId);
  assert.equal(res.won, false);
  assert.equal(res.payoutCents, 0);
  assert.equal(await h.repo.getBalance("p1"), START - STAKE, "loss: only the stake is gone");
});

test("digit contract: over/under settle against the committed digit and are factor-priced", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const digit = settledDigit(T_OPEN);
  const barrier = 3;
  const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: "over", target: barrier });
  const res = await h.game.settleDigitContract(open.positionId);
  assert.equal(res.won, digit > barrier);
  const prob = (9 - barrier) / 10;
  assert.equal(res.payoutCents, res.won ? Math.round((STAKE * factor) / prob) : 0);
});

test("digit factor is independent of the rise/fall houseEdge (playable payout)", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const digit = settledDigit(T_OPEN);
  const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: digit % 2 === 0 ? "even" : "odd" });
  const res = await h.game.settleDigitContract(open.positionId);
  // With houseEdge 0.75 the OLD code paid 0.5× (unplayable). The digit factor pays ~1.9× on even/odd.
  assert.ok(res.payoutCents > STAKE, `win must exceed stake: ${res.payoutCents} <= ${STAKE}`);
});

test("distinct instruments settle from independent digit streams", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const dDefault = digitAt(SEED, "vol10_1s", openIndexAt(T_OPEN) + 1);
  const dOther = digitAt(SEED, "vol100_1s", openIndexAt(T_OPEN) + 1);
  const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: "even", instrumentId: "vol100_1s" });
  const res = await h.game.settleDigitContract(open.positionId);
  assert.equal(res.digit, dOther, "settled against the chosen instrument's stream");
  // (Sanity: the two instruments generally differ; not asserted per-index to avoid a 10% collision flake.)
  assert.equal(open.instrumentId, "vol100_1s");
  void dDefault;
});

test("digit contract settlement is idempotent (double-settle is a no-op)", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: "even" });
  await h.game.settleDigitContract(open.positionId);
  const balAfter = await h.repo.getBalance("p1");
  await assert.rejects(() => h.game.settleDigitContract(open.positionId), /CONTRACT_NOT_FOUND/);
  assert.equal(await h.repo.getBalance("p1"), balAfter, "balance unchanged by a second settle attempt");
});

test("settleDueDigits settles only contracts whose settleIndex has arrived", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const open = await h.game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind: "even" });
  // Not yet due:
  const none = await h.game.settleDueDigits(inst.id, open.openIndex);
  assert.equal(none.length, 0, "nothing settles before settleIndex");
  assert.equal(await h.repo.getBalance("p1"), START - STAKE);
  // Due now:
  const done = await h.game.settleDueDigits(inst.id, open.settleIndex);
  assert.equal(done.length, 1);
  assert.equal(done[0]!.userId, "p1");
});
