#!/usr/bin/env python3
"""E2E: POOL-1 (docs/46, migration 0164) — per-brand pool overview + automatic distribution ON by default.

BEFORE (0001..0163) nothing listed each brand's pool for today (budget / paid / reserved / available), there
was no stored automatic-distribution setting (the daily run only happened if a GitHub variable was set), and
a demand-based run was indistinguishable from a manual per-brand edit in the history.
AFTER (0164): fn_pool_overview (scoped: platform admin = own platform; owner = one or all), per-platform
auto settings that default to 'dynamic', validated + audited; a run recorder; a `source` on distributions.
Run: python3 packages/db/_testkit/e2e_pool_overview.py   (needs local PG on /tmp:5433)
"""
import os, glob, uuid
import psycopg2

HERE = os.path.dirname(__file__)
MIG = os.path.join(HERE, "..", "migrations")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
DB = "pool1_test"
SYS = "platform_superadmin"
PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def build(upto):
    a = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); a.autocommit = True
    with a.cursor() as c:
        c.execute(f"select pg_terminate_backend(pid) from pg_stat_activity where datname='{DB}' and pid<>pg_backend_pid()")
        c.execute(f"drop database if exists {DB}"); c.execute(f"create database {DB}")
    a.close()
    conn = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname=DB); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(MIG, "[0-9][0-9][0-9][0-9]_*.sql"))):
            if os.path.basename(f)[:4] <= upto:
                c.execute(open(f, encoding="utf-8").read())
    return conn

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def err(cur, sql, args):
    try:
        cur.execute(sql, args); return "ok"
    except psycopg2.Error as e:
        return str(e).split("\n")[0]

