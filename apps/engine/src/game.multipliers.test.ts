import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurveGenerator, SettlementEngine, DEFAULT_CONFIG, dealCancellationFeeCents, type MultDir,
  InstrumentFeed, instrumentById, DEFAULT_INSTRUMENT_ID,
} from "@invest254/shared";
import { GameServer, type ActiveContext } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";

/**
 * Phase 2 — engine MULTIPLIER contracts, STATISTICAL path (pool off / marketers), now priced on the
 * PER-INSTRUMENT authoritative feed. The running position is evaluated against the same deterministic
 * quote the client streams, so the test recomputes P/L from the InstrumentFeed and asserts stake
 * debit + payout (stake + P/L, floored at 0) exactly. Auto-closes (TP/SL/stop-out/DC) are driven by
 * tickMultipliers — the transport's per-tick hook.
 */
const SEED = "deadbeefcafe";
const cfg = { ...DEFAULT_CONFIG };
const curve = new CurveGenerator(SEED, cfg);
const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600);
const DAY_START = Date.UTC(2026, 8, 5, 0, 0, 0);
const T_OPEN = Date.UTC(2026, 8, 5, 9, 0, 0);
const STAKE = 25_000;
const START = 10_000_000;
const inst = instrumentById(DEFAULT_INSTRUMENT_ID); // vol10_1s, tickMs 1000
const feed = new InstrumentFeed(SEED, inst);

const openIndex = Math.floor((T_OPEN - DAY_START) / inst.tickMs);
const entry = feed.tickAt(openIndex).quote;

/** First index after open where the quote moves in the wanted sign vs entry. */
function findMove(sign: 1 | -1, maxLook = 600): { index: number; quote: number } {
  for (let i = openIndex + 1; i <= openIndex + maxLook; i++) {
    const q = feed.tickAt(i).quote;
    if (Math.sign(q - entry) === sign && Math.abs(q - entry) / entry > 1e-6) return { index: i, quote: q };
  }
  throw new Error(`no ${sign > 0 ? "up" : "down"} move within ${maxLook} ticks`);
}
const pnlAt = (dir: MultDir, mult: number, quote: number) =>
  Math.max(-STAKE, Math.round(((dir === "up" ? 1 : -1) * (quote - entry)) / entry * mult * STAKE));

function makeGame() {
  let clock = T_OPEN;
  const now = () => clock;
  const ctx: ActiveContext = { curve, settlement, dayStartMs: DAY_START, gameDayId: 1, seed: SEED, configVersion: 0, siteId: "site-x" };
  const repo = new InMemoryGameRepository();
  const game = new GameServer(() => ctx, repo, () => cfg, now);
  return { repo, game, setIndex: (i: number) => { clock = DAY_START + i * inst.tickMs; } };
}

test("multiplier: manual close pays stake + P/L (favorable move on the instrument feed)", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const up = findMove(1);
  const mult = 1000;
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: mult });
  assert.equal(open.entry, entry, "entry = authoritative feed quote at the open index");
  assert.equal(await h.repo.getBalance("p1"), START - STAKE, "stake debited on open");
  h.setIndex(up.index);
  const expected = pnlAt("up", mult, up.quote);
  assert.ok(expected > 0, "favorable move should be a profit");
  const res = await h.game.closeMultiplierContract(open.positionId, "p1");
  assert.equal(res.reason, "manual");
  assert.equal(res.pnlCents, expected);
  assert.equal(res.payoutCents, STAKE + expected);
  assert.equal(await h.repo.getBalance("p1"), START - STAKE + STAKE + expected);
});

test("multiplier: tick loop stops out at 100% loss (pays 0)", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const down = findMove(-1);
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: 5_000_000 });
  h.setIndex(down.index);
  const { updates, closed } = await h.game.tickMultipliers(inst.id, down.index);
  assert.equal(updates.length, 0);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.reason, "stopout");
  assert.equal(closed[0]!.payoutCents, 0);
  assert.equal(await h.repo.getBalance("p1"), START - STAKE, "stop-out: only the stake is lost");
  void open;
});

test("multiplier: tick loop auto-closes at Take Profit for exactly the set profit", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const up = findMove(1);
  const mult = 1000;
  const full = pnlAt("up", mult, up.quote);
  assert.ok(full > 1, "need a positive P/L to place a TP below it");
  const tp = Math.max(1, Math.floor(full / 2));
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: mult, tpCents: tp });
  h.setIndex(up.index);
  const { closed } = await h.game.tickMultipliers(inst.id, up.index);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.reason, "tp");
  assert.equal(closed[0]!.payoutCents, STAKE + tp);
  assert.equal(await h.repo.getBalance("p1"), START + tp);
  void open;
});

test("multiplier: deal cancellation refunds the stake (minus fee) instead of stopping out", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const down = findMove(-1);
  assert.ok((down.index - openIndex) * inst.tickMs < 5 * 60_000, "adverse move is inside the 5-min DC window");
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: 5_000_000, dcMinutes: 5 });
  h.setIndex(down.index);
  const { closed } = await h.game.tickMultipliers(inst.id, down.index);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.reason, "cancel");
  const fee = dealCancellationFeeCents(STAKE, 5);
  assert.equal(closed[0]!.payoutCents, STAKE - fee, "stake refunded minus the DC fee");
  assert.equal(await h.repo.getBalance("p1"), START - fee, "net loss is only the DC fee");
  void open;
});

test("multiplier: live update stream carries the feed-derived P/L while open", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const mult = 50; // small: no stop-out, no TP
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: mult });
  const i = openIndex + 3;
  h.setIndex(i);
  const { updates, closed } = await h.game.tickMultipliers(inst.id, i);
  assert.equal(closed.length, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.positionId, open.positionId);
  assert.equal(updates[0]!.pnlCents, pnlAt("up", mult, feed.tickAt(i).quote));
});

test("multiplier: one open contract per (user, instrument); ownership enforced on close", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "up", multiplier: 100 });
  await assert.rejects(() => h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir: "down", multiplier: 100 }), /CONTRACT_EXISTS/);
  await assert.rejects(() => h.game.closeMultiplierContract(open.positionId, "someone-else"), /CONTRACT_NOT_FOUND/);
  await h.game.closeMultiplierContract(open.positionId, "p1");
});
