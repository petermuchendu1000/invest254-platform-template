#!/usr/bin/env python3
"""E2E: operators are never affiliates (docs/42 UI-12, BUGLOG #58 — migration 0159).

BEFORE (0001..0158) the gaps reproduce; AFTER (0159) every one is closed and players/marketers keep
working:
  * fn_affiliate_enroll refuses admin / platform_admin / platform_superadmin (OPERATOR_NOT_ELIGIBLE);
  * enrolment KEEPS the player's existing referral code (links already shared keep attributing);
  * a sign-up is never attributed to an operator (profile code or legacy affiliate code);
  * the instant 5% perk pays only a PLAYER referrer (was: any non-marketer, incl. operators);
  * GGR revenue share accrues only to player/marketer affiliates;
  * the role-change auto-enrol (player -> marketer) still works; 0159 re-applies cleanly.
Run: python3 packages/db/_testkit/e2e_operators_never_affiliates.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob
import psycopg2

HERE = os.path.dirname(__file__)
MIG = os.path.join(HERE, "..", "migrations")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
M0159 = os.path.join(MIG, "0159_operators_never_affiliates.sql")
SITE = "00000000-0000-0000-0000-000000000001"
PLATFORM = "10000000-0000-0000-0000-000000000001"
DB = "ui12_test"
PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

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

_phone = [254799000000]
def reg(cur, uname, code=None):
    _phone[0] += 1
    return q1(cur, "select user_id from fn_register_user(%s,%s,%s,%s,%s)", [str(_phone[0]), uname, "h" + "x" * 30, code, SITE])[0]

def profile_code(cur, uid):
    return q1(cur, "select referral_code from profiles where id=%s", [uid])[0]

def referred_by(cur, uid):
    return q1(cur, "select referred_by from profiles where id=%s", [uid])[0]

def enrol_outcome(cur, uid):
    try:   # autocommit: a failed call rolls back only itself
        q1(cur, "select referral_code from fn_affiliate_enroll(%s)", [uid]); return "ok"
    except psycopg2.Error as e:
        return str(e).split("\n")[0]

_n = [0]
def deposit(cur, user, amount=100000):
    _n[0] += 1; crid = f"CRID-ui12-{_n[0]}"
    tx = q1(cur, "select fn_create_deposit(%s,%s,%s,%s)", [user, amount, "254799000001", SITE])[0]
    q1(cur, "select fn_attach_stk(%s,%s,%s)", [tx, f"MREQ-ui12-{_n[0]}", crid])
    q1(cur, "select applied from fn_complete_deposit(%s,%s,%s,%s,%s)", [crid, 0, "verified", f"RCUI12{_n[0]}", "{}"])
    return tx

def perk_paid_to(cur, tx, who):
    return q1(cur, "select count(*) from deposit_commissions where deposit_tx_id=%s and beneficiary_user=%s and position=0", [tx, who])[0] > 0

def accrue_for(cur, affiliate, referred, period, gd_seed):
    gd = q1(cur, "insert into game_days(site_id,trade_date,server_seed_hash) values (%s,%s,%s) returning id", [SITE, period, gd_seed])[0]
    cur.execute("""insert into positions(user_id,game_day_id,direction,stake,entry_rate,duration_s,nonce,status,payout,site_id,settled_at)
                   values (%s,%s,'buy',100000,0.2,10,1,'settled',0,%s,now())""", [referred, gd, SITE])
    q1(cur, "select * from fn_accrue_affiliate_commissions(%s,%s)", [period, SITE])
    return q1(cur, "select count(*) from affiliate_commissions where affiliate_id=%s and period=%s", [affiliate, period])[0]

def scenario(cur, label, fixed):
    """Run every probe; `fixed` says which outcome is expected."""
    tag = "FIXED" if fixed else "BUG REPRODUCED"
    ops = {}
    for role in ("admin", "platform_admin", "platform_superadmin"):
        u = reg(cur, f"{label}{role[:6]}{len(ops)}")
        cur.execute("update profiles set role=%s, platform_id=%s where id=%s",
                    [role, PLATFORM if role == "platform_admin" else None, u]); ops[role] = u

    print(f"-- enrolment ({label}) --")
    for role, u in ops.items():
        out = enrol_outcome(cur, u)
        if fixed:
            check(f"{tag}: {role} cannot enrol as an affiliate", "OPERATOR_NOT_ELIGIBLE" in out, out)
        else:
            check(f"{tag}: {role} could enrol as an affiliate", out == "ok", out)

    p = reg(cur, f"{label}sharer"); shared = profile_code(cur, p)
    f1 = reg(cur, f"{label}friend1", shared)
    check(f"{label}: a player's shared link attributes before enrolment", referred_by(cur, f1) == p)
    q1(cur, "select referral_code from fn_affiliate_enroll(%s)", [p])
    aff_code = q1(cur, "select referral_code from affiliates where user_id=%s", [p])[0]
    late = reg(cur, f"{label}friend2", shared)
    if fixed:
        check(f"{tag}: enrolment keeps the player's existing code (affiliate code == shared code)", aff_code == shared, f"{aff_code} vs {shared}")
        check(f"{tag}: a link shared BEFORE enrolment still attributes after it", referred_by(cur, late) == p)
    else:
        check(f"{tag}: enrolment replaced the player's code (shared links died)", aff_code != shared and referred_by(cur, late) is None)

    print(f"-- attribution ({label}) --")
    adm = ops["admin"]
    via_profile = reg(cur, f"{label}viaadm", profile_code(cur, adm))
    # a marketer later promoted to admin keeps a (legacy) affiliate row + code
    m = reg(cur, f"{label}exmkt"); q1(cur, "select referral_code from fn_affiliate_enroll(%s)", [m])
    m_code = q1(cur, "select referral_code from affiliates where user_id=%s", [m])[0]
    cur.execute("update profiles set role='admin' where id=%s", [m])
    via_aff = reg(cur, f"{label}viaexm", m_code)
    if fixed:
        check(f"{tag}: a sign-up with an operator's profile code is not attributed to the operator", referred_by(cur, via_profile) is None)
        check(f"{tag}: a sign-up with a (now) operator's affiliate code is not attributed", referred_by(cur, via_aff) is None)
    else:
        check(f"{tag}: sign-ups were attributed to operators", referred_by(cur, via_profile) == adm and referred_by(cur, via_aff) == m)

    print(f"-- money ({label}) --")
    # instant 5% perk: an operator referrer (legacy attribution) vs a player referrer
    d_op = reg(cur, f"{label}depop"); cur.execute("update profiles set referred_by=%s where id=%s", [adm, d_op])
    tx_op = deposit(cur, d_op)
    pl = reg(cur, f"{label}plref"); d_pl = reg(cur, f"{label}deppl", profile_code(cur, pl))
    tx_pl = deposit(cur, d_pl)
    check(f"{label}: a PLAYER referrer still gets the instant 5% perk", perk_paid_to(cur, tx_pl, pl))
    if fixed:
        check(f"{tag}: an operator referrer gets no 5% perk", not perk_paid_to(cur, tx_op, adm))
    else:
        check(f"{tag}: an operator referrer was paid the 5% perk", perk_paid_to(cur, tx_op, adm))
    # GGR revenue share: the ex-marketer (now admin) with a legacy affiliate row + referred player
    r = reg(cur, f"{label}ggrref"); cur.execute("update profiles set referred_by=%s where id=%s", [m, r])
    period = "2026-03-01" if not fixed else "2026-03-02"
    n = accrue_for(cur, m, r, period, f"h-{label}")
    if fixed:
        check(f"{tag}: GGR revenue share does not accrue to an operator", n == 0, f"buckets={n}")
    else:
        check(f"{tag}: GGR revenue share accrued to an operator", n == 1, f"buckets={n}")
    # a real marketer's accrual keeps working
    mk = reg(cur, f"{label}realmk"); q1(cur, "select referral_code from fn_affiliate_enroll(%s)", [mk])
    rr = reg(cur, f"{label}mkref"); cur.execute("update profiles set referred_by=%s where id=%s", [mk, rr])
    check(f"{label}: a marketer's GGR revenue share still accrues", accrue_for(cur, mk, rr, "2026-03-0" + ("3" if not fixed else "4"), f"h2-{label}") == 1)

def main():
    print("== BEFORE (0001..0158) ==")
    b = build("0158"); scenario(b.cursor(), "pre", fixed=False); b.close()

    print("\n== AFTER (0001..0159) ==")
    a = build("0159"); ca = a.cursor(); scenario(ca, "post", fixed=True)

    print("-- role change & idempotency --")
    owner = reg(ca, "sysowner"); ca.execute("update profiles set role='platform_superadmin' where id=%s", [owner])
    t = reg(ca, "promoteme")
    q1(ca, "select 1 from fn_admin_set_user_role(%s,'platform_superadmin',%s,'marketer')", [owner, t])
    check("role change player -> marketer still auto-enrols", q1(ca, "select count(*) from affiliates where user_id=%s", [t])[0] == 1)
    try:
        ca.execute(open(M0159, encoding="utf-8").read()); check("0159 re-applies cleanly", True)
    except psycopg2.Error as e:
        check("0159 re-applies cleanly", False, str(e)[:160])
    for fn in ("fn_affiliate_enroll(uuid)", "fn_register_user(text,text,text,text,uuid)", "fn_pay_referral_commissions(uuid)",
               "fn_accrue_affiliate_commissions(date,uuid)", "fn_gen_referral_code()"):
        for role in ("anon", "authenticated"):
            ok = not q1(ca, "select has_function_privilege(%s, %s::regprocedure, 'EXECUTE')", [role, f"public.{fn}"])[0]
            check(f"{fn} not executable by {role}", ok)
    a.close()
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
