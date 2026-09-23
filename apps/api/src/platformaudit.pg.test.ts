import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgAdminRepository } from "@invest254/engine";

/** docs/42 UI-10 — the platform-wide audit query against the REAL schema (rolled back). E2E_PG_DSN only. */
const DSN = process.env.E2E_PG_DSN;

test("UI-10 (real schema): platform audit = its brands only, attributed to brand + actor name, paged", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const p1 = randomUUID(), p2 = randomUUID();
    await c.query("insert into platforms(id, slug, name) values ($1,'ui10p1','UI10 One'), ($2,'ui10p2','UI10 Two')", [p1, p2]);
    // an enterprise plan (no site cap) so the fixture can hold several brands (0138 enforcement)
    await c.query("insert into platform_subscriptions(platform_id, plan_key, status) values ($1,'enterprise','active'),($2,'enterprise','active') on conflict (platform_id) do update set plan_key='enterprise', status='active'", [p1, p2]);
    const s1 = (await c.query("insert into sites(slug, name, platform_id) values ('ui10-a','Alpha',$1) returning id", [p1])).rows[0].id as string;
    const s2 = (await c.query("insert into sites(slug, name, platform_id) values ('ui10-b','Bravo',$1) returning id", [p1])).rows[0].id as string;
    const s3 = (await c.query("insert into sites(slug, name, platform_id) values ('ui10-c','Charlie',$1) returning id", [p2])).rows[0].id as string;
    const actor = (await c.query("insert into profiles(phone, username, site_id, role) values ('254799200001','ui10actor',$1,'admin') returning id", [s1])).rows[0].id as string;
    const ins = (site: string, action: string) => c.query(
      "insert into admin_actions(actor_id, actor_role, action, target_type, target_id, site_id) values ($1,'admin',$2,'user','x',$3)", [actor, action, site]);
    await ins(s1, "ui10.a1"); await ins(s2, "ui10.b1"); await ins(s3, "ui10.c1"); await ins(s1, "ui10.a2");

    const repo = new PgAdminRepository({ query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) } as never);
    const mine = (await repo.listPlatformAudit({ platformId: p1, limit: 50 })).items.filter((r) => r.action.startsWith("ui10."));
    assert.deepEqual(mine.map((r) => r.action), ["ui10.a2", "ui10.b1", "ui10.a1"], "own brands only, newest first; never another platform's");
    assert.equal(mine[0]!.siteName, "Alpha"); assert.equal(mine[0]!.actorUsername, "ui10actor");
    const one = (await repo.listPlatformAudit({ platformId: p1, siteId: s2, limit: 50 })).items.map((r) => r.action);
    assert.deepEqual(one, ["ui10.b1"]);
    const page1 = await repo.listPlatformAudit({ platformId: p1, limit: 2 });
    assert.equal(page1.items.length, 2); assert.ok(page1.nextCursor, "keyset cursor");
    const page2 = await repo.listPlatformAudit({ platformId: p1, limit: 2, cursor: page1.nextCursor! });
    assert.deepEqual(page2.items.map((r) => r.action), ["ui10.a1"], "second page continues without overlap");
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
});
