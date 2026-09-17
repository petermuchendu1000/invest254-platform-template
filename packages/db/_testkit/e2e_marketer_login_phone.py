#!/usr/bin/env python3
"""e2e for marketer PIN login phone normalization (migration 0126, BUGLOG #30).

Resets a local Postgres, applies the shim + ALL migrations, then drives fn_marketer_login directly:
  - a marketer stored as 07… signs in with 07… / 254… / +254… / bare 7… / spaced -> ALL resolve;
  - the WRONG pin never resolves and (after 5) locks out;
  - cross-brand: two marketers with different phones resolve to the correct id, no leakage;
  - a non-default-brand marketer resolves with NO site hint (the app sends none).

Run: python3 packages/db/_testkit/e2e_marketer_login_phone.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_mktlogin_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"
SITE_B = "00000000-0000-0000-0000-0000000000b2"
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

def mk_marketer(cur, name, phone, site, pin, status="active"):
    cur.execute("insert into sites(id,slug,name,currency,status) values (%s,%s,%s,'KES','active') on conflict do nothing",
                [site, 'brand_'+site[-4:], name+' brand'])
    cur.execute("insert into marketers(id,name,phone,status,site_id) values (gen_random_uuid(),%s,%s,%s,%s) returning id",
                [name, phone, status, site])
    mid = cur.fetchone()[0]
    cur.execute("insert into marketer_credentials(marketer_id,pin_hash,failed_attempts) values (%s, extensions.crypt(%s, extensions.gen_salt('bf')), 0)",
                [mid, pin])
    return mid

def login(cur, phone, pin, site=None):
    cur.execute("select public.fn_marketer_login(%s,%s,%s)", [phone, pin, site]); return cur.fetchone()[0]

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()
    # Supabase ships pgcrypto in the `extensions` schema (fn_marketer_login calls extensions.crypt);
    # provide it on the local test PG so the PIN hashing/verify path runs identically.
    cur.execute("create schema if not exists extensions")
    cur.execute("create extension if not exists pgcrypto")
    cur.execute("alter extension pgcrypto set schema extensions")
    # marketer stored in local 07… form on a NON-default brand (B); a second on A with another phone.
    mB = mk_marketer(cur, "Mark Mumo", "0710613338", SITE_B, "1234")
    mA = mk_marketer(cur, "Joy",        "0748057157", SITE_A, "9999")

    print("\n== a marketer stored as 07… resolves from EVERY entered format (no site hint) ==")
    for fmt in ["0710613338", "254710613338", "+254710613338", "710613338", " 0710 613 338 ", "+254 710 613 338"]:
        check(f"login '{fmt.strip()}' -> Mark", str(login(cur, fmt, "1234")) == str(mB), f"got {login(cur, fmt, '1234')}")

    print("\n== wrong pin never resolves; correct pin still does ==")
    check("wrong pin -> null", login(cur, "254710613338", "0000") is None)
    check("correct pin after a miss -> Mark", str(login(cur, "0710613338", "1234")) == str(mB))

    print("\n== cross-brand: the OTHER phone resolves to the OTHER marketer, no leakage ==")
    check("Joy's phone -> Joy", str(login(cur, "+254748057157", "9999")) == str(mA))
    check("Joy's phone with Mark's pin -> null", login(cur, "254748057157", "1234") is None)

    print("\n== optional site hint still scopes ==")
    check("Mark with correct site B", str(login(cur, "254710613338", "1234", SITE_B)) == str(mB))
    check("Mark with wrong site A -> null", login(cur, "254710613338", "1234", SITE_A) is None)

    print("\n== lockout after 5 misses (throttle path also uses sig-9) ==")
    m2 = mk_marketer(cur, "Lockme", "0722000000", SITE_A, "4321")
    for _ in range(5): login(cur, "254722000000", "0000")   # 5 misses via a DIFFERENT format
    check("locked out even with the correct pin after 5 misses", login(cur, "0722000000", "4321") is None)

    print("\n== malformed phone matches nothing, no error ==")
    check("garbage phone -> null", login(cur, "abc", "1234") is None)

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL: print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL MARKETER-LOGIN PHONE-NORMALIZATION SCENARIOS PASSED")

if __name__ == "__main__":
    main()
