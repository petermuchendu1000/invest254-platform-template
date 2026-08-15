import { test } from "node:test";
import assert from "node:assert/strict";
import { isOriginAllowed } from "./http.js";
import { BrandOriginAllowlist } from "./cors.js";

/**
 * GAP 3 — multi-tenant CORS. Two layers, both unit-tested here:
 *   1. isOriginAllowed (pure decision): `*` allows all; else an exact allowlist match OR the
 *      injected brand predicate; a throwing predicate fails closed.
 *   2. BrandOriginAllowlist (the brand predicate's backing cache): refresh from `sites`, fold
 *      apex/www/scheme/case, pre-warm via add(), and keep the last good set if a refresh fails.
 */

// ── isOriginAllowed ──────────────────────────────────────────────────────────────────────────
test("isOriginAllowed: '*' allows any concrete origin but never a missing one", () => {
  assert.equal(isOriginAllowed("https://anything.example", { allowAll: true, allowList: [] }), true);
  assert.equal(isOriginAllowed(undefined, { allowAll: true, allowList: [] }), false);
});

test("isOriginAllowed: restricted list matches exactly, else defers to the brand predicate", () => {
  const opts = { allowAll: false, allowList: ["https://admin.invest254.example"] };
  assert.equal(isOriginAllowed("https://admin.invest254.example", opts), true, "static allowlist hit");
  assert.equal(isOriginAllowed("https://tamutraders.com", opts), false, "not listed, no predicate → blocked");
  assert.equal(
    isOriginAllowed("https://tamutraders.com", { ...opts, brandAllows: (o) => o === "https://tamutraders.com" }),
    true, "brand predicate allows an active brand origin",
  );
  assert.equal(
    isOriginAllowed("https://evil.example", { ...opts, brandAllows: (o) => o === "https://tamutraders.com" }),
    false, "brand predicate blocks a non-brand origin",
  );
});

test("isOriginAllowed: a throwing brand predicate fails closed", () => {
  assert.equal(
    isOriginAllowed("https://x.example", { allowAll: false, allowList: [], brandAllows: () => { throw new Error("boom"); } }),
    false,
  );
});

// ── BrandOriginAllowlist ───────────────────────────────────────────────────────────────────────
test("allowlist: refresh loads active brand hosts; allows apex, www and any scheme/case", async () => {
  const a = new BrandOriginAllowlist(async () => ["tamutraders.com", "www.brandb.example"]);
  await a.refresh();
  assert.equal(a.size, 2);
  assert.equal(a.allows("https://tamutraders.com"), true, "apex");
  assert.equal(a.allows("https://www.tamutraders.com"), true, "www folds to apex");
  assert.equal(a.allows("http://TAMUTRADERS.COM"), true, "scheme + case-insensitive");
  assert.equal(a.allows("https://brandb.example"), true, "www-stored source domain still matches apex origin");
  assert.equal(a.allows("https://unknown.example"), false, "unknown origin blocked");
  assert.equal(a.allows(""), false);
});

test("allowlist: add() pre-warms a just-onboarded brand without waiting for a refresh", async () => {
  const a = new BrandOriginAllowlist(async () => []);
  await a.refresh();
  assert.equal(a.allows("https://tamutraders.com"), false);
  a.add("tamutraders.com");
  assert.equal(a.allows("https://www.tamutraders.com"), true, "apex + www both allowed after add");
});

test("allowlist: a paused/removed brand stops being allowed after the next refresh", async () => {
  let domains = ["one.example", "two.example"];
  const a = new BrandOriginAllowlist(async () => domains);
  await a.refresh();
  assert.equal(a.allows("https://two.example"), true);
  domains = ["one.example"]; // two.example paused/archived
  await a.refresh();
  assert.equal(a.allows("https://two.example"), false, "refresh replaces the set");
  assert.equal(a.allows("https://one.example"), true);
});

test("allowlist: a failing refresh keeps the last good set (fail-safe)", async () => {
  let mode: "ok" | "fail" = "ok";
  const a = new BrandOriginAllowlist(async () => { if (mode === "fail") throw new Error("db down"); return ["one.example"]; });
  await a.refresh();
  assert.equal(a.allows("https://one.example"), true);
  mode = "fail";
  await a.refresh().catch(() => { /* refresh swallows via init interval; here we call directly */ });
  assert.equal(a.allows("https://one.example"), true, "kept the last good set despite the error");
});

test("allowlist: init() seeds the set and starts an unref'd timer that stop() clears", async () => {
  const a = new BrandOriginAllowlist(async () => ["seed.example"], 60_000);
  await a.init();
  assert.equal(a.allows("https://seed.example"), true);
  a.stop(); // must not throw and must clear the interval
});
