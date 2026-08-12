#!/usr/bin/env python3
"""Aggressive e2e for the platform-superadmin console RPCs (docs/22 Task H).

Resets a local Postgres, applies the shim + ALL migrations (incl. 0052), then exercises the
fn_platform_* + override RPCs adversarially:
  GATE       every platform RPC rejects a non-platform role (admin/superadmin/marketer).
  ONBOARD    create a brand -> site + a default (feasible) economy; slug is unique; blanks rejected.
  TUNE       edit branding + economy; an INFEASIBLE economy is rejected by the DB CHECK.
  KPIs       fn_platform_overview reports correct per-brand numbers, isolated between brands.
  OVERRIDE   fn_admin_set_user_overrides stamps the target's brand and accepts platform_superadmin.

Run: python3 packages/db/_testkit/e2e_platform_console.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
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

def expect_error(cur, sql, args, code_substr, name):
    try:
        cur.execute(sql, args); cur.connection.rollback(); check(name, False, "no error raised")
    except Exception as e:
        cur.connection.rollback(); check(name, code_substr.lower() in str(e).lower(), f"got: {str(e).strip()[:90]}")

def reset_and_migrate():
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='invest254_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists invest254_test"); c.execute("create database invest254_test")
    admin.close()
    conn = psycopg2.connect(**DSN); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "00*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

def loss(cur, user, stake, gd, site):
    pos = q1(cur, "select position_id from fn_open_position(%s,%s,'buy',0.2,10,%s,1,now(),1,%s)", [user, stake, gd, site])[0]
    cur.execute("select fn_settle_position(%s,0.19,'loss',0,0)", [pos])

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()

    print("\n== GATE: platform RPCs reject non-platform roles ==")
    for role in ("admin", "superadmin", "marketer"):
        expect_error(cur, "select fn_platform_create_site(%s,%s,'x','X')", [ACTOR, role], "NOT_AUTHORIZED", f"create rejected for {role}")
    expect_error(cur, "select * from fn_platform_overview(%s)", ["superadmin"], "NOT_AUTHORIZED", "overview rejected for superadmin")

    print("\n== ONBOARD: create a brand + default economy ==")
    expect_error(cur, "select fn_platform_create_site(%s,%s,'','Blank')", [ACTOR, PS], "INVALID_BRAND", "blank slug rejected")
    site_b = q1(cur, "select fn_platform_create_site(%s,%s,'brandb','Brand B','KES','brandb.example')", [ACTOR, PS])[0]
    check("create returns a new site id", site_b is not None and site_b != SITE_A)
    cfg = q1(cur, "select house_edge, target_win_rate, min_stake, version from site_game_config where site_id=%s", [site_b])
    check("new brand seeded with default feasible economy", cfg is not None and float(cfg[0]) == 0.75 and float(cfg[1]) == 0.125, f"{cfg}")
    expect_error(cur, "select fn_platform_create_site(%s,%s,'brandb','Dup')", [ACTOR, PS], "duplicate", "duplicate slug rejected (unique)")

    print("\n== TUNE: edit branding + economy; infeasible economy blocked ==")
    row = q1(cur, "select name, color_primary, status from fn_platform_update_site(%s,%s,%s,%s)",
             [ACTOR, PS, site_b, '{"name":"Brand Bravo","color_primary":"#ff0000","status":"paused"}'])
    check("update_site persists branding + status", row == ("Brand Bravo", "#ff0000", "paused"), f"{row}")
    cfgr = q1(cur, "select min_stake, version from fn_platform_set_site_config(%s,%s,%s,%s)",
              [ACTOR, PS, site_b, '{"min_stake":50000}'])
    check("set_site_config persists + bumps version", cfgr == (50000, 2), f"{cfgr}")
    # RTP = 1 - house_edge(0.75) = 0.25; win 0.5 -> RTP/win = 0.5 < 1 -> infeasible.
    expect_error(cur, "select fn_platform_set_site_config(%s,%s,%s,%s)",
                 [ACTOR, PS, site_b, '{"target_win_rate":0.5}'], "site_cfg_feasible", "infeasible economy rejected by CHECK")

    print("\n== KPIs: per-brand overview, isolated ==")
    uA = q1(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", ["254760000001","kpiA","h"+"x"*24, SITE_A])[0]
    uB = q1(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", ["254760000001","kpiB","h"+"x"*24, site_b])[0]
    for u in (uA, uB): cur.execute("update wallets set real_balance=1000000 where user_id=%s", [u])
    for u, site, co in ((uA, SITE_A, "coA"), (uB, site_b, "coB")):
        dep = q1(cur, "select fn_create_deposit(%s,%s,%s,%s)", [u, 80000, "254760000001", site])[0]
        cur.execute("select fn_attach_stk(%s,%s,%s)", [dep, "mr", co]); cur.execute("select fn_complete_deposit(%s,0,'ok','R','{}')", [co])
    gdA = q1(cur, "insert into game_days(site_id,trade_date,server_seed_hash) values (%s,'2026-04-01','hA') returning id",[SITE_A])[0]
    gdB = q1(cur, "insert into game_days(site_id,trade_date,server_seed_hash) values (%s,'2026-04-01','hB') returning id",[site_b])[0]
    loss(cur, uA, 30000, gdA, SITE_A)
    loss(cur, uB, 60000, gdB, site_b)   # brand B min_stake was tuned up to 50000 above
    cur.execute("select site_id, users, deposits_cents, ggr_cents, bets from fn_platform_overview(%s)", [PS])
    ov = {str(r[0]): r for r in cur.fetchall()}
    b = ov.get(str(site_b)); a = ov.get(str(SITE_A))
    check("overview lists brand B with its KPIs", b is not None and b[1] >= 1 and b[2] == 80000 and b[4] == 1, f"B={b}")
    check("overview lists the default brand separately", a is not None and a[2] == 80000, f"A={a}")
    check("deposits are isolated per brand (no cross-count)", b is not None and a is not None and b[2] == 80000 and a[2] == 80000)

    print("\n== OVERRIDE: stamped with the target's brand; platform_superadmin allowed ==")
    ovrow = q1(cur, "select site_id, win_rate from fn_admin_set_user_overrides(%s,%s,%s,%s)",
               [ACTOR, PS, uB, '{"win_rate":"0.9","house_edge":"0.05"}'])
    check("override stamped with the target user's brand (B)", str(ovrow[0]) == str(site_b), f"site={ovrow[0]}")
    check("override win_rate persisted", float(ovrow[1]) == 0.9)
    expect_error(cur, "select fn_admin_set_user_overrides(%s,%s,%s,%s)",
                 [ACTOR, "marketer", uA, '{"win_rate":"0.5"}'], "NOT_AUTHORIZED", "override rejected for marketer")

    print("\n== AUDIT: platform actions are recorded ==")
    n = q1(cur, "select count(*) from admin_actions where action like %s", ["platform.site.%"])[0]
    check("platform.site.* audit rows written (create+update+config)", n >= 3, f"count={n}")

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL PLATFORM-CONSOLE DB E2E SCENARIOS PASSED")

if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback; traceback.print_exc(); sys.exit(2)
