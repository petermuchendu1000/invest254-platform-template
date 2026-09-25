import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { makeDemoAccountResolver } from "@invest254/engine";
import { makeWalletModeDeps, demoTargetCents } from "./demo.pg.js";

/**
 * DEMO-1 against the REAL schema (rolled back): the engine's demo check and the money RPCs agree,
 * demo trades touch demo_balance only, and a switch is refused while a contract is open.
 * E2E_PG_DSN only.
 */
const DSN = process.env.E2E_PG_DSN;

test("DEMO-1 (real schema): switch, refresh, isolated demo money, engine agrees, open-contract lock", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const site = (await c.query("select id from sites order by created_at limit 1")).rows[0].id as string;
    const uid = (await c.query("insert into profiles(phone, username, site_id, role) values ('254799300001','demo1p',$1,'player') returning id", [site])).rows[0].id as string;
    await c.query("insert into wallets(user_id, site_id, real_balance, bonus_balance) values ($1,$2,50000,1000) on conflict (user_id) do update set real_balance=50000, bonus_balance=1000", [uid, site]).catch(async () => {
      await c.query("update wallets set real_balance=50000, bonus_balance=1000 where user_id=$1", [uid]);
    });
    const Q = { query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) as never };
    const wm = makeWalletModeDeps(Q);
    const isDemo = makeDemoAccountResolver(Q);

    let w = await wm.balances(uid, site);
    assert.equal(w.mode, "real"); assert.equal(w.real, 50000); assert.equal(w.bonus, 1000);
    assert.equal(await isDemo(uid), false, "a real-mode player is on the real path");

    assert.equal(await wm.setMode(uid, site, "demo"), "demo");
    assert.equal(await isDemo(uid), true, "the engine sees demo mode immediately (no stale cache)");
    w = await wm.balances(uid, site);
    assert.equal(w.real, 1_000_000, "DEMO-2: the first switch to demo opens funded (no 0 until Refresh)");
    assert.equal(await wm.topupDemo(uid, site), 1_000_000);
    w = await wm.balances(uid, site);
    assert.equal(w.real, 1_000_000); assert.equal(w.bonus, 0); assert.equal(w.realBalance, 50000); assert.equal(w.bonusBalance, 1000);

    // a demo contract: stake + payout touch demo_balance only
    const ver = (await c.query("select max(version) v from site_game_config_versions where site_id = $1", [site])).rows[0].v ?? null;
    const open = await c.query(
      "select position_id, new_balance from fn_open_contract($1, 25000, 'digit', '{\"type\":\"even\"}'::jsonb, 'buy', 100.5, 1, null, 1, now(), $3, $2)", [uid, site, ver]);
    const pos = open.rows[0].position_id as string;
    assert.equal(Number(open.rows[0].new_balance), 975_000);
    await assert.rejects(() => wm.setMode(uid, site, "real"), /OPEN_POSITIONS/, "no switch while a contract is open");
    await c.query("select * from fn_settle_position($1, 100.52, 'win', 1.9, 47500)", [pos]);
    const after = (await c.query("select real_balance, bonus_balance, demo_balance from wallets where user_id=$1", [uid])).rows[0];
    assert.equal(Number(after.real_balance), 50000); assert.equal(Number(after.bonus_balance), 1000);
    assert.equal(Number(after.demo_balance), 1_022_500);
    const kinds = (await c.query("select distinct balance_kind from ledger_entries where ref_id = $1", [pos])).rows.map((r) => r.balance_kind);
    assert.deepEqual(kinds, ["demo"]);
    assert.equal((await c.query("select count(*)::int n from v_real_positions where id = $1", [pos])).rows[0].n, 0, "demo trades never enter real reporting");

    assert.equal(await wm.setMode(uid, site, "real"), "real");
    assert.equal(await isDemo(uid), false);
    w = await wm.balances(uid, site);
    assert.equal(w.real, 50000); assert.equal(w.demoBalance, 1_022_500);
    assert.equal(await wm.topupDemo(uid, site), 1_022_500, "refresh is a no-op above the starting amount (can't be farmed)");
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
});

test("DEMO-2 (real schema): a USD brand's demo opens at $10,000; a spent demo refills on the next switch", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const site = (await c.query("select id from sites order by created_at limit 1")).rows[0].id as string;
    await c.query("update sites set currency = 'USD' where id = $1", [site]);
    const uid = (await c.query("insert into profiles(phone, username, site_id, role) values ('254799300002','demo2p',$1,'player') returning id", [site])).rows[0].id as string;
    await c.query("insert into wallets(user_id, site_id) values ($1,$2) on conflict do nothing", [uid, site]);
    const Q = { query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) as never };
    const rate = 0.00775;                                     // USD per KES
    const wm = makeWalletModeDeps(Q, async (cur) => (cur === "USD" ? rate : 0));
    const target = demoTargetCents(rate, "USD");
    assert.equal(target, 129_032_259);
    assert.ok((target / 100) * rate >= 10_000 && (target / 100) * rate < 10_000.01, "shows $10,000.00, never $9,999.99");
    await wm.setMode(uid, site, "demo");
    assert.equal((await wm.balances(uid, site)).real, target);
    // spend it below the minimum stake, go to Real and back: refilled
    await c.query("update wallets set demo_balance = 100 where user_id = $1", [uid]);
    await wm.setMode(uid, site, "real");
    assert.equal((await wm.balances(uid, site)).demoBalance, 100, "switching to Real never touches demo");
    await wm.setMode(uid, site, "demo");
    assert.equal((await wm.balances(uid, site)).real, target);
    // a demo balance that can still trade is left alone
    await c.query("update wallets set demo_balance = 5_000_000 where user_id = $1", [uid]);
    await wm.setMode(uid, site, "real"); await wm.setMode(uid, site, "demo");
    assert.equal((await wm.balances(uid, site)).real, 5_000_000);
    // marketers keep their own demo top-up
    const m = (await c.query("insert into profiles(phone, username, site_id, role) values ('254799300003','demo2m',$1,'marketer') returning id", [site])).rows[0].id as string;
    await c.query("insert into wallets(user_id, site_id) values ($1,$2) on conflict do nothing", [m, site]);
    await wm.setMode(m, site, "demo");
    assert.equal((await wm.balances(m, site)).demoBalance, 0, "marketer demo is funded by the marketer flow, not here");
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
});