def scenario(upto, fixed):
    conn = build(upto); cur = conn.cursor()
    ACTOR = str(uuid.uuid4())
    p1 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "alpha", "Alpha"])[0]
    p2 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "beta", "Beta"])[0]
    for pid in (p1, p2):
        q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [ACTOR, SYS, pid, "enterprise"])
    a1 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "a1site", "A1"])[0]
    a2 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "a2site", "A2"])[0]
    b1 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "b1site", "B1"])[0]
    for s, p in ((a1, p1), (a2, p1), (b1, p2)):
        q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, s, p])
    cur.execute("select user_id from fn_register_user('254700000021','pa1',%s,null,%s)", ["x" * 32, a1]); pa1 = cur.fetchone()[0]
    q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [ACTOR, SYS, pa1, p1])
    cur.execute("select user_id from fn_register_user('254700000022','player',%s,null,%s)", ["x" * 32, a1]); pl = cur.fetchone()[0]
    q1(cur, "select fn_platform_distribute_pool_scoped(%s,%s,%s,%s,%s,%s)", [pa1, "platform_admin", p1, 100000, "equal", None])
    # today's pool for a1 with some paid/reserved
    cur.execute("select fn_pool_ensure_day(%s, fn_eat_day(now()))", [a1])
    cur.execute("update withdrawal_pool set amount_cents=50000, paid_cents=20000, reserved_cents=5000 where site_id=%s", [a1])
    cur.execute("insert into transactions(user_id, kind, amount, status, provider, phone, site_id) values (%s,'withdrawal',3000,'pending','mpesa','0700000022',%s)", [pl, a1])

    r = err(cur, "select * from fn_pool_overview(%s,'platform_admin',%s)", [pa1, p1])
    if not fixed:
        check("BUG REPRODUCED: there is no per-brand pool overview", r != "ok", r)
        check("BUG REPRODUCED: no stored automatic-distribution setting", err(cur, "select 1 from pool_auto_settings", []) != "ok")
        conn.close(); return
    check("a platform admin gets its platform's overview", r == "ok", r)
    cur.execute("select slug, default_cents, today_cents, paid_cents, reserved_cents, available_cents, today_set, pending_count, pending_cents from fn_pool_overview(%s,'platform_admin',%s) order by slug", [pa1, p1])
    rows = {x[0]: x[1:] for x in cur.fetchall()}
    check("...with every active brand of that platform, and no other", set(rows) == {"a1site", "a2site"}, str(rows.keys()))
    check("today's budget / paid / reserved / available are exact", rows["a1site"][:6] == (50000, 50000, 20000, 5000, 25000, True), str(rows["a1site"]))
    check("a brand whose day hasn't started shows its default as today's budget", rows["a2site"][:6] == (50000, 50000, 0, 0, 50000, False), str(rows["a2site"]))
    check("pending withdrawals are counted per brand", rows["a1site"][6:] == (1, 3000), str(rows["a1site"]))
    check("a platform admin cannot read another platform", "PLATFORM_SCOPE_FORBIDDEN" in err(cur, "select * from fn_pool_overview(%s,'platform_admin',%s)", [pa1, p2]))
    check("a platform admin cannot ask for every platform", "PLATFORM_SCOPE_FORBIDDEN" in err(cur, "select * from fn_pool_overview(%s,'platform_admin',null)", [pa1]))
    cur.execute("select count(*) from fn_pool_overview(%s,%s,null)", [ACTOR, SYS])
    check("the System owner can see every platform at once", cur.fetchone()[0] >= 3)
    check("a brand admin is refused", "NOT_AUTHORIZED" in err(cur, "select * from fn_pool_overview(%s,'admin',%s)", [pa1, p1]))
    # auto settings
    cur.execute("select mode, is_default, daily_total_cents from fn_pool_auto_settings_get(%s,'platform_admin',%s)", [pa1, p1])
    check("with nothing saved, automatic distribution is DYNAMIC by default", cur.fetchone() == ("dynamic", True, None))
    check("equal split needs a daily total", "TOTAL_REQUIRED" in err(cur, "select fn_pool_auto_settings_set(%s,'platform_admin',%s,'equal',null,14)", [pa1, p1]))
    check("an unknown mode is refused", "INVALID_MODE" in err(cur, "select fn_pool_auto_settings_set(%s,'platform_admin',%s,'random',null,14)", [pa1, p1]))
    check("a silly look-back is refused", "INVALID_LOOKBACK" in err(cur, "select fn_pool_auto_settings_set(%s,'platform_admin',%s,'dynamic',null,1)", [pa1, p1]))
    check("a platform admin saves its own settings", err(cur, "select fn_pool_auto_settings_set(%s,'platform_admin',%s,'dynamic',200000,21)", [pa1, p1]) == "ok")
    cur.execute("select mode, is_default, daily_total_cents, lookback_days from fn_pool_auto_settings_get(%s,'platform_admin',%s)", [pa1, p1])
    check("...and reads them back", cur.fetchone() == ("dynamic", False, 200000, 21))
    check("...but not another platform's", "PLATFORM_SCOPE_FORBIDDEN" in err(cur, "select fn_pool_auto_settings_set(%s,'platform_admin',%s,'off',null,14)", [pa1, p2]))
    cur.execute("select count(*) from admin_actions where action='pool.auto_settings'")
    check("settings changes are audited", cur.fetchone()[0] == 1)
    cur.execute("select fn_pool_auto_record_run(%s, true, 'Split KES 2,000 across 2 brands')", [p2])
    cur.execute("select mode, last_run_ok, last_run_message from fn_pool_auto_settings_get(%s,%s,%s)", [ACTOR, SYS, p2])
    check("recording a run keeps the default mode and stores the outcome", cur.fetchone() == ("dynamic", True, "Split KES 2,000 across 2 brands"))
    cur.execute("select is_default from fn_pool_auto_settings_get(%s,%s,%s)", [ACTOR, SYS, p2])
    check("...and it is still shown as the default (nobody chose it)", cur.fetchone()[0] is True)
    cur.execute("select source from platform_pool_distributions order by created_at desc limit 1")
    check("existing distributions are labelled manual", cur.fetchone()[0] == "manual")
    check("a distribution source must be one of manual/dynamic/auto", "violates check" in err(cur, "update platform_pool_distributions set source='x'", []))
    cur.execute("""select bool_or(has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
                   from pg_proc p where proname in ('fn_pool_overview','fn_pool_auto_settings_get','fn_pool_auto_settings_set','fn_pool_auto_record_run','fn_pool_scope_assert')""")
    check("none of the new functions is executable by anon/authenticated", cur.fetchone()[0] is False)
    conn.close()

print("BEFORE (0001..0163):"); scenario("0163", False)
print("AFTER (0001..0164):"); scenario("9999", True)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
raise SystemExit(1 if FAIL else 0)
