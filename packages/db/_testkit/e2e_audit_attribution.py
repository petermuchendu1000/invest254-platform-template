#!/usr/bin/env python3
"""Audit-trail brand attribution e2e (Issue 1 / F-45, BUGLOG #45 — migration 0155).

Builds the schema up to 0154 and reproduces the production defect: audit rows written without a
site_id (26 audit-writing RPCs + the API's recordAction) were filed under the DEFAULT brand whatever
they touched, so the per-brand audit view (GET /platform/sites/:id/audit, `site_id = $brand`) leaked
other brands'/platforms' actions into the default brand and hid each brand's own. Then applies 0155
and proves: backfill files every row under the brand it concerns (or NULL = platform-level), explicit
correct sites are preserved, the insert trigger attributes new rows correctly (and overrides a WRONG
explicit site from the touched entity), impersonated untargeted actions are never mis-filed, and the
per-brand audit view shows exactly its own brand.
Run: python3 packages/db/_testkit/e2e_audit_attribution.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid, json
import psycopg2

DB = "invest254_audit_attr"
DSN = dict(host="/tmp", port=5433, user="postgres", dbname=DB)
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
MIG = os.path.join(BASE, "migrations", "0155_admin_actions_site_attribution.sql")
DEFAULT_SITE = "00000000-0000-0000-0000-000000000001"
SYS = "platform_superadmin"
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

def site_of_row(cur, action, target):
    r = q1(cur, "select site_id from admin_actions where action=%s and target_id=%s order by id desc limit 1", [action, target])
    return None if r is None or r[0] is None else str(r[0])

# The exact per-brand audit query used by AdminRepository.listAudit(q, siteId) (apps/engine/src/admin.ts).
AUDIT_FOR_SITE = "select action, target_id from admin_actions where ($1::uuid is null or site_id = $1) order by created_at desc, id desc"

def main():
    print("== Build up to 0154 + reproduce the defect ==")
    conn = build("0154"); cur = conn.cursor()
    owner = register(cur, "254700900001", "owner", DEFAULT_SITE)
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [owner])
    p2 = str(q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [owner, SYS, "beta", "Beta"])[0])
    q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [owner, SYS, p2, "enterprise"])
    q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [owner, SYS, p2, "active", "test"])
    b = str(q1(cur, "select fn_platform_create_site(%s,%s,%s,%s,%s,%s)", [owner, SYS, "bsite", "B", "KES", "b.test"])[0])
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [owner, SYS, b, p2])
    uA = register(cur, "254700900002", "userA", DEFAULT_SITE)
    uB = register(cur, "254700900003", "userB", b)
    admB = register(cur, "254700900004", "adminB", b)
    cur.execute("update profiles set role='admin' where id=%s", [admB])

    q1(cur, "select * from fn_admin_adjust_balance(%s,%s,%s,%s,%s)", [owner, SYS, uB, 5000, "pre-fix credit on B"])
    cur.execute("insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail) values (%s,'admin','notification.create','user',%s,'{}')", [admB, uB])
    q1(cur, "select fn_resolve_notifications_by_category(%s,%s,%s)", [admB, "admin", "security_notice"])
    q1(cur, "select fn_platform_update_platform(%s,%s,%s,%s::jsonb)", [owner, SYS, p2, json.dumps({"name": "Beta2"})])
    cur.execute("insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail) values (%s,%s,'game.config','game_config','1','{}')", [owner, SYS])
    cur.execute("insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id) values (%s,'admin','custom.explicit','custom','x','{}',%s)", [admB, b])
    q1(cur, "select fn_resolve_notifications_by_category(%s,%s,%s)", [owner, "admin", "impersonated_cat"])  # owner impersonating
    check("pre-fix: B user's balance action filed under the DEFAULT brand (defect reproduced)", site_of_row(cur, "balance.adjust", uB) == DEFAULT_SITE)
    cur.execute(AUDIT_FOR_SITE.replace("$1", "%s"), [DEFAULT_SITE, DEFAULT_SITE])
    check("pre-fix: the default brand's audit view shows brand B's actions (cross-platform leak)",
          any(t == uB for _, t in cur.fetchall()))

    print("\n== Apply 0155 ==")
    cur.execute(open(MIG, encoding="utf-8").read())
    check("backfill: B user's balance action -> brand B", site_of_row(cur, "balance.adjust", uB) == b)
    check("backfill: recordAction-style row on a B user -> brand B", site_of_row(cur, "notification.create", uB) == b)
    check("backfill: genuine site admin's untargeted action -> its own brand",
          str(q1(cur, "select site_id from admin_actions where action='notification.resolve_category' and target_id='security_notice'")[0]) == b)
    check("backfill: platform-level action -> NULL (no brand)", site_of_row(cur, "platform.update", p2) is None)
    check("backfill: legacy singleton game_config stays on the default brand", site_of_row(cur, "game.config", "1") == DEFAULT_SITE)
    check("backfill: deliberately set non-default site is preserved", site_of_row(cur, "custom.explicit", "x") == b)
    check("backfill: impersonated untargeted action -> NULL, never the impersonator's home brand",
          q1(cur, "select site_id from admin_actions where target_id='impersonated_cat'")[0] is None)

    print("\n== New inserts are attributed by the trigger ==")
    q1(cur, "select * from fn_admin_adjust_balance(%s,%s,%s,%s,%s)", [owner, SYS, uB, 100, "post-fix"])
    check("RPC without site on a B user -> brand B",
          str(q1(cur, "select site_id from admin_actions where action='balance.adjust' and detail->>'reason'='post-fix'")[0]) == b)
    cur.execute("insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail) values (%s,'admin','notification.create','user',%s,'{}')", [owner, uA])
    check("recordAction-style insert on an A user -> brand A", site_of_row(cur, "notification.create", uA) == DEFAULT_SITE)
    cur.execute("insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id) values (%s,'admin','wrong.explicit','user',%s,'{}',%s)", [admB, uA, b])
    check("a WRONG explicit site is overridden by the touched entity's brand", site_of_row(cur, "wrong.explicit", uA) == DEFAULT_SITE)
    q1(cur, "select fn_platform_update_platform(%s,%s,%s,%s::jsonb)", [owner, SYS, p2, json.dumps({"name": "Beta3"})])
    check("new platform-level action -> NULL",
          q1(cur, "select site_id from admin_actions where action='platform.update' order by id desc limit 1")[0] is None)
    cur.execute("insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail) values (%s,%s,'platform.provider.site','payment_provider','payhero',%s)", [owner, SYS, json.dumps({"site_id": b, "enabled": True})])
    check("per-brand provider action -> brand from detail.site_id", site_of_row(cur, "platform.provider.site", "payhero") == b)

    print("\n== The per-brand audit view is now exact ==")
    cur.execute(AUDIT_FOR_SITE.replace("$1", "%s"), [DEFAULT_SITE, DEFAULT_SITE]); rows_a = cur.fetchall()
    cur.execute(AUDIT_FOR_SITE.replace("$1", "%s"), [b, b]); rows_b = cur.fetchall()
    check("default brand's audit contains NO action on brand B's users", not any(t in (uB, admB) for _, t in rows_a))
    check("default brand's audit contains NO platform-level action", not any(a in ("platform.update", "platform.create") for a, _ in rows_a))
    check("brand B's audit contains its own users' actions", sum(1 for _, t in rows_b if t == uB) >= 3)
    check("system (unfiltered) view still sees everything",
          q1(cur, "select count(*) from admin_actions")[0] == len(rows_a) + len(rows_b) + q1(cur, "select count(*) from admin_actions where site_id is null")[0])

    print("\n== Idempotency, schema, grants ==")
    before = q1(cur, "select md5(string_agg(id::text||coalesce(site_id::text,'-'), ',' order by id)) from admin_actions")[0]
    try:
        cur.execute(open(MIG, encoding="utf-8").read()); check("0155 re-applies cleanly", True)
    except Exception as e:
        check("0155 re-applies cleanly", False, str(e)[:100])
    check("re-apply changes no attribution",
          before == q1(cur, "select md5(string_agg(id::text||coalesce(site_id::text,'-'), ',' order by id)) from admin_actions")[0])
    r = q1(cur, "select is_nullable, column_default from information_schema.columns where table_name='admin_actions' and column_name='site_id'")
    check("site_id is nullable with no default", r[0] == "YES" and r[1] is None, str(r))
    check("anon cannot EXECUTE the attribution function",
          not q1(cur, "select has_function_privilege('anon','fn_admin_action_site(text,text,jsonb)','EXECUTE')")[0])

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
