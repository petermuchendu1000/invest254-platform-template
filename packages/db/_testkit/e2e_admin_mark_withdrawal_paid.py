#!/usr/bin/env python3
"""e2e for admin manual withdrawal completion (migration 0127, BUGLOG #32).

Resets a local Postgres, applies shim + ALL migrations, then drives the withdrawal money lifecycle:
  create (debits) -> approve (processing) -> fn_admin_mark_withdrawal_paid -> 'success' with NO wallet
  change; idempotent on an already-paid row; REFUSES a rejected/reversed row (would double-pay);
  works straight from 'pending'; writes an admin_actions audit row.

Run: python3 packages/db/_testkit/e2e_admin_mark_withdrawal_paid.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_markpaid_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"
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

def one(cur, sql, a=None): cur.execute(sql, a or []); return cur.fetchone()

def new_withdrawal(cur, admin_id, phone, amount=100000):
    uid = one(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, "p"+phone[-4:], "h"+"x"*23, SITE_A])[0]
    cur.execute("update wallets set real_balance=1000000 where user_id=%s", [uid])
    tx = one(cur, "select tx_id from fn_create_withdrawal(%s,%s,%s,%s,%s)", [uid, amount, phone, 5000, SITE_A])[0]
    return uid, tx

def bal(cur, uid): return one(cur, "select real_balance from wallets where user_id=%s", [uid])[0]
def status(cur, tx): return one(cur, "select status from transactions where id=%s", [tx])[0]

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()
    admin_id = one(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", ["254700000000","adminacc","h"+"a"*23, SITE_A])[0]
    cur.execute("update profiles set role='admin' where id=%s", [admin_id])

    print("\n== processing -> mark paid: status 'success', wallet UNCHANGED (money already debited) ==")
    uid, tx = new_withdrawal(cur, admin_id, "254711000001")
    after_create = bal(cur, uid)
    check("created debits the wallet", after_create == 900000, f"bal={after_create}")
    cur.execute("select fn_approve_withdrawal(%s,%s)", [tx, admin_id])
    check("approve -> processing", status(cur, tx) == "processing")
    r = one(cur, "select applied,status,new_balance from fn_admin_mark_withdrawal_paid(%s,%s,%s)", [tx, admin_id, "MP-RECEIPT-1"])
    check("mark_paid applied + success", r[0] is True and r[1] == "success", f"{r}")
    check("status now success", status(cur, tx) == "success")
    check("wallet UNCHANGED by mark_paid", bal(cur, uid) == after_create, f"bal={bal(cur,uid)}")
    rec = one(cur, "select mpesa_receipt, result_code, approved_by from transactions where id=%s", [tx])
    check("manual receipt + result_code 0 recorded", rec[0] == "MP-RECEIPT-1" and rec[1] == 0)
    aud = one(cur, "select count(*) from admin_actions where action='withdrawal.mark_paid' and target_id=%s", [str(tx)])
    check("admin_actions audit row written", aud[0] == 1)

    print("\n== idempotent: marking an already-paid withdrawal is a no-op ==")
    r2 = one(cur, "select applied,status,new_balance from fn_admin_mark_withdrawal_paid(%s,%s,%s)", [tx, admin_id, "MP-RECEIPT-2"])
    check("second mark_paid -> applied=false, still success", r2[0] is False and r2[1] == "success")
    check("receipt not overwritten by no-op", one(cur,"select mpesa_receipt from transactions where id=%s",[tx])[0] == "MP-RECEIPT-1")

    print("\n== pending -> mark paid directly (admin paid out-of-band before approval) ==")
    uid2, tx2 = new_withdrawal(cur, admin_id, "254711000002")
    check("still pending", status(cur, tx2) == "pending")
    r3 = one(cur, "select applied,status,new_balance from fn_admin_mark_withdrawal_paid(%s,%s,%s)", [tx2, admin_id, None])
    check("pending -> success", r3[0] is True and r3[1] == "success")
    check("auto receipt when none supplied", (one(cur,"select mpesa_receipt from transactions where id=%s",[tx2])[0] or "").startswith("MANUAL-"))
    check("wallet unchanged (debited at create)", bal(cur, uid2) == 900000)

    print("\n== REFUSED: a rejected/reversed withdrawal cannot be marked paid (no double-pay) ==")
    uid3, tx3 = new_withdrawal(cur, admin_id, "254711000003")
    cur.execute("select fn_reject_withdrawal(%s,%s)", [tx3, admin_id])
    check("reject reverses -> wallet re-credited", bal(cur, uid3) == 1000000 and status(cur, tx3) == "reversed")
    try:
        cur.execute("select fn_admin_mark_withdrawal_paid(%s,%s,%s)", [tx3, admin_id, "X"])
        check("mark_paid on reversed rejected", False, "no error raised")
    except Exception as e:
        conn.rollback(); check("mark_paid on reversed -> WITHDRAWAL_ALREADY_REVERSED", "WITHDRAWAL_ALREADY_REVERSED" in str(e), str(e)[:80])
    check("reversed tx wallet still intact (no double pay)", bal(cur, uid3) == 1000000)

    print("\n== unknown tx -> TX_NOT_FOUND ==")
    try:
        cur.execute("select fn_admin_mark_withdrawal_paid(%s,%s,%s)", [str(uuid.uuid4()), admin_id, None])
        check("unknown tx", False, "no error")
    except Exception as e:
        conn.rollback(); check("unknown tx -> TX_NOT_FOUND", "TX_NOT_FOUND" in str(e), str(e)[:80])

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL: print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL ADMIN MARK-WITHDRAWAL-PAID DB E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
