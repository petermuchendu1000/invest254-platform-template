#!/usr/bin/env python3
"""Aggressive e2e for the sign-up welcome bonus + revived bonus engine (migration 0094).

Resets a local Postgres, applies the Supabase shim + ALL migrations, then exercises the
SECURITY DEFINER RPCs directly (as the engine does): grant idempotency + config/marketer guards,
bonus-first staking, wagering accrual, FIFO wagering conversion, insufficient-funds + min-stake
gates, and confirms zero-bonus players and demo/marketer accounts are UNCHANGED (no regression).

Run: python3 packages/db/_testkit/e2e_welcome_bonus.py
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

_n = [0]
def new_player(cur, real=0, bonus=0, demo=0):
    _n[0] += 1
    uid = str(uuid.uuid4()); ph = f"2547{_n[0]:08d}"
    cur.execute("insert into profiles(id,phone,username,role,status,site_id) values(%s,%s,%s,'player','active',%s)",
                (uid, ph, f"user{_n[0]}", SITE))
    cur.execute("insert into wallets(user_id,real_balance,bonus_balance,demo_balance,site_id) values(%s,%s,%s,%s,%s)",
                (uid, real, bonus, demo, SITE))
    return uid, ph

def new_marketer(cur, demo=0):
    uid, ph = new_player(cur, demo=demo)
    cur.execute("insert into marketers(name,phone,status,site_id) values(%s,%s,'active',%s)", ("mk", "0"+ph[3:], SITE))
    return uid, ph

def wallet(cur, uid):
    cur.execute("select real_balance,bonus_balance,demo_balance from wallets where user_id=%s", (uid,))
    r = cur.fetchone(); return {"real": r[0], "bonus": r[1], "demo": r[2]}

def open_pos(cur, uid, stake, day, cfg_ver):
    cur.execute("select position_id,new_balance from fn_open_position(%s,%s,'buy',100.0,10,%s,1,now(),%s,%s)",
                (uid, stake, day, cfg_ver, SITE))
    return cur.fetchone()[0]

def settle(cur, pid, result="win", mult=2.0, payout=0):
    cur.execute("select settled,new_balance from fn_settle_position(%s,101.0,%s,%s,%s)", (pid, result, mult, payout))
    return cur.fetchone()[0]

def main():
    conn = reset_and_migrate(); cur = conn.cursor()
    # shared fixtures
    cur.execute("insert into game_days(trade_date,server_seed_hash,site_id) values(current_date,'testhash',%s) returning id", (SITE,))
    DAY = cur.fetchone()[0]
    cur.execute("select version from site_game_config_versions where site_id=%s order by version desc limit 1", (SITE,))
    CFG = cur.fetchone()[0]

    print("T1: grant credits bonus + idempotent")
    uid, _ = new_player(cur)
    cur.execute("select fn_grant_welcome_bonus(%s)", (uid,)); g1 = cur.fetchone()[0]
    w = wallet(cur, uid)
    cur.execute("select amount,wagering_x,status,type from bonuses where user_id=%s", (uid,)); b = cur.fetchall()
    cur.execute("select type,amount,balance_kind,meta->>'kind' from ledger_entries where user_id=%s and type='bonus'", (uid,)); led = cur.fetchall()
    check("grant returns 20000", g1 == 20000, g1)
    check("bonus_balance == 20000", w["bonus"] == 20000, w)
    check("one active welcome row wx=3", len(b) == 1 and b[0][0] == 20000 and float(b[0][1]) == 3.0 and b[0][2] == "active" and b[0][3] == "welcome", b)
    check("ledger welcome_bonus entry", led == [("bonus", 20000, "bonus", "welcome_bonus")], led)
    cur.execute("select fn_grant_welcome_bonus(%s)", (uid,)); g2 = cur.fetchone()[0]
    check("second grant returns 0 (idempotent)", g2 == 0, g2)
    check("bonus unchanged after 2nd grant", wallet(cur, uid)["bonus"] == 20000)

    print("T2: marketer/demo accounts excluded")
    muid, _ = new_marketer(cur)
    cur.execute("select fn_grant_welcome_bonus(%s)", (muid,)); gm = cur.fetchone()[0]
    check("marketer grant returns 0", gm == 0, gm)
    check("marketer bonus stays 0", wallet(cur, muid)["bonus"] == 0)

    print("T3: config disabled -> no grant")
    cur.execute("update bonus_config set welcome_enabled=false where id=1")
    uid3, _ = new_player(cur); cur.execute("select fn_grant_welcome_bonus(%s)", (uid3,))
    check("disabled -> 0", cur.fetchone()[0] == 0)
    cur.execute("update bonus_config set welcome_enabled=true where id=1")

    print("T4: bonus-first staking (200 bonus + 50 real => 250 stake)")
    uid4, _ = new_player(cur, real=5000)
    cur.execute("select fn_grant_welcome_bonus(%s)", (uid4,))
    open_pos(cur, uid4, 25000, DAY, CFG)
    w4 = wallet(cur, uid4)
    cur.execute("select balance_kind,amount from ledger_entries where user_id=%s and type='stake'", (uid4,))
    led4 = set(cur.fetchall())
    cur.execute("select wagered from bonuses where user_id=%s", (uid4,)); wag = cur.fetchone()[0]
    check("bonus drawn first (->0)", w4["bonus"] == 0, w4)
    check("real remainder drawn (->0)", w4["real"] == 0, w4)
    check("stake split bonus -20000 / real -5000", led4 == {("bonus", -20000), ("real", -5000)}, led4)
    check("wagering accrued full stake", wag == 25000, wag)

    print("T5: insufficient funds & min-stake gate")
    uid5, _ = new_player(cur); cur.execute("select fn_grant_welcome_bonus(%s)", (uid5,))
    try:
        open_pos(cur, uid5, 25000, DAY, CFG); check("insufficient raises", False, "no error")
    except Exception as e:
        conn.rollback(); check("insufficient -> INSUFFICIENT_FUNDS", "INSUFFICIENT_FUNDS" in str(e), str(e))
    try:
        open_pos(cur, uid5, 20000, DAY, CFG); check("below-min raises", False, "no error")
    except Exception as e:
        conn.rollback(); check("bonus-only (200) blocked by STAKE_BELOW_MIN", "STAKE_BELOW_MIN" in str(e), str(e))

    print("T6: wagering conversion at settle (bonus -> real, cleared)")
    uid6, _ = new_player(cur, real=100000)
    bid = str(uuid.uuid4())
    cur.execute("insert into bonuses(id,user_id,site_id,type,amount,wagering_x,wagered,status) values(%s,%s,%s,'welcome',20000,1.0,25000,'active')", (bid, uid6, SITE))
    cur.execute("update wallets set bonus_balance=20000 where user_id=%s", (uid6,))
    pid6 = open_pos(cur, uid6, 25000, DAY, CFG)
    cur.execute("update wallets set bonus_balance=20000 where user_id=%s", (uid6,))
    cur.execute("update bonuses set wagered=60000, status='active' where id=%s", (bid,))
    real_before = wallet(cur, uid6)["real"]
    settle(cur, pid6, "win", 2.0, 50000)
    w6 = wallet(cur, uid6)
    cur.execute("select status,converted_at from bonuses where id=%s", (bid,)); st = cur.fetchone()
    check("bonus converted (->0)", w6["bonus"] == 0, w6)
    check("real = before + payout(50000) + converted(20000)", w6["real"] == real_before + 70000, {"before": real_before, "after": w6["real"]})
    check("bonus row cleared + converted_at", st[0] == "cleared" and st[1] is not None, st)
    cur.execute("select amount,balance_kind,meta->>'kind' from ledger_entries where ref_id=%s and (meta->>'kind')='wagering_conversion'", (bid,))
    check("conversion ledger written", cur.fetchall() == [(20000, "real", "wagering_conversion")])

    print("T7: zero-bonus player unchanged (no regression)")
    uid7, _ = new_player(cur, real=100000)
    pid7 = open_pos(cur, uid7, 25000, DAY, CFG)
    cur.execute("select balance_kind,count(*) from ledger_entries where user_id=%s and type='stake' group by 1", (uid7,))
    led7 = cur.fetchall()
    check("real debited (75000), no bonus ledger", wallet(cur, uid7)["real"] == 75000 and led7 == [("real", 1)], led7)
    settle(cur, pid7, "win", 2.0, 50000)
    w7 = wallet(cur, uid7)
    check("payout to real (125000), bonus stays 0", w7["real"] == 125000 and w7["bonus"] == 0, w7)

    print("T8: demo/marketer open+settle isolated (demo only)")
    muid8, _ = new_marketer(cur, demo=100000)
    pid8 = open_pos(cur, muid8, 25000, DAY, CFG)
    wm = wallet(cur, muid8)
    cur.execute("select balance_kind from ledger_entries where user_id=%s and type='stake'", (muid8,))
    check("marketer stake debits demo, kind=demo", wm["demo"] == 75000 and wm["real"] == 0 and wm["bonus"] == 0 and cur.fetchall() == [("demo",)], wm)
    settle(cur, pid8, "win", 2.0, 50000)
    check("marketer payout to demo (125000)", wallet(cur, muid8)["demo"] == 125000)

    print("T9: promotion to marketer clears the welcome bonus (trigger on profiles.role)")
    uid9, _ = new_player(cur)
    cur.execute("select fn_grant_welcome_bonus(%s)", (uid9,))
    check("granted before promotion (bonus=20000)", wallet(cur, uid9)["bonus"] == 20000)
    cur.execute("update profiles set role='marketer' where id=%s", (uid9,))   # any promotion path does this
    w9 = wallet(cur, uid9)
    cur.execute("select status from bonuses where user_id=%s and type='welcome'", (uid9,)); st9 = cur.fetchone()[0]
    cur.execute("select amount,balance_kind,meta->>'kind' from ledger_entries where user_id=%s and (meta->>'kind')='welcome_void'", (uid9,)); void_led = cur.fetchall()
    check("bonus_balance cleared to 0 on promotion", w9["bonus"] == 0, w9)
    check("welcome bonus row voided", st9 == "void", st9)
    check("welcome_void ledger entry (-20000, bonus)", void_led == [(-20000, "bonus", "welcome_void")], void_led)
    # a partially-staked bonus clears whatever remains (no negative balance)
    uid9b, _ = new_player(cur, real=5000)
    cur.execute("select fn_grant_welcome_bonus(%s)", (uid9b,))
    open_pos(cur, uid9b, 25000, DAY, CFG)   # spends the 20000 bonus -> bonus_balance 0
    cur.execute("update profiles set role='marketer' where id=%s", (uid9b,))
    check("already-spent bonus clears cleanly (bonus stays 0)", wallet(cur, uid9b)["bonus"] == 0)
    cur.execute("select status from bonuses where user_id=%s and type='welcome'", (uid9b,))
    check("spent bonus row still voided on promotion", cur.fetchone()[0] == "void")

    print("T10: deposit-bonus fully removed (orphaned fn_deposit_bonus_pct dropped)")
    cur.execute("select count(*) from pg_proc where proname='fn_deposit_bonus_pct'")
    check("fn_deposit_bonus_pct no longer exists", cur.fetchone()[0] == 0)

    print(f"\n{'='*60}\n  {len(PASS)} passed, {len(FAIL)} failed\n{'='*60}")
    if FAIL:
        print("FAILED:", FAIL); sys.exit(1)
    print("ALL GREEN")

if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc(); sys.exit(2)
