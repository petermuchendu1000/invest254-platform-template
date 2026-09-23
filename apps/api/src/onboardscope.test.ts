import { test } from "node:test";
import assert from "node:assert/strict";
import { refuseForeignReonboard, refuseDomainClash, assertDomainInPlatform, platformDomainSet, type Querier } from "./onboardscope.js";

/**
 * Issue 1 / F-47 — onboarding & domain-visibility scope rules (DB-free; the same helpers are exercised
 * against the real migrated schema by onboardscope.pg.test.ts). The fake querier implements exactly the
 * four statements the helpers issue, over an in-memory `sites` table.
 */
const P1 = "10000000-0000-0000-0000-00000000000a", P2 = "10000000-0000-0000-0000-00000000000b";
const SITES = [
  { id: "a1a1a1a1-0000-0000-0000-000000000001", slug: "alpha", platform_id: P1, primary_domain: "alpha.com" },
  { id: "b1b1b1b1-0000-0000-0000-000000000001", slug: "beta", platform_id: P2, primary_domain: "Beta.COM" },
  { id: "b2b2b2b2-0000-0000-0000-000000000002", slug: "nodomain", platform_id: P2, primary_domain: null },
];
const fake: Querier = {
  async query(sql: string, p: unknown[] = []) {
    if (sql.startsWith("select id, platform_id from sites where slug")) return { rows: SITES.filter((s) => s.slug === p[0]) };
    if (sql.startsWith("select 1 from sites where lower(primary_domain) = $1 and"))
      return { rows: SITES.filter((s) => s.primary_domain?.toLowerCase() === p[0] && (p[1] == null || s.id !== p[1])) };
    if (sql.startsWith("select 1 from sites where platform_id = $1 and lower"))
      return { rows: SITES.filter((s) => s.platform_id === p[0] && s.primary_domain?.toLowerCase() === p[1]) };
    if (sql.startsWith("select lower(primary_domain) as d from sites where platform_id"))
      return { rows: SITES.filter((s) => s.platform_id === p[0] && s.primary_domain).map((s) => ({ d: s.primary_domain!.toLowerCase() })) };
    throw new Error(`unexpected SQL: ${sql}`);
  },
};
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "OK", (e: Error) => e.message.split(":")[0]!);

test("F-47: re-onboarding another platform's slug is refused; own platform and system owner allowed", async () => {
  assert.equal(await code(refuseForeignReonboard(fake, "beta", P1)), "SLUG_TAKEN", "P1 admin cannot overwrite P2's brand");
  assert.equal(await refuseForeignReonboard(fake, "alpha", P1), SITES[0]!.id, "own platform's brand is re-onboardable");
  assert.equal(await refuseForeignReonboard(fake, "beta", null), SITES[1]!.id, "system owner is unrestricted");
  assert.equal(await refuseForeignReonboard(fake, "fresh", P1), null, "a new slug is not an existing brand");
});

test("F-47: a domain belongs to one brand — compared case-insensitively, apex/www normalised", async () => {
  assert.equal(await code(refuseDomainClash(fake, "beta.com", null)), "DOMAIN_TAKEN", "differently-cased copy of another brand's domain");
  assert.equal(await code(refuseDomainClash(fake, "WWW.beta.com", null)), "DOMAIN_TAKEN", "www. form of another brand's domain");
  assert.equal(await code(refuseDomainClash(fake, "alpha.com", SITES[0]!.id)), "OK", "a brand keeping its own domain on re-onboard");
  assert.equal(await code(refuseDomainClash(fake, "new.com", null)), "OK");
});

test("F-47: a platform admin may only probe its own platform's domains; the owner any", async () => {
  assert.equal(await code(assertDomainInPlatform(fake, "alpha.com", P1)), "OK");
  assert.equal(await code(assertDomainInPlatform(fake, "www.ALPHA.com", P1)), "OK");
  assert.equal(await code(assertDomainInPlatform(fake, "beta.com", P1)), "DOMAIN_NOT_FOUND", "another platform's domain");
  assert.equal(await code(assertDomainInPlatform(fake, "unknown.com", P1)), "DOMAIN_NOT_FOUND", "unclaimed domain");
  assert.equal(await code(assertDomainInPlatform(fake, "beta.com", null)), "OK", "system owner");
});

test("F-47: domain-health visibility set = own platform's apex + www; null (all) for the owner", async () => {
  assert.deepEqual([...(await platformDomainSet(fake, P2))!].sort(), ["beta.com", "www.beta.com"]);
  assert.deepEqual([...(await platformDomainSet(fake, P1))!].sort(), ["alpha.com", "www.alpha.com"]);
  assert.equal(await platformDomainSet(fake, null), null);
});
