import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCohortOverride, composeGlobalOverride } from "./globaloverride.js";
import { parseCohort, EMPTY_PLATFORM_ECONOMY, type PlatformEconomy } from "@invest254/shared";
import type { UserOverride } from "./overrides.js";

const baseOv = (o: Partial<UserOverride>): UserOverride => ({
  userId: "u1", winRate: null, houseEdge: null, tradeDurationS: null, maxWinMultiplier: null,
  minStakeCents: null, maxStakeCents: null, notes: null, updatedBy: null, updatedAtMs: 0, ...o,
});

test("mergeCohortOverride: no base + nothing enforced => null (unchanged behaviour)", () => {
  assert.equal(mergeCohortOverride("u1", null, {}), null);
  assert.equal(mergeCohortOverride("u1", null, parseCohort({ houseEdge: { v: 0.7, on: false } })), null);
});

test("mergeCohortOverride: enforced global fields WIN over the per-user override", () => {
  const base = baseOv({ winRate: 0.5, houseEdge: 0.2, maxWinMultiplier: 3, tradeDurationS: 20, minStakeCents: 100, maxStakeCents: 999 });
  const cohort = parseCohort({
    targetWinRate: { v: 0.9, on: true },   // -> winRate
    houseEdge: { v: 0.05, on: true },
    maxMultiplier: { v: 5, on: true },     // -> maxWinMultiplier
    minStakeCents: { v: 250, on: true },
  });
  const m = mergeCohortOverride("u1", base, cohort)!;
  assert.equal(m.winRate, 0.9, "global win rate wins");
  assert.equal(m.houseEdge, 0.05, "global edge wins");
  assert.equal(m.maxWinMultiplier, 5, "global cap wins");
  assert.equal(m.minStakeCents, 250, "global min stake wins");
  assert.equal(m.tradeDurationS, 20, "unset global field falls back to user override");
  assert.equal(m.maxStakeCents, 999, "unset global field falls back to user override");
});

test("mergeCohortOverride: enforced global with NO base still produces an override", () => {
  const m = mergeCohortOverride("u1", null, parseCohort({ targetWinRate: { v: 0.85, on: true }, houseEdge: { v: 0.05, on: true } }))!;
  assert.equal(m.winRate, 0.85);
  assert.equal(m.houseEdge, 0.05);
  assert.equal(m.maxWinMultiplier, null, "unset => null (site config)");
});

test("mergeCohortOverride: off fields do NOT override the base", () => {
  const base = baseOv({ winRate: 0.5 });
  const m = mergeCohortOverride("u1", base, parseCohort({ targetWinRate: { v: 0.9, on: false } }))!;
  assert.equal(m.winRate, 0.5, "off => keep user override");
});

test("composeGlobalOverride: picks the MARKETER cohort for a marketer, PLAYER cohort otherwise", async () => {
  const eco: PlatformEconomy = {
    player: parseCohort({ targetWinRate: { v: 0.1, on: true } }),
    marketer: parseCohort({ targetWinRate: { v: 0.9, on: true } }),
    payments: {},
  };
  const load = composeGlobalOverride(async () => null, { economy: async () => eco }, async (uid) => uid === "mkt");
  const asPlayer = await load("player1");
  const asMarketer = await load("mkt");
  assert.equal(asPlayer!.winRate, 0.1, "player gets player economy");
  assert.equal(asMarketer!.winRate, 0.9, "marketer gets marketer economy");
});

test("composeGlobalOverride: gate unavailable => plain per-user override (fail-open)", async () => {
  const base = baseOv({ winRate: 0.42 });
  const load = composeGlobalOverride(async () => base, { economy: async () => { throw new Error("db down"); } }, async () => false);
  const r = await load("u1");
  assert.equal(r!.winRate, 0.42, "falls back to base override on gate error");
});

test("composeGlobalOverride: empty economy => returns the base override unchanged", async () => {
  const base = baseOv({ maxStakeCents: 5000 });
  const load = composeGlobalOverride(async () => base, { economy: async () => EMPTY_PLATFORM_ECONOMY }, async () => false);
  const r = await load("u1");
  assert.equal(r!.maxStakeCents, 5000);
  assert.equal(r!.winRate, null);
});
