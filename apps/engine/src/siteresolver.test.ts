import { test } from "node:test";
import assert from "node:assert/strict";
import { SiteResolver } from "./siteresolver.js";

/**
 * GAP 2 unit coverage — the resolver that lets a brand ONBOARDED AFTER boot serve without a
 * restart. Boot aliases are the fast path; a miss falls to a live (injected) lookup, whose result
 * is cached; unknown refs are short-negative-cached; concurrent misses coalesce.
 */

test("boot aliases resolve without ever touching the live lookup", async () => {
  let calls = 0;
  const r = new SiteResolver({
    aliases: [["brandb", "SB"], ["brandb.example", "SB"], ["SB", "SB"]],
    lookup: async () => { calls++; return null; },
  });
  assert.equal(await r.resolve("brandb"), "SB");
  assert.equal(await r.resolve("BRANDB"), "SB", "case-insensitive");
  assert.equal(await r.resolve("  brandb.example  "), "SB", "trims + resolves by domain alias");
  assert.equal(await r.resolve("SB"), "SB", "resolves by id");
  assert.equal(calls, 0, "known aliases never hit the DB");
});

test("a brand unknown at boot resolves via the live lookup and is then cached", async () => {
  let calls = 0;
  const r = new SiteResolver({ lookup: async (ref) => { calls++; return ref === "tamutraders" ? "S-TAMU" : null; } });
  assert.equal(await r.resolve("tamutraders"), "S-TAMU", "newly onboarded brand resolves live");
  assert.equal(await r.resolve("tamutraders"), "S-TAMU");
  assert.equal(calls, 1, "the second resolve is served from cache");
  assert.equal(await r.resolve("S-TAMU"), "S-TAMU", "the returned id is cached too");
  assert.equal(calls, 1, "resolving by the cached id needs no lookup");
});

test("an unknown ref returns null and is negative-cached for the TTL, then retried", async () => {
  let calls = 0; let clock = 1_000;
  const r = new SiteResolver({ lookup: async () => { calls++; return null; }, negativeTtlMs: 500, now: () => clock });
  assert.equal(await r.resolve("nope"), null);
  assert.equal(await r.resolve("nope"), null);
  assert.equal(calls, 1, "negative cache prevents a second DB hit within the TTL");
  clock += 600; // TTL elapsed
  assert.equal(await r.resolve("nope"), null);
  assert.equal(calls, 2, "after the TTL the lookup is retried");
});

test("empty / nullish refs resolve to null and never hit the lookup", async () => {
  let calls = 0;
  const r = new SiteResolver({ lookup: async () => { calls++; return "X"; } });
  assert.equal(await r.resolve(""), null);
  assert.equal(await r.resolve("   "), null);
  assert.equal(await r.resolve(undefined), null);
  assert.equal(await r.resolve(null), null);
  assert.equal(calls, 0);
});

test("in-memory dev (no lookup): a boot alias hits, any other ref is a miss", async () => {
  const r = new SiteResolver({ aliases: [["default", "D"], ["D", "D"]] });
  assert.equal(await r.resolve("default"), "D");
  assert.equal(await r.resolve("unknown"), null, "no lookup → a miss stays a miss (never throws)");
});

test("concurrent resolves for the same new ref coalesce into a single lookup", async () => {
  let calls = 0;
  const r = new SiteResolver({ lookup: async () => { calls++; await new Promise((res) => setTimeout(res, 20)); return "S"; } });
  const [a, b, c] = await Promise.all([r.resolve("x"), r.resolve("x"), r.resolve("x")]);
  assert.deepEqual([a, b, c], ["S", "S", "S"]);
  assert.equal(calls, 1, "in-flight coalescing avoids a thundering herd on connect storms");
});

test("add() caches a positive alias and clears a prior negative entry (no new lookup)", async () => {
  let calls = 0;
  const r = new SiteResolver({ lookup: async () => { calls++; return null; }, negativeTtlMs: 10_000 });
  assert.equal(await r.resolve("newbrand"), null); // negative-cached
  assert.equal(calls, 1);
  r.add("newbrand", "S-NEW");                       // e.g. an onboarding signal pre-warms it
  assert.equal(await r.resolve("newbrand"), "S-NEW");
  assert.equal(await r.resolve("S-NEW"), "S-NEW");
  assert.equal(calls, 1, "add() short-circuits the negative cache without another lookup");
});
