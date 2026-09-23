import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PgAdminRepository, PgGameRepository, PgPaymentRepository, type Page } from "@invest254/engine";

/**
 * PAGE-1 (BUGLOG #61) — keyset pagination against the REAL schema. Cursors carry a MILLISECOND time,
 * timestamps have MICROSECONDS; comparing `(created_at, id) < (cursor_ms, id)` dropped every row that
 * shared the cursor row's millisecond (all rows written in one transaction share `now()`). Every list
 * must now return each row exactly once however it is paged. E2E_PG_DSN only; rolled back.
 */
const DSN = process.env.E2E_PG_DSN;
const SITE = "00000000-0000-0000-0000-000000000001";

async function drain<T>(first: (cursor?: string) => Promise<Page<T>>, maxPages = 50): Promise<T[]> {
  const out: T[] = []; let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const p = await first(cursor);
    out.push(...p.items);
    if (!p.nextCursor) break;
    cursor = p.nextCursor;
  }
  return out;
}

test("PAGE-1 (real schema): rows sharing a timestamp are each returned exactly once across pages", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");   // every insert below shares ONE now() — the worst case for a ms cursor
    const q = { query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) } as never;
    const uid = (await c.query("insert into profiles(phone, username, site_id) values ('254799300001','page1user',$1) returning id", [SITE])).rows[0].id as string;
    await c.query("insert into wallets(user_id, site_id) values ($1,$2) on conflict do nothing", [uid, SITE]);
    const gd = (await c.query("insert into game_days(site_id, trade_date, server_seed_hash) values ($1, current_date - 4000, 'page1') returning id", [SITE])).rows[0].id;
    for (let i = 0; i < 7; i++) {
      await c.query("insert into ledger_entries(user_id, type, amount, balance_kind, site_id) values ($1,'adjustment',$2,'real',$3)", [uid, 100 + i, SITE]);
      await c.query("insert into transactions(user_id, kind, amount, status, phone, site_id) values ($1,'deposit',$2,'pending','254799300001',$3)", [uid, 1000 + i, SITE]);
      await c.query(`insert into positions(user_id, game_day_id, direction, stake, entry_rate, duration_s, nonce, status, site_id)
                     values ($1,$2,'buy',$3,0.2,10,$4,'open',$5)`, [uid, gd, 500 + i, 9000 + i, SITE]);
      await c.query("insert into admin_actions(actor_id, actor_role, action, target_type, target_id, site_id) values ($1,'admin','page1.act','user',$2,$3)", [uid, String(i), SITE]);
      await c.query("insert into system_logs(level, msg, app) values ('info','page1-marker','api')");
    }
    const admin = new PgAdminRepository(q), game = new PgGameRepository(q), pay = new PgPaymentRepository(q);
    const uniq = (xs: string[]) => new Set(xs).size;

    const ledger = await drain((cursor) => game.listLedger(uid, { limit: 2, ...(cursor ? { cursor } : {}) }));
    assert.equal(ledger.length, 7, `ledger: ${ledger.length} rows`); assert.equal(uniq(ledger.map((r) => String(r.id))), 7);

    const positions = await drain((cursor) => game.listPositions(uid, { limit: 2, ...(cursor ? { cursor } : {}) }));
    assert.equal(positions.length, 7, `positions: ${positions.length}`); assert.equal(uniq(positions.map((r) => r.id)), 7);

    const txs = await drain((cursor) => pay.listTransactions(uid, { limit: 2, ...(cursor ? { cursor } : {}) }));
    assert.equal(txs.length, 7, `player transactions: ${txs.length}`);

    const activity = await drain((cursor) => admin.listUserActivity(uid, { limit: 3, ...(cursor ? { cursor } : {}) }));
    assert.equal(activity.length, 21, `user activity (union): ${activity.length}`); assert.equal(uniq(activity.map((r) => `${r.kind}:${r.id}`)), 21);

    const audit = (await drain((cursor) => admin.listAudit({ limit: 2, ...(cursor ? { cursor } : {}) }), 400)).filter((r) => r.action === "page1.act");
    assert.equal(audit.length, 7, `audit: ${audit.length}`);

    const logs = await drain((cursor) => admin.listSystemLogs({ limit: 2, q: "page1-marker", ...(cursor ? { cursor } : {}) }));
    assert.equal(logs.length, 7, `system logs: ${logs.length}`);

    const adminTx = (await drain((cursor) => admin.listTransactions({ limit: 2, ...(cursor ? { cursor } : {}) }), 400)).filter((r) => r.userId === uid);
    assert.equal(adminTx.length, 7, `admin transactions: ${adminTx.length}`);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
});
