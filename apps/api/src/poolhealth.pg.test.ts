import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { checkPoolHealth } from "./poolhealth.js";

/**
 * The pool-health monitor's QUERY against the REAL schema. The unit tests in poolhealth.test.ts pin
 * the thresholds; this pins the thing they cannot see — that the SQL still joins what it thinks it
 * joins (sites, site_game_config, withdrawal_pool, position_decision, positions), that the EAT
 * trade-day and the rolling window behave, and that `bigint`/`numeric` surviving the driver as
 * strings still produce the right verdicts.
 *
 * That last one is why this test matters most: a schema change that turned a cents column into
 * `numeric` would keep every unit test green and silently break the comparisons.
 *
 * E2E_PG_DSN only; everything is rolled back.
 */
const DSN = process.env.E2E_PG_DSN;

test("pool health (real schema): starved, all-loss, below-viable and healthy brands", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const q = { query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) };

    // Only our fixtures should be in scope, so park every pre-existing pool brand for this tx.
    await c.query("update sites set pool_mode = false where pool_mode");
    await c.query(
      "insert into profiles (id, phone, username) values ('aaaaaaaa-0000-0000-0000-0000000000ff','254700000099','phpgplayer') on conflict (id) do nothing");

    const day = (await c.query("select (now() at time zone 'Africa/Nairobi')::date as d")).rows[0].d;
    let n = 0;
    const brand = async (slug: string, o: {
      minStake: number; amount: number; paid: number; decisions: number; wins: number;
    }): Promise<void> => {
      n += 1;
      const id = `dddddddd-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
      await c.query(
        "insert into sites (id, slug, name, status, pool_mode, created_at) values ($1,$2,$2,'active',true, now() + ($3 || ' seconds')::interval)",
        [id, slug, n]);
      // max_multiplier must clear site_cfg_feasible: (1 - house_edge) / target_win_rate <= it.
      await c.query(
        "insert into site_game_config (site_id, min_stake, max_multiplier) values ($1,$2,5.0)", [id, o.minStake]);
      if (o.amount > 0 || o.paid > 0) {
        await c.query(
          "insert into withdrawal_pool (site_id, trade_day, amount_cents, paid_cents, reserved_cents) values ($1,$2,$3,$4,0)",
          [id, day, o.amount, o.paid]);
      }
      for (let i = 1; i <= o.decisions; i += 1) {
        const pos = (await c.query(
          "insert into positions (id, user_id, site_id, direction, stake, entry_rate, duration_s, nonce, opened_at, status)"
          + " values (gen_random_uuid(),'aaaaaaaa-0000-0000-0000-0000000000ff',$1,'buy',30000,1,60,$2, now() - interval '5 minutes','settled') returning id",
          [id, i])).rows[0].id as string;
        await c.query(
          "insert into position_decision (position_id, site_id, pool_day, decided_result, decision_seed) values ($1,$2,$3,$4,$5)",
          [pos, id, day, i <= o.wins ? "win" : "loss", `s${n}-${i}`]);
      }
    };

    await brand("pg-healthy",  { minStake: 25000, amount: 5_000_000, paid: 0,     decisions: 10, wins: 4 });
    await brand("pg-starved",  { minStake: 25000, amount: 10_000,    paid: 9_000, decisions: 5,  wins: 0 });
    await brand("pg-allloss",  { minStake: 25000, amount: 5_000_000, paid: 0,     decisions: 10, wins: 0 });
    await brand("pg-low",      { minStake: 25000, amount: 200_000,   paid: 0,     decisions: 3,  wins: 1 });
    await brand("pg-quiet",    { minStake: 25000, amount: 0,         paid: 0,     decisions: 0,  wins: 0 });

    const r = await checkPoolHealth(q, { minDecisions: 8 });
    const by = new Map(r.brands.map((b) => [b.slug, b]));
    assert.equal(r.brands.length, 5, "every active pool-mode brand is reported, healthy ones included");

    // The numbers came back as numbers, not as strings that happen to print right.
    const starved = by.get("pg-starved")!;
    assert.equal(starved.availableCents, 1000);
    assert.equal(typeof starved.availableCents, "number");
    assert.equal(starved.turnoverCents, 150_000, "turnover is summed from positions.stake");

    assert.deepEqual(by.get("pg-healthy")!.alerts.map((a) => a.kind), []);
    assert.deepEqual(starved.alerts.map((a) => a.kind), ["POOL_STARVED"]);
    assert.deepEqual(by.get("pg-allloss")!.alerts.map((a) => a.kind), ["ALL_LOSS"]);
    assert.deepEqual(by.get("pg-low")!.alerts.map((a) => a.kind), ["BELOW_VIABLE"]);
    assert.deepEqual(by.get("pg-quiet")!.alerts.map((a) => a.kind), [], "no trades, no alert");

    assert.equal(r.alert, true);
    assert.equal(r.hard.length, 2, "starved + all-loss page; below-viable does not");
    assert.equal(r.warnings.length, 1);

    // The window is rolling: age every decision past it and the live alerts must clear.
    await c.query("update positions set opened_at = now() - interval '3 hours'");
    const stale = await checkPoolHealth(q, { minDecisions: 8 });
    assert.equal(stale.alert, false, "a re-funded brand must not be paged for pre-remediation losses");
    assert.deepEqual(stale.brands.flatMap((b) => b.alerts.map((a) => a.kind)), []);
  } finally {
    await c.query("rollback");
    c.release();
    await pool.end();
  }
});
