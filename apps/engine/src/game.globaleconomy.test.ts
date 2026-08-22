import { test } from "node:test";
import assert from "node:assert/strict";
import { CurveGenerator, SettlementEngine, DEFAULT_CONFIG, parseCohort, type PlatformEconomy } from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { GameServer } from "./game.js";
import { composeGlobalOverride } from "./globaloverride.js";
import type { UserOverride } from "./overrides.js";

/**
 * END-TO-END scenario tests for the platform GLOBAL economy (migration 0099) driving the REAL
 * GameServer.openPosition path — proving the composed override reaches the engine per cohort with the
 * correct precedence (global wins), deterministically (via stake gates + duration, which don't depend
 * on the settlement RNG). Pricing calibration itself is covered by overrides/settle tests.
 */
function rig() {
  const cfg = DEFAULT_CONFIG; // min stake 25000, default duration 10
  const curve = new CurveGenerator("engine-day", cfg);
  const eng = new SettlementEngine(curve, cfg);
  const repo = new InMemoryGameRepository();
  const clock = { ms: 0 };
  const ctx = { curve, settlement: eng, dayStartMs: 0, gameDayId: null, configVersion: 1 };
  return { cfg, repo, clock, ctx };
}
const econ = (player: object, marketer: object): PlatformEconomy => ({
  player: parseCohort(player), marketer: parseCohort(marketer), payments: {},
});
const gate = (eco: PlatformEconomy) => ({ economy: async () => eco });
const isMkt = (id: string) => Promise.resolve(id === "mkt");
const baseOv = (o: Partial<UserOverride>): UserOverride => ({
  userId: "x", winRate: null, houseEdge: null, tradeDurationS: null, maxWinMultiplier: null,
  minStakeCents: null, maxStakeCents: null, notes: null, updatedBy: null, updatedAtMs: 0, ...o,
});

test("e2e: enforced PLAYER economy gates stake + forces duration on the real open path", async () => {
  const { cfg, repo, clock, ctx } = rig();
  const eco = econ({ minStakeCents: { v: 50000, on: true }, defaultDurationS: { v: 30, on: true } }, {});
  const load = composeGlobalOverride(async () => null, gate(eco), isMkt);
  const gs = new GameServer(() => ctx, repo, () => cfg, () => clock.ms, load, undefined, isMkt);
  repo.seed("p1", 1_000_000);
  // Below the ENFORCED global min (50000) even though the site min is 25000.
  await assert.rejects(() => gs.openPosition({ userId: "p1", stakeCents: 25000, direction: "buy" }), /STAKE_BELOW_MIN/);
  const { position } = await gs.openPosition({ userId: "p1", stakeCents: 50000, direction: "buy" });
  assert.equal(position.durationS, 30, "enforced global duration applied on the real open path");
});

test("e2e: PLAYER and MARKETER economies are SEPARATE (marketer min differs from player min)", async () => {
  const { cfg, repo, clock, ctx } = rig();
  const eco = econ(
    { minStakeCents: { v: 50000, on: true } },   // players must stake >= 500
    { minStakeCents: { v: 10000, on: true } },   // marketers only >= 100
  );
  const load = composeGlobalOverride(async () => null, gate(eco), isMkt);
  const gs = new GameServer(() => ctx, repo, () => cfg, () => clock.ms, load, undefined, isMkt);
  repo.seed("p1", 1_000_000); repo.seed("mkt", 1_000_000);
  // 25000: below the player min (reject) but above the marketer min (allow) — proves the cohort split.
  await assert.rejects(() => gs.openPosition({ userId: "p1", stakeCents: 25000, direction: "buy" }), /STAKE_BELOW_MIN/);
  const { position } = await gs.openPosition({ userId: "mkt", stakeCents: 25000, direction: "buy" });
  assert.ok(position.id, "marketer trade admitted under the separate marketer economy");
});

test("e2e: GLOBAL enforce WINS over a per-user override on the real open path", async () => {
  const { cfg, repo, clock, ctx } = rig();
  const eco = econ({ minStakeCents: { v: 50000, on: true } }, {});
  // The user has a LOWER personal min (5000); global enforce must still win.
  const load = composeGlobalOverride(async (uid) => (uid === "p2" ? baseOv({ userId: "p2", minStakeCents: 5000 }) : null), gate(eco), isMkt);
  const gs = new GameServer(() => ctx, repo, () => cfg, () => clock.ms, load, undefined, isMkt);
  repo.seed("p2", 1_000_000);
  await assert.rejects(() => gs.openPosition({ userId: "p2", stakeCents: 25000, direction: "buy" }), /STAKE_BELOW_MIN/);
  const ok = await gs.openPosition({ userId: "p2", stakeCents: 50000, direction: "buy" });
  assert.ok(ok.position.id);
});

test("e2e: a per-user override still applies for fields the global does NOT enforce", async () => {
  const { cfg, repo, clock, ctx } = rig();
  const eco = econ({ minStakeCents: { v: 50000, on: true } }, {}); // global enforces stake only
  const load = composeGlobalOverride(async (uid) => (uid === "p3" ? baseOv({ userId: "p3", tradeDurationS: 45 }) : null), gate(eco), isMkt);
  const gs = new GameServer(() => ctx, repo, () => cfg, () => clock.ms, load, undefined, isMkt);
  repo.seed("p3", 1_000_000);
  const { position } = await gs.openPosition({ userId: "p3", stakeCents: 50000, direction: "buy" });
  assert.equal(position.durationS, 45, "user-override duration survives where global doesn't enforce it");
});

test("e2e: nothing enforced => unchanged behaviour (site min + default duration)", async () => {
  const { cfg, repo, clock, ctx } = rig();
  const load = composeGlobalOverride(async () => null, gate(econ({}, {})), isMkt);
  const gs = new GameServer(() => ctx, repo, () => cfg, () => clock.ms, load, undefined, isMkt);
  repo.seed("p4", 1_000_000);
  const { position } = await gs.openPosition({ userId: "p4", stakeCents: 25000, direction: "buy" });
  assert.equal(position.durationS, 10, "default duration");
  assert.equal(position.stakeCents, 25000, "site min (25000) still admits the trade");
});
