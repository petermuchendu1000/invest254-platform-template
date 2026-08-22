#!/usr/bin/env python3
"""Demo/real ISOLATION e2e (migration 0101). Proves the canonical v_real_*/v_demo_* views over the
live classifier (fn_is_marketer_account) never mix cohorts, so real analytics can't be polluted.

Resets a local Postgres, applies the Supabase shim + ALL migrations, then:
  - a real player and a marketer-role profile on the same site,
  - a settled position for each,
and asserts the real views exclude the marketer, the demo views exclude the player, and
fn_demo_isolation_report() reports 0 leakage.

Run: python3 packages/db/_testkit/e2e_demo_isolation.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid, traceback
import psycopg2

DSN = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
MIG_DIR = os.path.join(os.path.dirname(__file__), "..", "migrations")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE = "00000000-0000-0000-0000-000000000001"   # default (invest254)

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def reset_and_migrate():
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres")
    admin.set_client_encoding("UTF8"); admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='invest254_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists invest254_test")
        c.execute("create database invest254_test")
    admin.close()
    conn = psycopg2.connect(**DSN); conn.set_client_encoding("UTF8"); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(MIG_DIR, "00*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

def one(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()[0]

def main():
    conn = reset_and_migrate(); cur = conn.cursor()
    real_id, demo_id = str(uuid.uuid4()), str(uuid.uuid4())
    cur.execute("insert into profiles(id,role,site_id,phone,username) values (%s,'player',%s,%s,%s)",
                (real_id, SITE, "0700"+real_id[:6], "iso_real_"+real_id[:6]))
    cur.execute("insert into profiles(id,role,site_id,phone,username) values (%s,'marketer',%s,%s,%s)",
                (demo_id, SITE, "0711"+demo_id[:6], "iso_demo_"+demo_id[:6]))

    check("classifier: player is NOT demo", one(cur, "select not fn_is_marketer_account(%s)", (real_id,)))
    check("classifier: marketer IS demo", one(cur, "select fn_is_marketer_account(%s)", (demo_id,)))
    check("v_real_profiles has player, not marketer",
          one(cur, "select exists(select 1 from v_real_profiles where id=%s)", (real_id,))
          and not one(cur, "select exists(select 1 from v_real_profiles where id=%s)", (demo_id,)))
    check("v_demo_profiles has marketer, not player",
          one(cur, "select exists(select 1 from v_demo_profiles where id=%s)", (demo_id,))
          and not one(cur, "select exists(select 1 from v_demo_profiles where id=%s)", (real_id,)))

    gd = one(cur, "select id from game_days where site_id=%s order by id desc limit 1", (SITE,)) \
         if one(cur, "select count(*) from game_days where site_id=%s", (SITE,)) else None
    if gd:
        for uid in (real_id, demo_id):
            cur.execute("""insert into positions(id,user_id,game_day_id,direction,stake,entry_rate,result,status,duration_s,nonce,site_id,opened_at)
                           values (%s,%s,%s,'buy',100000,1.0,'loss','settled',10,1,%s,now())""",
                        (str(uuid.uuid4()), uid, gd, SITE))
        check("v_real_positions excludes marketer",
              one(cur, "select exists(select 1 from v_real_positions where user_id=%s)", (real_id,))
              and not one(cur, "select exists(select 1 from v_real_positions where user_id=%s)", (demo_id,)))
        check("v_demo_positions excludes player",
              one(cur, "select exists(select 1 from v_demo_positions where user_id=%s)", (demo_id,))
              and not one(cur, "select exists(select 1 from v_demo_positions where user_id=%s)", (real_id,)))

    check("fn_demo_isolation_report leaked=0", one(cur, "select coalesce(sum(leaked),0) from fn_demo_isolation_report()") == 0)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    conn.close()
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc(); sys.exit(2)
