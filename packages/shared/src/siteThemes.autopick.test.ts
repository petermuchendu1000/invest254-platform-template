import { test } from "node:test";
import assert from "node:assert/strict";
import { SITE_THEMES, autoThemeFor, themeIdOfTokens } from "./siteThemes.js";

/**
 * BUGLOG #137 — brands were born unthemed.
 *
 * `sites.theme_tokens` carries a brand's whole look; the three `color_*` columns produce only three
 * CSS variables, so a brand with no tokens renders on the stock design system however its colour was
 * set. Onboarding never wrote tokens, so SEVEN live brands looked identical and unbranded, and the
 * symptom reported was "brand themes are not taking effect" — they had never been set. These pin the
 * rule that now assigns one automatically.
 */

test("a brand always gets a COMPLETE palette, never a bare colour", () => {
  const t = autoThemeFor({ slug: "newbrand" });
  // The tokens the stock fallback cannot supply are exactly what was missing in production.
  for (const k of ["bg", "surface", "surface2", "border", "fg", "muted", "brand", "accent", "up", "down"] as const) {
    assert.ok(t.tokens[k], `${k} must be present`);
  }
});

test("the pick is deterministic: the same slug always lands on the same theme", () => {
  const a = autoThemeFor({ slug: "dakafx" });
  const b = autoThemeFor({ slug: "dakafx" });
  assert.equal(a.id, b.id, "re-running onboarding must not reshuffle a brand's look");
  assert.notEqual(autoThemeFor({ slug: "otherbrand" }).id, undefined);
});

test("auto-assignment NEVER crosses light and dark", () => {
  // Turning a brand the owner set to dark into a white site is a far bigger change than giving it
  // a palette, so the mode is treated as the operator's decision and never overridden.
  for (const slug of ["a", "b", "c", "dakafx", "paidpesa", "peakpesa", "zzz"]) {
    assert.equal(autoThemeFor({ slug, mode: "dark" }).mode, "dark", slug);
    assert.equal(autoThemeFor({ slug, mode: "light" }).mode, "light", slug);
  }
  assert.equal(autoThemeFor({ slug: "x" }).mode, "dark", "dark is the default");
});

test("a colour the operator actually chose is honoured — the NEAREST theme wins", () => {
  // "I picked blue" should produce the whole blue theme, not a blue button on a stock grey site.
  const gold = autoThemeFor({ slug: "whatever", preferredColour: "#F0B90B" });
  assert.equal(gold.tokens.brand, "#F0B90B", "an exact library colour resolves to that theme");
  // A near-miss still lands on the same family rather than falling back to the slug hash.
  const nearlyGold = autoThemeFor({ slug: "whatever", preferredColour: "#F1BA0C" });
  assert.equal(nearlyGold.tokens.brand, "#F0B90B");
});

test("the STOCK placeholder colour is not treated as a choice", () => {
  // #22c55e is the default an unconfigured brand carries; honouring it would hand every new brand
  // the same green theme and recreate the uniformity this fixes.
  const stock = autoThemeFor({ slug: "brand-one", preferredColour: "#22c55e" });
  const none = autoThemeFor({ slug: "brand-one" });
  assert.equal(stock.id, none.id, "stock green falls through to the slug-seeded pick");
  // And two different brands on the stock colour do NOT come out identical.
  assert.notEqual(
    autoThemeFor({ slug: "brand-one", preferredColour: "#22c55e" }).id,
    autoThemeFor({ slug: "brand-two", preferredColour: "#22c55e" }).id,
  );
});

test("a theme another brand already wears is skipped, so brands look distinct", () => {
  const first = autoThemeFor({ slug: "alpha", mode: "dark" });
  const second = autoThemeFor({ slug: "alpha", mode: "dark", taken: [first.id] });
  assert.notEqual(second.id, first.id);
  assert.equal(second.mode, "dark", "and the mode still holds while avoiding a clash");
});

test("every theme being taken degrades to a repeat rather than throwing", () => {
  // A platform with more brands than themes must still onboard: looks repeat, nothing breaks.
  const all = SITE_THEMES.map((t) => t.id);
  const t = autoThemeFor({ slug: "overflow", mode: "dark", taken: all });
  assert.ok(t && t.mode === "dark");
});

test("an invalid or empty colour falls through instead of poisoning the pick", () => {
  for (const c of ["", "   ", "not-a-colour", "#12", null]) {
    const t = autoThemeFor({ slug: "brand-x", preferredColour: c as string | null });
    assert.equal(t.id, autoThemeFor({ slug: "brand-x" }).id, String(c));
  }
});

test("themeIdOfTokens recognises a stored palette, so callers can build the taken set", () => {
  const t = SITE_THEMES[3]!;
  assert.equal(themeIdOfTokens({ brand: t.tokens.brand, bg: t.tokens.bg }), t.id);
  assert.equal(themeIdOfTokens({ brand: "#123456", bg: "#654321" }), undefined, "a hand-tuned palette is not a library theme");
  assert.equal(themeIdOfTokens(null), undefined);
  assert.equal(themeIdOfTokens({}), undefined);
});
