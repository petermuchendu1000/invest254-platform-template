import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SYMBOLS, SYMBOL_GROUPS, DEFAULT_SYMBOL, CURVE_DAY_TRAVEL, conventionalDigits,
  instrumentFor, marketSymbolOf, scaleFor, symbolDef, symbolsInGroup,
} from "./symbols.js";
import { XAUUSD } from "./candles.js";

/**
 * The catalogue. The tests that matter are the ones that would catch a symbol being WRONG rather
 * than merely absent: a digit count against market convention, a derived scale that does not
 * reproduce the instrument this platform already shipped, or two symbols that would collide on one
 * seed domain.
 */

test("the catalogue reproduces the instrument that already shipped, exactly", () => {
  // XAUUSD's scale was tuned by eye long before this catalogue existed. The derivation has to land
  // on the same number, or every chart and every settled position on the live brand would move.
  const gold = instrumentFor("XAUUSD");
  assert.deepEqual(gold, XAUUSD);
  assert.equal(gold?.scale, 85);
  assert.equal(DEFAULT_SYMBOL, XAUUSD.symbol);
});

test("scale is derived, not hand-picked", () => {
  // The rule, back-solved from gold: anchor * dayRange / 0.25.
  assert.equal(CURVE_DAY_TRAVEL, 0.25);
  for (const d of SYMBOLS) {
    if (d.scale === undefined) {
      assert.equal(marketSymbolOf(d).scale, scaleFor(d.anchor, d.dayRange), d.symbol);
    }
    // A scale of zero would pin the chart to a flat line. Rounding the derivation to an integer
    // did exactly that to every FX major before this test caught it: EURUSD derives 0.026.
    assert.ok(marketSymbolOf(d).scale > 0, d.symbol);
  }
  assert.ok(scaleFor(1.085, 0.006) > 0.02, "a major's scale must survive the derivation");
});

test("exactly one symbol overrides the derivation, and it is the one that predates it", () => {
  const overridden = SYMBOLS.filter((d) => d.scale !== undefined).map((d) => d.symbol);
  assert.deepEqual(overridden, ["XAUUSD"]);
});

test("digits follow market convention, which is what makes a quote readable", () => {
  const digitsOf = (s: string) => symbolDef(s)?.digits;
  // Majors quote to five places.
  for (const s of ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDCHF", "USDCAD"]) {
    assert.equal(digitsOf(s), 5, s);
  }
  // Yen pairs to three. This is the one that looks like a typo and is not.
  assert.equal(digitsOf("USDJPY"), 3);
  // Metals: gold two, silver three.
  assert.equal(digitsOf("XAUUSD"), 2);
  assert.equal(digitsOf("XAGUSD"), 3);
  // Indices to two.
  for (const s of ["US30", "US500", "USTEC", "GER40", "UK100", "JP225"]) {
    assert.equal(digitsOf(s), 2, s);
  }
  // Every symbol quotes to somewhere between two and five places.
  for (const d of SYMBOLS) assert.ok(d.digits >= 2 && d.digits <= 5, `${d.symbol} ${d.digits}`);
});

test("every symbol is unique, because the symbol IS the seed domain", () => {
  // Two symbols sharing a name would share a curve, which is the exact failure multi-symbol exists
  // to avoid.
  const names = SYMBOLS.map((s) => s.symbol);
  assert.equal(new Set(names).size, names.length);
  // And no name is empty or padded, since it goes into a seed string verbatim.
  for (const n of names) assert.equal(n, n.trim(), n);
  for (const n of names) assert.ok(n.length > 0);
});

test("the seven groups are all populated, and every symbol is in one", () => {
  assert.deepEqual([...SYMBOL_GROUPS], [
    "Forex\\Majors", "Forex\\Minors", "Forex\\Exotics",
    "Metals", "Crypto", "Indices", "Energies",
  ]);
  for (const g of SYMBOL_GROUPS) assert.ok(symbolsInGroup(g).length > 0, g);
  assert.equal(
    SYMBOL_GROUPS.reduce((n, g) => n + symbolsInGroup(g).length, 0),
    SYMBOLS.length,
  );
  // The seven majors that carry USD on one side. Exactly seven: there is no eighth major, so a
  // pair arriving in this group is either a cross or a mistake.
  assert.equal(symbolsInGroup("Forex\\Majors").length, 7);
  // The catalogue is broker-sized rather than a demo of four symbols.
  assert.ok(SYMBOLS.length >= 90, `${SYMBOLS.length} symbols`);
});

