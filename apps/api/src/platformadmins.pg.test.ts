import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgPlatformRepository } from "@invest254/engine";

/**
 * docs/42 UI-9 — the platform-admin list and cross-brand user search against the REAL migrated schema.
 * Runs only when E2E_PG_DSN points at a database built from all migrations; everything happens in a
 * transaction that is rolled back.
 */
const DSN = process.env.E2E_PG_DSN;

test("UI-9 (real schema): platform-admin list + directory search (literal LIKE, default-marketer flag)", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const p1 = randomUUID(), p2 = randomUUID();
    await c.query("insert into platforms(id, slug, name) values ($1,'ui9p1','UI9 One'), ($2,'ui9p2','UI9 Two')", [p1, p2]);
    const s1 = (await c.query("insert into sites(slug, name, platform_id) values ('ui9-alpha','Alpha Brand',$1) returning id", [p1])).rows[0].id as string;
    const mk = async (phone: string, username: string, role = "player", platformId: string | null = null) =>
      (await c.query("insert into profiles(phone, username, site_id, role, platform_id) values ($1,$2,$3,$4,$5) returning id",
        [phone, username, s1, role, platformId])).rows[0].id as string;
    const pa1 = await mk("254799100001", "ui9_pa_one", "platform_admin", p1);
    const pa2 = await mk("254799100002", "ui9_pa_two", "platform_admin", p2);
    const axb = await mk("254799100003", "ui9axb");
    const lit = await mk("254799100004", "ui9a_b");
    const owner = await mk("254799100005", "ui9owner", "marketer");
    await c.query("update sites set owner_user_id = $1 where id = $2", [owner, s1]);

    const repo = new PgPlatformRepository({ query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) } as never);

    const one = await repo.listPlatformAdmins(p1);
    assert.deepEqual(one.map((a) => a.userId), [pa1]);
    assert.equal(one[0]!.platformName, "UI9 One");
    assert.equal(one[0]!.homeSiteName, "Alpha Brand");
    const all = (await repo.listPlatformAdmins(null)).map((a) => a.userId);
    assert.ok(all.includes(pa1) && all.includes(pa2), "every platform when unfiltered");

    const underscore = (await repo.searchUsers("ui9a_b", 20)).map((u) => u.userId);
    assert.deepEqual(underscore, [lit], "'_' matches literally, not any character (ui9axb excluded)");
    assert.ok(!underscore.includes(axb));
    const byPhone = await repo.searchUsers("799100005", 20);
    assert.deepEqual(byPhone.map((u) => u.userId), [owner]);
    assert.equal(byPhone[0]!.isDefaultMarketer, true, "default marketer flagged (appoint would be refused)");
    assert.equal(byPhone[0]!.platformId, p1, "platform resolved via the home brand");
    const pa = (await repo.searchUsers("ui9_pa_two", 20))[0]!;
    assert.equal(pa.role, "platform_admin"); assert.equal(pa.platformId, p2, "a platform admin's own platform wins");
    const pct = await repo.searchUsers("100%", 20);
    assert.deepEqual(pct, [], "'%' is literal too");
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
});
