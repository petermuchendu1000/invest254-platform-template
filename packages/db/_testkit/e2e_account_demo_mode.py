#!/usr/bin/env python3
"""Account DEMO MODE isolation e2e (migration 0123).

Resets a local Postgres, applies the Supabase shim + ALL migrations (incl. 0123), then proves the
five invariants of the real<->demo toggle directly against the SECURITY DEFINER money RPCs:

  1. Demo stakes/payouts touch demo_balance ONLY; real/bonus untouched (and vice-versa).
  2. Demo funds are never withdrawable (fn_create_withdrawal sources real_balance only).
  3. Real cohort views exclude demo-mode positions; demo views include them.
  4. Marketers are ALWAYS demo (mode 'real' is forced to 'demo').
  5. Settlement routes by the bucket STORED ON THE POSITION at open, even if the user's mode
     changed between open and settle (the critical cross-mode leak the design prevents).

Run: python3 packages/db/_testkit/e2e_account_demo_mode.py     (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid, traceback
import psycopg2

DSN = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
MIG_DIR = os.path.join(os.path.dirname(__file__), "..", "migrations")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE = "00000000-0000-0000-0000-000000000001"

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

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
        for f in sorted(glob.glob(os.path.join(MIG_DIR, "[0-9][0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

_NONCE = [0]
def nonce():
    _NONCE[0] += 1
    return _NONCE[0]

def one(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def bal(cur, uid):
    r = one(cur, "select real_balance, bonus_balance, demo_balance from wallets where user_id=%s and site_id=%s", (uid, SITE))
    return {"real": r[0], "bonus": r[1], "demo": r[2]}

def mkuser(cur, role, real=0, bonus=0, demo=0):
    uid = str(uuid.uuid4())
    cur.execute("insert into profiles(id,role,site_id,phone,username) values (%s,%s,%s,%s,%s)",
                (uid, role, SITE, "07"+uid.replace("-","")[:8], role[:3]+"_"+uid[:6]))
    cur.execute("insert into wallets(user_id,site_id,real_balance,bonus_balance,demo_balance) values (%s,%s,%s,%s,%s)",
                (uid, SITE, real, bonus, demo))
    return uid

def open_digit(cur, uid, gd, stake, kindname="even"):
    contract = '{"kind":"%s","target":0}' % kindname
    r = one(cur, """select position_id from fn_open_contract(%s,%s,'digit',%s::jsonb,'buy',1.0,1,%s,%s,now(),null,%s)""",
            (uid, stake, contract, gd, nonce(), SITE))
    return r[0]

def settle(cur, pos, result, payout):
    return one(cur, "select settled,new_balance from fn_settle_position(%s,1.0,%s,0,%s)", (pos, result, payout))

def main():
    conn = reset_and_migrate(); cur = conn.cursor()
    gd = one(cur, "select fn_ensure_game_day(current_date,'demotest',%s)", (SITE,))[0]

    # ── A. REAL MODE (default): stakes/payouts on real; demo untouched ──────────────────────────────
    u = mkuser(cur, "player", real=500000)
    check("default mode is 'real'", one(cur, "select account_mode from wallets where user_id=%s and site_id=%s", (u, SITE))[0] == "real")
    check("fn_account_is_demo=false for real player in real mode", one(cur, "select fn_account_is_demo(%s,%s)", (u, SITE))[0] is False)
    newdemo = one(cur, "select fn_topup_demo_account(%s,%s)", (u, SITE))[0]
    b0 = bal(cur, u)
    check("topup granted demo=1,000,000; real untouched", newdemo == 1000000 and b0 == {"real":500000,"bonus":0,"demo":1000000})
    check("topup idempotent (no-op at cap)", one(cur, "select fn_topup_demo_account(%s,%s)", (u, SITE))[0] == 1000000 and bal(cur,u)["demo"] == 1000000)
    pos_real = open_digit(cur, u, gd, 50000)
    b1 = bal(cur, u)
    check("real-mode stake debits REAL only", b1 == {"real":450000,"bonus":0,"demo":1000000})
    check("real-mode position tagged demo=false", one(cur, "select demo from positions where id=%s", (pos_real,))[0] is False)
    settle(cur, pos_real, "win", 95000)
    b2 = bal(cur, u)
    check("real-mode payout credits REAL only", b2 == {"real":545000,"bonus":0,"demo":1000000})

    # ── B. DEMO MODE: stakes/payouts on demo; real untouched ────────────────────────────────────────
    check("switch to demo returns 'demo'", one(cur, "select fn_set_account_mode(%s,%s,'demo')", (u, SITE))[0] == "demo")
    check("fn_account_is_demo=true in demo mode", one(cur, "select fn_account_is_demo(%s,%s)", (u, SITE))[0] is True)
    pos_demo = open_digit(cur, u, gd, 80000)
    b3 = bal(cur, u)
    check("demo-mode stake debits DEMO only", b3 == {"real":545000,"bonus":0,"demo":920000})
    check("demo-mode position tagged demo=true", one(cur, "select demo from positions where id=%s", (pos_demo,))[0] is True)
    settle(cur, pos_demo, "win", 152000)
    b4 = bal(cur, u)
    check("demo-mode payout credits DEMO only; REAL untouched", b4 == {"real":545000,"bonus":0,"demo":1072000})

    # ── C. CRITICAL: settle routes by POSITION bucket even if mode changed after open ────────────────
    pos_x = open_digit(cur, u, gd, 30000)           # opened in DEMO mode -> demo bucket
    check("pos_x tagged demo=true", one(cur, "select demo from positions where id=%s", (pos_x,))[0] is True)
    one(cur, "select fn_set_account_mode(%s,%s,'real')", (u, SITE))   # user flips to REAL before settle
    before = bal(cur, u)
    settle(cur, pos_x, "win", 57000)
    after = bal(cur, u)
    check("cross-mode: demo position still settles to DEMO (real untouched)",
          after["real"] == before["real"] and after["demo"] == before["demo"] + 57000,
          detail=f"before={before} after={after}")

    # ── D. Marketer is ALWAYS demo (mode 'real' forced to 'demo') ───────────────────────────────────
    m = mkuser(cur, "marketer", real=100000, demo=200000)
    check("marketer fn_account_is_demo=true", one(cur, "select fn_account_is_demo(%s,%s)", (m, SITE))[0] is True)
    check("marketer set_account_mode('real') is forced to 'demo'", one(cur, "select fn_set_account_mode(%s,%s,'real')", (m, SITE))[0] == "demo")
    pm = open_digit(cur, m, gd, 40000)
    bm = bal(cur, m)
    check("marketer stake debits DEMO only; real untouched", bm == {"real":100000,"bonus":0,"demo":160000} and one(cur,"select demo from positions where id=%s",(pm,))[0] is True)

    # ── E. Demo funds are NEVER withdrawable ────────────────────────────────────────────────────────
    d = mkuser(cur, "player", real=0, demo=1000000)
    one(cur, "select fn_set_account_mode(%s,%s,'demo')", (d, SITE))
    wd_blocked = False
    try:
        cur.execute("select fn_create_withdrawal(%s,%s,%s,%s,%s)", (d, 50000, "0700000000", 1000, SITE))
    except Exception as e:
        wd_blocked = "INSUFFICIENT_FUNDS" in str(e)
        conn.rollback()  # clear aborted tx (autocommit re-enables after)
        conn.autocommit = True
    check("demo-only user cannot withdraw (real sourced only)", wd_blocked and bal(cur, d)["demo"] == 1000000)

    # ── F. Reporting: demo-mode positions leave the real cohort, join the demo cohort ────────────────
    check("v_real_positions INCLUDES the real-mode position", one(cur, "select exists(select 1 from v_real_positions where id=%s)", (pos_real,))[0] is True)
    check("v_real_positions EXCLUDES the demo-mode position", one(cur, "select exists(select 1 from v_real_positions where id=%s)", (pos_demo,))[0] is False)
    check("v_demo_positions INCLUDES the demo-mode position", one(cur, "select exists(select 1 from v_demo_positions where id=%s)", (pos_demo,))[0] is True)
    check("v_demo_positions EXCLUDES the real-mode position", one(cur, "select exists(select 1 from v_demo_positions where id=%s)", (pos_real,))[0] is False)
    check("fn_demo_isolation_report still leaked=0", one(cur, "select coalesce(sum(leaked),0) from fn_demo_isolation_report()")[0] == 0)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    conn.close()
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc(); sys.exit(2)
