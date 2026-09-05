import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, formatKes, isForeignDisplay, displayToKesCents, kesCentsToDisplay } from "./money.js";

const USD_PER_KES = 1 / 129.388213; // live-style rate (KES->USD)

test("formatMoney: KES is byte-for-byte formatKes (no regression)", () => {
  for (const c of [0, 25000, 100000, 123450, 999999]) {
    assert.equal(formatMoney(c, { currency: "KES", locale: "en-KE", fxRateFromKes: 1 }), formatKes(c));
    assert.equal(formatMoney(c), formatKes(c)); // defaults
  }
});

test("formatMoney: falls back to KES when FX is missing/invalid", () => {
  assert.equal(formatMoney(25000, { currency: "USD", fxRateFromKes: 0 }), formatKes(25000));
  assert.equal(formatMoney(25000, { currency: "USD", fxRateFromKes: NaN }), formatKes(25000));
  assert.equal(formatMoney(25000, { currency: "USD" }), formatKes(25000)); // no rate
});

test("formatMoney: converts KES cents to USD at the given rate", () => {
  // 25000 cents = KES 250 -> ~ $1.93
  const s = formatMoney(25000, { currency: "USD", locale: "en-US", fxRateFromKes: USD_PER_KES });
  assert.ok(s.includes("1.93"), `expected ~$1.93, got ${s}`);
  assert.ok(s.startsWith("$"), `expected leading $, got ${s}`);
});

test("formatMoney: unknown currency degrades to 'CUR 0.00' string, never throws", () => {
  const s = formatMoney(100000, { currency: "ZZZ", locale: "en-US", fxRateFromKes: 2 });
  assert.ok(s.includes("ZZZ"));
  assert.ok(s.includes("2,000") && !s.includes("2,000.00")); // KES 1000 * 2, whole -> no decimals
});

test("isForeignDisplay: true only for non-KES with a usable rate", () => {
  assert.equal(isForeignDisplay({ currency: "USD", fxRateFromKes: USD_PER_KES }), true);
  assert.equal(isForeignDisplay({ currency: "KES", fxRateFromKes: 1 }), false);
  assert.equal(isForeignDisplay({ currency: "USD", fxRateFromKes: 0 }), false);
  assert.equal(isForeignDisplay(undefined), false);
});

test("displayToKesCents <-> kesCentsToDisplay round-trip within a cent", () => {
  const cents = 25000; // KES 250
  const usd = kesCentsToDisplay(cents, USD_PER_KES);
  assert.ok(Math.abs(usd - 1.9322) < 1e-3, `usd=${usd}`);
  const back = displayToKesCents(usd, USD_PER_KES);
  assert.ok(Math.abs(back - cents) <= 1, `round-trip drifted: ${back} vs ${cents}`);
});

test("displayToKesCents: rounds to whole cents, guards bad rate", () => {
  assert.equal(displayToKesCents(1, 1), 100);           // $1 @ rate 1 -> 100 cents
  assert.equal(displayToKesCents(10, 0), 1000);         // invalid rate -> treated as 1
  assert.throws(() => displayToKesCents(NaN, USD_PER_KES));
});

test("formatMoney: whole display amounts drop decimals; fractional keep 2dp", () => {
  const fifteen = displayToKesCents(15, USD_PER_KES);        // $15 expressed in KES cents
  assert.equal(formatMoney(fifteen, { currency: "USD", locale: "en-US", fxRateFromKes: USD_PER_KES }), "$15");
  const s = formatMoney(200000, { currency: "USD", locale: "en-US", fxRateFromKes: USD_PER_KES }); // KES 2,000
  assert.ok(/^\$15\.\d{2}$/.test(s), `expected $15.xx, got ${s}`);
});
