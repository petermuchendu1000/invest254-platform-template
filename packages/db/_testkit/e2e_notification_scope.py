#!/usr/bin/env python3
"""Issue 1 — broadcast/announcement audience isolation e2e (migration 0141).

Proves fn_notification_audience_scoped / _count_scoped / fn_broadcast_notification /
fn_resolve_notifications_by_category are ACTOR-SCOPED:
  * site admin ('admin')          -> ONLY its own site's users;
  * platform admin ('platform_admin') -> ALL users across the sites in ITS platform;
  * system owner ('platform_superadmin') -> everyone;
  * an explicit { "sites":[...] } audience can only NARROW within the caller's allowed sites;
  * platform_admin may broadcast (was previously locked out).

Run: python3 packages/db/_testkit/e2e_notification_scope.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SYS  = "platform_superadmin"

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

def register(cur, phone, username, site):
    cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, username, "x"*32, site])
    return q1(cur, "select id from profiles where site_id=%s and phone=%s", [site, phone])[0]

def seed_site(cur, actor, slug, name):
    return q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [actor, SYS, slug, name])[0]

# recipient-role predicate identical to the SQL under test (the canonical "people-facing" set)
REC_ROLES = "('player','marketer','admin','superadmin','super_admin','platform_superadmin')"

def direct_recipients(cur, site_ids):
    placeholders = ",".join(["%s"]*len(site_ids))
    return q1(cur, f"select count(*)::int from profiles where status='active' and role in {REC_ROLES} and site_id in ({placeholders})", list(site_ids))[0]

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()
    ACTOR = str(uuid.uuid4())

    print("\n== Setup: two platforms, three sites, players, admins ==")
    p1 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "alpha", "Alpha"])[0]
    p2 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "beta",  "Beta"])[0]
    for pid in (p1, p2):
        q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [ACTOR, SYS, pid, "enterprise"])
        q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [ACTOR, SYS, pid, "active", "test"])
    a1 = seed_site(cur, ACTOR, "a1site", "A1"); a2 = seed_site(cur, ACTOR, "a2site", "A2"); b1 = seed_site(cur, ACTOR, "b1site", "B1")
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, a1, p1])
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, a2, p1])
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, b1, p2])

    plA1 = register(cur, "254700000011", "plA1", a1)
    plA2 = register(cur, "254700000012", "plA2", a2)
    plB1 = register(cur, "254700000013", "plB1", b1)
    pa1  = register(cur, "254700000021", "pa1user", a1)
    q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [ACTOR, SYS, pa1, p1])
    saA1 = register(cur, "254700000031", "saA1", a1)
    q1(cur, "select * from fn_admin_set_user_role(%s,%s,%s,%s)", [ACTOR, SYS, saA1, "admin"])
    rpa = q1(cur,"select role, platform_id::text from profiles where id=%s",[pa1])
    check("setup: pa1 is platform_admin of p1", rpa[0]=="platform_admin" and rpa[1]==str(p1), str(rpa))
    rsa = q1(cur,"select role, site_id::text from profiles where id=%s",[saA1])
    check("setup: saA1 is a site admin on a1", rsa[0]=="admin" and rsa[1]==str(a1), str(rsa))

    def scoped_count(actor, role, aud="{}"):
        return q1(cur, "select fn_notification_audience_count_scoped(%s,%s,%s::jsonb)", [actor, role, aud])[0]

    print("\n== Audience COUNT is actor-scoped ==")
    exp_a1     = direct_recipients(cur, [a1])
    exp_p1     = direct_recipients(cur, [a1, a2])
    exp_all    = q1(cur, f"select count(*)::int from profiles where status='active' and role in {REC_ROLES}")[0]
    global_leak = q1(cur, "select fn_notification_audience_count(%s::jsonb)", ["{}"])[0]  # legacy unscoped
    check("site admin count == its OWN site only", scoped_count(saA1,"admin")==exp_a1, f"{scoped_count(saA1,'admin')} vs {exp_a1}")
    check("platform admin count == ALL sites in its platform", scoped_count(pa1,"platform_admin")==exp_p1, f"{scoped_count(pa1,'platform_admin')} vs {exp_p1}")
    check("system owner count == everyone", scoped_count(ACTOR,SYS)==exp_all, f"{scoped_count(ACTOR,SYS)} vs {exp_all}")
    check("scoped site-admin count < legacy global (leak was real & is now closed)", scoped_count(saA1,"admin") < global_leak, f"{scoped_count(saA1,'admin')} < {global_leak}")
    check("platform admin count EXCLUDES the other platform's users", scoped_count(pa1,"platform_admin") == exp_p1 and exp_p1 < exp_all)

    print("\n== Explicit { sites:[...] } can only NARROW (never broaden) ==")
    # a site admin on a1 asking for a2 must get ZERO (cannot reach outside its own site)
    check("site admin cannot target a sibling brand via explicit sites", scoped_count(saA1,"admin", '{"sites":["%s"]}' % a2)==0)
    # a platform admin narrowing to a2 (in its platform) works
    check("platform admin can narrow to one of its own sites", scoped_count(pa1,"platform_admin", '{"sites":["%s"]}' % a2)==direct_recipients(cur,[a2]))
    # a platform admin asking for b1 (other platform) gets ZERO
    check("platform admin cannot target another platform's site via explicit sites", scoped_count(pa1,"platform_admin", '{"sites":["%s"]}' % b1)==0)

    print("\n== BROADCAST inserts only within the caller's tenant ==")
    # deterministic template with no resolves_category
    cur.execute("""insert into notification_templates(key,level,title,body,dismissible,category,default_audience,description)
                   values ('t_ann','info','T','B',true,'t_ann_cat','{"status":"active"}','test')
                   on conflict (key) do nothing""")
    n = q1(cur, "select fn_broadcast_notification(%s,%s,%s,%s)", [saA1,"admin","t_ann",None])[0]
    check("site admin broadcast recipient count == its own site", n==exp_a1, f"{n} vs {exp_a1}")
    cur.execute("select site_id, count(*) from user_notifications where category='t_ann_cat' group by site_id")
    per_site = {str(r[0]): r[1] for r in cur.fetchall()}
    check("broadcast rows exist ONLY for the site-admin's brand", set(per_site.keys())=={a1}, str(per_site))

    # platform admin broadcast (was locked out before) — a NEW category to avoid idempotency dedupe
    cur.execute("""insert into notification_templates(key,level,title,body,dismissible,category,default_audience,description)
                   values ('t_pa','info','T','B',true,'t_pa_cat','{"status":"active"}','test')
                   on conflict (key) do nothing""")
    npa = q1(cur, "select fn_broadcast_notification(%s,%s,%s,%s)", [pa1,"platform_admin","t_pa",None])[0]
    check("platform admin CAN broadcast (no NOT_AUTHORIZED)", npa==exp_p1, f"{npa} vs {exp_p1}")
    cur.execute("select distinct site_id from user_notifications where category='t_pa_cat'")
    pa_sites = {str(r[0]) for r in cur.fetchall()}
    check("platform admin broadcast touched ONLY its platform's sites", pa_sites=={a1,a2}, str(pa_sites))

    print("\n== resolves_category CLEAR is actor-scoped ==")
    # seed an active incident banner 'inc' for one user on each brand
    for u,s in [(plA1,a1),(plA2,a2),(plB1,b1)]:
        cur.execute("insert into user_notifications(user_id,level,title,body,dismissible,category,created_by,site_id) values (%s,'warning','x','y',true,'inc',%s,%s)", [u, ACTOR, s])
    cleared = q1(cur, "select fn_resolve_notifications_by_category(%s,%s,%s)", [saA1,"admin","inc"])[0]
    cur.execute("select distinct site_id from user_notifications where category='inc' and resolved_at is null")
    still_active = {str(r[0]) for r in cur.fetchall()}
    check("site admin cleared exactly ONE banner (its own site)", cleared==1, str(cleared))
    check("other brands' incident banners remain active", still_active=={a2,b1}, str(still_active))

    print("\n== gate ==")
    expect_error(cur, "select fn_broadcast_notification(%s,%s,%s,%s)", [plA1,"player","t_ann",None], "NOT_AUTHORIZED", "player cannot broadcast")

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL NOTIFICATION-SCOPE E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
