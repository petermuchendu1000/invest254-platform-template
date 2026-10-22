import { test } from "node:test";
import assert from "node:assert/strict";
import { BrandOriginAllowlist, ExtraOriginAllowlist, parseExtraOrigins } from "./cors.js";

/**
 * CORS is the one place where a mistake is invisible in curl and in every other test in this repo
 * (both of which ignore the header) and fatal in a browser — either the clients are locked out, or
 * an origin we never meant to trust can read authenticated responses from a real-money API. So the
 * assertions here come in two halves:
 *
 *  1. The brand allowance must keep behaving EXACTLY as it did (apex, `www.`, unknown refused, and
 *     the fail-safe that keeps the last good set when the source throws).
 *  2. The configured extra (preview) allowance must match what was configured and NOTHING else —
 *     in particular the two near-miss hosts an attacker would register, `evil-invest254.pages.dev`
 *     and `invest254.pages.dev.attacker.com`, which are what the anchoring in cors.ts exists for.
 */

const PREVIEWS = "https://*.invest254.pages.dev";

// ── brand allowance: unchanged behaviour ───────────────────────────────────────────────────
test("brand hosts are allowed at the apex and with www, unknown origins are not", async () => {
  const list = new BrandOriginAllowlist(async () => ["tamutraders.com", "https://www.cpfmarket.com/"]);
  await list.refresh();

  assert.equal(list.allows("https://tamutraders.com"), true);
  assert.equal(list.allows("https://www.tamutraders.com"), true);
  assert.equal(list.allows("https://cpfmarket.com"), true);
  assert.equal(list.allows("https://www.cpfmarket.com"), true);
  assert.equal(list.allows("https://evil.com"), false);
  assert.equal(list.allows(""), false);
  assert.equal(list.size, 2);
});

test("a failing refresh keeps the previous brand set (fail-safe)", async () => {
  let fail = false;
  const list = new BrandOriginAllowlist(async () => {
    if (fail) throw new Error("db down");
    return ["tamutraders.com"];
  });
  await list.refresh();
  fail = true;
  await assert.rejects(() => list.refresh());
  assert.equal(list.allows("https://tamutraders.com"), true, "a dead source must not lock clients out");
  assert.equal(list.size, 1);
});

test("a just-onboarded brand can be pre-warmed without waiting for the interval", async () => {
  const list = new BrandOriginAllowlist(async () => []);
  await list.refresh();
  assert.equal(list.allows("https://newbrand.co.ke"), false);
  list.add("www.newbrand.co.ke");
  assert.equal(list.allows("https://newbrand.co.ke"), true);
});

// ── extra origins: nothing unless configured ───────────────────────────────────────────────
test("absent or empty configuration allows nothing extra", () => {
  for (const spec of [undefined, null, "", "   ", ","]) {
    const extra = new ExtraOriginAllowlist(spec);
    assert.equal(extra.size, 0, `spec ${JSON.stringify(spec)} must produce no rules`);
    assert.equal(extra.allows("https://anything.invest254.pages.dev"), false);
    assert.equal(extra.allows("https://cpfmarket.com"), false);
  }
  assert.equal(ExtraOriginAllowlist.fromEnv({}).size, 0);
});

test("fromEnv reads CORS_ALLOWED_ORIGINS", () => {
  const extra = ExtraOriginAllowlist.fromEnv({ CORS_ALLOWED_ORIGINS: PREVIEWS });
  assert.deepEqual(extra.describe(), ["https://*.invest254.pages.dev"]);
  assert.equal(extra.allows("https://claude-project-setup-credent.invest254.pages.dev"), true);
});

test("a bare * never widens this matcher", () => {
  const extra = new ExtraOriginAllowlist("*");
  assert.equal(extra.size, 0);
  assert.equal(extra.allows("https://evil.com"), false);
  assert.equal(extra.allows("https://anything.invest254.pages.dev"), false);
});

// ── extra origins: matching ────────────────────────────────────────────────────────────────
test("an exactly-listed extra origin is allowed, and only that origin", () => {
  const extra = new ExtraOriginAllowlist("https://staging.invest254.com, preview.invest254.com");
  assert.equal(extra.allows("https://staging.invest254.com"), true);
  assert.equal(extra.allows("https://preview.invest254.com"), true, "a schemeless entry means https");
  assert.equal(extra.allows("https://staging.invest254.com."), true, "trailing FQDN dot is the same host");
  assert.equal(extra.allows("https://other.invest254.com"), false);
  assert.equal(extra.allows("https://invest254.com"), false);
  assert.equal(extra.allows("https://staging.invest254.com.attacker.com"), false);
});

test("a suffix pattern matches subdomains of the configured suffix", () => {
  const extra = new ExtraOriginAllowlist(PREVIEWS);
  assert.equal(extra.allows("https://a1b2c3d4.invest254.pages.dev"), true);
  assert.equal(extra.allows("https://claude-project-setup-credent.invest254.pages.dev"), true);
  assert.equal(extra.allows("https://deep.nested.invest254.pages.dev"), true);
  // The apex is not a subdomain of itself: list it explicitly if it is ever wanted.
  assert.equal(extra.allows("https://invest254.pages.dev"), false);
  assert.equal(extra.allows("https://.invest254.pages.dev"), false);
});

