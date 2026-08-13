#!/usr/bin/env python3
"""Aggressive RLS ADMIN-dimension e2e (docs/22 Task F — final item, migration 0056).

Resets a local Postgres, applies the shim + ALL migrations (incl. 0056), seeds two brands with
players + a per-brand admin + a platform superadmin, then logs in as the `authenticated` role
(as PostgREST/Supabase would) with different JWT `role`/`site`/`sub` claims and asserts the admin
read policies behave:

  * a SITE-scoped admin (role=admin, site=A) reads EVERY brand-A row (across users) and ZERO
    brand-B rows;
  * a PLATFORM_SUPERADMIN reads every brand's rows;
  * the admin policy NEVER leaks to a player token (a player still sees only its own rows);
  * admin-only tables (user_overrides) are brand-scoped for admins and invisible to players;
  * an admin's scope FOLLOWS its signed `site` claim (A-claim -> A only, B-claim -> B only).

Run: python3 packages/db/_testkit/e2e_rls_admin_sites.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"
ACTOR  = str(uuid.uuid4())
PS = "platform_superadmin"

# Tables the admin console reads; RLS (not the table grant) must be the gate.
TABLES = ["profiles", "wallets", "transactions", "user_overrides"]

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

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

def register(cur, phone, username, site):
    # username >= 3 chars, password hash >= 20 chars (validated by fn_register_user).
    cur.execute("select fn_register_user(%s,%s,%s,null,%s)", [phone, username, "x" * 32, site])
    return q1(cur, "select id from profiles where site_id=%s and phone=%s", [site, phone])[0]

def total(cur, table, site=None):
    """Superuser (RLS-bypassed) row count, optionally for one brand."""
    if site:
        return q1(cur, f"select count(*) from public.{table} where site_id=%s", [site])[0]
    return q1(cur, f"select count(*) from public.{table}")[0]

def count_as(conn, role, sub, site, table):
    """Rows visible from `table` for an `authenticated` session with the given role/site/uid claims."""
    with conn.cursor() as cur:
        cur.execute("begin"); cur.execute("set local role authenticated")
        cur.execute("select set_config('request.jwt.claim.sub', %s, true)", [sub])
        cur.execute("select set_config('request.jwt.claim.site', %s, true)", [site])
        cur.execute("select set_config('request.jwt.claim.role', %s, true)", [role])
        cur.execute(f"select count(*) from public.{table}")
        n = cur.fetchone()[0]
        cur.execute("rollback")   # resets role + local GUCs
    return n

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()

    # Mirror Supabase's default grant of SELECT to authenticated so RLS (not the grant) is the gate.
    for t in TABLES:
        cur.execute(f"grant select on public.{t} to authenticated")

    # ── Seed two brands ───────────────────────────────────────────────────────────────────────
    site_b = q1(cur, "select fn_platform_create_site(%s,%s,'brandb','Brand B')", [ACTOR, PS])[0]

    userA1 = register(cur, "254700000001", "usera1", SITE_A)
    userA2 = register(cur, "254700000002", "usera2", SITE_A)
    userB1 = register(cur, "254700000003", "userb1", site_b)

    # Per-brand admin + a platform superadmin (roles set directly; RLS reads the JWT claim, not this).
    adminA = register(cur, "254700000010", "admA", SITE_A)
    platform = register(cur, "254700000011", "plat", SITE_A)
    cur.execute("update profiles set role='admin' where id=%s", [adminA])
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [platform])

    # Transactions on each brand (pending is fine — the row carries site_id).
    cur.execute("select fn_create_deposit(%s, 500000, '254700000001', %s)", [userA1, SITE_A])
    cur.execute("select fn_create_deposit(%s, 500000, '254700000003', %s)", [userB1, site_b])

    # Overrides on each brand (stamped with the target's brand by the RPC).
    cur.execute("select fn_admin_set_user_overrides(%s,%s,%s,%s)", [ACTOR, PS, userA1, '{"win_rate":"0.9","house_edge":"0.05"}'])
    cur.execute("select fn_admin_set_user_overrides(%s,%s,%s,%s)", [ACTOR, PS, userB1, '{"win_rate":"0.9","house_edge":"0.05"}'])

    # Brand truth (RLS-bypassed).
    A = {t: total(cur, t, SITE_A) for t in TABLES}
    B = {t: total(cur, t, site_b) for t in TABLES}
    ALL = {t: total(cur, t) for t in TABLES}

    print("\n== A site-scoped ADMIN (role=admin, site=A) sees EVERY brand-A row, ZERO brand-B ==")
    for t in TABLES:
        seen = count_as(conn, "admin", adminA, SITE_A, t)
        check(f"admin/site=A sees all {t} on A ({seen}=={A[t]})", seen == A[t] and A[t] > 0, f"seen={seen} A={A[t]}")
        # equality to A-only (< A+B) proves brand-B rows are excluded
        check(f"admin/site=A excludes brand-B {t}", seen == A[t] and seen != ALL[t], f"seen={seen} all={ALL[t]}")

    print("\n== The admin's scope FOLLOWS its signed site claim (A-admin claim=B -> only B) ==")
    for t in ("wallets", "transactions"):
        seen = count_as(conn, "admin", adminA, site_b, t)
        check(f"admin with site=B claim sees only brand-B {t} ({seen}=={B[t]})", seen == B[t], f"seen={seen} B={B[t]}")

    print("\n== A PLATFORM_SUPERADMIN sees every brand's rows ==")
    for t in TABLES:
        seen = count_as(conn, PS, platform, SITE_A, t)
        check(f"platform sees ALL {t} across brands ({seen}=={ALL[t]})", seen == ALL[t] and ALL[t] > A[t], f"seen={seen} all={ALL[t]}")

    print("\n== The admin policy NEVER leaks to a PLAYER token (own rows only) ==")
    check("player userA1 sees exactly 1 wallet (own)", count_as(conn, "player", userA1, SITE_A, "wallets") == 1)
    check("player userA1 sees exactly 1 profile (own)", count_as(conn, "player", userA1, SITE_A, "profiles") == 1)
    check("player userA1 sees only its own transaction", count_as(conn, "player", userA1, SITE_A, "transactions") == 1)
    check("player userA1 sees ZERO user_overrides (admin-only table)", count_as(conn, "player", userA1, SITE_A, "user_overrides") == 0)

    print("\n== user_overrides is brand-scoped for admins, global for platform, hidden from players ==")
    check(f"admin/site=A sees only brand-A overrides ({A['user_overrides']})", count_as(conn, "admin", adminA, SITE_A, "user_overrides") == A["user_overrides"] and A["user_overrides"] == 1)
    check(f"platform sees all overrides ({ALL['user_overrides']})", count_as(conn, PS, platform, SITE_A, "user_overrides") == ALL["user_overrides"] and ALL["user_overrides"] == 2)

    print("\n== An unknown/empty role claim gets NO admin escalation (own rows only) ==")
    # role='' -> is_site_admin() false; only sel_own applies, so the platform user's own wallet (1)
    # is visible but NOT the brand-wide set an admin/platform role would see.
    check("empty-role session sees only its own wallet (no escalation)",
          count_as(conn, "", platform, SITE_A, "wallets") == 1 and ALL["wallets"] > 1)

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL RLS ADMIN-DIMENSION E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
