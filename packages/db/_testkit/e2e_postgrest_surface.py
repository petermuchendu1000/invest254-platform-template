#!/usr/bin/env python3
"""Adversarial PostgREST TABLE/VIEW surface e2e (Issue 1 / BUGLOG #42 — migration 0153).

WHY THIS HARNESS IS DIFFERENT: every other e2e applies the shim, then the migrations, and only
afterwards grants SELECT to anon/authenticated. Production Supabase is harsher: DEFAULT PRIVILEGES
grant ALL (SELECT/INSERT/UPDATE/DELETE/TRUNCATE) on every new public table, view and sequence to
anon + authenticated AT CREATION TIME. This harness reproduces that posture BEFORE applying the
migrations, so it tests exactly what the public anon key can do in production.

It seeds two platforms (P1: sites A1+A2, P2: site B1) with players, a platform admin, marketers
(+PIN hashes, wallets), audit rows, logs, tickets and pool rows, then attacks as:
  * anon                      (the public anon key, no user)
  * authenticated, claimless  (what a Supabase-Auth self-signup JWT carries)
and proves: zero rows readable from EVERY public table and view, and every write/TRUNCATE refused.
It also proves the defense-in-depth design still works (a player reads only itself — now also
THROUGH views; a platform_admin reads only its platform; `sites` exposes only (id, platform_id)),
the application (owner) path is unaffected, the fix is idempotent, future tables are not
auto-writable, and the fail-closed ownership guard fires.

Run:  python3 packages/db/_testkit/e2e_postgrest_surface.py            (expects 0153 applied)
      E2E_UPTO=0152 python3 packages/db/_testkit/e2e_postgrest_surface.py   (demonstrates the hole: MUST FAIL)
Needs a local PG on /tmp:5433.
"""
import os, sys, glob, uuid
import psycopg2

DB = "invest254_postgrest"
DSN = dict(host="/tmp", port=5433, user="postgres", dbname=DB)
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
MIG_0153 = os.path.join(BASE, "migrations", "0153_postgrest_table_surface_lockdown.sql")
UPTO = os.environ.get("E2E_UPTO")  # e.g. "0152" to build the pre-fix schema
SYS = "platform_superadmin"

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def build():
    a = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); a.autocommit = True
    with a.cursor() as c:
        c.execute(f"select pg_terminate_backend(pid) from pg_stat_activity where datname='{DB}' and pid<>pg_backend_pid()")
        c.execute(f"drop database if exists {DB}"); c.execute(f"create database {DB}")
    a.close()
    conn = psycopg2.connect(**DSN); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        # >>> Supabase's production default-privilege posture (the whole point of this harness) <<<
        c.execute("""
          grant usage on schema public to anon, authenticated, service_role;
          alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
          alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
          alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
        """)
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9][0-9][0-9][0-9]_*.sql"))):
            if UPTO and os.path.basename(f)[:4] > UPTO:
                continue
            c.execute(open(f, encoding="utf-8").read())
    return conn

def register(cur, phone, username, site):
    cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, username, "x" * 32, site])
    return str(q1(cur, "select id from profiles where site_id=%s and phone=%s", [site, phone])[0])

def relations(cur, kinds):
    cur.execute("""select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
                   where n.nspname='public' and c.relkind = any(%s) order by 1""", [list(kinds)])
    return [r[0] for r in cur.fetchall()]

def as_role(conn, role, claims, fn):
    """Run fn(cur) inside a transaction as `role` with JWT claim GUCs; always rolled back."""
    with conn.cursor() as cur:
        cur.execute("begin"); cur.execute(f"set local role {role}")
        for k, v in claims.items():
            cur.execute("select set_config(%s, %s, true)", [f"request.jwt.claim.{k}", v or ""])
        try:
            return fn(cur)
        finally:
            cur.execute("rollback")  # autocommit conn + explicit BEGIN: conn.rollback() would be a no-op

def visible(conn, role, claims, rel):
    """Row count visible to the role, or 'DENIED' on a privilege error (also a pass)."""
    def f(cur):
        try:
            cur.execute(f'select count(*) from public."{rel}"'); return cur.fetchone()[0]
        except psycopg2.errors.InsufficientPrivilege:
            return "DENIED"
        except psycopg2.Error as e:          # any other refusal still returns no data
            return "DENIED"
    return as_role(conn, role, claims, f)

