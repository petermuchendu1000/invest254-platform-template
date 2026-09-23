#!/usr/bin/env python3
"""Marketer-expense brand scope e2e (Issue 1 / F-44, BUGLOG #44 — migration 0154).

Builds the schema up to 0153, reproduces the production defect (an expense stamped on the ADMIN's
brand while the marketer lives on another brand, and a cross-brand "expense" cutting a foreign
marketer's withdrawable), then applies 0154 and proves:
  * an expense for a marketer on a different brand than p_site is refused (MARKETER_SITE_MISMATCH);
  * an unknown marketer is refused (MARKETER_NOT_FOUND);
  * the legitimate path still works and is audited on the marketer's brand;
  * existing mis-stamped rows are re-stamped to the marketer's brand, amounts and the marketer's
    expense total unchanged; re-applying 0154 is a no-op.
Run: python3 packages/db/_testkit/e2e_marketer_expense_scope.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid
import psycopg2

DB = "invest254_expense_scope"
DSN = dict(host="/tmp", port=5433, user="postgres", dbname=DB)
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
MIG_0154 = os.path.join(BASE, "migrations", "0154_marketer_expense_brand_scope.sql")
SYS = "platform_superadmin"
PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def expect_error(cur, sql, args, code, name):
    try:
        cur.execute(sql, args); check(name, False, "no error raised")
    except Exception as e:
        check(name, code in str(e), str(e).strip()[:100])

def build(upto):
    a = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); a.autocommit = True
    with a.cursor() as c:
        c.execute(f"select pg_terminate_backend(pid) from pg_stat_activity where datname='{DB}' and pid<>pg_backend_pid()")
        c.execute(f"drop database if exists {DB}"); c.execute(f"create database {DB}")
    a.close()
    conn = psycopg2.connect(**DSN); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9][0-9][0-9][0-9]_*.sql"))):
            if os.path.basename(f)[:4] <= upto:
                c.execute(open(f, encoding="utf-8").read())
    return conn

def register(cur, phone, username, site):
    cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, username, "x" * 32, site])
    return str(q1(cur, "select id from profiles where site_id=%s and phone=%s", [site, phone])[0])

def main():
    print("== Build up to 0153 and reproduce the production defect ==")
    conn = build("0153"); cur = conn.cursor()
    actor = str(uuid.uuid4())
    home = "00000000-0000-0000-0000-000000000001"
    other = str(q1(cur, "select fn_platform_create_site(%s,%s,%s,%s,%s,%s)", [actor, SYS, "madolar", "Madolar", "KES", "madolar.test"])[0])
    m_other = register(cur, "254733000001", "markB", other)
    # Pre-fix: the owner's expense for a brand-B marketer landed on its HOME brand (as seen in prod).
    cur.execute("select id from fn_admin_add_marketer_expense(%s,%s,%s,%s,%s,%s,%s)", [actor, SYS, home, m_other, "advance", 365000, "prod-like"])
    # Pre-fix: a brand-A site admin can even log an expense against brand B's marketer.
    cur.execute("select id from fn_admin_add_marketer_expense(%s,%s,%s,%s,%s,%s,%s)", [actor, "admin", home, m_other, "other", 50000, "sabotage"])
    total_before = q1(cur, "select fn_marketer_expenses_total(%s)", [m_other])[0]
    check("pre-fix: 2 expenses mis-stamped on the admin's brand (defect reproduced)",
          q1(cur, "select count(*) from marketer_expenses where marketer_user_id=%s and site_id=%s", [m_other, home])[0] == 2)

    print("\n== Apply 0154 ==")
    cur.execute(open(MIG_0154, encoding="utf-8").read())
    check("mis-stamped rows re-stamped to the marketer's brand",
          q1(cur, "select count(*) from marketer_expenses where marketer_user_id=%s and site_id<>%s", [m_other, other])[0] == 0)
    check("amounts untouched: marketer's expense total unchanged",
          q1(cur, "select fn_marketer_expenses_total(%s)", [m_other])[0] == total_before, f"before={total_before}")

    print("\n== The RPC now refuses cross-brand expenses ==")
    expect_error(cur, "select fn_admin_add_marketer_expense(%s,%s,%s,%s,%s,%s,%s)", [actor, "admin", home, m_other, "other", 100, None],
                 "MARKETER_SITE_MISMATCH", "brand-A expense against a brand-B marketer is refused")
    r = q1(cur, "select site_id from fn_admin_add_marketer_expense(%s,%s,%s,%s,%s,%s,%s)", [actor, SYS, home, m_other, "other", 100, None])
    check("system owner's expense is NORMALISED onto the marketer's brand (old-API compatible, never mis-stamped)", str(r[0]) == other, str(r[0]))
    expect_error(cur, "select fn_admin_add_marketer_expense(%s,%s,%s,%s,%s,%s,%s)", [actor, "admin", home, str(uuid.uuid4()), "other", 100, None],
                 "MARKETER_NOT_FOUND", "unknown marketer is refused")
    expect_error(cur, "select fn_admin_add_marketer_expense(%s,%s,%s,%s,%s,%s,%s)", [actor, "player", other, m_other, "other", 100, None],
                 "NOT_AUTHORIZED", "non-admin actor still refused")

    print("\n== The legitimate path still works ==")
    before = q1(cur, "select fn_marketer_expenses_total(%s)", [m_other])[0]
    check("no row was ever stamped off the marketer's brand after 0154",
          q1(cur, "select count(*) from marketer_expenses e join profiles p on p.id=e.marketer_user_id where e.site_id<>p.site_id")[0] == 0)
    r = q1(cur, "select site_id, amount_cents from fn_admin_add_marketer_expense(%s,%s,%s,%s,%s,%s,%s)", [actor, "admin", other, m_other, "fuel", 1200, "ok"])
    check("same-brand expense accepted on the marketer's brand", str(r[0]) == other and r[1] == 1200)
    check("expense total increases by exactly the amount", q1(cur, "select fn_marketer_expenses_total(%s)", [m_other])[0] == before + 1200)
    check("audited on the marketer's brand",
          q1(cur, "select count(*) from admin_actions where action='marketer.expense.add' and target_id=%s and site_id=%s", [m_other, other])[0] >= 1)

    print("\n== Idempotency + grants ==")
    try:
        cur.execute(open(MIG_0154, encoding="utf-8").read()); check("0154 re-applies cleanly", True)
    except Exception as e:
        check("0154 re-applies cleanly", False, str(e)[:100])
    check("anon/authenticated cannot EXECUTE the RPC",
          not q1(cur, "select has_function_privilege('anon','fn_admin_add_marketer_expense(uuid,text,uuid,uuid,text,bigint,text)','EXECUTE') or has_function_privilege('authenticated','fn_admin_add_marketer_expense(uuid,text,uuid,uuid,text,bigint,text)','EXECUTE')")[0])

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
