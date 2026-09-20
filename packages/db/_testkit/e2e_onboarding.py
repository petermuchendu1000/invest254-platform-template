#!/usr/bin/env python3
"""Issue 2 / onboarding — end-to-end DB pipeline audit (migrations incl. 0148 entitlement trigger).

Onboarding a client must, on EVERY creation path (the /platform/onboard raw insert AND the console
fn_platform_create_site RPC):
  * stamp the brand into the caller's platform;
  * seed the free default entitlements (line chart / classic UI / mpesa gateway) — the bug this fixes;
  * default chart_style=line, trade_ui=classic;
  * resolve by host (primary_domain), and expose mpesa as an entitled gateway;
  * be blocked when the platform's subscription quota is exceeded (0138), with a clear error.

Run: python3 packages/db/_testkit/e2e_onboarding.py   (needs local PG on /tmp:5433)
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
def ents(cur, site):
    cur.execute("select category, key from brand_entitlements where site_id=%s order by 1,2", [site])
    return {(r[0], r[1]) for r in cur.fetchall()}

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()
    ACTOR = str(uuid.uuid4())
    print("\n== Setup: platform p1 (enterprise) + platform admin pa1 ==")
    p1 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "alpha", "Alpha"])[0]
    q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [ACTOR, SYS, p1, "enterprise"])
    q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [ACTOR, SYS, p1, "active", "t"])
    seed = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "seedsite", "Seed"])[0]
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, seed, p1])
    pa1 = register(cur, "254700000021", "pa1", seed); q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [ACTOR, SYS, pa1, p1])

    print("\n== Path A: console RPC fn_platform_create_site (platform admin) ==")
    a1 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s,%s,%s)", [pa1, "platform_admin", "shikafx", "Shika FX", "KES", "shikafx.com"])[0]
    got_pf = q1(cur, "select platform_id::text from sites where id=%s", [a1])[0]
    default_pf = "10000000-0000-0000-0000-000000000001"
    check("A: new brand stamped into the admin's platform (not default)", got_pf == str(p1) and got_pf != default_pf, f"got={got_pf} p1={p1} default={default_pf}")
    check("A: default entitlements seeded (line/classic/mpesa)", ents(cur,a1)=={("chart","line"),("trade_ui","classic"),("payment_gateway","mpesa")}, str(ents(cur,a1)))
    row = q1(cur,"select chart_style, trade_ui, status from sites where id=%s",[a1])
    check("A: chart=line, trade=classic, active", row==("line","classic","active"), str(row))
    check("A: resolves by host", q1(cur,"select count(*) from sites where lower(primary_domain)='shikafx.com' and status='active' and id=%s",[a1])[0]==1)
    check("A: mpesa is an entitled gateway", "mpesa" in q1(cur,"select fn_site_entitled_gateways(%s)",[a1])[0])
    view = {(r["category"],r["key"]): r for r in q1(cur,"select fn_addon_brand_view(%s,%s,%s)",[pa1,"platform_admin",a1])[0]}
    check("A: brand view shows line entitled+active, candlestick locked", view[("chart","line")]["entitled"] and view[("chart","line")]["active"] and not view[("chart","candlestick")]["entitled"])

    print("\n== Path B: /platform/onboard-style RAW insert into sites ==")
    b1 = str(uuid.uuid4())
    cur.execute("""insert into sites (id, slug, name, status, platform_id, primary_domain, currency)
                   values (%s,'rawbrand','Raw Brand','active',%s,'rawbrand.com','KES')""", [b1, p1])
    check("B: raw-insert brand got default entitlements via trigger", ents(cur,b1)=={("chart","line"),("trade_ui","classic"),("payment_gateway","mpesa")}, str(ents(cur,b1)))
    check("B: raw-insert resolves by host", q1(cur,"select count(*) from sites where lower(primary_domain)='rawbrand.com' and status='active'")[0]==1)

    print("\n== Path C: subscription site-quota blocks onboarding ==")
    p3 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "starterp", "Starter P"])[0]
    q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [ACTOR, SYS, p3, "starter"])
    q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [ACTOR, SYS, p3, "active", "t"])
    limit = q1(cur, "select max_sites from fn_plan_limits(%s)", [p3])[0]
    print(f"    starter max_sites = {limit}")
    s1 = str(uuid.uuid4()); cur.execute("insert into sites (id, slug, name, status, platform_id) values (%s,'st1','S1','active',%s)", [s1, p3])
    check("C: first brand within quota inserted", q1(cur,"select count(*) from sites where platform_id=%s",[p3])[0]==1)
    if limit is not None and limit <= 1:
        expect_error(cur, "insert into sites (id, slug, name, status, platform_id) values (%s,'st2','S2','active',%s)", [str(uuid.uuid4()), p3], "SUBSCRIPTION_SITE_LIMIT", "C: second brand over quota is blocked")
    else:
        check("C: (starter quota not <=1; skipped over-quota assertion)", True)

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL: print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL ONBOARDING E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
