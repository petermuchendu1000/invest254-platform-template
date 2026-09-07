#!/usr/bin/env python3
"""Aggressive e2e for the C2B / Pay Bill deposit money core (migration 0115).

Stands up a local ephemeral Postgres, applies the Supabase shim + ALL migrations, then proves the
money invariants of fn_ingest_c2b / fn_claim_c2b_deposit directly against the SECURITY DEFINER RPCs:

  CREDIT-EXACT   — a claim credits the amount SAFARICOM recorded, never the client-entered amount.
  CLAIM-ONCE     — a code can be claimed exactly once (same-user re-claim is an idempotent no-op).
  CROSS-USER     — a code already claimed by user A cannot be claimed by user B (CODE_ALREADY_USED).
  NORMALIZE      — codes are matched case-insensitively (stored/compared UPPERCASE).
  INGEST-IDEMPOTENT — Safaricom retries the confirmation; a duplicate code is a no-op.
  MIGRATION-IDEMPOTENT — re-applying 0115 preserves data.

Run: python3 packages/db/_testkit/e2e_c2b_paybill.py   (requires a local Postgres on /tmp:5433)
"""
import os, glob, sys, uuid
import psycopg2

DSN = dict(host="/tmp", port=5433, user="postgres", dbname="c2b_test")
MIG_DIR = os.path.join(os.path.dirname(__file__), "..", "migrations")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"
MIG_0115 = os.path.join(MIG_DIR, "0115_c2b_paybill_deposit.sql")

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def reset_and_migrate():
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres")
    admin.set_client_encoding("UTF8"); admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='c2b_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists c2b_test"); c.execute("create database c2b_test")
    admin.close()
    conn = psycopg2.connect(**DSN); conn.set_client_encoding("UTF8"); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        # NOTE: match 0001..0115+ (four-digit prefix) — a plain "00*.sql" glob silently skips 0100+.
        for f in sorted(glob.glob(os.path.join(MIG_DIR, "0[0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def expect_error(cur, sql, args, code_substr, name):
    try:
        cur.execute(sql, args); check(name, False, "no error raised")
    except Exception as e:
        check(name, code_substr.lower() in str(e).lower(), f"got: {str(e).strip()[:80]}")

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()

    print("\n== paybill_config seeded ==")
    row = q1(cur, "select enabled, shortcode, account_number, business_name from paybill_config where id=1")
    check("paybill_config seeded (625625 / 7719580265 / BETWOIN LTD)",
          row == (True, "625625", "7719580265", "BETWOIN LTD"), f"{row}")

    pda = q1(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", ["254720000001","payA","hash_"+"p"*24, SITE_A])[0]
    pdb = q1(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", ["254720000002","payB","hash_"+"q"*24, SITE_A])[0]
    check("two site-A users created", pda != pdb)

    print("\n== ingest C2B (idempotent) ==")
    ins1 = q1(cur, "select fn_ingest_c2b(%s,%s,%s,%s,%s,%s)", ["QGH1ABC", 20000, "254720000001", "7719580265", "625625", '{}'])[0]
    ins2 = q1(cur, "select fn_ingest_c2b(%s,%s,%s,%s,%s,%s)", ["qgh1abc", 20000, "254720000001", "7719580265", "625625", '{}'])[0]
    cnt = q1(cur, "select count(*) from c2b_payments where trans_id='QGH1ABC'")[0]
    check("first ingest stores row", ins1 is True)
    check("duplicate ingest is a case-insensitive no-op", ins2 is False and cnt == 1, f"ins2={ins2} cnt={cnt}")
    expect_error(cur, "select fn_ingest_c2b(%s,%s,%s,%s,%s,%s)", ["", 100, None, None, None, '{}'], "INVALID_C2B", "empty code rejected")
    expect_error(cur, "select fn_ingest_c2b(%s,%s,%s,%s,%s,%s)", ["X1", 0, None, None, None, '{}'], "INVALID_C2B", "zero amount rejected")

    print("\n== claim credits the EXACT verified amount, once ==")
    r = q1(cur, "select status, amount, new_balance, tx_id from fn_claim_c2b_deposit(%s,%s,%s)", [pda, "qgh1abc", SITE_A])
    check("claim credited exact amount 20000", r[0]=="credited" and r[1]==20000 and r[2]==20000 and r[3] is not None, f"{r}")
    bal = q1(cur, "select real_balance from wallets where user_id=%s and site_id=%s", [pda, SITE_A])[0]
    check("wallet real_balance = 20000", bal==20000, f"bal={bal}")
    txrow = q1(cur, "select kind,status,provider,mpesa_receipt,amount,site_id::text from transactions where id=%s", [r[3]])
    check("tx row deposit/success/mpesa_paybill/QGH1ABC/20000/siteA",
          txrow==("deposit","success","mpesa_paybill","QGH1ABC",20000, SITE_A), f"{txrow}")
    led = q1(cur, "select type,amount,balance_kind,site_id::text,meta->>'source' from ledger_entries where ref_id=%s", [str(r[3])])
    check("ledger stamped deposit/real/siteA/paybill_c2b", led==("deposit",20000,"real",SITE_A,"paybill_c2b"), f"{led}")

    print("\n== double-claim / cross-user safety ==")
    r2 = q1(cur, "select status, new_balance from fn_claim_c2b_deposit(%s,%s,%s)", [pda, "QGH1ABC", SITE_A])
    bal2 = q1(cur, "select real_balance from wallets where user_id=%s and site_id=%s", [pda, SITE_A])[0]
    check("same-user re-claim = already_claimed, no double credit", r2[0]=="already_claimed" and bal2==20000, f"{r2} bal={bal2}")
    expect_error(cur, "select fn_claim_c2b_deposit(%s,%s,%s)", [pdb, "QGH1ABC", SITE_A], "CODE_ALREADY_USED", "other user cannot claim a used code")

    r3 = q1(cur, "select status from fn_claim_c2b_deposit(%s,%s,%s)", [pda, "NOPE999", SITE_A])
    check("unknown code = not_found", r3[0]=="not_found", f"{r3}")

    print("\n== amount authority ==")
    q1(cur, "select fn_ingest_c2b(%s,%s,%s,%s,%s,%s)", ["AMT500", 50000, "254720000002", "7719580265", "625625", '{}'])
    ra = q1(cur, "select status, amount, new_balance from fn_claim_c2b_deposit(%s,%s,%s)", [pdb, "AMT500", SITE_A])
    check("credited the Safaricom-recorded 50000 (client cannot influence)", ra[0]=="credited" and ra[1]==50000 and ra[2]==50000, f"{ra}")

    print("\n== migration idempotency ==")
    cur.execute(open(MIG_0115, encoding="utf-8").read())
    check("re-applying 0115 preserves data", q1(cur, "select count(*) from c2b_payments")[0]==2)

    print(f"\n==== {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", FAIL); sys.exit(1)

if __name__ == "__main__":
    main()
