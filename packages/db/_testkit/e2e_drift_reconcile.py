#!/usr/bin/env python3
"""Production drift reconciliation e2e (DRIFT-1, BUGLOG #57 — migration 0158).

Proves that migration 0158 takes BOTH a fresh build and a faithful replica of production's drifted
state (fixtures/prod_drift_2026_09_23: the exact definitions fetched from production on 2026-09-23)
to the SAME catalog, and that the reconciled schema works:
  * A = fresh build of every migration (0001..0158);
  * B = migrations 0001..0157 + production's out-of-band state (referral_code column/index/generator,
    newer register/enrol/marketer_create, CLOBBERED accrual/payout-request, brand-less sel_own policies,
    brand-less commission index, stale pre-multi-brand overloads) + 0158;
  * A and B are identical on every public function body, policy, index, view and column;
  * functional: profile referral codes attribute, enrolment unifies the code, a payout request is
    stamped with its brand again, accrual's ON CONFLICT matches the per-brand index, stale overloads
    are gone, the generator and profile views are service_role-only;
  * 0158 re-applies cleanly on both.
Run: python3 packages/db/_testkit/e2e_drift_reconcile.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob
import psycopg2

HERE = os.path.dirname(__file__)
BASE = os.path.join(HERE, "..")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
FX = os.path.join(HERE, "fixtures", "prod_drift_2026_09_23")
MIG = os.path.join(BASE, "migrations", "0158_prod_drift_reconcile.sql")
DEFAULT_SITE = "00000000-0000-0000-0000-000000000001"
PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def build(db, upto):
    a = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); a.autocommit = True
    with a.cursor() as c:
        c.execute(f"select pg_terminate_backend(pid) from pg_stat_activity where datname='{db}' and pid<>pg_backend_pid()")
        c.execute(f"drop database if exists {db}"); c.execute(f"create database {db}")
    a.close()
    conn = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname=db); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9][0-9][0-9][0-9]_*.sql"))):
            if os.path.basename(f)[:4] <= upto:
                c.execute(open(f, encoding="utf-8").read())
    return conn

def fx(name):
    return open(os.path.join(FX, name), encoding="utf-8").read().strip().rstrip(";") + ";"

def apply_prod_drift(cur):
    """Replay production's 2026-09-23 state on top of 0001..0157."""
    cur.execute("alter table public.profiles add column if not exists referral_code text")
    cur.execute("create unique index if not exists uq_profiles_referral_code on public.profiles (referral_code)")
    cur.execute(fx("fn_gen_referral_code.prod.sql"))
    cur.execute("do $$ declare r record; begin for r in select id from public.profiles where referral_code is null loop "
                "update public.profiles set referral_code = public.fn_gen_referral_code() where id = r.id; end loop; end $$")
    for f in ("fn_register_user.prod.sql", "fn_affiliate_enroll.prod.sql", "fn_marketer_create.prod.sql",
              "fn_affiliate_request_payout.prod.sql", "fn_marketer_credit.prod.sql"):
        cur.execute(fx(f))
    # production's accrual has NO default on p_site_id (a replace cannot remove one): drop + create
    cur.execute("drop function public.fn_accrue_affiliate_commissions(date, uuid)")
    cur.execute(fx("fn_accrue_affiliate_commissions.prod.sql"))
    for v in ("v_real_profiles", "v_demo_profiles"):
        cur.execute(f"drop view if exists public.{v}")
        cur.execute(fx(f"{v}.prod.sql").replace("create or replace view", "create view", 1))
    for line in open(os.path.join(FX, "sel_own.prod.txt"), encoding="utf-8").read().strip().splitlines():
        tp, cmd, roles, qual = line.split("|")
        t = tp.split(".")[0]
        cur.execute(f"drop policy if exists sel_own on public.{t}")
        cur.execute(f"create policy sel_own on public.{t} for {cmd.lower()} to {roles} using ({qual})")
    cur.execute("drop index if exists public.uq_commission_bucket")
    cur.execute("create unique index uq_commission_bucket on public.affiliate_commissions (affiliate_id, referred_user, period)")
    # production never had the 2-argument marketer overloads
    cur.execute("drop function if exists public.fn_marketer_create(text, text)")
    cur.execute("drop function if exists public.fn_marketer_login(text, text)")
    cur.execute("set check_function_bodies = off")
    for f in sorted(glob.glob(os.path.join(FX, "stale_*.sql"))):
        cur.execute(open(f, encoding="utf-8").read().strip().rstrip(";") + ";")
    cur.execute("set check_function_bodies = on")

CATALOG = {
    "function": "select p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace "
                "where n.nspname='public' and p.prokind='f' and (p.proname like 'fn\\_%' or p.proname like 'current\\_%')",
    "policy": "select tablename||'.'||policyname, md5(coalesce(qual,'')||coalesce(with_check,'')||cmd||array_to_string(roles,',')) from pg_policies where schemaname='public'",
    "index": "select indexname, md5(indexdef) from pg_indexes where schemaname='public'",
    "view": "select c.relname, md5(pg_get_viewdef(c.oid)||coalesce(array_to_string(c.reloptions,','),'')) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='v'",
    "column": "select table_name||'.'||column_name, data_type from information_schema.columns where table_schema='public'",
}
def snapshot(cur):
    snap = {}
    for kind, sql in CATALOG.items():
        cur.execute(sql)
        snap[kind] = dict(cur.fetchall())
    return snap

