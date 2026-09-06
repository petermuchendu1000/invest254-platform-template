import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator, SettlementEngine, DEFAULT_CONFIG, dealCancellationFeeCents, type MultDir } from "@invest254/shared";
import { GameServer, type ActiveContext } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";

/**
 * Phase 2 — engine MULTIPLIER contract path (demo-first, additive). The running position is evaluated
 * against the SAME deterministic authoritative quote the client renders, so the test recomputes the
 * P/L from the CurveGenerator and asserts stake debit + payout (stake + P/L, floored at 0) exactly.
 */
const SEED = "deadbeefcafe";
const cfg = { ...DEFAULT_CONFIG };
const curve = new CurveGenerator(SEED, cfg);
const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600);
const DAY_START = Date.UTC(2026, 8, 5, 0, 0, 0);
const T_OPEN = Date.UTC(2026, 8, 5, 9, 0, 0);
const DELTA = 3000;
const STAKE = 25_000;
const START = 10_000_000;

const entry = curve.rate((T_OPEN - DAY_START) / 1000);
const cur = curve.rate((T_OPEN + DELTA - DAY_START) / 1000);
const movePct = (cur - entry) / entry;
const signedPnl = (dir: MultDir, mult: number) => Math.max(-STAKE, Math.round((dir === "up" ? movePct : -movePct) * mult * STAKE));

function makeGame() {
  let clock = T_OPEN;
  const now = () => clock;
  const ctx: ActiveContext = { curve, settlement, dayStartMs: DAY_START, gameDayId: 1, seed: SEED, configVersion: 0, siteId: "site-x" };
  const repo = new InMemoryGameRepository();
  const game = new GameServer(() => ctx, repo, () => cfg, now);
  return { repo, game, advance: (ms: number) => { clock += ms; } };
}

test("sanity: the deterministic quote actually moves over the window", () => {
  assert.ok(Math.abs(movePct) > 0, `movePct=${movePct}`);
});

test("multiplier: manual close pays stake + P/L (favorable direction)", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const dir: MultDir = movePct >= 0 ? "up" : "down"; // favorable → profit
  const mult = 1000;
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir, multiplier: mult });
  assert.equal(await h.repo.getBalance("p1"), START - STAKE, "stake debited on open");
  h.advance(DELTA);
  const realized = signedPnl(dir, mult);
  assert.ok(realized > 0, "favorable move should be a profit");
  const res = await h.game.closeMultiplierContract(open.positionId);
  assert.equal(res.reason, "manual");
  assert.equal(res.pnlCents, realized);
  assert.equal(res.payoutCents, STAKE + realized);
  assert.equal(await h.repo.getBalance("p1"), START - STAKE + (STAKE + realized));
});

test("multiplier: stop-out at 100% loss pays 0", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const dir: MultDir = movePct >= 0 ? "down" : "up"; // adverse
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir, multiplier: 500_000 });
  h.advance(DELTA);
  const res = await h.game.evaluateMultiplierContract(open.positionId);
  assert.equal(res.closed, true);
  assert.equal(res.reason, "stopout");
  assert.equal(res.payoutCents, 0);
  assert.equal(await h.repo.getBalance("p1"), START - STAKE, "stop-out: only the stake is lost");
});

test("multiplier: take profit auto-closes at the set profit", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const dir: MultDir = movePct >= 0 ? "up" : "down";
  const mult = 1000;
  const full = signedPnl(dir, mult);
  assert.ok(full > 1, "need a positive P/L to place a TP below it");
  const tp = Math.max(1, Math.floor(full / 2));
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir, multiplier: mult, tpCents: tp });
  h.advance(DELTA);
  const res = await h.game.evaluateMultiplierContract(open.positionId);
  assert.equal(res.reason, "tp");
  assert.equal(res.payoutCents, STAKE + tp);
  assert.equal(await h.repo.getBalance("p1"), START - STAKE + STAKE + tp);
});

test("multiplier: deal cancellation refunds the stake (minus fee) instead of stopping out", async () => {
  const h = makeGame();
  h.repo.seed("p1", START);
  const dir: MultDir = movePct >= 0 ? "down" : "up"; // adverse → would stop out
  const open = await h.game.openMultiplierContract({ userId: "p1", stakeCents: STAKE, dir, multiplier: 500_000, dcMinutes: 5 });
  h.advance(DELTA); // still within the 5-minute DC window
  const res = await h.game.evaluateMultiplierContract(open.positionId);
  assert.equal(res.reason, "cancel");
  const fee = dealCancellationFeeCents(STAKE, 5);
  assert.equal(res.payoutCents, STAKE - fee, "stake refunded minus the DC fee");
  assert.equal(await h.repo.getBalance("p1"), START - fee, "net loss is only the DC fee");
});
