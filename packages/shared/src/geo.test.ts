import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_DISPLAY_CURRENCIES,
  isSupportedDisplayCurrency,
  normalizeCurrency,
  normalizeCountry,
  currencyForCountry,
  resolveDisplayCurrency,
} from "./geo.js";

test("normalizeCurrency upper-cases valid 3-letter codes and rejects junk", () => {
  assert.equal(normalizeCurrency("usd"), "USD");
  assert.equal(normalizeCurrency("  Kes "), "KES");
  assert.equal(normalizeCurrency("US"), null);
  assert.equal(normalizeCurrency("US$"), null);
  assert.equal(normalizeCurrency(""), null);
  assert.equal(normalizeCurrency(null), null);
  assert.equal(normalizeCurrency(undefined), null);
});

test("isSupportedDisplayCurrency accepts curated set (case-insensitive), rejects others", () => {
  for (const c of SUPPORTED_DISPLAY_CURRENCIES) assert.equal(isSupportedDisplayCurrency(c.toLowerCase()), true);
  assert.equal(isSupportedDisplayCurrency("KES"), true);
  assert.equal(isSupportedDisplayCurrency("JPY"), false); // fx can quote it, but it's not a display choice
  assert.equal(isSupportedDisplayCurrency("ZZZ"), false);
  assert.equal(isSupportedDisplayCurrency(null), false);
});

test("normalizeCountry upper-cases valid alpha-2 and rejects junk", () => {
  assert.equal(normalizeCountry("ke"), "KE");
  assert.equal(normalizeCountry(" Us "), "US");
  assert.equal(normalizeCountry("USA"), null);
  assert.equal(normalizeCountry("K"), null);
  assert.equal(normalizeCountry(null), null);
});

test("currencyForCountry maps home + international markets, undefined for unknown/sentinel", () => {
  assert.equal(currencyForCountry("KE"), "KES");
  assert.equal(currencyForCountry("ug"), "UGX");
  assert.equal(currencyForCountry("NG"), "NGN");
  assert.equal(currencyForCountry("US"), "USD");
  assert.equal(currencyForCountry("GB"), "GBP");
  // Eurozone members all fold to EUR.
  assert.equal(currencyForCountry("DE"), "EUR");
  assert.equal(currencyForCountry("FR"), "EUR");
  // CFA unions.
  assert.equal(currencyForCountry("SN"), "XOF");
  assert.equal(currencyForCountry("CM"), "XAF");
  // Unknown / CDN sentinels / junk → undefined (caller keeps the brand default).
  assert.equal(currencyForCountry("XX"), undefined);
  assert.equal(currencyForCountry("T1"), undefined);
  assert.equal(currencyForCountry("ZW"), undefined); // not in the supported set
  assert.equal(currencyForCountry(null), undefined);
});

test("every mapped country resolves to a SUPPORTED display currency", () => {
  for (const cc of ["KE", "UG", "TZ", "NG", "GH", "ZA", "US", "GB", "DE", "SN", "CM", "IN", "AE"]) {
    const cur = currencyForCountry(cc);
    assert.ok(cur && isSupportedDisplayCurrency(cur), `${cc} → ${cur} must be supported`);
  }
});

test("resolveDisplayCurrency prefers a supported user preference above all", () => {
  assert.equal(resolveDisplayCurrency({ userPreference: "usd", countryCode: "KE", brandCurrency: "NGN" }), "USD");
  // An unsupported/blank preference is ignored, not shown.
  assert.equal(resolveDisplayCurrency({ userPreference: "JPY", countryCode: "KE", brandCurrency: "NGN" }), "KES");
  assert.equal(resolveDisplayCurrency({ userPreference: "  ", countryCode: "US", brandCurrency: "NGN" }), "USD");
});

test("resolveDisplayCurrency falls back geo → brand → KES", () => {
  // No preference → geo wins.
  assert.equal(resolveDisplayCurrency({ countryCode: "GB", brandCurrency: "KES" }), "GBP");
  // Unknown country → brand currency.
  assert.equal(resolveDisplayCurrency({ countryCode: "XX", brandCurrency: "NGN" }), "NGN");
  // Nothing usable anywhere → KES.
  assert.equal(resolveDisplayCurrency({}), "KES");
  assert.equal(resolveDisplayCurrency({ countryCode: "ZW", brandCurrency: "not-a-code" }), "KES");
});
