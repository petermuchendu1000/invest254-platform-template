#!/usr/bin/env python3
"""Aggressive e2e for the cross-brand marketer rollup RPCs (docs/22 Task R).

Resets a local Postgres, applies the shim + ALL migrations (incl. 0053), then exercises the
fn_platform_create_marketer_global / fn_platform_link_marketer / fn_platform_marketer_rollup RPCs:
  GATE     every rollup RPC rejects a non-platform role (admin/superadmin/marketer).
  LINK     a person's per-site affiliate rows link to ONE global identity; unknown global/affiliate
           are rejected; unlink (null) works.
  ROLLUP   per (affiliate, site) clients / GGR / commission are correct and isolated per brand;
           the linked rows share the global id + label so the console can total across sites.
  MONEY    linking is reporting-only: per-site accrual/commission rows are untouched.
  AUDIT    create + link write admin_actions rows.

Run: PGCLIENTENCODING=UTF8 python3 packages/db/_testkit/e2e_marketer_rollup.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"
ACTOR  = str(uuid.uuid4())
PS = "platform_superadmin"

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
        cur.connection.rollback(); check(name, code_substr.lower() in str(e).lower(), f"got: {str(e).strip()[:90]}")

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

_phone = [254700000000]
def reg(cur, uname, site):
    _phone[0] += 1
    return q1(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", [str(_phone[0]), uname, "h"+"x"*24, site])[0]

def enroll(cur, uid, code, site):
    cur.execute("insert into affiliates(user_id, referral_code, site_id) values (%s,%s,%s)", [uid, code, site])

def refer(cur, affiliate_uid, referred_uid):
    cur.execute("insert into referrals(affiliate_id, referred_user) values (%s,%s)", [affiliate_uid, referred_uid])

def commission(cur, affiliate_uid, referred_uid, period, ggr, comm, site):
    cur.execute("insert into affiliate_commissions(affiliate_id, referred_user, period, ggr, commission, status, site_id) values (%s,%s,%s,%s,%s,'accrued',%s)",
                [affiliate_uid, referred_uid, period, ggr, comm, site])

def seed_marketer(cur, name, site, n_clients, ggr_each, comm_each):
    """Enroll `name` as an affiliate on `site` with n_clients referred players + one commission row each."""
    aff = reg(cur, name, site)
    enroll(cur, aff, f"code_{name}", site)
    for i in range(n_clients):
        c = reg(cur, f"{name}_c{i}", site)
        refer(cur, aff, c)
        commission(cur, aff, c, "2026-05-01", ggr_each, comm_each, site)
    return aff

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()

    print("\n== GATE: rollup RPCs reject non-platform roles ==")
    for role in ("admin", "superadmin", "marketer"):
        expect_error(cur, "select fn_platform_create_marketer_global(%s,%s,'Jane')", [ACTOR, role], "NOT_AUTHORIZED", f"create rejected for {role}")
        expect_error(cur, "select * from fn_platform_marketer_rollup(%s)", [role], "NOT_AUTHORIZED", f"rollup rejected for {role}")
    expect_error(cur, "select fn_platform_link_marketer(%s,%s,%s,null)", [ACTOR, "admin", str(uuid.uuid4())], "NOT_AUTHORIZED", "link rejected for admin")
    expect_error(cur, "select fn_platform_create_marketer_global(%s,%s,'')", [ACTOR, PS], "INVALID_LABEL", "blank label rejected")

    print("\n== SETUP: two brands; one person markets on both + a single-brand marketer ==")
    site_b = q1(cur, "select fn_platform_create_site(%s,%s,'brandb','Brand B','KES','brandb.example')", [ACTOR, PS])[0]
    jane_a = seed_marketer(cur, "jane_a", SITE_A, 3, 10000, 2000)   # clients 3, ggr 30000, comm 6000
    jane_b = seed_marketer(cur, "jane_b", site_b, 5, 10000, 2000)   # clients 5, ggr 50000, comm 10000
    solo_a = seed_marketer(cur, "solo_a", SITE_A, 2, 4000, 800)     # clients 2, ggr 8000, comm 1600

    print("\n== LINK: bind Jane's two per-site rows to one global identity ==")
    gid = q1(cur, "select fn_platform_create_marketer_global(%s,%s,'Jane Doe')", [ACTOR, PS])[0]
    check("create returns a global marketer id", gid is not None)
    expect_error(cur, "select fn_platform_link_marketer(%s,%s,%s,%s)", [ACTOR, PS, jane_a, str(uuid.uuid4())], "MARKETER_GLOBAL_NOT_FOUND", "link to unknown global rejected")
    expect_error(cur, "select fn_platform_link_marketer(%s,%s,%s,%s)", [ACTOR, PS, str(uuid.uuid4()), gid], "NOT_AFFILIATE", "link of a non-affiliate rejected")
    q1(cur, "select fn_platform_link_marketer(%s,%s,%s,%s)", [ACTOR, PS, jane_a, gid])
    q1(cur, "select fn_platform_link_marketer(%s,%s,%s,%s)", [ACTOR, PS, jane_b, gid])

    print("\n== ROLLUP: per (affiliate, site) facts, grouped by the global identity ==")
    cur.execute("select marketer_global_id, label, affiliate_user_id, site_id, site_slug, clients, ggr_cents, commission_cents from fn_platform_marketer_rollup(%s)", [PS])
    rows = {str(r[2]): r for r in cur.fetchall()}
    ra, rb, rs = rows.get(str(jane_a)), rows.get(str(jane_b)), rows.get(str(solo_a))
    check("jane_a row: linked to global + brand A facts", ra is not None and str(ra[0]) == str(gid) and ra[1] == "Jane Doe" and ra[5] == 3 and ra[6] == 30000 and ra[7] == 6000, f"{ra}")
    check("jane_b row: linked to same global + brand B facts", rb is not None and str(rb[0]) == str(gid) and rb[5] == 5 and rb[6] == 50000 and rb[7] == 10000, f"{rb}")
    check("jane rows are on different brands", ra is not None and rb is not None and str(ra[3]) != str(rb[3]))
    check("solo marketer stays unlinked (null global)", rs is not None and rs[0] is None and rs[5] == 2 and rs[6] == 8000, f"{rs}")
    # Cross-brand total for the global identity: clients 8, ggr 80000, commission 16000.
    linked = [r for r in (ra, rb) if r]
    tot_clients = sum(r[5] for r in linked); tot_ggr = sum(r[6] for r in linked); tot_comm = sum(r[7] for r in linked)
    check("global marketer totals across sites", (tot_clients, tot_ggr, tot_comm) == (8, 80000, 16000), f"({tot_clients},{tot_ggr},{tot_comm})")

    print("\n== MONEY: linking is reporting-only (per-site accrual untouched) ==")
    cur.execute("select site_id, sum(commission) from affiliate_commissions group by site_id")
    csum = {str(r[0]): int(r[1]) for r in cur.fetchall()}
    check("brand A commission unchanged by the link", csum.get(SITE_A) == 6000 + 1600, f"A={csum.get(SITE_A)}")
    check("brand B commission unchanged by the link", csum.get(str(site_b)) == 10000, f"B={csum.get(str(site_b))}")

    print("\n== UNLINK: null detaches jane_a from the global identity ==")
    q1(cur, "select fn_platform_link_marketer(%s,%s,%s,null)", [ACTOR, PS, jane_a])
    cur.execute("select marketer_global_id from fn_platform_marketer_rollup(%s) where affiliate_user_id=%s", [PS, jane_a])
    check("jane_a unlinked (null global) after unlink", q1(cur, "select marketer_global_id from affiliates where user_id=%s", [jane_a])[0] is None)

    print("\n== AUDIT: create + link recorded ==")
    n_create = q1(cur, "select count(*) from admin_actions where action='platform.marketer.create'")[0]
    n_link = q1(cur, "select count(*) from admin_actions where action='platform.marketer.link'")[0]
    check("platform.marketer.create audited", n_create >= 1, f"count={n_create}")
    check("platform.marketer.link audited (2 links + 1 unlink)", n_link >= 3, f"count={n_link}")

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL MARKETER-ROLLUP DB E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