test("the digit rule is applied, not merely documented", () => {
  // At ninety-odd symbols, a hand-picked digit count per row is ninety chances to be quietly
  // wrong. There is one rule, and every row obeys it with no exceptions.
  for (const d of SYMBOLS) {
    assert.equal(d.digits, conventionalDigits(d.group, d.anchor), d.symbol);
  }
  // And the rule itself reproduces the conventions that are not negotiable.
  assert.equal(conventionalDigits("Forex\\Majors", 1.085), 5, "a major");
  assert.equal(conventionalDigits("Forex\\Majors", 151.5), 3, "a yen pair");
  assert.equal(conventionalDigits("Metals", 2650), 2, "gold");
  assert.equal(conventionalDigits("Metals", 31.2), 3, "silver");
  assert.equal(conventionalDigits("Indices", 42_000), 2, "an index");
  assert.equal(conventionalDigits("Crypto", 62_000), 2, "bitcoin");
  assert.equal(conventionalDigits("Crypto", 0.52), 5, "a sub-dollar coin");
  assert.equal(conventionalDigits("Energies", 70.45), 2, "oil");
  assert.equal(conventionalDigits("Energies", 2.875), 3, "gas");
});

test("a pair is in the group its own currencies put it in", () => {
  // The group is not decoration: MetaTrader's Symbols tree is how a trader finds an instrument, and
  // a cross filed under Majors would be unfindable.
  const code = (s: string, at: 0 | 3) => s.slice(at, at + 3);
  for (const d of symbolsInGroup("Forex\\Majors")) {
    assert.equal(d.symbol.length, 6, d.symbol);
    assert.ok(
      code(d.symbol, 0) === "USD" || code(d.symbol, 3) === "USD",
      `${d.symbol} is in Majors without a USD leg`,
    );
  }
  const MAJOR_CURRENCIES = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD"]);
  for (const d of symbolsInGroup("Forex\\Minors")) {
    assert.equal(d.symbol.length, 6, d.symbol);
    // A cross has no USD leg, and both legs are themselves major currencies.
    assert.ok(!d.symbol.includes("USD"), `${d.symbol} is a cross with a USD leg`);
    assert.ok(MAJOR_CURRENCIES.has(code(d.symbol, 0)), d.symbol);
    assert.ok(MAJOR_CURRENCIES.has(code(d.symbol, 3)), d.symbol);
  }
  for (const d of symbolsInGroup("Forex\\Exotics")) {
    assert.equal(d.symbol.length, 6, d.symbol);
    // An exotic is quoted against a major base, and its quote currency is NOT a major — otherwise
    // it belongs in one of the two groups above.
    assert.ok(MAJOR_CURRENCIES.has(code(d.symbol, 0)), d.symbol);
    assert.ok(!MAJOR_CURRENCIES.has(code(d.symbol, 3)), `${d.symbol} is not exotic`);
  }
});

test("no two symbols are the same instrument under two names", () => {
  // Two rows with the same group, anchor and day range would be indistinguishable on a chart, which
  // is the catalogue padding itself out. The curves would differ, but nothing else would.
  const shape = SYMBOLS.map((d) => `${d.group}|${d.anchor}|${d.dayRange}`);
  assert.equal(new Set(shape).size, shape.length);
});

test("volatility is ordered the way these markets actually are", () => {
  // This is what stops every chart looking the same with a different number on the axis: crypto has
  // to move more than a metal, and a metal more than a major.
  const range = (s: string) => symbolDef(s)!.dayRange;
  assert.ok(range("BTCUSD") > range("XAUUSD"), "bitcoin over gold");
  assert.ok(range("XAUUSD") > range("EURUSD"), "gold over the euro");
  assert.ok(range("XAGUSD") > range("XAUUSD"), "silver over gold");
  // No symbol is implausibly still or implausibly wild.
  for (const d of SYMBOLS) {
    assert.ok(d.dayRange >= 0.004 && d.dayRange <= 0.06, `${d.symbol} ${d.dayRange}`);
  }
});

test("every symbol carries a description, which MetaTrader prints beside it", () => {
  for (const d of SYMBOLS) {
    assert.ok(d.description.length > 3, d.symbol);
    // The Specification header reads "XAUUSD, Gold vs US Dollar", so the description must not
    // repeat the symbol back.
    assert.ok(!d.description.startsWith(d.symbol), d.symbol);
  }
  assert.equal(symbolDef("XAUUSD")?.description, "Gold vs US Dollar");
});

test("anchors are plausible starting levels, not placeholders", () => {
  for (const d of SYMBOLS) assert.ok(d.anchor > 0, d.symbol);
  // A symbol quoted to five places sits near 1, one quoted to two can sit anywhere.
  assert.ok(symbolDef("EURUSD")!.anchor < 10);
  assert.ok(symbolDef("BTCUSD")!.anchor > 1000);
  // The anchor must survive rounding to the symbol's own tick: an anchor finer than the tick could
  // not be printed.
  for (const d of SYMBOLS) {
    const tick = 10 ** -d.digits;
    assert.ok(Math.abs(d.anchor / tick - Math.round(d.anchor / tick)) < 1e-6, `${d.symbol} ${d.anchor}`);
  }
});

test("an unknown symbol resolves to nothing rather than to a default", () => {
  // Silently falling back to gold would mean a typo traded a different instrument.
  assert.equal(instrumentFor("NOPE"), undefined);
  assert.equal(symbolDef("NOPE"), undefined);
});
