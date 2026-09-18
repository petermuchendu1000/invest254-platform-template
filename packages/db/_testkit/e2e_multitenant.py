#!/usr/bin/env python3
"""Aggressive multi-tenant e2e for the platform template DB layer.

Resets a local Postgres, applies the Supabase shim + ALL migrations (0001..00xx), then runs
adversarial two-site scenarios directly against the SECURITY DEFINER money RPCs. Fails loud.

Run: python3 packages/db/_testkit/e2e_multitenant.py
"""
import os, sys, glob, uuid, traceback
import psycopg2

DSN = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
MIG_DIR = os.path.join(os.path.dirname(__file__), "..", "migrations")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"   # default (invest254)
SITE_B = "00000000-0000-0000-0000-0000000000b2"

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def reset_and_migrate():
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres")
    admin.set_client_encoding("UTF8")
    admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='invest254_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists invest254_test")
        c.execute("create database invest254_test")
    admin.close()
    conn = psycopg2.connect(**DSN); conn.set_client_encoding("UTF8"); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(MIG_DIR, "[0-9][0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
        c.execute("""insert into public.site_game_config_versions
          (site_id, version, house_edge, max_multiplier, min_stake, max_stake, min_withdrawal,
           default_duration_s, tick_rate_ms, drift_bias, volatility, target_win_rate)
          select site_id, 1, house_edge, max_multiplier, min_stake, max_stake, min_withdrawal,
           default_duration_s, tick_rate_ms, drift_bias, volatility, target_win_rate
          from public.site_game_config where site_id='00000000-0000-0000-0000-000000000001'
          on conflict do nothing""")  # test-fix: default site historic v1 snapshot for FK 0089
    return conn

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); r = cur.fetchone(); return r

def expect_error(cur, sql, args, code_substr, name):
    try:
        cur.execute(sql, args); cur.connection.rollback(); check(name, False, "no error raised")
    except Exception as e:
        cur.connection.rollback(); check(name, code_substr.lower() in str(e).lower(), f"got: {str(e).strip()[:80]}")

