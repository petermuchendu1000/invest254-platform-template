#!/usr/bin/env python3
"""Intensive e2e for instant multi-level referral commissions (0068).
Runs the ACTUAL RPCs on a fresh fully-migrated Postgres. Zero assumptions: every case asserted."""
import os, glob, psycopg2
DSN = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
MIG_DIR = os.path.join(os.path.dirname(__file__), "..", "migrations")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
HASH = "scrypt$32768$8$1$" + "a"*24 + "$" + "b"*24
A = "00000000-0000-0000-0000-000000000001"
p, f = 0, 0

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
        for fn in sorted(glob.glob(os.path.join(MIG_DIR, "00*.sql"))):
            c.execute(open(fn, encoding="utf-8").read())
    return conn

def check(name, ok, extra=""):
    global p, f
    if ok: p += 1; print(f"  ok  {name}")
    else:  f += 1; print(f"  FAIL {name}  {extra}")

conn = reset_and_migrate(); cur = conn.cursor()
def one(q, a=None): cur.execute(q, a or []); r = cur.fetchone(); return r[0] if r else None

def reg(phone, user, code=None, site=A):
    return one("select user_id from fn_register_user(%s,%s,%s,%s,%s::uuid)", [phone, user, HASH, code, site])
def enroll(uid): cur.execute("select fn_affiliate_enroll(%s)", [uid])
def refcode(uid): return one("select referral_code from profiles where id=%s", [uid])
def bal(uid): return one("select real_balance from wallets where user_id=%s", [uid]) or 0
def deposit_and_complete(uid, amount, phone, ok=True):
    tx = one("select fn_create_deposit(%s,%s,%s,%s::uuid)", [uid, amount, phone, A])
    chk = f"chk-{tx}"
    cur.execute("update transactions set checkout_request_id=%s where id=%s", [chk, tx])
    cur.execute("select applied,status,new_balance from fn_complete_deposit(%s,%s,%s,%s,%s::jsonb)",
                [chk, 0 if ok else 1, "ok" if ok else "fail", "RCPT" if ok else None, "{}"])
    return tx, chk

print("\n== every user gets a referral code ==")
m3 = reg("254700000003", "mkt3"); enroll(m3)
m2 = reg("254700000002", "mkt2", refcode(m3)); enroll(m2)
m1 = reg("254700000001", "mkt1", refcode(m2)); enroll(m1)
player = reg("254700000010", "player_p", refcode(m1))
for u,n in [(m3,"mkt3"),(m2,"m2"),(m1,"m1"),(player,"player")]:
    check(f"{n} has referral_code", refcode(u) is not None)
check("attribution chain: player.referred_by == m1", one("select referred_by from profiles where id=%s",[player]) == m1)
check("m1.referred_by == m2", one("select referred_by from profiles where id=%s",[m1]) == m2)
check("m2.referred_by == m3", one("select referred_by from profiles where id=%s",[m2]) == m3)

print("\n== MULTI-LEVEL: player deposits KES 1000 -> 25/20/17 up the marketer chain ==")
b1,b2,b3 = bal(m1), bal(m2), bal(m3)
deposit_and_complete(player, 100000, "254700000010")
check("L1 direct marketer m1 += 25% (25000)", bal(m1)-b1 == 25000, f"got {bal(m1)-b1}")
check("L2 marketer m2 += 20% (20000)",        bal(m2)-b2 == 20000, f"got {bal(m2)-b2}")
check("L3 marketer m3 += 17% (17000)",        bal(m3)-b3 == 17000, f"got {bal(m3)-b3}")
check("3 deposit_commissions rows for this deposit",
      one("select count(*) from deposit_commissions where referred_user=%s",[player]) == 3)
check("levels recorded 1,2,3",
      [r for r in [one("select array_agg(level order by level) from deposit_commissions where referred_user=%s",[player])]][0] == [1,2,3])

print("\n== PLAYER REFERRER: plain player refers -> 5% only, single level ==")
pref = reg("254700000020", "pref_player")          # a plain player (no enroll)
p2   = reg("254700000021", "player2", refcode(pref))
bpref = bal(pref)
deposit_and_complete(p2, 100000, "254700000021")
check("player referrer pref += 5% (5000)", bal(pref)-bpref == 5000, f"got {bal(pref)-bpref}")
check("only 1 commission row (no L2/L3 for player)",
      one("select count(*) from deposit_commissions where referred_user=%s",[p2]) == 1)
check("that row is level 1, rate 0.05, role player",
      one("select level||':'||rate||':'||beneficiary_role from deposit_commissions where referred_user=%s",[p2]) == "1:0.05:player")

print("\n== ADMIN CREDIT is NOT a deposit -> zero commission ==")
before = one("select count(*) from deposit_commissions")
dep_before = one("select count(*) from transactions where kind='deposit'")
# admin adjust credit to player (internal deposit)
cur.execute("select fn_admin_adjust_balance(%s,'superadmin',%s,%s,%s)", [m3, player, 50000, "goodwill"])
check("admin credit created NO new deposit_commissions", one("select count(*) from deposit_commissions") == before)
check("admin credit created NO new 'deposit' transaction row",
      one("select count(*) from transactions where kind='deposit'") == dep_before)
check("admin credit landed as ledger 'adjustment' (internal, not commissionable)",
      one("select count(*) from ledger_entries where user_id=%s and type='adjustment'",[player]) >= 1)

print("\n== FAILED deposit -> zero commission ==")
before = one("select count(*) from deposit_commissions")
deposit_and_complete(player, 100000, "254700000010", ok=False)
check("failed deposit paid no commission", one("select count(*) from deposit_commissions") == before)

print("\n== IDEMPOTENCY: re-complete + re-run payout must NOT double-pay ==")
p3 = reg("254700000030", "player3", refcode(m1))
b1 = bal(m1)
tx, chk = deposit_and_complete(p3, 100000, "254700000030")
after_first = bal(m1)
check("first completion paid m1 25000", after_first-b1 == 25000, f"got {after_first-b1}")
# re-run the completion RPC (callback + reconcile both hit this) — must be a no-op
cur.execute("select applied,status from fn_complete_deposit(%s,0,'ok','RCPT','{}'::jsonb)", [chk])
check("second completion applied=false", cur.fetchone()[0] == False)
# re-run the payout RPC directly — must return 0 new rows
check("direct re-run fn_pay_referral_commissions -> 0 new", one("select fn_pay_referral_commissions(%s)",[tx]) == 0)
check("m1 balance unchanged after re-runs (no double pay)", bal(m1) == after_first, f"got {bal(m1)}")

print("\n== NO REFERRER -> zero commission ==")
orphan = reg("254700000040", "orphan")   # no code
before = one("select count(*) from deposit_commissions")
deposit_and_complete(orphan, 100000, "254700000040")
check("orphan deposit paid no commission", one("select count(*) from deposit_commissions") == before)

print("\n== attribution via a PLAYER's code works (not just affiliates) ==")
check("p2 attributed to plain player pref", one("select referred_by from profiles where id=%s",[p2]) == pref)

print(f"\n==== referral-commission e2e: {p} passed, {f} failed ====")
conn.close()
raise SystemExit(1 if f else 0)
