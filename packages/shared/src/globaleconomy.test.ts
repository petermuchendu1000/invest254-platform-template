import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type GameConfig } from "./config.js";
import {
  parsePlatformEconomy, parseCohort, enforcedValue, enforcedCohortValues, applyCohortEconomy,
  cohortFeasibility, effectiveMinDeposit, effectiveMaxDeposit, effectiveMinWithdrawal,
  EMPTY_PLATFORM_ECONOMY, COHORT_KEYS, PAYMENT_KEYS,
} from "./globaleconomy.js";

test("parsePlatformEconomy: parses valid blocks, ignores malformed", () => {
  const eco = parsePlatformEconomy({
    player_economy: { houseEdge: { v: 0.7, on: true }, targetWinRate: { v: 0.2, on: false } },
    marketer_economy: { maxMultiplier: { v: 10, on: true }, bogus: { v: 1, on: true } },
    payments: { minDepositCents: { v: 30000, on: true }, minWithdrawalCents: { v: "x", on: true } },
  });
  assert.deepEqual(eco.player.houseEdge, { v: 0.7, on: true });
  assert.deepEqual(eco.player.targetWinRate, { v: 0.2, on: false });
  assert.deepEqual(eco.marketer.maxMultiplier, { v: 10, on: true });
  assert.equal((eco.marketer as Record<string, unknown>).bogus, undefined, "unknown key dropped");
  assert.deepEqual(eco.payments.minDepositCents, { v: 30000, on: true });
  assert.equal(eco.payments.minWithdrawalCents, undefined, "non-numeric value dropped");
});

test("parsePlatformEconomy: null/garbage -> empty (behaviour-neutral)", () => {
  assert.deepEqual(parsePlatformEconomy(null), EMPTY_PLATFORM_ECONOMY);
  assert.deepEqual(parsePlatformEconomy(undefined), EMPTY_PLATFORM_ECONOMY);
  assert.deepEqual(parseCohort("nope"), {});
  assert.deepEqual(parseCohort(42), {});
});

test("enforcedValue: only returns a value when on=true", () => {
  const c = parseCohort({ houseEdge: { v: 0.7, on: true }, maxMultiplier: { v: 5, on: false } });
  assert.equal(enforcedValue(c, "houseEdge"), 0.7);
  assert.equal(enforcedValue(c, "maxMultiplier"), null, "off => not enforced");
  assert.equal(enforcedValue(c, "minStakeCents"), null, "absent => not enforced");
});

test("enforcedCohortValues + applyCohortEconomy: enforced fields override base 1:1", () => {
  const c = parseCohort({ houseEdge: { v: 0.6, on: true }, targetWinRate: { v: 0.3, on: true }, maxMultiplier: { v: 4, on: false } });
  assert.deepEqual(enforcedCohortValues(c), { houseEdge: 0.6, targetWinRate: 0.3 });
  const eff = applyCohortEconomy(DEFAULT_CONFIG, c);
  assert.equal(eff.houseEdge, 0.6);
  assert.equal(eff.targetWinRate, 0.3);
  assert.equal(eff.maxMultiplier, DEFAULT_CONFIG.maxMultiplier, "off field keeps base");
  assert.equal(eff.minStakeCents, DEFAULT_CONFIG.minStakeCents, "absent field keeps base");
});

test("cohortFeasibility: catches an infeasible merged config (RTP/winRate > maxMultiplier cap)", () => {
  // house edge 0.05 -> RTP 0.95; win rate 0.1 -> required mean mult 9.5 > default cap 5 => infeasible.
  const bad = parseCohort({ houseEdge: { v: 0.05, on: true }, targetWinRate: { v: 0.1, on: true } });
  assert.equal(cohortFeasibility(DEFAULT_CONFIG, bad).ok, false);
  // Same but raise the cap in the same enforced set -> feasible.
  const good = parseCohort({ houseEdge: { v: 0.05, on: true }, targetWinRate: { v: 0.1, on: true }, maxMultiplier: { v: 10, on: true } });
  assert.equal(cohortFeasibility(DEFAULT_CONFIG, good).ok, true);
});

test("cohortFeasibility: a 'boost' marketer economy (high win rate, low edge) is feasible", () => {
  const boost = parseCohort({ targetWinRate: { v: 0.9, on: true }, houseEdge: { v: 0.05, on: true }, maxMultiplier: { v: 5, on: true } });
  const f = cohortFeasibility(DEFAULT_CONFIG, boost);
  assert.equal(f.ok, true, f.reason ?? "");
});

test("payments resolution: enforced wins, else base; non-positive/non-int ignored", () => {
  const p = parsePlatformEconomy({ payments: { minDepositCents: { v: 30000, on: true }, maxDepositCents: { v: 5_000_000, on: false } } }).payments;
  assert.equal(effectiveMinDeposit(20000, p), 30000, "enforced overrides base");
  assert.equal(effectiveMaxDeposit(null, p), null, "off => base (no cap)");
  assert.equal(effectiveMinWithdrawal(25000, p), 25000, "absent => base");
  const bad = parseCohort({}) as never;
  assert.equal(effectiveMinDeposit(20000, bad), 20000, "empty => base");
});

test("field key sets are the expected contract", () => {
  assert.deepEqual([...COHORT_KEYS], ["houseEdge", "targetWinRate", "maxMultiplier", "minStakeCents", "maxStakeCents", "defaultDurationS"]);
  assert.deepEqual([...PAYMENT_KEYS], ["minDepositCents", "maxDepositCents", "minWithdrawalCents"]);
});

test("PlatformGate.economy(): exposes parsed overrides from the same cached row", async () => {
  const { PlatformGate } = await import("./platformgate.js");
  const g = new PlatformGate(async () => ({ rows: [{
    deposits_enabled: true, withdrawals_enabled: true, play_enabled: true, marketers_enabled: true,
    registrations_enabled: true, maintenance_message: null, version: 5,
    player_economy: { houseEdge: { v: 0.7, on: true } },
    marketer_economy: { targetWinRate: { v: 0.85, on: true } },
    payments: { minDepositCents: { v: 30000, on: true } },
  }] }), 5000);
  const eco = await g.economy();
  assert.equal(enforcedValue(eco.player, "houseEdge"), 0.7);
  assert.equal(enforcedValue(eco.marketer, "targetWinRate"), 0.85);
  assert.equal(effectiveMinDeposit(20000, eco.payments), 30000);
  const _base: GameConfig = DEFAULT_CONFIG; void _base;
});
