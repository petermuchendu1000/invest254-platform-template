import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurveGenerator, SettlementEngine, DEFAULT_CONFIG, type DigitKind,
  instrumentById, DEFAULT_INSTRUMENT_ID, digitAt, digitPayoutFactor,
} from "@invest254/shared";
import { GameServer, type ActiveContext } from "./game.js";
import { InMemoryGameRepository } from "./wallet.js";
import { RecoveryService } from "./recovery.js";
import type { SeedManager } from "./daycontext.js";

/**
 * Phase 2 — crash recovery for open DIGIT contracts. A stake is debited on open; if the engine
 * restarts before the 1-tick settlement, the position is still `open` in the DB. Recovery must
 * settle it deterministically (same digit as a no-crash run) and idempotently (no double credit).
 */
const SEED = "deadbeefcafe";
const cfg = { ...DEFAULT_CONFIG };
const curve = new CurveGenerator(SEED, cfg);
const settlement = new SettlementEngine(curve, cfg, "calib", cfg.defaultDurationS, 3600, 600);
const DAY_START = Date.UTC(2026, 8, 5, 0, 0, 0);
const T_OPEN = Date.UTC(2026, 8, 5, 9, 0, 0);
const STAKE = 25_000;
const START = 10_000_000;
const inst = instrumentById(DEFAULT_INSTRUMENT_ID);
const factor = digitPayoutFactor(cfg);

const ctx: ActiveContext = { curve, settlement, dayStartMs: DAY_START, gameDayId: 1, seed: SEED, configVersion: 0, siteId: "site-x" };
// A minimal SeedManager whose contextFor returns the same day context, plus cfg (recovery reads ctx.cfg).
const seedsStub = { contextFor: async () => ({ ...ctx, cfg }) } as unknown as SeedManager;

test("crash recovery settles a stranded digit contract deterministically + idempotently", async () => {
  const repo = new InMemoryGameRepository();
  repo.seed("p1", START);
  const game = new GameServer(() => ctx, repo, () => cfg, () => T_OPEN);

  const digit = digitAt(SEED, inst.id, Math.floor((T_OPEN - DAY_START) / inst.tickMs) + 1);
  const kind: DigitKind = digit % 2 === 0 ? "even" : "odd"; // a guaranteed win to make the payout deterministic
  const open = await game.openDigitContract({ userId: "p1", stakeCents: STAKE, kind });
  assert.equal(await repo.getBalance("p1"), START - STAKE, "stake debited on open");

  // Simulate a crash: a brand-new GameServer (empty in-memory maps) + recovery over the SAME repo.
  const freshGame = new GameServer(() => ctx, repo, () => cfg, () => T_OPEN);
  const rec = new RecoveryService(repo, seedsStub, freshGame, () => T_OPEN + 5000, undefined, "site-x");

  const report = await rec.recover();
  assert.equal(report.scanned, 1);
  assert.equal(report.settled, 1, "the stranded digit contract was settled on boot");

  const expectedPayout = Math.round((STAKE * factor) / 0.5); // even/odd win
  assert.equal(await repo.getBalance("p1"), START - STAKE + expectedPayout, "recovered payout matches a no-crash settle");

  // Idempotent: a second recovery pass must not move money again.
  const again = await rec.recover();
  assert.equal(again.scanned, 0, "position is no longer open after recovery");
  assert.equal(await repo.getBalance("p1"), START - STAKE + expectedPayout, "no double credit");
  void open;
});