def diff(a, b):
    out = []
    for kind in CATALOG:
        ka, kb = a[kind], b[kind]
        out += [f"{kind} only in fresh: {k}" for k in sorted(set(ka) - set(kb))]
        out += [f"{kind} only in prod-replica: {k}" for k in sorted(set(kb) - set(ka))]
        out += [f"{kind} differs: {k}" for k in sorted(set(ka) & set(kb)) if ka[k] != kb[k]]
    return out

def main():
    print("== B: production replica (0001..0157 + production's drift) ==")
    b = build("invest254_drift_b", "0157"); cb = b.cursor()
    apply_prod_drift(cb)
    cb.execute("select indexdef from pg_indexes where indexname='uq_commission_bucket'")
    check("replica reproduces the brand-less commission index", "site_id" not in cb.fetchone()[0])
    cb.execute("select qual from pg_policies where tablename='wallets' and policyname='sel_own'")
    check("replica reproduces the brand-less sel_own policy", "current_site" not in cb.fetchone()[0])
    cb.execute(open(MIG, encoding="utf-8").read())

    print("\n== A: fresh build (0001..0158) ==")
    a = build("invest254_drift_a", "0158"); ca = a.cursor()

    print("\n-- convergence --")
    d = diff(snapshot(ca), snapshot(cb))
    check("fresh build and reconciled production replica are IDENTICAL", not d, "; ".join(d[:12]))

    print("\n-- the reconciled schema works (on the fresh build) --")
    ca.execute("select user_id from fn_register_user('254703000001','refer_a','h'||repeat('x',30),null,%s)", [DEFAULT_SITE])
    ref = ca.fetchone()[0]
    ca.execute("select referral_code from profiles where id=%s", [ref]); code = ca.fetchone()[0]
    check("every new profile gets a referral code", bool(code) and len(code) == 7, str(code))
    ca.execute("select user_id from fn_register_user('254703000002','refd_b','h'||repeat('x',30),%s,%s)", [code, DEFAULT_SITE])
    refd = ca.fetchone()[0]
    ca.execute("select referred_by from profiles where id=%s", [refd])
    check("a player's profile code attributes the referral", ca.fetchone()[0] == ref)
    ca.execute("select referral_code from fn_affiliate_enroll(%s)", [ref]); aff_code = ca.fetchone()[0]
    ca.execute("select referral_code from profiles where id=%s", [ref])
    check("enrolment unifies the profile code with the affiliate code (production behaviour, adopted)", ca.fetchone()[0] == aff_code)
    ca.execute("insert into affiliate_commissions(affiliate_id, referred_user, period, ggr, commission, status, site_id) values (%s,%s,current_date,10000,2000,'accrued',%s)", [ref, refd, DEFAULT_SITE])
    ca.execute("select * from fn_affiliate_request_payout(%s)", [ref]); payout = ca.fetchone()[0]
    ca.execute("select site_id from affiliate_payouts where id=%s", [payout])
    check("a payout request is stamped with its brand again (F-44 checks resolve it)", str(ca.fetchone()[0]) == DEFAULT_SITE)
    try:
        ca.execute("select fn_accrue_affiliate_commissions(current_date - 1, null)")
        check("accrual's ON CONFLICT target matches the per-brand index", True)
    except psycopg2.Error as e:
        check("accrual's ON CONFLICT target matches the per-brand index", False, str(e)[:120])
    ca.execute("select count(*) from pg_policies where schemaname='public' and policyname='sel_own' and qual like '%current_site()%'")
    check("all 10 sel_own policies require the session's brand", ca.fetchone()[0] == 10)
    for sig in ("fn_create_deposit(uuid,bigint,text)", "fn_open_position(uuid,bigint,text,numeric,integer,bigint,bigint)", "fn_affiliate_payout_request(uuid)"):
        cb.execute("select to_regprocedure(%s)", [f"public.{sig}"])
        check(f"stale overload dropped in the replica: {sig}", cb.fetchone()[0] is None)
    for role in ("anon", "authenticated"):
        ca.execute("select has_function_privilege(%s,'public.fn_gen_referral_code()','EXECUTE')", [role])
        check(f"fn_gen_referral_code not executable by {role}", not ca.fetchone()[0])
        ca.execute("select has_table_privilege(%s,'public.v_real_profiles','SELECT')", [role])
        check(f"v_real_profiles not readable by {role}", not ca.fetchone()[0])

    print("\n-- idempotency --")
    for name, cur in (("fresh", ca), ("replica", cb)):
        try:
            cur.execute(open(MIG, encoding="utf-8").read()); check(f"0158 re-applies cleanly ({name})", True)
        except psycopg2.Error as e:
            check(f"0158 re-applies cleanly ({name})", False, str(e)[:160])
    d = diff(snapshot(ca), snapshot(cb))
    check("still identical after re-applying", not d, "; ".join(d[:6]))

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
