#!/usr/bin/env python3
"""Aggressive PLATFORM-tier isolation e2e (Issue 1 — migrations 0131..0134).

Stands up a local Postgres, applies the Supabase shim + ALL migrations, then proves the
System > Platform > Site tier model and its STRICT isolation, at two layers:

  GOVERNANCE (SECURITY DEFINER RPCs, as the API calls them):
    * only the system owner (platform_superadmin) can create platforms, assign sites, appoint
      platform admins, and list all platforms;
    * a platform_admin manages ONLY sites/users inside ITS platform; any cross-platform target is
      refused with PLATFORM_SCOPE_FORBIDDEN;
    * a platform_admin cannot appoint another platform_admin, and cannot be demoted by anyone but
      the system owner; the system owner is unchallengeable.

  RLS (defense-in-depth for the public anon/authenticated keys, via signed JWT claims):
    * a platform_admin (role=platform_admin, platform=P1) reads EVERY row of P1's sites and ZERO
      rows of P2;
    * a site admin still sees only its one brand; the system owner sees all; a player only its own.

Run: python3 packages/db/_testkit/e2e_platform_isolation.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
DEFAULT_SITE     = "00000000-0000-0000-0000-000000000001"
DEFAULT_PLATFORM = "10000000-0000-0000-0000-000000000001"
SYS = "platform_superadmin"

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

def ok(cur, sql, args, name):
    try:
        cur.execute(sql, args); cur.connection.commit(); check(name, True)
    except Exception as e:
        cur.connection.rollback(); check(name, False, f"unexpected error: {str(e).strip()[:90]}")

def reset_and_migrate():
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres")
    admin.set_client_encoding("UTF8"); admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='invest254_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists invest254_test"); c.execute("create database invest254_test")
    admin.close()
    conn = psycopg2.connect(**DSN); conn.set_client_encoding("UTF8"); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        # CORRECT glob: ALL migrations (the 00* glob in the older harness silently skipped 0100+).
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9][0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
        # Mirror Supabase's posture: authenticated/anon hold SELECT on public tables and RLS is the
        # operative gate (the shim omits this; without it a `set role authenticated` count hits a
        # grant error before RLS is ever evaluated). Test-harness only.
        c.execute("grant select on all tables in schema public to anon, authenticated")
    return conn

def register(cur, phone, username, site):
    cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, username, "x"*32, site])
    return q1(cur, "select id from profiles where site_id=%s and phone=%s", [site, phone])[0]

def seed_site(cur, actor, slug, name):
    """System creates a site (lands in default platform), returns its id."""
    return q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [actor, SYS, slug, name])[0]

def count_as(conn, role, sub, site, platform, table):
    """Rows visible from `table` for an `authenticated` session with the given claims."""
    with conn.cursor() as cur:
        cur.execute("begin"); cur.execute("set local role authenticated")
        cur.execute("select set_config('request.jwt.claim.sub', %s, true)", [sub])
        cur.execute("select set_config('request.jwt.claim.site', %s, true)", [site or ""])
        cur.execute("select set_config('request.jwt.claim.role', %s, true)", [role])
        cur.execute("select set_config('request.jwt.claim.platform', %s, true)", [platform or ""])
        cur.execute(f"select count(*) from public.{table}")
        n = cur.fetchone()[0]
        cur.execute("reset role"); cur.execute("rollback")
        return n

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()
    ACTOR = str(uuid.uuid4())  # a synthetic system-owner uuid for audit stamping

    print("\n== Setup: two platforms, three sites, players, admins ==")
    p1 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "alpha", "Alpha Platform"])[0]
    p2 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "beta",  "Beta Platform"])[0]
    check("system created two platforms", p1 != p2)
    # This suite tests ISOLATION, not billing: put both platforms on Enterprise/active so the
    # subscription site/user quotas (migration 0138) don't constrain the multi-site fixtures.
    for pid in (p1, p2):
        q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [ACTOR, SYS, pid, "enterprise"])
        q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [ACTOR, SYS, pid, "active", "test"])

    a1 = seed_site(cur, ACTOR, "a1site", "A1"); a2 = seed_site(cur, ACTOR, "a2site", "A2"); b1 = seed_site(cur, ACTOR, "b1site", "B1")
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, a1, p1])
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, a2, p1])
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, b1, p2])
    got = {r[0]: str(r[1]) for r in [q1(cur,"select id, platform_id from sites where id=%s",[s]) for s in (a1,a2,b1)]}
    check("sites assigned to correct platforms", got[a1]==p1 and got[a2]==p1 and got[b1]==p2, str(got))

    # players
    plA1 = register(cur, "254700000011", "plA1", a1)
    plA2 = register(cur, "254700000012", "plA2", a2)
    plB1 = register(cur, "254700000013", "plB1", b1)
    for u, ph, s in [(plA1,"254700000011",a1),(plA2,"254700000012",a2),(plB1,"254700000013",b1)]:
        cur.execute("insert into transactions(user_id, kind, amount, phone, site_id, status) values (%s,'deposit',10000,%s,%s,'success')", [u, ph, s])

    # platform admins: register on a home site, then appoint
    pa1 = register(cur, "254700000021", "pa1user", a1)
    pa2 = register(cur, "254700000022", "pa2user", b1)
    q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [ACTOR, SYS, pa1, p1])
    q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [ACTOR, SYS, pa2, p2])
    r = q1(cur, "select role, platform_id from profiles where id=%s", [pa1])
    check("appoint platform_admin sets role+platform", r[0]=="platform_admin" and str(r[1])==p1, str(r))

    # a site admin on A1 (system elevates a fresh player to admin)
    saA1 = register(cur, "254700000031", "saA1", a1)
    q1(cur, "select * from fn_admin_set_user_role(%s,%s,%s,%s)", [ACTOR, SYS, saA1, "admin"])
    check("system minted a site admin on A1", q1(cur,"select role from profiles where id=%s",[saA1])[0]=="admin")

    print("\n== Governance: only SYSTEM can do platform-level ops ==")
    expect_error(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [pa1, "platform_admin", "gamma", "Gamma"], "NOT_AUTHORIZED", "platform_admin cannot create a platform")
    expect_error(cur, "select fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [pa1, "platform_admin", plA1, p1], "NOT_AUTHORIZED", "platform_admin cannot appoint a platform_admin")
    expect_error(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [plA1, "player", "gamma", "Gamma"], "NOT_AUTHORIZED", "player cannot create a platform")
    expect_error(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [pa1, "platform_admin", b1, p1], "NOT_AUTHORIZED", "platform_admin cannot reassign sites (system-only)")

    print("\n== Overview scoping ==")
    cur.execute("select platform_id, sites from fn_platforms_overview(%s) where platform_id in (%s,%s)", [SYS, p1, p2])
    ov = {str(r[0]): r[1] for r in cur.fetchall()}
    check("system all-platforms overview counts sites per platform", ov.get(p1)==2 and ov.get(p2)==1, str(ov))
    cur.execute("select site_id from fn_platform_overview(%s,%s)", [pa1, "platform_admin"]); pa1_sites={str(r[0]) for r in cur.fetchall()}
    check("platform_admin overview shows ONLY its platform's sites", pa1_sites=={a1,a2}, str(pa1_sites))
    cur.execute("select site_id from fn_platform_overview(%s,%s)", [pa2, "platform_admin"]); pa2_sites={str(r[0]) for r in cur.fetchall()}
    check("platform_admin P2 overview shows only B1", pa2_sites=={b1}, str(pa2_sites))
    cur.execute("select count(*) from fn_platform_overview(%s,%s)", [ACTOR, SYS]); alln=cur.fetchone()[0]
    check("system 2-arg overview shows all sites", alln>=4, f"n={alln}")

    print("\n== Platform_admin site management is platform-bounded ==")
    ok(cur, "select fn_platform_update_site(%s,%s,%s,%s)", [pa1,"platform_admin",a1,'{"name":"A1x"}'], "PA1 edits its own site A1")
    ok(cur, "select fn_platform_set_site_config(%s,%s,%s,%s)", [pa1,"platform_admin",a2,'{"min_stake":30000}'], "PA1 tunes its own site A2 economy")
    expect_error(cur, "select fn_platform_update_site(%s,%s,%s,%s)", [pa1,"platform_admin",b1,'{"name":"hax"}'], "PLATFORM_SCOPE_FORBIDDEN", "PA1 CANNOT edit P2's site B1")
    expect_error(cur, "select fn_platform_set_site_config(%s,%s,%s,%s)", [pa1,"platform_admin",b1,'{"min_stake":30000}'], "PLATFORM_SCOPE_FORBIDDEN", "PA1 CANNOT tune P2's site config")
    newsite = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [pa1,"platform_admin","a3site","A3"])[0]
    check("PA1-created site is stamped into P1", str(q1(cur,"select platform_id from sites where id=%s",[newsite])[0])==p1)

    print("\n== Platform_admin user management is platform-bounded ==")
    ok(cur, "select * from fn_admin_set_user_role(%s,%s,%s,%s)", [pa1,"platform_admin",plA1,"marketer"], "PA1 manages a P1 user (player->marketer)")
    ok(cur, "select * from fn_admin_set_user_status(%s,%s,%s,%s,%s)", [pa1,"platform_admin",plA2,"suspended","t"], "PA1 suspends a P1 user")
    expect_error(cur, "select * from fn_admin_set_user_role(%s,%s,%s,%s)", [pa1,"platform_admin",plB1,"marketer"], "PLATFORM_SCOPE_FORBIDDEN", "PA1 CANNOT manage a P2 user's role")
    expect_error(cur, "select * from fn_admin_set_user_status(%s,%s,%s,%s,%s)", [pa1,"platform_admin",plB1,"banned","t"], "PLATFORM_SCOPE_FORBIDDEN", "PA1 CANNOT change a P2 user's status")
    ok(cur, "select * from fn_admin_set_user_role(%s,%s,%s,%s)", [pa1,"platform_admin",saA1,"marketer"], "PA1 can manage a site admin in its platform")

    print("\n== Money/PII levers are platform-bounded (Issue 1 final scope) ==")
    ok(cur, "select * from fn_admin_adjust_balance(%s,%s,%s,%s,%s)", [pa1,"platform_admin",plA1,1000,"topup"], "PA1 adjusts a P1 player's balance")
    ok(cur, "select * from fn_admin_adjust_balance_kind(%s,%s,%s,%s,%s,%s)", [pa1,"platform_admin",plA1,500,"bonus","promo"], "PA1 adjusts a P1 player's bonus balance")
    ok(cur, "select * from fn_admin_set_user_overrides(%s,%s,%s,%s)", [pa1,"platform_admin",plA1,'{"win_rate":"0.1"}'], "PA1 sets a P1 player's (punitive) override")
    expect_error(cur, "select * from fn_admin_adjust_balance(%s,%s,%s,%s,%s)", [pa1,"platform_admin",plB1,1000,"topup"], "PLATFORM_SCOPE_FORBIDDEN", "PA1 CANNOT adjust a P2 player's balance")
    expect_error(cur, "select * from fn_admin_adjust_balance_kind(%s,%s,%s,%s,%s,%s)", [pa1,"platform_admin",plB1,500,"bonus","x"], "PLATFORM_SCOPE_FORBIDDEN", "PA1 CANNOT adjust a P2 player's bonus")
    expect_error(cur, "select * from fn_admin_set_user_overrides(%s,%s,%s,%s)", [pa1,"platform_admin",plB1,'{"win_rate":"0.1"}'], "PLATFORM_SCOPE_FORBIDDEN", "PA1 CANNOT override a P2 player")
    expect_error(cur, "select * from fn_admin_set_user_overrides(%s,%s,%s,%s)", [pa1,"platform_admin",plA1,'{"house_edge":"0.01"}'], "OVERRIDE_FAVORS_PLAYER", "favors-player guard still enforced for PA1")

    print("\n== Protections ==")
    expect_error(cur, "select * from fn_admin_set_user_role(%s,%s,%s,%s)", [ACTOR,SYS,pa1,"player"], "PLATFORM_ADMIN_PROTECTED", "platform_admin cannot be demoted via generic role RPC")
    ok(cur, "select * from fn_platform_revoke_platform_admin(%s,%s,%s,%s)", [ACTOR,SYS,pa2,"admin"], "system revokes a platform_admin via dedicated RPC")
    check("revoke cleared platform_id + set role", q1(cur,"select role, platform_id from profiles where id=%s",[pa2])==("admin",None))
    # a site admin cannot mint an admin
    expect_error(cur, "select * from fn_admin_set_user_role(%s,%s,%s,%s)", [saA1,"admin",plA2,"admin"], "NOT_AUTHORIZED", "site admin cannot mint a site admin")

    print("\n== RLS defense-in-depth (authenticated + signed claims) ==")
    real_p1 = q1(cur, "select count(*) from profiles p join sites s on s.id=p.site_id where s.platform_id=%s", [p1])[0]
    real_p2 = q1(cur, "select count(*) from profiles p join sites s on s.id=p.site_id where s.platform_id=%s", [p2])[0]
    seen_p1_prof = count_as(conn, "platform_admin", pa1, a1, p1, "profiles")
    check("platform_admin sees ALL its platform's profiles", seen_p1_prof==real_p1, f"seen={seen_p1_prof} real={real_p1}")
    # count P2 rows visible to PA1: filter by joining—use a scoped count via a temp: easier assert total==P1 only
    total_prof = q1(cur, "select count(*) from profiles")[0]
    check("platform_admin sees ZERO rows outside its platform (profiles)", seen_p1_prof==real_p1 and real_p1 < total_prof, f"seen={seen_p1_prof} total={total_prof}")
    seen_p1_tx = count_as(conn, "platform_admin", pa1, a1, p1, "transactions")
    real_tx_p1 = q1(cur, "select count(*) from transactions t join sites s on s.id=t.site_id where s.platform_id=%s",[p1])[0]
    check("platform_admin sees ALL its platform's transactions and no others", seen_p1_tx==real_tx_p1, f"seen={seen_p1_tx} real={real_tx_p1}")

    # site admin (role=admin, site=A1): only A1 profiles
    a1_prof = q1(cur, "select count(*) from profiles where site_id=%s", [a1])[0]
    seen_sa = count_as(conn, "admin", saA1, a1, p1, "profiles")
    check("site admin sees only its OWN site's profiles", seen_sa==a1_prof, f"seen={seen_sa} a1={a1_prof}")

    # system owner sees all
    seen_sys = count_as(conn, "platform_superadmin", ACTOR, DEFAULT_SITE, DEFAULT_PLATFORM, "profiles")
    check("system owner sees ALL profiles", seen_sys==total_prof, f"seen={seen_sys} total={total_prof}")

    # a player sees only its own row
    seen_player = count_as(conn, "player", plB1, b1, p2, "profiles")
    check("player sees only its own profile row", seen_player==1, f"seen={seen_player}")

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILURES:", ", ".join(FAIL)); sys.exit(1)
    print("ALL PLATFORM-TIER ISOLATION E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