// ── the point of the exercise: the near-miss hosts ─────────────────────────────────────────
test("spoofing: a host that merely ENDS WITH the suffix text is refused (label boundary)", () => {
  const extra = new ExtraOriginAllowlist(PREVIEWS);
  assert.equal(extra.allows("https://evil-invest254.pages.dev"), false);
  assert.equal(extra.allows("https://xinvest254.pages.dev"), false);
  assert.equal(extra.allows("https://notinvest254.pages.dev"), false);
});

test("spoofing: an attacker-owned parent domain is refused (end anchor)", () => {
  const extra = new ExtraOriginAllowlist(PREVIEWS);
  assert.equal(extra.allows("https://invest254.pages.dev.attacker.com"), false);
  assert.equal(extra.allows("https://x.invest254.pages.dev.attacker.com"), false);
  assert.equal(extra.allows("https://attacker.com/invest254.pages.dev"), false);
  assert.equal(extra.allows("https://attacker.com#.invest254.pages.dev"), false);
  assert.equal(extra.allows("https://attacker.com?x=.invest254.pages.dev"), false);
  // Userinfo: the real host is attacker.com, whatever precedes the `@`.
  assert.equal(extra.allows("https://x.invest254.pages.dev@attacker.com"), false);
});

test("scheme matters: http is refused even when the host matches", () => {
  const extra = new ExtraOriginAllowlist(`${PREVIEWS},https://staging.invest254.com`);
  assert.equal(extra.allows("http://a1b2c3d4.invest254.pages.dev"), false);
  assert.equal(extra.allows("http://staging.invest254.com"), false);
  assert.equal(extra.allows("ws://a1b2c3d4.invest254.pages.dev"), false);
  assert.equal(extra.allows("null"), false);
  assert.equal(extra.allows("file://"), false);
  // An http:// entry in the configuration is dropped rather than honoured.
  const httpSpec = new ExtraOriginAllowlist("http://localhost:5173,http://*.invest254.pages.dev");
  assert.equal(httpSpec.size, 0);
  assert.equal(httpSpec.allows("http://localhost:5173"), false);
  assert.equal(httpSpec.allows("https://localhost:5173"), false);
});

test("a suffix match does not extend to other ports", () => {
  const extra = new ExtraOriginAllowlist(PREVIEWS);
  assert.equal(extra.allows("https://a1b2c3d4.invest254.pages.dev:8443"), false);
  assert.equal(extra.allows("https://a1b2c3d4.invest254.pages.dev:443"), true, "443 IS the default");
});

test("an unknown origin is refused with a realistic preview allowlist configured", () => {
  const extra = new ExtraOriginAllowlist(`https://cpfmarket.com,${PREVIEWS}`);
  assert.equal(extra.allows("https://evil.com"), false);
  assert.equal(extra.allows("https://pages.dev"), false);
  assert.equal(extra.allows("https://invest254.pages.dev.evil.com"), false);
  assert.equal(extra.allows("not a url"), false);
  assert.equal(extra.allows(""), false);
});

// ── malformed configuration ────────────────────────────────────────────────────────────────
test("malformed configuration does not throw and never allows everything", () => {
  const spec = "  , https://*.invest254.pages.dev ,, *, */, https://, *.dev, *.*.com, https://a*b.com, ,";
  let extra: ExtraOriginAllowlist;
  assert.doesNotThrow(() => { extra = new ExtraOriginAllowlist(spec); });
  extra = new ExtraOriginAllowlist(spec);
  assert.deepEqual(extra.describe(), ["https://*.invest254.pages.dev"], "only the one good entry survives");
  assert.equal(extra.allows("https://a1b2c3d4.invest254.pages.dev"), true);
  assert.equal(extra.allows("https://evil.dev"), false, "*.dev must not become a rule");
  assert.equal(extra.allows("https://evil.com"), false);
  assert.equal(extra.allows("https://a-b.com"), false);
});

test("entries are case- and whitespace-insensitive", () => {
  const extra = new ExtraOriginAllowlist("  HTTPS://*.Invest254.Pages.Dev\t");
  assert.equal(extra.allows("https://A1B2.INVEST254.PAGES.DEV"), true);
});

test("parseExtraOrigins drops everything it does not understand", () => {
  assert.deepEqual(parseExtraOrigins("https://*.invest254.pages.dev"), [
    { kind: "suffix", suffix: "invest254.pages.dev" },
  ]);
  assert.deepEqual(parseExtraOrigins("*"), []);
  assert.deepEqual(parseExtraOrigins("https://ok.example.com/path"), []);
  assert.deepEqual(parseExtraOrigins(undefined), []);
});
