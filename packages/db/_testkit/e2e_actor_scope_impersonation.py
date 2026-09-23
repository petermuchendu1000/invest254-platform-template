#!/usr/bin/env python3
"""Actor scope: impersonation + DB-level brand fence e2e (Issue 1 / F-46, BUGLOG #46 — migration 0156).

Topology chosen to make any home-brand leak unmistakable:
  platform P1 = {A1, A2}      platform P2 = {B1}
  pa1   : platform_admin of P1 whose HOME brand is B1 (on the OTHER platform)
  saA1  : genuine site admin of A1
  demo  : a DEMOTED admin (profile role 'player') still acting with role 'admin' (stale token)
  owner : platform_superadmin (home brand = default site)
Proves, against the pre-0156 schema (defects reproduced) and the post-0156 schema:
  * FENCE: site-tier actors are confined to their permission set on the user/brand/advance RPCs;
    platform tiers are unchanged;
  * TARGETING: impersonated bulk actions never land on the impersonator's home brand — without a named
    brand (old API) they reach nobody; with the token's brand named (new API) exactly that brand;
  * category clear (3-arg old / 4-arg new), ticket creation, add-on permission;
  * the 17 fenced RPC bodies differ from their previous definitions by EXACTLY the one guard line.
Run: python3 packages/db/_testkit/e2e_actor_scope_impersonation.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid, json
import psycopg2

DB = "invest254_actor_scope"
DSN = dict(host="/tmp", port=5433, user="postgres", dbname=DB)
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
MIG = os.path.join(BASE, "migrations", "0156_actor_scope_impersonation_and_db_fence.sql")
DEFAULT_SITE = "00000000-0000-0000-0000-000000000001"
SYS = "platform_superadmin"
FENCED = ["fn_admin_adjust_balance", "fn_admin_adjust_balance_kind", "fn_admin_clear_balance", "fn_admin_delete_user",
          "fn_admin_reset_balance_to_last_funded", "fn_admin_set_commission_rate", "fn_admin_set_user_overrides",
          "fn_admin_set_user_role", "fn_admin_set_user_status", "fn_admin_update_user", "fn_admin_set_default_pool",
          "fn_admin_set_pool_mode", "fn_admin_set_site_game_config", "fn_admin_set_withdrawal_pool",
          "fn_admin_set_withdrawals_enabled", "fn_admin_decide_advance", "fn_admin_set_site_owner"]
PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def outcome(cur, sql, args):
    """'OK' or the raised exception code text (autocommit connection)."""
    try:
        cur.execute(sql, args); return "OK"
    except psycopg2.Error as e:
        return (e.diag.message_primary or str(e)).strip()

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

def seed(cur):
    owner = register(cur, "254701000001", "owner", DEFAULT_SITE)
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [owner])
    p1 = str(q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [owner, SYS, "p1", "P1"])[0])
    p2 = str(q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [owner, SYS, "p2", "P2"])[0])
    for p in (p1, p2):
        q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [owner, SYS, p, "enterprise"])
        q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [owner, SYS, p, "active", "test"])
    mk = lambda slug: str(q1(cur, "select fn_platform_create_site(%s,%s,%s,%s,%s,%s)", [owner, SYS, slug, slug.upper(), "KES", f"{slug}.test"])[0])
    a1, a2, b1 = mk("a1"), mk("a2"), mk("b1")
    for s, p in ((a1, p1), (a2, p1), (b1, p2)):
        q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [owner, SYS, s, p])
    pl = {k: register(cur, f"25470100{i:04d}", f"pl{k}", s) for i, (k, s) in enumerate((("A1", a1), ("A2", a2), ("B1", b1)), start=10)}
    pa1 = register(cur, "254701000100", "pa1", b1)                  # HOME brand on the OTHER platform
    q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [owner, SYS, pa1, p1])
    saA1 = register(cur, "254701000200", "saA1", a1)
    cur.execute("update profiles set role='admin' where id=%s", [saA1])
    demo = register(cur, "254701000300", "demo", a1)               # profile stays 'player'
    for u in pl.values():
        cur.execute("update wallets set real_balance = real_balance + 100000 where user_id=%s", [u])
    return dict(owner=owner, p1=p1, p2=p2, a1=a1, a2=a2, b1=b1, pl=pl, pa1=pa1, saA1=saA1, demo=demo)

def adjust(cur, actor, role, target):
    return outcome(cur, "select * from fn_admin_adjust_balance(%s,%s,%s,%s,%s)", [actor, role, target, 100, "t"])

def recipients(cur, template_key):
    """Brands that received a broadcast of `template_key` (resolved to the template's real CATEGORY —
    keys and categories differ, e.g. payments_delayed -> payments_delay)."""
    cur.execute("""select distinct p.site_id::text from user_notifications n join profiles p on p.id=n.user_id
                   where n.category = (select category from notification_templates where key=%s)""", [template_key])
    return sorted(r[0] for r in cur.fetchall())

def main():
    print("== Pre-0156: reproduce both defects ==")
    conn = build("0155"); cur = conn.cursor(); s = seed(cur)
    pre_defs = {}
    for fn in FENCED:
        cur.execute("select p.oid::regprocedure::text, pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=%s", [fn])
        for sig, d in cur.fetchall(): pre_defs[sig] = d
    check("pre-fix: a site admin credits ANOTHER brand's user at the DB (no fence)", adjust(cur, s["saA1"], "admin", s["pl"]["A2"]) == "OK")
    check("pre-fix: a DEMOTED admin (stale token) credits a user", adjust(cur, s["demo"], "admin", s["pl"]["A1"]) == "OK")
    q1(cur, "select fn_broadcast_notification(%s,%s,%s,%s::jsonb)", [s["pa1"], "admin", "security_notice", "{}"])
    check("pre-fix: an IMPERSONATED broadcast lands on the impersonator's HOME brand (other platform)",
          recipients(cur, "security_notice") == [s["b1"]], str(recipients(cur, "security_notice")))

    print("\n== Apply 0156 on a fresh build ==")
    conn = build("0155"); cur = conn.cursor(); s = seed(cur)
    cur.execute(open(MIG, encoding="utf-8").read())
    pl = s["pl"]

    print("\n-- FENCE (site-tier) --")
    check("genuine site admin: own-brand user OK", adjust(cur, s["saA1"], "admin", pl["A1"]) == "OK")
    check("genuine site admin: same-platform other brand REFUSED", adjust(cur, s["saA1"], "admin", pl["A2"]) == "SITE_SCOPE_FORBIDDEN")
    check("genuine site admin: other-platform brand REFUSED", adjust(cur, s["saA1"], "admin", pl["B1"]) == "SITE_SCOPE_FORBIDDEN")
    check("demoted admin on a stale token: REFUSED even on its own brand", adjust(cur, s["demo"], "admin", pl["A1"]) == "SITE_SCOPE_FORBIDDEN")
    check("platform admin impersonating: a brand of ITS platform OK", adjust(cur, s["pa1"], "admin", pl["A2"]) == "OK")
    check("platform admin impersonating: its HOME brand (other platform) REFUSED", adjust(cur, s["pa1"], "admin", pl["B1"]) == "SITE_SCOPE_FORBIDDEN")
    check("owner impersonating: any brand OK", adjust(cur, s["owner"], "admin", pl["B1"]) == "OK")
    check("platform tier unchanged: platform_admin in-platform OK", adjust(cur, s["pa1"], "platform_admin", pl["A1"]) == "OK")
    check("platform tier unchanged: platform_admin cross-platform PLATFORM_SCOPE_FORBIDDEN",
          adjust(cur, s["pa1"], "platform_admin", pl["B1"]) == "PLATFORM_SCOPE_FORBIDDEN")
    check("brand-addressed RPC fenced: site admin flips ANOTHER brand's kill switch REFUSED",
          outcome(cur, "select fn_admin_set_withdrawals_enabled(%s,%s,%s,%s)", [s["saA1"], "admin", s["a2"], False]) == "SITE_SCOPE_FORBIDDEN")
    check("brand-addressed RPC: own brand OK",
          outcome(cur, "select fn_admin_set_withdrawals_enabled(%s,%s,%s,%s)", [s["saA1"], "admin", s["a1"], True]) == "OK")
    check("user-status RPC fenced cross-brand",
          outcome(cur, "select * from fn_admin_set_user_status(%s,%s,%s,%s,%s)", [s["saA1"], "admin", pl["A2"], "suspended", "x"]) == "SITE_SCOPE_FORBIDDEN")
    check("unknown target still reaches the function's own NOT_FOUND handling",
          adjust(cur, s["saA1"], "admin", str(uuid.uuid4())) not in ("OK", "SITE_SCOPE_FORBIDDEN"))

    print("\n-- TARGETING (bulk) --")
    q1(cur, "select fn_broadcast_notification(%s,%s,%s,%s::jsonb)", [s["saA1"], "admin", "security_notice", "{}"])
    check("genuine site admin broadcast: exactly its brand", recipients(cur, "security_notice") == [s["a1"]], str(recipients(cur, "security_notice")))
    q1(cur, "select fn_broadcast_notification(%s,%s,%s,%s::jsonb)", [s["pa1"], "admin", "service_disruption", "{}"])
    check("impersonated broadcast WITHOUT a named brand (old API): reaches nobody, never the home brand",
          recipients(cur, "service_disruption") == [], str(recipients(cur, "service_disruption")))
    q1(cur, "select fn_broadcast_notification(%s,%s,%s,%s::jsonb)", [s["pa1"], "admin", "payments_delayed", json.dumps({"sites": [s["a2"]]})])
    check("impersonated broadcast naming the token's brand (new API): exactly that brand",
          recipients(cur, "payments_delayed") == [s["a2"]], str(recipients(cur, "payments_delayed")))
    q1(cur, "select fn_broadcast_notification(%s,%s,%s,%s::jsonb)", [s["pa1"], "admin", "withdrawals_down", json.dumps({"sites": [s["b1"]]})])
    check("impersonated broadcast naming a brand OUTSIDE its platform: nobody",
          recipients(cur, "withdrawals_down") == [], str(recipients(cur, "withdrawals_down")))
    q1(cur, "select fn_broadcast_notification(%s,%s,%s,%s::jsonb)", [s["owner"], "admin", "deposits_down", json.dumps({"sites": [s["b1"]]})])
    check("owner impersonating, naming B1: exactly B1", recipients(cur, "deposits_down") == [s["b1"]], str(recipients(cur, "deposits_down")))
    cnt = q1(cur, "select fn_notification_audience_count_scoped(%s,%s,%s::jsonb)", [s["pa1"], "admin", "{}"])[0]
    check("impersonated audience count without a named brand = 0", cnt == 0, str(cnt))
    q1(cur, "select fn_broadcast_notification(%s,%s,%s,%s::jsonb)", [s["owner"], SYS, "announcement", "{}"])
    check("system broadcast unchanged: every brand", recipients(cur, "announcement") == sorted([DEFAULT_SITE, s["a1"], s["a2"], s["b1"]]), str(recipients(cur, "announcement")))

    print("\n-- category clear --")
    active = lambda key, site: q1(cur, "select count(*) from user_notifications n join profiles p on p.id=n.user_id where n.category=(select category from notification_templates where key=%s) and p.site_id=%s and n.resolved_at is null", [key, site])[0]
    check("3-arg clear by an impersonator (old API): clears nothing",
          q1(cur, "select fn_resolve_notifications_by_category(%s,%s,%s)", [s["pa1"], "admin", "announcement"])[0] == 0)
    n = q1(cur, "select fn_resolve_notifications_by_category(%s,%s,%s,%s)", [s["pa1"], "admin", "announcement", s["a2"]])[0]
    check("4-arg clear naming A2: clears only A2", n >= 1 and active("announcement", s["a2"]) == 0 and active("announcement", s["a1"]) >= 1 and active("announcement", s["b1"]) >= 1)
    check("4-arg clear naming a brand outside scope: clears nothing",
          q1(cur, "select fn_resolve_notifications_by_category(%s,%s,%s,%s)", [s["pa1"], "admin", "announcement", s["b1"]])[0] == 0 and active("announcement", s["b1"]) >= 1)
    check("genuine site admin 3-arg clear: its own brand only",
          q1(cur, "select fn_resolve_notifications_by_category(%s,%s,%s)", [s["saA1"], "admin", "announcement"])[0] >= 1 and active("announcement", s["a1"]) == 0 and active("announcement", s["b1"]) >= 1)

    print("\n-- tickets --")
    t = q1(cur, "select site_id, platform_id from fn_ticket_create(%s,%s,%s,%s,%s,%s,%s)", [s["pa1"], "admin", None, s["a2"], "imp", "", "low"])
    check("impersonated ticket naming A2 -> filed under A2 / P1 (was: home brand's platform)", (str(t[0]), str(t[1])) == (s["a2"], s["p1"]), str(t))
    check("impersonated ticket without a brand: NOT_AUTHORIZED (never the home brand)",
          outcome(cur, "select fn_ticket_create(%s,%s,%s,%s,%s,%s,%s)", [s["pa1"], "admin", None, None, "imp2", "", "low"]) == "NOT_AUTHORIZED")
    t = q1(cur, "select site_id from fn_ticket_create(%s,%s,%s,%s,%s,%s,%s)", [s["saA1"], "admin", None, None, "own", "", "low"])
    check("genuine site admin ticket without a brand -> its own brand", str(t[0]) == s["a1"])
    check("genuine site admin ticket naming another brand: SITE_SCOPE_FORBIDDEN",
          outcome(cur, "select fn_ticket_create(%s,%s,%s,%s,%s,%s,%s)", [s["saA1"], "admin", None, s["a2"], "x", "", "low"]) == "SITE_SCOPE_FORBIDDEN")

    print("\n-- add-ons (permission) --")
    check("impersonator may request an add-on for a brand of its platform (was: refused, home != X)",
          outcome(cur, "select fn_addon_request(%s,%s,%s,%s,%s,%s)", [s["pa1"], "admin", s["a2"], "chart", "area", None]) == "OK")
    check("impersonator refused for its HOME brand on the other platform",
          outcome(cur, "select fn_addon_request(%s,%s,%s,%s,%s,%s)", [s["pa1"], "admin", s["b1"], "chart", "bars", None]) == "SITE_SCOPE_FORBIDDEN")
    check("demoted admin refused",
          outcome(cur, "select fn_addon_request(%s,%s,%s,%s,%s,%s)", [s["demo"], "admin", s["a1"], "chart", "baseline", None]) == "SITE_SCOPE_FORBIDDEN")

    print("\n-- integrity of the generated definitions --")
    guard_line = "fn_assert_actor_site_scope(p_actor, p_actor_role"
    diffs = []
    for sig, before in pre_defs.items():
        after = q1(cur, "select pg_get_functiondef(%s::regprocedure)", [sig])[0]
        stripped = "\n".join(l for l in after.split("\n") if guard_line not in l)
        if stripped != before or after.count(guard_line) != 1:
            diffs.append(sig)
    check(f"all {len(pre_defs)} fenced RPCs = previous body + exactly ONE guard line", not diffs and len(pre_defs) == 17, str(diffs))
    try:
        cur.execute(open(MIG, encoding="utf-8").read()); check("0156 re-applies cleanly (idempotent)", True)
    except Exception as e:
        check("0156 re-applies cleanly (idempotent)", False, str(e)[:120])
    bad = q1(cur, """select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
                      and p.prosecdef and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))""")[0]
    check("no SECURITY DEFINER function is executable by anon/authenticated", bad == 0, str(bad))

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
