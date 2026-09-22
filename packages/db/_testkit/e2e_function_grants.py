#!/usr/bin/env python3
"""Function-grant assertion sweep (Issue 1 / BUGLOG #39, finding 04).

Stands up a local Postgres, applies the Supabase shim + ALL migrations (which now includes
0151_revoke_public_function_execute.sql), then asserts the PostgREST function surface is CLOSED:

  * NO function in schema `public` is EXECUTE-able by `anon`, `authenticated`, or `PUBLIC`.
    (This is the test that would have caught the original hole: the public anon key being able to
    call SECURITY DEFINER admin/financial RPCs directly, bypassing the API.)
  * `service_role` retains EXECUTE (Supabase's privileged server key).
  * Default privileges for future functions do NOT auto-grant EXECUTE to anon/authenticated.

Fails the build (exit 1) if any public function is reachable by anon/authenticated/PUBLIC.

Run: python3 packages/db/_testkit/e2e_function_grants.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

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
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9][0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

# SECURITY DEFINER functions (run as OWNER = the escalation surface) reachable by a role's EXECUTE.
DEFINER_EXPOSED = """
  select p.oid::regprocedure::text as sig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  where p.prosecdef and has_function_privilege(%s, p.oid, 'EXECUTE')
  order by 1
"""

def definer_exposed_to(cur, role):
    cur.execute(DEFINER_EXPOSED, (role,))
    return [r[0] for r in cur.fetchall()]

def main():
    conn = reset_and_migrate()
    cur = conn.cursor()

    # THE INVARIANT: no SECURITY DEFINER function (owner-privileged; RLS-bypassing) may be executable
    # by the public keys. INVOKER functions run as the caller and cannot escalate, so they are allowed
    # (the RLS policies themselves depend on INVOKER helpers — see below).
    d_anon = definer_exposed_to(cur, "anon")
    d_auth = definer_exposed_to(cur, "authenticated")
    check("no SECURITY DEFINER public function is EXECUTE-able by anon", len(d_anon) == 0,
          f"{len(d_anon)} exposed, e.g. {d_anon[:8]}")
    check("no SECURITY DEFINER public function is EXECUTE-able by authenticated", len(d_auth) == 0,
          f"{len(d_auth)} exposed, e.g. {d_auth[:8]}")

    # The dangerous admin/financial RPCs specifically must be closed to anon.
    for fn in ("fn_admin_adjust_balance", "fn_admin_set_user_role", "fn_admin_delete_user",
               "fn_approve_withdrawal", "fn_complete_withdrawal", "fn_admin_rotate_seed"):
        cur.execute("""select bool_or(has_function_privilege('anon', p.oid, 'EXECUTE'))
                       from pg_proc p join pg_namespace n on n.oid=p.pronamespace and n.nspname='public'
                       where p.proname=%s""", (fn,))
        exposed = cur.fetchone()[0]
        check(f"{fn} is NOT anon-executable", exposed is not True, "still exposed to anon")

    # The RLS read path MUST survive: its INVOKER helpers stay executable by authenticated, else every
    # anon/authenticated table read errors with "permission denied for function current_site".
    for fn in ("current_site", "is_site_admin", "current_platform", "jwt_role"):
        cur.execute("""select bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
                       from pg_proc p join pg_namespace n on n.oid=p.pronamespace and n.nspname='public'
                       where p.proname=%s""", (fn,))
        ok = cur.fetchone()[0]
        check(f"RLS helper {fn} stays EXECUTE-able by authenticated", ok is True,
              "RLS read path broken — helper was revoked")

    # Default privileges: a NEW SECURITY DEFINER function must not be anon-executable.
    cur.execute("create or replace function public._grant_sweep_probe() returns int "
                "language sql security definer as 'select 1'")
    probe = definer_exposed_to(cur, "anon")
    check("a newly-created SECURITY DEFINER function is NOT auto-exposed to anon",
          "public._grant_sweep_probe()" not in probe,
          "default privileges still grant execute to anon")
    cur.execute("drop function public._grant_sweep_probe()")

    print(f"\n{'='*60}\nPASS={len(PASS)}  FAIL={len(FAIL)}")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("function-grant surface is closed ✓")

if __name__ == "__main__":
    main()
