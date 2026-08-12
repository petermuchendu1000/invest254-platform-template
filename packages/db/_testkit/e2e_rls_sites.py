#!/usr/bin/env python3
"""Aggressive RLS site-dimension e2e (docs/22 Task F).

Resets a local Postgres, applies the shim + ALL migrations (incl. 0051), seeds real rows for a
player on each of two brands via the SECURITY DEFINER RPCs, then logs in as the `authenticated`
role (as PostgREST/Supabase would) with different JWT `sub`/`site` claims and asserts Row-Level
Security only ever exposes rows that match BOTH the caller's uid AND their brand.

Invariant: a client holding the (public) anon/authenticated key for brand B can NEVER read brand
A's rows — not even by presenting a valid brand-A uid with a brand-B site claim, or vice-versa.

Run: python3 packages/db/_testkit/e2e_rls_sites.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"
SITE_B = "00000000-0000-0000-0000-0000000000b2"

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

def count_as(conn, sub, site, table):
    """Row count visible from `table` for an `authenticated` session with the given uid+site claim."""
    cur = conn.cursor()
    try:
        cur.execute("begin")
        cur.execute("set local role authenticated")
        cur.execute("select set_config('request.jwt.claim.sub', %s, true)", [sub])
        cur.execute("select set_config('request.jwt.claim.site', %s, true)", [site])
        cur.execute(f"select count(*) from public.{table}")
        n = cur.fetchone()[0]
    finally:
        cur.execute("rollback")   # resets role + the local GUCs
    return n

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()

    print("\n== Setup: a funded player + activity on each of two brands ==")
    cur.execute("insert into sites(id,slug,name,currency,status) values (%s,'brandB','Brand B','KES','active') on conflict do nothing", [SITE_B])
    cur.execute("insert into site_game_config(site_id,min_stake,max_stake,house_edge,target_win_rate) values (%s,25000,5000000,0.75,0.125) on conflict (site_id) do nothing", [SITE_B])

    userA = q1(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", ["254740000001","rlsA","hash_"+"x"*24, SITE_A])[0]
    userB = q1(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", ["254740000001","rlsB","hash_"+"x"*24, SITE_B])[0]
    for uid in (userA, userB): cur.execute("update wallets set real_balance=1000000 where user_id=%s", [uid])
    gdA = q1(cur, "insert into game_days(site_id,trade_date,server_seed_hash) values (%s,'2026-03-01','hA') returning id",[SITE_A])[0]
    gdB = q1(cur, "insert into game_days(site_id,trade_date,server_seed_hash) values (%s,'2026-03-01','hB') returning id",[SITE_B])[0]
    # positions + stake/payout ledger (site-stamped by the RPCs)
    q1(cur, "select position_id from fn_open_position(%s,%s,'buy',0.2,10,%s,1,now(),1,%s)", [userA, 30000, gdA, SITE_A])
    q1(cur, "select position_id from fn_open_position(%s,%s,'buy',0.2,10,%s,1,now(),1,%s)", [userB, 30000, gdB, SITE_B])
    # deposits -> transactions + ledger (site-stamped)
    depA = q1(cur, "select fn_create_deposit(%s,%s,%s,%s)", [userA, 50000, "254740000001", SITE_A])[0]
    cur.execute("select fn_attach_stk(%s,%s,%s)", [depA, "mrA", "coA"]); cur.execute("select fn_complete_deposit(%s,0,'ok','R-A','{}')", ["coA"])
    depB = q1(cur, "select fn_create_deposit(%s,%s,%s,%s)", [userB, 50000, "254740000001", SITE_B])[0]
    cur.execute("select fn_attach_stk(%s,%s,%s)", [depB, "mrB", "coB"]); cur.execute("select fn_complete_deposit(%s,0,'ok','R-B','{}')", ["coB"])

    # Supabase grants SELECT to anon/authenticated on public tables by default; mirror that so RLS
    # (not a missing grant) is what governs visibility in this harness.
    for t in ["profiles","wallets","ledger_entries","positions","transactions"]:
        cur.execute(f"grant select on public.{t} to authenticated")

    print("\n== A brand-A player (site=A claim) sees ONLY their own brand-A rows ==")
    for t in ["wallets","positions","transactions"]:
        check(f"userA/site=A sees own {t}", count_as(conn, userA, SITE_A, t) == 1, f"{t}={count_as(conn, userA, SITE_A, t)}")
    check("userA/site=A ledger visible (>=2 rows)", count_as(conn, userA, SITE_A, "ledger_entries") >= 2)

    print("\n== The site dimension blocks a VALID uid presenting the WRONG brand claim ==")
    for t in ["wallets","positions","transactions","ledger_entries"]:
        check(f"userA with site=B claim sees NO {t}", count_as(conn, userA, SITE_B, t) == 0, f"{t}={count_as(conn, userA, SITE_B, t)}")

    print("\n== Brand-B player is symmetric; brands never see each other ==")
    for t in ["wallets","positions","transactions"]:
        check(f"userB/site=B sees own {t}", count_as(conn, userB, SITE_B, t) == 1)
        check(f"userB with site=A claim sees NO {t}", count_as(conn, userB, SITE_A, t) == 0)

    print("\n== Cross-user isolation still holds (uid dimension) ==")
    # userA can never see userB's rows even with a matching site claim for userB's brand.
    check("userA/site=B cannot see userB's wallet", count_as(conn, userA, SITE_B, "wallets") == 0)
    check("userB/site=A cannot see userA's wallet", count_as(conn, userB, SITE_A, "wallets") == 0)

    print("\n== A token with NO site claim falls back to the default brand (single-tenant safe) ==")
    # userA is on the default brand, so a legacy (no-site) claim still sees userA's rows;
    # userB (brand B) does NOT, because the fallback is the default brand.
    def count_no_site(sub, table):
        cur2 = conn.cursor()
        try:
            cur2.execute("begin"); cur2.execute("set local role authenticated")
            cur2.execute("select set_config('request.jwt.claim.sub', %s, true)", [sub])
            cur2.execute("select set_config('request.jwt.claim.site', '', true)")   # no site claim
            cur2.execute(f"select count(*) from public.{table}"); n = cur2.fetchone()[0]
        finally: cur2.execute("rollback")
        return n
    check("legacy userA (default brand) still sees own wallet", count_no_site(userA, "wallets") == 1)
    check("legacy claim does NOT expose brand-B userB's wallet", count_no_site(userB, "wallets") == 0)

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL RLS SITE-DIMENSION E2E SCENARIOS PASSED")

if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback; traceback.print_exc(); sys.exit(2)
