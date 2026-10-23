import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PgAdminRepository } from "./admin.js";
import { makeSweepRegistry } from "./sweeps.js";

/**
 * The sweep heartbeat round-trip against the REAL migration (0212).
 *
 * sweeps.test.ts pins the staleness rule in memory. This pins the two things it cannot see:
 *   1. that `fn_sweep_heartbeat` is actually an UPSERT keyed on (app, machine, name) — the whole
 *      premise of a permanently-tiny table rests on it, and a key mistake would instead append a
 *      row per heartbeat and quietly grow forever;
 *   2. that `listSweeps` RECOMPUTES the verdict from the timestamps. This is the one that would
 *      cost us the feature: a machine whose process died leaves `status` frozen at 'ok', so a read
 *      that trusted the column would render a dead sweep green — exactly the invisible failure the
 *      registry exists to end. The test kills a sweep by ageing its row and asserts the board turns
 *      it red WITHOUT anything having rewritten the status column.
 *
 * E2E_PG_DSN only; everything is rolled back.
 */
const DSN = process.env.E2E_PG_DSN;

const beat = (c: pg.PoolClient, name: string, o: {
  app?: string; machine?: string; everyMs: number; firstRunMs?: number; status: string;
  armedAgo?: string; lastRunAgo?: string | null; lastOkAgo?: string | null; lastErrorAgo?: string | null;
  lastError?: string | null; runs?: number; failures?: number;
}) => c.query(
  `select public.fn_sweep_heartbeat($1,$2,$3,$4,$5,$6,
      now() - $7::interval,
      case when $8::text is null then null else now() - $8::interval end,
      case when $9::text is null then null else now() - $9::interval end,
      case when $10::text is null then null else now() - $10::interval end,
      $11,$12,$13)`,
  [o.app ?? "api", o.machine ?? "m1", name, o.everyMs, o.firstRunMs ?? 0, o.status,
    o.armedAgo ?? "1 hour", o.lastRunAgo ?? null, o.lastOkAgo ?? null, o.lastErrorAgo ?? null,
    o.lastError ?? null, o.runs ?? 0, o.failures ?? 0]);

