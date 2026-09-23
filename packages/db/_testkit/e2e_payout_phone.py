#!/usr/bin/env python3
"""E2E: F-49 (BUGLOG #64, migration 0161) — real-money withdrawals are paid ONLY to the registered number.

BEFORE (0001..0160) a withdrawal could name any M-Pesa number (with the live phone-only password reset,
that is wallet theft); AFTER (0161) any other number is refused and nothing is held, while the
registered number in any format (07…, 2547…, +254 7…) still works.
Run: python3 packages/db/_testkit/e2e_payout_phone.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob
import psycopg2

HERE = os.path.dirname(__file__)
MIG = os.path.join(HERE, "..", "migrations")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
SITE = "00000000-0000-0000-0000-000000000001"
DB = "f49_test"
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

def attempt(cur, uid, phone):
    try:
        cur.execute("select tx_id from fn_create_withdrawal(%s, 50000, %s, 25000, %s)", [uid, phone, SITE]); return "ok"
    except psycopg2.Error as e:
        return str(e).split("\n")[0]

def scenario(upto, fixed):
    conn = build(upto); cur = conn.cursor()
    cur.execute("select user_id from fn_register_user('254711222333','f49victim',%s,null,%s)", ["x" * 32, SITE])
    uid = cur.fetchone()[0]
    cur.execute("update wallets set real_balance = 1000000 where user_id=%s", [uid])
    r = attempt(cur, uid, "254799000111")
    if fixed:
        check("an attacker's number is refused (PAYOUT_PHONE_MISMATCH)", "PAYOUT_PHONE_MISMATCH" in r, r)
        cur.execute("select real_balance from wallets where user_id=%s", [uid])
        check("nothing was held", cur.fetchone()[0] == 1000000)
        for p in ("254711222333", "0711222333", "+254 711 222 333"):
            check(f"the registered number as '{p}' is paid", attempt(cur, uid, p) == "ok")
        check("an empty/short number is refused", "PAYOUT_PHONE_MISMATCH" in attempt(cur, uid, "123"))
        cur.execute("select has_function_privilege('anon','public.fn_create_withdrawal(uuid,bigint,text,bigint,uuid)','EXECUTE')")
        check("not executable by anon", cur.fetchone()[0] is False)
    else:
        check("BUG REPRODUCED: a withdrawal to any number was accepted", r == "ok", r)
    conn.close()

print("== BEFORE (0001..0160) =="); scenario("0160", False)
print("\n== AFTER (0001..0161) =="); scenario("0161", True)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
