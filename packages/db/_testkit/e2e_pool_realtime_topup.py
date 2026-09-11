#!/usr/bin/env python3
"""E2E for real-time (intra-day) withdrawal-pool top-up RPC fn_pool_topup_today (migration 0118).

Stands up a full-migration Postgres and proves the money invariants of the never-clawback top-up:
  RAISE        — a top-up raises today's withdrawal_pool.amount_cents.
  NEVER-LOWER  — a top-up below the current amount is a no-op (greatest()); budget never clawed back.
  ENSURE-DAY   — a brand with no day row yet gets one (seeded from default), then raised.
  INVARIANT    — amount_cents stays >= paid_cents + reserved_cents (0062 hard cap) at all times.
  GATE         — a non-platform_superadmin actor is rejected (NOT_AUTHORIZED).
  AUDIT        — each applied site writes an admin_actions row (action platform.pool.realtime_topup).
  IDEMPOTENT   — re-applying the same amount keeps amount_cents unchanged.

Run: PGCLIENTENCODING=UTF8 python3 packages/db/_testkit/e2e_pool_realtime_topup.py  (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid, json
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="poolrt_test")
MIG  = os.path.join(os.path.dirname(__file__), "..", "migrations")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"
ACTOR  = str(uuid.uuid4())
PS = "platform_superadmin"

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def expect_error(cur, sql, args, code, name):
    try:
        cur.execute(sql, args); cur.connection.rollback(); check(name, False, "no error")
    except Exception as e:
        cur.connection.rollback(); check(name, code.lower() in str(e).lower(), f"got {str(e).strip()[:80]}")

def migrate():
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres")
    admin.set_client_encoding("UTF8"); admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='poolrt_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists poolrt_test"); c.execute("create database poolrt_test")
    admin.close()
    conn = psycopg2.connect(**DSN); conn.set_client_encoding("UTF8"); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(MIG, "0[0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

def topup(cur, grants):
    cur.execute("select public.fn_pool_topup_today(%s,%s,%s::jsonb)", [ACTOR, PS, json.dumps(grants)])
    return cur.fetchone()[0]

def amount_today(cur, site):
    r = q1(cur, "select amount_cents, paid_cents, reserved_cents from withdrawal_pool where site_id=%s and trade_day=public.fn_eat_day()", [site])
    return r

def main():
    conn = migrate(); conn.autocommit = True; cur = conn.cursor()

    # Two active pool-mode brands. Site A exists; create Site B via the platform RPC.
    site_b = q1(cur, "select fn_platform_create_site(%s,%s,'brandb','Brand B','KES','brandb.example')", [ACTOR, PS])[0]
    cur.execute("update sites set pool_mode=true, default_daily_pool_cents=100000 where id in (%s,%s)", [SITE_A, site_b])

    print("\n== ENSURE-DAY + RAISE ==")
    # No day rows yet. Top up A to 300000, B to 150000.
    res = topup(cur, [{"site_id": SITE_A, "amount_cents": 300000}, {"site_id": site_b, "amount_cents": 150000}])
    a = amount_today(cur, SITE_A); b = amount_today(cur, site_b)
    check("A day row created + raised to 300000", a is not None and a[0] == 300000, f"{a}")
    check("B day row created + raised to 150000", b is not None and b[0] == 150000, f"{b}")
    check("RPC reports 2 sites applied", res.get("sites") == 2, f"{res}")

    print("\n== NEVER-LOWER (greatest) ==")
    topup(cur, [{"site_id": SITE_A, "amount_cents": 50000}])   # below current 300000
    a2 = amount_today(cur, SITE_A)
    check("A stays at 300000 (a lower top-up never claws back)", a2[0] == 300000, f"{a2}")

    print("\n== RAISE FURTHER ==")
    topup(cur, [{"site_id": SITE_A, "amount_cents": 400000}])
    check("A raised to 400000", amount_today(cur, SITE_A)[0] == 400000)

    print("\n== INVARIANT vs paid/reserved ==")
    # Simulate consumed budget: reserve+commit against A's day, then a lower top-up must not breach cap.
    cur.execute("update withdrawal_pool set paid_cents=100000, reserved_cents=50000 where site_id=%s and trade_day=public.fn_eat_day()", [SITE_A])
    topup(cur, [{"site_id": SITE_A, "amount_cents": 120000}])   # < paid+reserved(150000) and < current(400000)
    a3 = amount_today(cur, SITE_A)
    check("amount_cents >= paid+reserved still holds (never lowered)", a3[0] >= a3[1] + a3[2] and a3[0] == 400000, f"{a3}")

    print("\n== IDEMPOTENT ==")
    topup(cur, [{"site_id": site_b, "amount_cents": 150000}])   # same as current
    check("B unchanged at 150000 on same-amount re-apply", amount_today(cur, site_b)[0] == 150000)

    print("\n== GATE ==")
    for role in ("admin", "superadmin", "marketer"):
        expect_error(cur, "select public.fn_pool_topup_today(%s,%s,%s::jsonb)",
                     [ACTOR, role, '[{"site_id":"%s","amount_cents":1}]' % SITE_A], "NOT_AUTHORIZED", f"rejected for {role}")

    print("\n== AUDIT ==")
    n = q1(cur, "select count(*) from admin_actions where action='platform.pool.realtime_topup'")[0]
    check("realtime_topup audited (>=5 applied rows)", n >= 5, f"count={n}")

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL POOL-REALTIME-TOPUP E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
