#!/usr/bin/env python3
"""Issue 1 #4 — platform-scoped withdrawal-pool distribution isolation (migration 0143).

Proves fn_platform_distribute_pool_scoped:
  * a platform_admin distributes ONLY across the ACTIVE sites in ITS platform (others untouched);
  * per_site overrides naming a site outside the platform are refused (PLATFORM_SCOPE_FORBIDDEN);
  * a platform_admin targeting another platform is refused;
  * the system owner may target any platform;
  * the distribution audit row carries platform_id;
  * it does NOT clobber the GLOBAL platform_global_config total (system-owner's field);
  * site admin / player are NOT_AUTHORIZED.

Run: python3 packages/db/_testkit/e2e_platform_pool.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SYS  = "platform_superadmin"
PASS, FAIL = [], []
def check(n, c, d=""):
    (PASS if c else FAIL).append(n); print(f"  [{'PASS' if c else 'FAIL'}] {n}" + (f"  -- {d}" if d and not c else ""))
def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()
def expect_error(cur, sql, args, sub, name):
    try:
        cur.execute(sql, args); cur.connection.rollback(); check(name, False, "no error raised")
    except Exception as e:
        cur.connection.rollback(); check(name, sub.lower() in str(e).lower(), f"got: {str(e).strip()[:90]}")
def reset_and_migrate():
    a = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); a.set_client_encoding("UTF8"); a.autocommit = True
    with a.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='invest254_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists invest254_test"); c.execute("create database invest254_test")
    a.close()
    conn = psycopg2.connect(**DSN); conn.set_client_encoding("UTF8"); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9][0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn
def register(cur, phone, username, site):
    cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, username, "x"*32, site])
    return q1(cur, "select id from profiles where site_id=%s and phone=%s", [site, phone])[0]
def pool(cur, site):
    return q1(cur, "select default_daily_pool_cents from sites where id=%s", [site])[0]

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()
    ACTOR = str(uuid.uuid4())
    print("\n== Setup: p1 (2 sites) + p2 (1 site), platform admins, a site admin ==")
    p1 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "alpha", "Alpha"])[0]
    p2 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "beta",  "Beta"])[0]
    for pid in (p1, p2):
        q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [ACTOR, SYS, pid, "enterprise"])
        q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [ACTOR, SYS, pid, "active", "t"])
    a1 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "a1site", "A1"])[0]
    a2 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "a2site", "A2"])[0]
    b1 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "b1site", "B1"])[0]
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, a1, p1])
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, a2, p1])
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, b1, p2])
    pa1 = register(cur, "254700000021", "pa1", a1); q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [ACTOR, SYS, pa1, p1])
    saA1 = register(cur, "254700000031", "saA1", a1); q1(cur, "select * from fn_admin_set_user_role(%s,%s,%s,%s)", [ACTOR, SYS, saA1, "admin"])
    plA1 = register(cur, "254700000041", "plA1", a1)
    sysu = register(cur, "254700000051", "sysu", a1); cur.execute("update profiles set role='platform_superadmin' where id=%s", [sysu])
    glob0 = q1(cur, "select global_daily_pool_cents from platform_global_config where id")[0]

    print("\n== Platform admin distributes EQUAL across its own platform only ==")
    r = q1(cur, "select fn_platform_distribute_pool_scoped(%s,%s,%s,%s,%s,%s)", [pa1,"platform_admin",p1,100000,"equal",None])[0]
    check("equal split applied to p1's 2 sites", pool(cur,a1)==50000 and pool(cur,a2)==50000, f"a1={pool(cur,a1)} a2={pool(cur,a2)}")
    check("p2's site was NOT touched", pool(cur,b1)==0, f"b1={pool(cur,b1)}")
    check("return names the platform", str(r.get("platform_id"))==str(p1))

    print("\n== per_site overrides confined to the platform ==")
    q1(cur, "select fn_platform_distribute_pool_scoped(%s,%s,%s,%s,%s,%s::jsonb)",
       [pa1,"platform_admin",p1,None,"per_site", '{"%s": 70000}' % a2])
    check("per_site override set a2 only", pool(cur,a2)==70000 and pool(cur,a1)==50000, f"a1={pool(cur,a1)} a2={pool(cur,a2)}")
    expect_error(cur, "select fn_platform_distribute_pool_scoped(%s,%s,%s,%s,%s,%s::jsonb)",
                 [pa1,"platform_admin",p1,None,"per_site", '{"%s": 90000}' % b1], "PLATFORM_SCOPE_FORBIDDEN", "pa1 CANNOT override a p2 site")
    expect_error(cur, "select fn_platform_distribute_pool_scoped(%s,%s,%s,%s,%s,%s)",
                 [pa1,"platform_admin",p2,100000,"equal",None], "PLATFORM_SCOPE_FORBIDDEN", "pa1 CANNOT target p2")

    print("\n== Authorization matrix ==")
    expect_error(cur, "select fn_platform_distribute_pool_scoped(%s,%s,%s,%s,%s,%s)", [saA1,"admin",p1,100000,"equal",None], "NOT_AUTHORIZED", "site admin NOT_AUTHORIZED")
    expect_error(cur, "select fn_platform_distribute_pool_scoped(%s,%s,%s,%s,%s,%s)", [plA1,"player",p1,100000,"equal",None], "NOT_AUTHORIZED", "player NOT_AUTHORIZED")
    rs = q1(cur, "select fn_platform_distribute_pool_scoped(%s,%s,%s,%s,%s,%s)", [sysu,SYS,p2,40000,"equal",None])[0]
    check("system owner may distribute to any platform (p2)", pool(cur,b1)==40000, f"b1={pool(cur,b1)}")

    print("\n== Audit carries platform_id; GLOBAL total untouched ==")
    dp1 = q1(cur, "select platform_id from platform_pool_distributions where platform_id=%s order by id desc limit 1", [p1])
    check("distribution audit row carries platform_id", dp1 is not None and str(dp1[0])==str(p1))
    glob1 = q1(cur, "select global_daily_pool_cents from platform_global_config where id")[0]
    check("scoped distribution did NOT change the global total", glob0==glob1, f"{glob0} -> {glob1}")

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL: print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL PLATFORM-POOL E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
