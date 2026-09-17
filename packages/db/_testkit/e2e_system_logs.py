#!/usr/bin/env python3
"""e2e for the system_logs store + retention (migration 0128, BUGLOG #33).

Resets a local Postgres, applies shim + ALL migrations, then verifies the exact query the owner-only
System logs UI runs (PgAdminRepository.listSystemLogs) + the retention prune (fn_prune_system_logs):
  - newest-first ordering + keyset cursor;
  - level / status / requestId / since / text (msg|path) filters;
  - prune deletes only rows older than keep_days.

Run: python3 packages/db/_testkit/e2e_system_logs.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, json
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_syslogs_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def reset_and_migrate():
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname=%s and pid<>pg_backend_pid()", [DSN["dbname"]])
        c.execute(f"drop database if exists {DSN['dbname']}"); c.execute(f"create database {DSN['dbname']}")
    admin.close()
    conn = psycopg2.connect(**DSN); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9]*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

# The listSystemLogs query, verbatim from PgAdminRepository.listSystemLogs.
LIST = """select id, t, level, msg, request_id, method, path, status, duration_ms, ip, user_id, role, site_id, fields, app
  from system_logs
 where (%(cur_t)s::timestamptz is null or (t, id) < (%(cur_t)s::timestamptz, %(cur_id)s::bigint))
   and (%(level)s::text is null or level = %(level)s)
   and (%(status)s::int  is null or status = %(status)s)
   and (%(req)s::text is null or request_id = %(req)s)
   and (%(since)s::timestamptz is null or t >= %(since)s)
   and (%(q)s::text is null or (msg ilike '%%'||%(q)s||'%%' or path ilike '%%'||%(q)s||'%%'))
   and (%(app)s::text is null or app = %(app)s)
 order by t desc, id desc
 limit %(limit)s"""
def q(cur, **kw):
    p = dict(cur_t=None, cur_id=None, level=None, status=None, req=None, since=None, q=None, app=None, limit=100); p.update(kw)
    cur.execute(LIST, p); return cur.fetchall()

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()
    ins = ("insert into system_logs(t, app, level, msg, request_id, method, path, status, duration_ms, ip, user_id, role, site_id, fields) "
           "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)")
    # 3 fresh rows (newest last) + 1 old row (45 days ago). r3 is an engine line; the rest are API.
    cur.execute(ins, ["2026-09-17T10:00:00Z","api","info","request","r1","GET","/api/v1/wallet",200,12,"1.1.1.1","u1","player","siteA",json.dumps({"module":"http"})])
    cur.execute(ins, ["2026-09-17T10:01:00Z","api","warn","request rejected","r2","POST","/api/v1/withdrawals",402,8,"1.1.1.2","u2","player","siteA",json.dumps({"code":"INSUFFICIENT_FUNDS"})])
    cur.execute(ins, ["2026-09-17T10:02:00Z","engine","error","request failed","r3","POST","/api/v1/admin/withdrawals/x/approve",500,30,"1.1.1.3","adm","admin","siteB",json.dumps({"err":{"message":"boom"}})])
    cur.execute(ins, ["2026-08-03T10:00:00Z","api","error","old failure","r0","GET","/api/v1/x",500,1,"1.1.1.9","u0","player","siteA",json.dumps({})])

    print("\n== newest-first ordering ==")
    rows = q(cur)
    check("returns all 4, newest first", [r[4] for r in rows] == ["r3","r2","r1","r0"], f"{[r[4] for r in rows]}")

    print("\n== filters ==")
    check("level=error -> r3,r0", [r[4] for r in q(cur, level="error")] == ["r3","r0"])
    check("status=402 -> r2", [r[4] for r in q(cur, status=402)] == ["r2"])
    check("requestId=r2 -> r2", [r[4] for r in q(cur, req="r2")] == ["r2"])
    check("q='withdrawals' (path) -> r3,r2", [r[4] for r in q(cur, q="withdrawals")] == ["r3","r2"])
    check("q='failed' (msg) -> r3", [r[4] for r in q(cur, q="failed")] == ["r3"])
    check("since 2026-09-17 -> the 3 fresh", [r[4] for r in q(cur, since="2026-09-17T00:00:00Z")] == ["r3","r2","r1"])
    check("app=engine -> only r3", [r[4] for r in q(cur, app="engine")] == ["r3"])
    check("app=api -> r2,r1,r0 (excludes the engine line)", [r[4] for r in q(cur, app="api")] == ["r2","r1","r0"])

    print("\n== keyset cursor: page size 2 then next ==")
    p1 = q(cur, limit=2)
    check("page1 = r3,r2", [r[4] for r in p1] == ["r3","r2"])
    last = p1[-1]  # (id, t, ...)
    p2 = q(cur, cur_t=last[1], cur_id=last[0], limit=2)
    check("page2 = r1,r0", [r[4] for r in p2] == ["r1","r0"])

    print("\n== retention prune (keep 30 days) deletes only the old row ==")
    cur.execute("select public.fn_prune_system_logs(30) as n"); pruned = cur.fetchone()[0]
    remaining = [r[4] for r in q(cur)]
    check("prune removed exactly 1 (the 45-day-old row)", pruned == 1, f"pruned={pruned}")
    check("fresh rows remain, old gone", remaining == ["r3","r2","r1"], f"{remaining}")

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL: print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL SYSTEM-LOGS DB E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
