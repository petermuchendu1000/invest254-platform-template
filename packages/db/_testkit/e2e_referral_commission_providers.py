#!/usr/bin/env python3
"""E2E: referral/marketer commissions must accrue on EVERY real-cash deposit rail.

Regression guard for the bug where fn_pay_referral_commissions hard-coded provider='mpesa', so
Mega Pay (0116, 'megapay') and Pay Bill/C2B (0115, 'mpesa_paybill') deposits created ZERO
commissions (marketers saw nothing recent). Fixed in 0117.

Proves BEFORE (migrate 0001..0116) the bug reproduces, and AFTER (apply 0117) every rail accrues
the full 25% to the brand default-marketer hierarchy — with a differential chain + idempotency.

Run: PGCLIENTENCODING=UTF8 python3 packages/db/_testkit/e2e_referral_commission_providers.py
(needs local PG on /tmp:5433)
"""
import os, sys, glob
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="rcp_test")
MIG  = os.path.join(os.path.dirname(__file__), "..", "migrations")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"
MIG_0117 = os.path.join(MIG, "0117_referral_commissions_all_providers.sql")

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def migrate(include_0117: bool):
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres")
    admin.set_client_encoding("UTF8"); admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='rcp_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists rcp_test"); c.execute("create database rcp_test")
    admin.close()
    conn = psycopg2.connect(**DSN); conn.set_client_encoding("UTF8"); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(MIG, "0[0-9][0-9][0-9]_*.sql"))):
            if (not include_0117) and os.path.basename(f).startswith("0117_"):
                continue
            c.execute(open(f, encoding="utf-8").read())
    return conn

_phone = [254790000000]
def reg(cur, uname, referred_by=None):
    _phone[0] += 1
    uid = q1(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)",
             [str(_phone[0]), uname, "h"+"x"*24, SITE_A])[0]
    if referred_by is not None:
        cur.execute("update profiles set referred_by=%s where id=%s", [referred_by, uid])
    return uid

def make_marketer(cur, uid):
    cur.execute("update profiles set role='marketer' where id=%s", [uid])

def set_default_marketer(cur, uid):
    cur.execute("update sites set owner_user_id=%s where id=%s", [uid, SITE_A])

def comms_for(cur, tx):
    """(count, total_commission, rows[(beneficiary, position, rate, amount, status)]) for a deposit tx."""
    rows = []
    cur.execute("""select beneficiary_user, position, rate, commission_amount, status
                     from deposit_commissions where deposit_tx_id=%s order by position desc""", [tx])
    rows = cur.fetchall()
    total = sum(r[3] for r in rows)
    return len(rows), total, rows

# ── deposit rails (mirror the engine's exact RPC usage) ──────────────────────────────────────────
_n = [0]
def dep_megapay(cur, user, amount):
    _n[0]+=1; trid=f"TRID-mp-{_n[0]}"
    tx = q1(cur, "select fn_create_deposit_provider(%s,%s,%s,%s,%s)", [user, amount, "254790000001", SITE_A, "megapay"])[0]
    q1(cur, "select fn_attach_stk(%s,%s,%s)", [tx, f"MREQ{_n[0]}", trid])
    q1(cur, "select applied,status,new_balance from fn_complete_deposit(%s,%s,%s,%s,%s)", [trid, 0, "verified:megapay", f"RC{_n[0]}", "{}"])
    return tx
def dep_mpesa(cur, user, amount):
    _n[0]+=1; crid=f"CRID-mp-{_n[0]}"
    tx = q1(cur, "select fn_create_deposit(%s,%s,%s,%s)", [user, amount, "254790000001", SITE_A])[0]
    q1(cur, "select fn_attach_stk(%s,%s,%s)", [tx, f"MREQ{_n[0]}", crid])
    q1(cur, "select applied,status,new_balance from fn_complete_deposit(%s,%s,%s,%s,%s)", [crid, 0, "verified", f"RC{_n[0]}", "{}"])
    return tx
def dep_c2b(cur, user, amount):
    _n[0]+=1; code=f"C2BCODE{_n[0]}"
    q1(cur, "select fn_ingest_c2b(%s,%s,%s,%s,%s,%s)", [code, amount, "254790000001", "7719580265", "625625", "{}"])
    return q1(cur, "select tx_id from fn_claim_c2b_deposit(%s,%s,%s)", [user, code, SITE_A])[0]

AMT = 100000  # KES 1,000

