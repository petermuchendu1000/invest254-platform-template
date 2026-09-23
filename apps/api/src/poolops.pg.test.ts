import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PgPlatformRepository, PlatformService, PgPoolOpsRepository, PoolOpsService } from "@invest254/engine";

/**
 * POOL-1 (docs/46) against the REAL schema (0164) with the REAL repositories: a platform admin's overview
 * shows each brand's pool; with nothing configured the automatic run is DYNAMIC over the platform's current
 * total (so the total budget is unchanged, only its split), is labelled 'auto' in the history and recorded.
 * E2E_PG_DSN only; everything is rolled back.
 */
const DSN = process.env.E2E_PG_DSN;

test("POOL-1 (real schema): overview + default dynamic automatic run", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const q = { query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) };
    const one = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0];
    const reg = async (phone: string, user: string, site: string) =>
      (await one("select user_id from fn_register_user($1,$2,$3,null,$4)", [phone, user, "x".repeat(32), site])).user_id as string;
    const owner = await reg("254711910000", "pool1owner", "00000000-0000-0000-0000-000000000001");
    await c.query("update profiles set role='platform_superadmin' where id=$1", [owner]);
    const plat = (await one("select fn_platform_create_platform($1,'platform_superadmin','pool1pg','Pool1 PG') as id", [owner])).id as string;
    await c.query("insert into platform_subscriptions(platform_id, plan_key, status) values ($1,'enterprise','active') on conflict (platform_id) do update set plan_key='enterprise'", [plat]);
    const mk = async (slug: string) => {
      const id = (await one("select fn_platform_create_site($1,'platform_superadmin',$2,$2) as id", [owner, slug])).id as string;
      await one("select fn_platform_assign_site($1,'platform_superadmin',$2,$3)", [owner, id, plat]);
      return id;
    };
    const s1 = await mk("pool1-a"), s2 = await mk("pool1-b");
    const pa = await reg("254711910001", "pool1pa", s1);
    await one("select fn_platform_appoint_platform_admin($1,'platform_superadmin',$2,$3)", [owner, pa, plat]);
    await c.query("update sites set default_daily_pool_cents = $2 where id = $1", [s1, 300000]);
    await c.query("update sites set default_daily_pool_cents = $2 where id = $1", [s2, 100000]);

    const platform = new PlatformService(new PgPlatformRepository(q));
    const ops = new PoolOpsService(new PgPoolOpsRepository(q), platform);
    const rows = await ops.overview(pa, "platform_admin", plat);
    assert.deepEqual(rows.map((r) => [r.slug, r.defaultCents]).sort(), [["pool1-a", 300000], ["pool1-b", 100000]]);
    const st = await ops.settings(pa, "platform_admin", plat);
    assert.equal(st.mode, "dynamic"); assert.equal(st.isDefault, true);

    const run = await ops.runAuto(owner, "platform_superadmin", plat);
    assert.equal(run.ok, true, run.message);
    const after = await one("select sum(default_daily_pool_cents)::bigint as t from sites where platform_id=$1", [plat]);
    assert.ok(Number(after.t) <= 400000, "a dynamic run never budgets more than the platform's current total");
    const d = await one("select source, mode, platform_id from platform_pool_distributions where platform_id=$1 order by created_at desc limit 1", [plat]);
    assert.equal(d.source, "auto"); assert.equal(d.mode, "per_site");
    const again = await ops.settings(pa, "platform_admin", plat);
    assert.equal(again.lastRunOk, true); assert.match(again.lastRunMessage ?? "", /by demand/);
    await assert.rejects(() => ops.overview(pa, "platform_admin", null), /PLATFORM_SCOPE_FORBIDDEN/);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
});
