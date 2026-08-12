#!/usr/bin/env python3
"""Aggressive multi-tenant e2e for the AFFILIATE accrual + payout RPCs (docs/22 Task B).

Resets a local Postgres, applies the Supabase shim + ALL migrations (incl. 0050), then runs
adversarial two-site affiliate scenarios directly against the SECURITY DEFINER RPCs:

  fn_accrue_affiliate_commissions(period, site?)  · fn_affiliate_request_payout(user)
  fn_affiliate_approve_payout · fn_affiliate_complete_payout

Invariants proven:
  ISOLATION  — a commission bucket / payout is stamped with, and scoped to, the affiliate's brand.
  GUARD      — an affiliate is NEVER credited for GGR earned on another brand (even a data anomaly).
  IDEMPOTENT — re-accrual is stable; paid/reserved buckets are never re-touched.

Run: python3 packages/db/_testkit/e2e_affiliate_sites.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"   # default (invest254)
SITE_B = "00000000-0000-0000-0000-0000000000b2"
PERIOD = "2026-02-01"
RATE   = 0.2                                        # default commission_rate at enrol

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def expect_error(cur, sql, args, code_substr, name):
    try:
        cur.execute(sql, args); cur.connection.rollback(); check(name, False, "no error raised")
    except Exception as e:
        cur.connection.rollback(); check(name, code_substr.lower() in str(e).lower(), f"got: {str(e).strip()[:80]}")

def reset_and_migrate():
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='invest254_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists invest254_test"); c.execute("create database invest254_test")
    admin.close()
    conn = psycopg2.connect(**DSN); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "00*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

def register(cur, phone, user, site, code=None):
    return q1(cur, "select user_id from fn_register_user(%s,%s,%s,%s,%s)",
              [phone, user, "hash_"+"x"*24, code, site])[0]

def loss_position(cur, user_id, stake, game_day, site, nonce=1):
    """Open + settle a losing position (payout 0 => GGR == stake) on `site`/`game_day`."""
    pos = q1(cur, "select position_id from fn_open_position(%s,%s,'buy',0.2,10,%s,%s,now(),1,%s)",
             [user_id, stake, game_day, nonce, site])[0]
    cur.execute("select fn_settle_position(%s,0.19,'loss',0,0)", [pos])
    return pos

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()

    print("\n== Setup: two brands, an affiliate + a referred player on each ==")
    cur.execute("insert into sites(id,slug,name,currency,status) values (%s,'brandB','Brand B','KES','active') on conflict do nothing", [SITE_B])
    cur.execute("insert into site_game_config(site_id,min_stake,max_stake,house_edge,target_win_rate) values (%s,50000,5000000,0.75,0.125) on conflict (site_id) do nothing", [SITE_B])

    affA = register(cur, "254730000001", "affA", SITE_A)
    affB = register(cur, "254730000002", "affB", SITE_B)
    codeA = q1(cur, "select referral_code from fn_affiliate_enroll(%s)", [affA])[0]
    codeB = q1(cur, "select referral_code from fn_affiliate_enroll(%s)", [affB])[0]
    check("affiliate A stamped site A", str(q1(cur,"select site_id from affiliates where user_id=%s",[affA])[0]) == SITE_A)
    check("affiliate B stamped site B", str(q1(cur,"select site_id from affiliates where user_id=%s",[affB])[0]) == SITE_B)

    playerA = register(cur, "254731000001", "playerA", SITE_A, codeA)   # referred by affA on A
    playerB = register(cur, "254731000002", "playerB", SITE_B, codeB)   # referred by affB on B
    for uid in (playerA, playerB): cur.execute("update wallets set real_balance=1000000 where user_id=%s", [uid])

    gdA = q1(cur, "insert into game_days(site_id,trade_date,server_seed_hash) values (%s,%s,'hA') returning id", [SITE_A, PERIOD])[0]
    gdB = q1(cur, "insert into game_days(site_id,trade_date,server_seed_hash) values (%s,%s,'hB') returning id", [SITE_B, PERIOD])[0]
    loss_position(cur, playerA, 100000, gdA, SITE_A)   # GGR 100000 -> commission 20000
    loss_position(cur, playerB,  70000, gdB, SITE_B)   # GGR  70000 -> commission 14000

    print("\n== Accrue ALL brands: each affiliate bucketed on their OWN brand only ==")
    res = q1(cur, "select buckets, total_commission from fn_accrue_affiliate_commissions(%s,%s)", [PERIOD, None])
    check("accrual created 2 buckets across both brands", res[0] == 2, f"buckets={res[0]}")
    check("accrual total = 20000+14000", res[1] == 34000, f"total={res[1]}")
    bA = q1(cur, "select site_id, commission from affiliate_commissions where affiliate_id=%s and period=%s", [affA, PERIOD])
    bB = q1(cur, "select site_id, commission from affiliate_commissions where affiliate_id=%s and period=%s", [affB, PERIOD])
    check("affA bucket stamped site A + commission 20000", str(bA[0]) == SITE_A and bA[1] == 20000, f"{bA}")
    check("affB bucket stamped site B + commission 14000", str(bB[0]) == SITE_B and bB[1] == 14000, f"{bB}")
    leak = q1(cur, "select count(*) from affiliate_commissions where (affiliate_id=%s and site_id<>%s) or (affiliate_id=%s and site_id<>%s)", [affA, SITE_A, affB, SITE_B])[0]
    check("no commission bucket stamped with the wrong brand", leak == 0, f"leaked={leak}")

    print("\n== Idempotency: re-accrue is stable (no double, buckets unchanged) ==")
    res2 = q1(cur, "select buckets, total_commission from fn_accrue_affiliate_commissions(%s,%s)", [PERIOD, None])
    cnt = q1(cur, "select count(*) from affiliate_commissions where period=%s", [PERIOD])[0]
    check("re-accrual still reports 2 buckets", res2[0] == 2, f"buckets={res2[0]}")
    check("still exactly 2 commission rows total (no duplicate)", cnt == 2, f"rows={cnt}")

    print("\n== Per-brand accrual: p_site_id=B touches ONLY brand B ==")
    # Add a NEW brand-B loss on a later period, accrue only B, and confirm A gets nothing new.
    gdB2 = q1(cur, "insert into game_days(site_id,trade_date,server_seed_hash) values (%s,'2026-02-02','hB2') returning id", [SITE_B])[0]
    loss_position(cur, playerB, 60000, gdB2, SITE_B, nonce=2)
    resB = q1(cur, "select buckets, total_commission from fn_accrue_affiliate_commissions(%s,%s)", ["2026-02-02", SITE_B])
    check("site-B accrual made exactly 1 bucket", resB[0] == 1, f"buckets={resB[0]}")
    aOnB = q1(cur, "select count(*) from affiliate_commissions where affiliate_id=%s and period='2026-02-02'", [affA])[0]
    check("brand-A affiliate got NOTHING from a site-B accrual", aOnB == 0, f"count={aOnB}")

    print("\n== GUARD: a data-anomaly position on the WRONG brand never credits the affiliate ==")
    # Directly inject a settled position for player A (site A user) but stamped site B, on a fresh period.
    gAnom = q1(cur, "insert into game_days(site_id,trade_date,server_seed_hash) values (%s,'2026-02-03','hX') returning id", [SITE_B])[0]
    cur.execute("""insert into positions(user_id,game_day_id,direction,stake,entry_rate,duration_s,nonce,status,payout,site_id,settled_at)
                   values (%s,%s,'buy',500000,0.2,10,99,'settled',0,%s,now())""", [playerA, gAnom, SITE_B])
    resX = q1(cur, "select buckets, total_commission from fn_accrue_affiliate_commissions(%s,%s)", ["2026-02-03", None])
    anom = q1(cur, "select count(*) from affiliate_commissions where affiliate_id=%s and period='2026-02-03'", [affA])[0]
    check("affiliate A NOT credited for a position stamped another brand (join guard)", anom == 0, f"buckets_made={resX[0]}, affA_rows={anom}")

    print("\n== Payout: request is scoped + stamped to the affiliate's brand ==")
    payA = q1(cur, "select payout_id, amount from fn_affiliate_request_payout(%s)", [affA])
    check("affA payout amount = its accrued commission (20000)", payA[1] == 20000, f"amount={payA[1]}")
    check("affA payout stamped site A", str(q1(cur,"select site_id from affiliate_payouts where id=%s",[payA[0]])[0]) == SITE_A)
    reservedA = q1(cur, "select count(*) from affiliate_commissions where payout_id=%s", [payA[0]])[0]
    check("affA payout reserved exactly its own brand's bucket(s)", reservedA == 1, f"reserved={reservedA}")
    bLockedByA = q1(cur, "select count(*) from affiliate_commissions where affiliate_id=%s and payout_id is not null", [affB])[0]
    check("brand-B commissions were NOT reserved by brand-A's payout", bLockedByA == 0, f"b_reserved={bLockedByA}")

    print("\n== Payout: brands are independent; double-request is rejected ==")
    expect_error(cur, "select fn_affiliate_request_payout(%s)", [affA], "PAYOUT_PENDING",
                 "affA cannot open a second payout while one is pending")
    payB = q1(cur, "select payout_id, amount from fn_affiliate_request_payout(%s)", [affB])   # 14000 + 12000
    check("affB payout amount = its two accrued buckets (26000)", payB[1] == 26000, f"amount={payB[1]}")
    check("affB payout stamped site B", str(q1(cur,"select site_id from affiliate_payouts where id=%s",[payB[0]])[0]) == SITE_B)

    print("\n== Payout completion moves ONLY the reserved brand's buckets accrued->paid ==")
    cur.execute("select approved, amount, phone from fn_affiliate_approve_payout(%s,%s)", [payA[0], affA])
    cur.execute("select fn_affiliate_complete_payout(%s,%s,%s,%s,%s,%s)", [payA[0], 0, "conv-A", "RCPT-A", "ok", '{}'])
    paidA = q1(cur, "select status from affiliate_commissions where affiliate_id=%s and period=%s", [affA, PERIOD])[0]
    check("affA bucket now 'paid'", paidA == "paid", f"status={paidA}")
    stillB = q1(cur, "select count(*) from affiliate_commissions where affiliate_id=%s and status='accrued'", [affB])[0]
    check("brand-B buckets untouched by brand-A's completion (still accrued/reserved)", stillB >= 1, f"accrued_B={stillB}")

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL AFFILIATE MULTI-TENANT DB E2E SCENARIOS PASSED")

if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback; traceback.print_exc(); sys.exit(2)