def seed(cur):
    owner = reg(cur, "owner"); make_marketer(cur, owner); set_default_marketer(cur, owner)
    p1 = reg(cur, "playerone")  # unreferred -> default marketer earns the full 25%
    return owner, p1

def main():
    # ── BEFORE (0001..0116): the bug ──────────────────────────────────────────────────────────
    print("\n===== BEFORE FIX (migrations 0001..0116) =====")
    conn = migrate(include_0117=False); cur = conn.cursor()
    owner, p1 = seed(cur)

    tx = dep_mpesa(cur, p1, AMT); n,_,_ = comms_for(cur, tx)
    check("mpesa (STK) deposit accrues commission [working rail]", n >= 1, f"rows={n}")

    tx = dep_megapay(cur, p1, AMT); n,tot,_ = comms_for(cur, tx)
    check("BUG REPRODUCED: megapay deposit accrues NOTHING pre-fix", n == 0, f"rows={n} total={tot}")

    tx = dep_c2b(cur, p1, AMT); n,tot,_ = comms_for(cur, tx)
    check("BUG REPRODUCED: c2b paybill deposit accrues NOTHING pre-fix", n == 0, f"rows={n} total={tot}")
    conn.close()

    # ── AFTER (apply 0117): every rail accrues ────────────────────────────────────────────────
    print("\n===== AFTER FIX (0117 applied) =====")
    conn = migrate(include_0117=True); cur = conn.cursor()
    owner, p1 = seed(cur)

    for rail, fn in [("mpesa", dep_mpesa), ("megapay", dep_megapay), ("c2b_paybill", dep_c2b)]:
        tx = fn(cur, p1, AMT); n, tot, rows = comms_for(cur, tx)
        # unreferred player -> single row: default marketer gets full 25%
        ok = (n == 1 and tot == 25000 and rows[0][0] == owner and rows[0][1] == 1
              and abs(float(rows[0][2]) - 0.25) < 1e-9 and rows[0][4] == "accrued")
        check(f"{rail}: default marketer accrues exactly 25% (25000)", ok, f"rows={rows}")
        # idempotency: re-running accrual creates no duplicate
        q1(cur, "select fn_pay_referral_commissions(%s)", [tx]); n2,_,_ = comms_for(cur, tx)
        check(f"{rail}: accrual is idempotent (no duplicate)", n2 == n, f"before={n} after={n2}")

    # ── Differential unilevel chain across a real rail (megapay), sums to exactly 25% ─────────
    print("\n== differential chain (player -> subA -> owner) on megapay ==")
    subA = reg(cur, "subalpha"); make_marketer(cur, subA)
    cur.execute("update profiles set referred_by=%s where id=%s", [owner, subA])  # subA recruited by owner
    p2 = reg(cur, "playertwo", referred_by=subA)                                          # player recruited by subA
    tx = dep_megapay(cur, p2, AMT); n, tot, rows = comms_for(cur, tx)
    by = {r[0]: r[3] for r in rows}
    check("chain sums to exactly 25% (25000)", tot == 25000, f"rows={rows}")
    check("subA (direct recruiter) earns 20% (20000)", by.get(subA) == 20000, f"subA={by.get(subA)}")
    check("owner (default, root) earns the 5% override (5000)", by.get(owner) == 5000, f"owner={by.get(owner)}")

    # ── retail player-referral perk still additive (non-marketer referrer gets 5% instant) ────
    print("\n== retail 5% player referral still works (additive) ==")
    pref = reg(cur, "prefplayer")                       # a plain player referrer (not a marketer)
    p3 = reg(cur, "playerthree", referred_by=pref)
    bal0 = q1(cur, "select real_balance from wallets where user_id=%s and site_id=%s", [pref, SITE_A])[0]
    tx = dep_megapay(cur, p3, AMT); n, tot, rows = comms_for(cur, tx)
    bal1 = q1(cur, "select real_balance from wallets where user_id=%s and site_id=%s", [pref, SITE_A])[0]
    retail = next((r for r in rows if r[0] == pref), None)
    check("retail referrer paid 5% (5000) instantly to wallet", retail is not None and retail[3] == 5000 and (bal1 - bal0) == 5000,
          f"retail={retail} delta={bal1-bal0}")
    check("default marketer STILL earns full 25% additively", by_owner_25(rows, owner), f"rows={rows}")

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL REFERRAL-COMMISSION PROVIDER E2E SCENARIOS PASSED")

def by_owner_25(rows, owner):
    return any(r[0] == owner and r[3] == 25000 and r[1] == 1 for r in rows)

if __name__ == "__main__":
    main()