test("sweep heartbeats (real schema): upsert, recomputed staleness, ordering and prune", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("delete from sweep_heartbeats");   // rolled back; isolates the fixtures
    const repo = new PgAdminRepository({ query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) } as never);

    // ── 1. the UPSERT ───────────────────────────────────────────────────────────────────────────
    await beat(c, "payments.reconcile.mpesa", { everyMs: 300_000, status: "pending", lastRunAgo: null });
    await beat(c, "payments.reconcile.mpesa", { everyMs: 300_000, status: "ok", lastRunAgo: "10 seconds", lastOkAgo: "10 seconds", runs: 1 });
    await beat(c, "payments.reconcile.mpesa", { everyMs: 300_000, status: "ok", lastRunAgo: "5 seconds", lastOkAgo: "5 seconds", runs: 2 });
    assert.equal(
      Number((await c.query("select count(*)::int as n from sweep_heartbeats")).rows[0].n), 1,
      "three heartbeats for one sweep are ONE row — the table is keyed, not appended to");
    assert.equal(Number((await c.query("select runs from sweep_heartbeats")).rows[0].runs), 2, "the latest counters win");

    // Same sweep name on a SECOND machine is a separate row: one machine's healthy timer must not
    // mask another's dead one (`auto_start_machines` can run two API machines).
    await beat(c, "payments.reconcile.mpesa", { machine: "m2", everyMs: 300_000, status: "ok", lastRunAgo: "5 seconds", lastOkAgo: "5 seconds", runs: 9 });
    assert.equal(Number((await c.query("select count(*)::int as n from sweep_heartbeats")).rows[0].n), 2);

    // ── 2. the verdict is RECOMPUTED, not read from the column ──────────────────────────────────
    // A process that died at 10:00 leaves this row saying 'ok' forever. Nothing will ever update it.
    await beat(c, "pool.health", {
      everyMs: 1_800_000, firstRunMs: 45_000, status: "ok",
      armedAgo: "6 hours", lastRunAgo: "5 hours", lastOkAgo: "5 hours", runs: 11,
    });
    // And one that armed and never ran at all — judged on its first-run delay, not its cadence.
    await beat(c, "tickets.escalate", { everyMs: 900_000, firstRunMs: 30_000, status: "pending", armedAgo: "20 minutes", lastRunAgo: null });
    // A sweep whose last run threw, but recently enough to still be firing.
    await beat(c, "billing.reconcile", {
      everyMs: 120_000, status: "failing", lastRunAgo: "30 seconds", lastOkAgo: "9 minutes",
      lastErrorAgo: "30 seconds", lastError: "connection terminated unexpectedly", runs: 40, failures: 1,
    });

    const rows = await repo.listSweeps();
    const by = new Map(rows.map((r) => [`${r.machine}/${r.name}`, r]));

    assert.equal(by.get("m1/pool.health")!.status, "stale",
      "the stored column says 'ok'; five hours of silence on a half-hourly sweep says otherwise");
    assert.equal(
      (await c.query("select status from sweep_heartbeats where name = 'pool.health'")).rows[0].status, "ok",
      "and the read did NOT rewrite the row — the board is a view, not a mutation");
    assert.ok(by.get("m1/pool.health")!.ageMs > 4.9 * 3600_000, "age is measured from last_run_at");
    assert.equal(by.get("m1/pool.health")!.toleranceMs, 1_800_000 * 2 + 30_000);

    assert.equal(by.get("m1/tickets.escalate")!.status, "stale",
      "armed 20 min ago with a 30 s first run and no run recorded: overdue, not merely young");
    assert.equal(by.get("m1/tickets.escalate")!.toleranceMs, 30_000 * 2 + 30_000, "judged on the FIRST-run delay");
    assert.equal(by.get("m1/tickets.escalate")!.lastRunAtMs, null);

    assert.equal(by.get("m1/billing.reconcile")!.status, "failing", "firing, but failing");
    assert.equal(by.get("m1/billing.reconcile")!.lastError, "connection terminated unexpectedly");
    assert.equal(by.get("m1/billing.reconcile")!.failures, 1);

    assert.equal(by.get("m1/payments.reconcile.mpesa")!.status, "ok");
    assert.equal(by.get("m2/payments.reconcile.mpesa")!.status, "ok");

    // ── 3. worst news first ─────────────────────────────────────────────────────────────────────
    assert.deepEqual(
      rows.map((r) => r.status),
      ["stale", "stale", "failing", "ok", "ok"],
      "the owner should not have to scan a table to find the red row");
    assert.ok(rows[0]!.ageMs >= rows[1]!.ageMs, "and within a group, longest-overdue first");

    // ── 4. the error text is bounded at the DB boundary ─────────────────────────────────────────
    await beat(c, "noisy", { everyMs: 1_000, status: "failing", lastRunAgo: "1 second", lastErrorAgo: "1 second", lastError: "E".repeat(2_000), runs: 1, failures: 1 });
    assert.equal(
      Number((await c.query("select length(last_error) as n from sweep_heartbeats where name = 'noisy'")).rows[0].n), 500,
      "a pathological stack cannot bloat the table");

    // ── 5. prune drops departed machines, keeps live ones ───────────────────────────────────────
    // Fly stops surplus machines (`auto_stop_machines`), so their rows would sit there looking
    // overdue forever. Nothing pages off this table, but the board reads it.
    await c.query("update sweep_heartbeats set updated_at = now() - interval '30 days' where machine = 'm2'");
    const pruned = Number((await c.query("select public.fn_prune_sweep_heartbeats(7) as n")).rows[0].n);
    assert.equal(pruned, 1, "only the departed machine's row");
    assert.equal(
      Number((await c.query("select count(*)::int as n from sweep_heartbeats where machine = 'm1'")).rows[0].n), 5,
      "every live row survives (the four sweeps above plus `noisy`)");
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }
});

test("the registry's persist callback writes a row the real function accepts", { skip: !DSN }, async () => {
  /**
   * The unit tests inject a fake `persist`, so nothing there proves the registry's own state shape
   * matches the function's twelve-argument signature. A mismatch would be swallowed by the
   * fire-and-forget `.catch` in server.ts and leave the table silently empty — observability that
   * fails invisibly being precisely the bug under repair.
   */
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("delete from sweep_heartbeats");
    const writes: Promise<unknown>[] = [];
    const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());
    const r = makeSweepRegistry({
      persist: (s) => {
        writes.push(c.query(
          "select public.fn_sweep_heartbeat($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11,$12,$13)",
          ["api", "pgtest", s.name, s.everyMs, s.firstRunMs, s.status, iso(s.armedAtMs), iso(s.lastRunAtMs),
            iso(s.lastOkAtMs), iso(s.lastErrorAtMs), s.lastError, s.runs, s.failures]));
      },
    });
    r.arm("pool.health", { everyMs: 1_800_000, firstRunMs: 45_000 });
    r.fail("pool.health", new Error("boom"));
    await Promise.all(writes);

    const row = (await c.query("select * from sweep_heartbeats where name = 'pool.health'")).rows[0];
    assert.ok(row, "the arm/fail pair reached the table");
    assert.equal(row.status, "failing");
    assert.equal(row.every_ms, "1800000");
    assert.equal(row.first_run_ms, "45000");
    assert.equal(row.last_error, "boom");
    assert.equal(Number(row.runs), 1);
    assert.equal(Number(row.failures), 1);
    assert.ok(row.last_run_at instanceof Date && row.last_ok_at === null);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }
});
