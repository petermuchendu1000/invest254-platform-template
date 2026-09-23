import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { refuseForeignReonboard, refuseDomainClash, assertDomainInPlatform, platformDomainSet } from "./onboardscope.js";

/**
 * Issue 1 / F-47 — the onboarding scope helpers against the REAL migrated schema (`sites`,
 * `platforms`). Runs only when E2E_PG_DSN points at a database built from all migrations (e.g. the
 * DB e2e harness DB); skipped in CI, which has no Postgres. Everything is created inside a transaction
 * that is rolled back.
 */
const DSN = process.env.E2E_PG_DSN;

test("F-47 (real schema): foreign re-onboard, case-insensitive domain clash, platform-bounded domains", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const p1 = randomUUID(), p2 = randomUUID();
    await c.query("insert into platforms(id, slug, name) values ($1,'f47p1','F47 P1'), ($2,'f47p2','F47 P2')", [p1, p2]);
    const s1 = (await c.query("insert into sites(slug, name, primary_domain, platform_id) values ('f47-alpha','A','f47-alpha.test',$1) returning id", [p1])).rows[0].id as string;
    const s2 = (await c.query("insert into sites(slug, name, primary_domain, platform_id) values ('f47-beta','B','F47-Beta.TEST',$1) returning id", [p2])).rows[0].id as string;
    const q = { query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) };
    const code = async (x: Promise<unknown>) => x.then(() => "OK", (e: Error) => e.message.split(":")[0]!);

    assert.equal(await code(refuseForeignReonboard(q, "f47-beta", p1)), "SLUG_TAKEN");
    assert.equal(await refuseForeignReonboard(q, "f47-alpha", p1), s1);
    assert.equal(await refuseForeignReonboard(q, "f47-beta", null), s2);
    assert.equal(await code(refuseDomainClash(q, "f47-beta.test", null)), "DOMAIN_TAKEN", "case-insensitive clash");
    assert.equal(await code(refuseDomainClash(q, "f47-alpha.test", s1)), "OK");
    assert.equal(await code(assertDomainInPlatform(q, "www.f47-alpha.test", p1)), "OK");
    assert.equal(await code(assertDomainInPlatform(q, "f47-beta.test", p1)), "DOMAIN_NOT_FOUND");
    assert.deepEqual([...(await platformDomainSet(q, p2))!].sort(), ["f47-beta.test", "www.f47-beta.test"]);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
});