def attempt(conn, role, claims, sql):
    """Returns 'DENIED' if refused, else the number of rows affected (0 == RLS filtered it out)."""
    def f(cur):
        try:
            cur.execute(sql); return cur.rowcount
        except (psycopg2.errors.InsufficientPrivilege, psycopg2.errors.lookup("42501")):
            return "DENIED"
        except psycopg2.Error as e:
            return f"ERR:{e.pgcode}"
    return as_role(conn, role, claims, f)

def main():
    print(f"== Build: Supabase default-privilege posture + migrations{' up to ' + UPTO if UPTO else ' (all)'} ==")
    conn = build(); cur = conn.cursor()
    ACTOR = str(uuid.uuid4())

    print("\n== Seed: P1{A1,A2} and P2{B1} with real data in the sensitive tables ==")
    p1 = str(q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "alpha", "Alpha"])[0])
    p2 = str(q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "beta", "Beta"])[0])
    for pid in (p1, p2):
        q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [ACTOR, SYS, pid, "enterprise"])
        q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [ACTOR, SYS, pid, "active", "test"])
    mk = lambda slug: str(q1(cur, "select fn_platform_create_site(%s,%s,%s,%s,%s,%s)", [ACTOR, SYS, slug, slug.upper(), "KES", f"{slug}.test"])[0])
    a1, a2, b1 = mk("a1"), mk("a2"), mk("b1")
    for s, p in ((a1, p1), (a2, p1), (b1, p2)):
        q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, s, p])
    plA1 = register(cur, "254711000001", "plA1", a1)
    plB1 = register(cur, "254711000002", "plB1", b1)
    pa1 = register(cur, "254711000003", "pa1", a1)
    q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [ACTOR, SYS, pa1, p1])
    for u, s in ((plA1, a1), (plB1, b1)):
        cur.execute("insert into transactions(user_id, kind, amount, phone, site_id, status) values (%s,'deposit',10000,'254700',%s,'success')", [u, s])
    for s, name, phone in ((a1, "MarkA", "254722000001"), (b1, "MarkB", "254722000002")):
        m = str(q1(cur, "insert into marketers(name, phone, site_id) values (%s,%s,%s) returning id", [name, phone, s])[0])
        cur.execute("insert into marketer_credentials(marketer_id, pin_hash) values (%s, 'scrypt$fakehash')", [m])
        cur.execute("insert into marketer_wallets(marketer_id, balance_cents) values (%s, 500000) on conflict (marketer_id) do update set balance_cents=500000", [m])
        cur.execute("insert into admin_actions(actor_id, actor_role, action, target_type, site_id) values (%s,%s,'seed','site',%s)", [ACTOR, SYS, s])
        cur.execute("insert into withdrawal_pool(site_id, trade_day, amount_cents) values (%s, current_date, 100000) on conflict do nothing", [s])
    cur.execute("insert into system_logs(level, msg, site_id, ip) values ('info','seed',%s,'10.0.0.1')", [a1])
    cur.execute("insert into tickets(platform_id, site_id, created_by, created_by_role, subject, urgency) values (%s,%s,%s,'admin','seed','low')", [p1, a1, pa1])
    tables = relations(cur, "rp"); views = relations(cur, "v"); seqs = relations(cur, "S")
    owner_counts = {r: q1(cur, f'select count(*) from public."{r}"')[0] for r in tables + views}
    seeded = [r for r in tables + views if owner_counts[r] > 0]
    check(f"seeded data present in {len(seeded)} of {len(tables)+len(views)} relations (incl. the sensitive ones)",
          all(owner_counts[r] > 0 for r in ("sites", "platforms", "marketers", "marketer_credentials", "marketer_wallets",
                                              "admin_actions", "system_logs", "tickets", "withdrawal_pool", "profiles", "v_real_profiles")))

    print("\n== A. Structure: RLS on every table; every view is security_invoker ==")
    cur.execute("""select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
                   where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity order by 1""")
    off = [r[0] for r in cur.fetchall()]
    check("every public table has RLS enabled", not off, f"{len(off)} without RLS: {', '.join(off[:12])}{'…' if len(off) > 12 else ''}")
    cur.execute("""select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
                   where n.nspname='public' and c.relkind='v'
                     and coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'false') <> 'true'""")
    owner_views = [r[0] for r in cur.fetchall()]
    check("every public view is security_invoker (cannot bypass RLS)", not owner_views, f"{len(owner_views)} owner-run: {', '.join(owner_views)}")

    print("\n== B. Privileges: no writes / TRUNCATE / sequence access for the public roles ==")
    for role in ("anon", "authenticated"):
        bad_w = [t for t in tables + views
                 if any(q1(cur, "select has_table_privilege(%s, %s, %s)", [role, f'public."{t}"', p])[0] for p in ("INSERT", "UPDATE", "DELETE"))
                 and t != "push_subscriptions"]
        check(f"{role}: no INSERT/UPDATE/DELETE on any table/view (except push_subscriptions own-row)", not bad_w, f"{len(bad_w)}: {', '.join(bad_w[:10])}")
        bad_t = [t for t in tables if q1(cur, "select has_table_privilege(%s, %s, 'TRUNCATE')", [role, f'public."{t}"'])[0]]
        check(f"{role}: no TRUNCATE anywhere (TRUNCATE ignores RLS)", not bad_t, f"{len(bad_t)}: {', '.join(bad_t[:10])}")
        bad_s = [s for s in seqs if q1(cur, "select has_sequence_privilege(%s, %s, 'USAGE') or has_sequence_privilege(%s, %s, 'UPDATE')", [role, f'public."{s}"', role, f'public."{s}"'])[0]]
        check(f"{role}: no sequence USAGE/UPDATE", not bad_s, f"{len(bad_s)}: {', '.join(bad_s[:10])}")
    check("sites: anon has no table-level SELECT", not q1(cur, "select has_table_privilege('anon','public.sites','SELECT')")[0])
    check("sites: authenticated has no table-level SELECT (column-minimal only)", not q1(cur, "select has_table_privilege('authenticated','public.sites','SELECT')")[0])

    print("\n== C. Attack as ANON (public key): zero rows from EVERY table and view ==")
    leaks = {r: n for r in tables + views if (n := visible(conn, "anon", {}, r)) not in (0, "DENIED")}
    check(f"anon reads 0 rows from all {len(tables)} tables + {len(views)} views", not leaks, f"LEAKS: {leaks}")

    print("\n== D. Attack as AUTHENTICATED with a claimless Supabase-signup JWT ==")
    stranger = {"sub": str(uuid.uuid4()), "role": "authenticated"}
    leaks = {r: n for r in tables + views if (n := visible(conn, "authenticated", stranger, r)) not in (0, "DENIED")}
    check(f"claimless authenticated reads 0 rows from all {len(tables)+len(views)} relations", not leaks, f"LEAKS: {leaks}")

    print("\n== E. Write attacks (money, kill switches, audit trail) ==")
    attacks = {
        "credit a marketer wallet": "update marketer_wallets set balance_cents = balance_cents + 99999999",
        "flip platform kill switch": "update platform_global_config set withdrawals_enabled = false",
        "rewrite a brand's economy": "update site_game_config set house_edge = 0.0",
        "inflate the withdrawal pool": "update withdrawal_pool set amount_cents = 999999999",
        "forge an audit row": f"insert into admin_actions(actor_id, actor_role, action, target_type) values ('{ACTOR}','platform_superadmin','forged','x')",
        "erase the audit trail": "delete from admin_actions",
        "TRUNCATE system logs": "truncate system_logs",
        "re-parent a brand": f"update sites set platform_id = '{p2}'",
        "mint a platform": "insert into platforms(slug, name) values ('evil','Evil')",
        "reset a marketer PIN": "update marketer_credentials set pin_hash = 'x', failed_attempts = 0",
        "change a player's role via view": "update v_real_profiles set role = 'platform_superadmin'",
    }
    for role, claims in (("anon", {}), ("authenticated", stranger)):
        for name, sql in attacks.items():
            res = attempt(conn, role, claims, sql)
            check(f"{role}: cannot {name}", res in ("DENIED", 0), f"got {res}")
    check("owner data intact after attacks (rolled back / refused)",
          q1(cur, "select count(*) from admin_actions where action='forged'")[0] == 0 and q1(cur, "select min(balance_cents) from marketer_wallets")[0] == 500000)

    print("\n== F. Defense-in-depth design still holds (now also THROUGH views) ==")
    me = {"sub": plA1, "site": a1, "role": "authenticated"}
    check("player reads exactly its own profile via profiles", visible(conn, "authenticated", me, "profiles") == 1)
    # v_real_*/v_demo_* classify marketers via fn_is_marketer_account (SECURITY DEFINER, not
    # executable by public roles since 0151), so via PostgREST they FAIL CLOSED (denied). The only
    # safe outcomes are "own rows only" or "denied" — never another user's row.
    v = visible(conn, "authenticated", me, "v_real_profiles")
    check("player via v_real_profiles: own row only or denied (never others)", v in (1, "DENIED"), f"got {v}")
    check("player reads 0 marketer rows via marketer_profiles view", visible(conn, "authenticated", me, "marketer_profiles") in (0, "DENIED"))
    pa = {"sub": pa1, "role": "platform_admin", "platform": p1}
    n_p1 = q1(cur, "select count(*) from profiles p join sites s on s.id=p.site_id where s.platform_id=%s", [p1])[0]
    check(f"platform_admin P1 reads all {n_p1} P1 profiles via RLS", visible(conn, "authenticated", pa, "profiles") == n_p1)
    v = visible(conn, "authenticated", pa, "v_real_profiles")
    check("platform_admin P1 via v_real_profiles: own platform only or denied", v in (q1(cur, "select count(*) from v_real_profiles p join sites s on s.id=p.site_id where s.platform_id=%s", [p1])[0], "DENIED"), f"got {v}")
    got = as_role(conn, "authenticated", pa, lambda c: (c.execute("select id::text, platform_id::text from sites order by 1"), c.fetchall())[1])
    check("platform_admin P1 sees ONLY P1 sites' (id, platform_id)", sorted(r[0] for r in got) == sorted([a1, a2]) and all(r[1] == p1 for r in got), str(got))
    def read_name(c):
        try:
            c.execute("select name from sites limit 1"); return "READ"
        except psycopg2.errors.InsufficientPrivilege:
            return "DENIED"
    check("sites brand config columns are NOT readable via RLS path", as_role(conn, "authenticated", pa, read_name) == "DENIED")
    sa = {"sub": str(uuid.uuid4()), "role": "admin", "site": b1}
    check("site admin B1 reads only B1 profiles", visible(conn, "authenticated", sa, "profiles") == q1(cur, "select count(*) from profiles where site_id=%s", [b1])[0])
    check("platform_admin with NO platform claim fails closed on sites", visible(conn, "authenticated", {"sub": pa1, "role": "platform_admin"}, "sites") == 0)

    print("\n== G. Application path (table owner) is unaffected ==")
    after = {r: q1(cur, f'select count(*) from public."{r}"')[0] for r in tables + views}
    check("owner sees identical row counts in every relation", after == owner_counts,
          str({k: (owner_counts[k], after[k]) for k in after if after[k] != owner_counts[k]}))
    try:
        cur.execute("update marketer_wallets set balance_cents = balance_cents where true")
        cur.execute("select fn_platform_update_platform(%s,%s,%s,%s::jsonb)", [ACTOR, SYS, p1, '{"name":"Alpha2"}'])
        check("owner writes + SECURITY DEFINER RPCs still work", True)
    except Exception as e:
        check("owner writes + SECURITY DEFINER RPCs still work", False, str(e)[:120])

    print("\n== H. Future-proofing, idempotency, fail-closed guard ==")
    cur.execute("create table public.zz_future(x int)")
    fut = [p for p in ("INSERT", "UPDATE", "DELETE", "TRUNCATE") if q1(cur, "select has_table_privilege('anon','public.zz_future',%s)", [p])[0]]
    check("a FUTURE table is not auto-writable/truncatable by anon", not fut, f"anon has {fut}")
    cur.execute("drop table public.zz_future")
    if not UPTO:
        try:
            cur.execute(open(MIG_0153, encoding="utf-8").read()); check("0153 re-applies cleanly (idempotent)", True)
        except Exception as e:
            check("0153 re-applies cleanly (idempotent)", False, str(e)[:120])
        guard = open(MIG_0153, encoding="utf-8").read().split("-- 1..3)")[0]
        cur.execute("do $$ begin if not exists (select 1 from pg_roles where rolname='mig_probe') then create role mig_probe nobypassrls; end if; end $$")
        cur.execute("begin"); cur.execute("set local role mig_probe")
        try:
            cur.execute(guard); cur.execute("rollback"); check("ownership guard BLOCKS a role that neither owns nor bypasses RLS", False, "no error")
        except psycopg2.Error as e:
            cur.execute("rollback"); check("ownership guard BLOCKS a role that neither owns nor bypasses RLS", "BLOCKED (0153)" in str(e), str(e)[:100])

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