def main():
    conn = reset_and_migrate()
    conn.autocommit = True
    cur = conn.cursor()

    print("\n== Setup: create Site B with a DIFFERENT economy ==")
    cur.execute("""insert into sites(id, slug, name, currency, status)
                   values (%s,'brandB','Brand B','KES','active') on conflict do nothing""", [SITE_B])
    # Site A min stake 25000 (default); Site B min stake 50000, tighter economy.
    cur.execute("""insert into site_game_config(site_id, min_stake, max_stake, house_edge, target_win_rate)
                   values (%s, 50000, 5000000, 0.75, 0.125) on conflict (site_id) do nothing""", [SITE_B])
    a = q1(cur, "select min_stake from site_game_config where site_id=%s", [SITE_A])[0]
    b = q1(cur, "select min_stake from site_game_config where site_id=%s", [SITE_B])[0]
    check("per-site game config distinct", a == 25000 and b == 50000, f"A={a} B={b}")

    print("\n== Per-site identity: same phone/username on two brands = two accounts ==")
    ua = q1(cur, "select user_id, role from fn_register_user(%s,%s,%s,null,%s)",
            ["254712000001", "sameuser", "hash_"+"x"*24, SITE_A])
    ub = q1(cur, "select user_id, role from fn_register_user(%s,%s,%s,null,%s)",
            ["254712000001", "sameuser", "hash_"+"x"*24, SITE_B])
    check("same phone registers on both sites (per-site identity)", ua[0] != ub[0])
    ua_id, ub_id = ua[0], ub[0]
    check("profiles stamped correct site A", str(q1(cur,"select site_id from profiles where id=%s",[ua_id])[0])==SITE_A)
    check("profiles stamped correct site B", str(q1(cur,"select site_id from profiles where id=%s",[ub_id])[0])==SITE_B)
    expect_error(cur, "select fn_register_user(%s,%s,%s,null,%s)",
                 ["254712000001","other","hash_"+"y"*24, SITE_A], "PHONE_TAKEN",
                 "duplicate phone WITHIN a site is rejected")

    print("\n== Wallet isolation + money lifecycle per site ==")
    cur.execute("update wallets set real_balance=1000000 where user_id=%s", [ua_id])
    cur.execute("update wallets set real_balance=1000000 where user_id=%s", [ub_id])
    # game_days: same trade_date allowed on both sites
    gda = q1(cur, "insert into game_days(site_id,trade_date,server_seed_hash) values (%s,'2026-01-01','h_a') returning id",[SITE_A])[0]
    gdb = q1(cur, "insert into game_days(site_id,trade_date,server_seed_hash) values (%s,'2026-01-01','h_b') returning id",[SITE_B])[0]
    check("same trade_date on two sites (per-site fairness lineage)", gda != gdb)
    # open on A (stake 25000 ok for A), settle win
    posA = q1(cur, "select position_id,new_balance from fn_open_position(%s,%s,'buy',0.2,10,%s,1,now(),1,%s)",
              [ua_id, 25000, gda, SITE_A])
    check("open on A debits stake", posA[1] == 975000, f"bal={posA[1]}")
    setA = q1(cur, "select settled,new_balance from fn_settle_position(%s,0.25,'win',2.0,50000)", [posA[0]])
    check("settle win on A credits payout", setA[1] == 1025000, f"bal={setA[1]}")

    print("\n== THE site-stamping bug-catch: ledger rows must carry the POSITION's site ==")
    la = q1(cur, "select count(*) from ledger_entries where user_id=%s and site_id=%s",[ua_id, SITE_A])[0]
    la_wrong = q1(cur, "select count(*) from ledger_entries where user_id=%s and site_id<>%s",[ua_id, SITE_A])[0]
    check("A's stake+payout ledger stamped site A (>=2 rows)", la >= 2, f"count={la}")
    check("no A ledger row leaked to another site", la_wrong == 0, f"leaked={la_wrong}")
    posB = q1(cur, "select position_id,new_balance from fn_open_position(%s,%s,'sell',0.2,10,%s,1,now(),1,%s)",
              [ub_id, 60000, gdb, SITE_B])
    cur.execute("select fn_settle_position(%s,0.19,'loss',0,0)", [posB[0]])
    bad = q1(cur, "select count(*) from ledger_entries l join positions p on p.id::text=l.ref_id "
                  "where p.site_id=%s and l.site_id<>%s", [SITE_B, SITE_B])[0]
    check("no B ledger row mis-stamped as default site", bad == 0, f"mis={bad}")

    print("\n== Per-site stake bounds ==")
    # 30000 is >= A.min(25000) but < B.min(50000): allowed on A, rejected on B
    okA = q1(cur, "select position_id from fn_open_position(%s,%s,'buy',0.2,10,%s,1,now(),1,%s)",
             [ua_id, 30000, gda, SITE_A])
    check("stake 30000 allowed on A (min 25000)", okA[0] is not None)
    expect_error(cur, "select fn_open_position(%s,%s,'buy',0.2,10,%s,1,now(),1,%s)",
                 [ub_id, 30000, gdb, SITE_B], "STAKE_BELOW_MIN",
                 "stake 30000 rejected on B (min 50000)")

    print("\n== Cross-site safety: cannot open A's wallet under B's site id ==")
    expect_error(cur, "select fn_open_position(%s,%s,'buy',0.2,10,%s,1,now(),1,%s)",
                 [ua_id, 60000, gdb, SITE_B], "WALLET_NOT_FOUND",
                 "opening user-A wallet with site B is impossible")

    print("\n== Affiliate: per-site marketer + attribution scoped to the site ==")
    aff = q1(cur, "select referral_code, role from fn_affiliate_enroll(%s)", [ua_id])
    code = aff[0]
    check("enroll promotes to marketer on A", aff[1] == "marketer")
    check("affiliate row stamped site A", str(q1(cur,"select site_id from affiliates where user_id=%s",[ua_id])[0])==SITE_A)
    ref = q1(cur, "select user_id from fn_register_user(%s,%s,%s,%s,%s)",
             ["254712000009","refkid","hash_"+"z"*24, code, SITE_A])[0]
    attr = q1(cur, "select count(*) from referrals where affiliate_id=%s and referred_user=%s and site_id=%s",[ua_id, ref, SITE_A])[0]
    check("referral attributed on A with code", attr == 1)
    # Same code used when registering on B => ignored (code not active on B)
    refB = q1(cur, "select user_id from fn_register_user(%s,%s,%s,%s,%s)",
              ["254712000010","refkidb","hash_"+"z"*24, code, SITE_B])[0]
    leak = q1(cur, "select count(*) from referrals where referred_user=%s",[refB])[0]
    check("A's referral code does NOT attribute a signup on B", leak == 0, f"leak={leak}")

    print("\n== Economic feasibility guard (per-site config CHECK) ==")
    # RTP/winRate must be in (1, maxMult]. house_edge 0.75 => RTP 0.25; winRate 0.5 => 0.5 <1 => infeasible.
    expect_error(cur, "update site_game_config set target_win_rate=0.5 where site_id=%s", [SITE_A],
                 "site_cfg_feasible", "infeasible economy rejected by CHECK")

    print("\n== Statistical override (per user, per site) ==")
    # Boost a failing player: high win rate needs low personal house edge (feasibility rule).
    cur.execute("""insert into user_overrides(user_id, win_rate, house_edge)
                   values (%s, 0.90, 0.05)
                   on conflict (user_id) do update set win_rate=excluded.win_rate, house_edge=excluded.house_edge""",
                [ua_id])
    ov = q1(cur, "select win_rate, house_edge, site_id from user_overrides where user_id=%s",[ua_id])
    feasible = (1 - float(ov[1])) / float(ov[0])  # RTP/winRate
    check("override stored + engine-feasible (RTP/winRate>1)", float(ov[0])==0.90 and 1 < feasible, f"factor={feasible:.3f}")
    check("override scoped to user's site A", str(ov[2])==SITE_A)

    print("\n== Deposits: site-stamped credit + idempotency + cross-site safety ==")
    import hashlib
    pda = q1(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", ["254720000001","payA","hash_"+"p"*24, SITE_A])[0]
    pdb = q1(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", ["254720000001","payB","hash_"+"p"*24, SITE_B])[0]
    dep = q1(cur, "select fn_create_deposit(%s,%s,%s,%s)", [pda, 100000, "254720000001", SITE_A])[0]
    cur.execute("select fn_attach_stk(%s,%s,%s)", [dep, "mr1", "co_A_1"])
    res = q1(cur, "select applied,status,new_balance from fn_complete_deposit(%s,%s,%s,%s,%s)", ["co_A_1", 0, "ok", "RCPT1", '{}'])
    check("deposit credits wallet on A", res[1]=="success" and res[2]==100000, f"{res}")
    site_ok = q1(cur, "select site_id from ledger_entries where ref_id=%s and type='deposit'", [dep])[0]
    check("deposit ledger stamped site A", str(site_ok)==SITE_A)
    res2 = q1(cur, "select applied,status,new_balance from fn_complete_deposit(%s,%s,%s,%s,%s)", ["co_A_1", 0, "ok", "RCPT1", '{}'])
    check("deposit completion is idempotent (no double credit)", res2[0]==False and res2[2]==100000, f"{res2}")
    expect_error(cur, "select fn_create_deposit(%s,%s,%s,%s)", [pda, 100000, "x", SITE_B], "WALLET_NOT_FOUND",
                 "cannot create a deposit for user A under site B")
    # failed deposit never credits
    dep2 = q1(cur, "select fn_create_deposit(%s,%s,%s,%s)", [pdb, 50000, "254720000001", SITE_B])[0]
    cur.execute("select fn_attach_stk(%s,%s,%s)", [dep2, "mr2", "co_B_1"])
    fres = q1(cur, "select applied,status,new_balance from fn_complete_deposit(%s,%s,%s,%s,%s)", ["co_B_1", 1, "cancelled", None, '{}'])
    check("failed deposit does not credit on B", fres[1]=="failed" and fres[2]==0, f"{fres}")

    print("\n== Withdrawals: hold/approve/complete + reversal, all site-stamped ==")
    cur.execute("update site_game_config set min_withdrawal=25000 where site_id=%s", [SITE_A])
    wd = q1(cur, "select tx_id,new_balance from fn_create_withdrawal(%s,%s,%s,%s,%s)", [pda, 40000, "254720000001", 25000, SITE_A])
    check("withdrawal holds funds on A (debit)", wd[1]==60000, f"bal={wd[1]}")
    hold_site = q1(cur, "select site_id from ledger_entries where ref_id=%s and type='withdrawal'", [wd[0]])[0]
    check("withdrawal hold ledger stamped site A", str(hold_site)==SITE_A)
    cur.execute("select fn_approve_withdrawal(%s,%s)", [wd[0], pda])
    cres = q1(cur, "select applied,status,new_balance from fn_complete_withdrawal(%s,%s,%s,%s,%s)", [wd[0], 0, "conv1", "WR1", '{}'])
    check("withdrawal success keeps the debit", cres[1]=="success" and cres[2]==60000, f"{cres}")
    # failure path reverses with a site-stamped reversal
    wd2 = q1(cur, "select tx_id,new_balance from fn_create_withdrawal(%s,%s,%s,%s,%s)", [pda, 30000, "254720000001", 25000, SITE_A])
    cur.execute("select fn_approve_withdrawal(%s,%s)", [wd2[0], pda])
    fw = q1(cur, "select applied,status,new_balance from fn_complete_withdrawal(%s,%s,%s,%s,%s)", [wd2[0], 1, "conv2", None, '{}'])
    check("withdrawal failure reverses the hold", fw[1]=="failed" and fw[2]==60000, f"{fw}")
    rev_site = q1(cur, "select site_id from ledger_entries where ref_id=%s and type='withdrawal_reversal'", [wd2[0]])[0]
    check("reversal ledger stamped site A", str(rev_site)==SITE_A)
    expect_error(cur, "select fn_create_withdrawal(%s,%s,%s,%s,%s)", [pda, 1000, "x", 25000, SITE_A], "BELOW_MIN",
                 "withdrawal below site A min rejected")

    print("\n== Fairness: fn_ensure_game_day per site + reveal scoped to one brand ==")
    seed = "deadbeef"*8
    h = hashlib.sha256(seed.encode()).hexdigest()
    gA = q1(cur, "select fn_ensure_game_day('2020-01-02',%s,%s)", [h, SITE_A])[0]
    gB = q1(cur, "select fn_ensure_game_day('2020-01-02',%s,%s)", [h, SITE_B])[0]
    check("same date -> distinct game_day per site (ensure)", gA != gB)
    gA2 = q1(cur, "select fn_ensure_game_day('2020-01-02',%s,%s)", [h, SITE_A])[0]
    check("fn_ensure_game_day idempotent per site", gA2 == gA)
    ok_reveal = q1(cur, "select fn_reveal_game_day('2020-01-02',%s,%s)", [seed, SITE_A])[0]
    check("reveal past day on A succeeds (hash-verified)", ok_reveal == True)
    b_revealed = q1(cur, "select revealed_at from game_days where id=%s", [gB])[0]
    check("revealing A's day did NOT reveal B's same-date day", b_revealed is None)

    print("\n== Global ledger integrity: every money row has a valid site ==")
    orphan = q1(cur, "select count(*) from ledger_entries l left join sites s on s.id=l.site_id where s.id is null")[0]
    check("no orphan ledger site_id", orphan == 0)
    posorph = q1(cur, "select count(*) from positions p left join sites s on s.id=p.site_id where s.id is null")[0]
    check("no orphan position site_id", posorph == 0)

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL MULTI-TENANT DB E2E SCENARIOS PASSED")

if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc(); sys.exit(2)
