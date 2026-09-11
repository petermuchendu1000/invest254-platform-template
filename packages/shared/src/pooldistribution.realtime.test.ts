import { test } from "node:test";
import assert from "node:assert/strict";
import {
  grantsFromIdeal, redistributeHeadroom, distributeDynamicPool, type BrandCommit,
} from "./pooldistribution.js";

/**
 * Real-time (intra-day) reallocation (docs/25 §15.1). Invariants under test:
 *   MONOTONE     — every grant ≥ 0; newAmount ≥ committed (never claws back).
 *   ENVELOPE     — Σ newAmount ≤ envelope whenever Σ committed ≤ envelope.
 *   RESERVE-ONLY — Σ grant ≤ reserve (envelope − Σ committed); nothing invented.
 *   DEFICIT-FAIR — reserve fills deficits (ideal − committed) proportionally, capped at each deficit.
 *   NO-OP        — brands already at/over ideal, or a zero reserve, produce zero grants.
 */
const sumGrant = (g: { grantCents: number }[]) => g.reduce((s, x) => s + x.grantCents, 0);
const sumNew = (g: { newAmountCents: number }[]) => g.reduce((s, x) => s + x.newAmountCents, 0);

test("monotone: grants never negative, newAmount never below committed", () => {
  const g = grantsFromIdeal(
    [{ siteId: "a", idealCents: 100, committedCents: 40 }, { siteId: "b", idealCents: 10, committedCents: 90 }],
    200);
  for (const r of g) { assert.ok(r.grantCents >= 0); assert.ok(r.newAmountCents >= r.committedCents); }
});

test("reserve-only + envelope: Σgrant ≤ reserve and Σnew ≤ envelope", () => {
  const items = [{ siteId: "a", idealCents: 500, committedCents: 100 }, { siteId: "b", idealCents: 300, committedCents: 100 }];
  const env = 1000;
  const g = grantsFromIdeal(items, env);
  const reserve = env - (100 + 100);
  assert.ok(sumGrant(g) <= reserve, `Σgrant=${sumGrant(g)} reserve=${reserve}`);
  assert.ok(sumNew(g) <= env);
});

test("deficit-fair: reserve splits proportionally to deficit, capped at deficit", () => {
  // deficits: a=300, b=100 (ratio 3:1). reserve = 1000-(100+100)=800 > total deficit 400 ⇒ each filled to ideal.
  const g = grantsFromIdeal(
    [{ siteId: "a", idealCents: 400, committedCents: 100 }, { siteId: "b", idealCents: 200, committedCents: 100 }], 1000);
  const by = Object.fromEntries(g.map((r) => [r.siteId, r]));
  assert.equal(by.a!.newAmountCents, 400); // capped at ideal (never beyond deficit)
  assert.equal(by.b!.newAmountCents, 200);
});

test("scarce reserve rations proportionally to deficit", () => {
  // deficits a=300, b=100 (3:1); reserve = 400-(? ) make reserve small: env=200, committed 0+0.
  const g = grantsFromIdeal(
    [{ siteId: "a", idealCents: 300, committedCents: 0 }, { siteId: "b", idealCents: 100, committedCents: 0 }], 200);
  const by = Object.fromEntries(g.map((r) => [r.siteId, r.grantCents]));
  // reserve 200 split 3:1 → ~150 / ~50 (±1 rounding)
  assert.ok(Math.abs(by.a! - 150) <= 1 && Math.abs(by.b! - 50) <= 1, JSON.stringify(by));
  assert.ok(sumGrant(g) <= 200);
});

test("no-op when every brand is at/over ideal", () => {
  const g = grantsFromIdeal(
    [{ siteId: "a", idealCents: 100, committedCents: 100 }, { siteId: "b", idealCents: 50, committedCents: 80 }], 1000);
  assert.equal(sumGrant(g), 0);
});

test("no-op when reserve is exhausted (Σcommitted ≥ envelope)", () => {
  const g = grantsFromIdeal(
    [{ siteId: "a", idealCents: 900, committedCents: 600 }, { siteId: "b", idealCents: 900, committedCents: 600 }], 1000);
  assert.equal(sumGrant(g), 0); // committed 1200 ≥ envelope 1000 ⇒ never claw back, add nothing
});

test("redistributeHeadroom matches the batch water-fill ideal when reserve suffices", () => {
  const brands: BrandCommit[] = [
    { siteId: "a", houseEdge: 0.1, forecastTurnoverCents: 1_000_000, committedTodayCents: 0 },
    { siteId: "b", houseEdge: 0.2, forecastTurnoverCents: 500_000, committedTodayCents: 0 },
  ];
  const env = 100_000_000; // huge envelope ⇒ each reaches its ideal
  const ideal = distributeDynamicPool(brands.map((b) => ({ siteId: b.siteId, houseEdge: b.houseEdge, forecastTurnoverCents: b.forecastTurnoverCents })), env);
  const idealBy = Object.fromEntries(ideal.map((a) => [a.siteId, a.allocCents]));
  const g = redistributeHeadroom(brands, env);
  for (const r of g) assert.equal(r.newAmountCents, idealBy[r.siteId]); // committed 0 ⇒ grant == ideal
});

test("incremental convergence: repeated passes never decrease and approach ideal", () => {
  const brands: BrandCommit[] = [
    { siteId: "a", houseEdge: 0.1, forecastTurnoverCents: 800_000, committedTodayCents: 10_000 },
    { siteId: "b", houseEdge: 0.1, forecastTurnoverCents: 200_000, committedTodayCents: 10_000 },
  ];
  const env = 5_000_000;
  const p1 = redistributeHeadroom(brands, env);
  // apply pass 1, then run again from the new committed values
  const brands2 = brands.map((b) => ({ ...b, committedTodayCents: p1.find((g) => g.siteId === b.siteId)!.newAmountCents }));
  const p2 = redistributeHeadroom(brands2, env);
  for (const b of brands2) {
    const g = p2.find((x) => x.siteId === b.siteId)!;
    assert.ok(g.newAmountCents >= b.committedTodayCents); // monotone across passes
  }
});
