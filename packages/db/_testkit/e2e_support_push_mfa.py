#!/usr/bin/env python3
"""Support ownership, push recipients and MFA view e2e (Issue 1 / F-48, BUGLOG #49 — migration 0157).

Proves against a fresh build of every migration:
  * pre-0157 defects: conversations carry no ownership material; v_mfa_status hides both platform tiers
    and is granted to anon/authenticated (under Supabase's default privileges);
  * 0157: access_hash column + format check; 4-arg fn_support_start binds the hash and refuses a missing
    or malformed one; the 3-arg (previously deployed API) still works; grants service_role only;
    v_mfa_status lists exactly the live operator tiers, is security_invoker and unreadable by
    anon/authenticated even with Supabase's default grants re-applied by the view's re-creation;
  * the PUSH RECIPIENT SQL — extracted VERBATIM from apps/engine/src/push.ts so the test can never drift
    from production — alerts exactly the operators the engine truth table allows (live profile; stale
    stored site ignored; demoted/suspended/other-platform excluded; unknown brand -> owner only);
  * 0157 re-applies cleanly (idempotent).
Run: python3 packages/db/_testkit/e2e_support_push_mfa.py   (needs local PG on /tmp:5433)
"""
import os, re, sys, glob, hashlib, secrets
import psycopg2

DB = "invest254_f48"
DSN = dict(host="/tmp", port=5433, user="postgres", dbname=DB)
HERE = os.path.dirname(__file__)
BASE = os.path.join(HERE, "..")
ROOT = os.path.join(BASE, "..", "..")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
MIG = os.path.join(BASE, "migrations", "0157_support_owner_binding_and_mfa_view.sql")
PUSH_TS = os.path.join(ROOT, "apps", "engine", "src", "push.ts")
DEFAULT_SITE = "00000000-0000-0000-0000-000000000001"
SYS = "platform_superadmin"
PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def outcome(cur, sql, args):
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
        # Supabase grants anon/authenticated ALL on every NEW public table/view by default privileges.
        c.execute("alter default privileges in schema public grant all on tables to anon, authenticated")
    return conn

def register(cur, phone, username, site):
    cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, username, "x" * 32, site])
    return str(q1(cur, "select id from profiles where site_id=%s and phone=%s", [site, phone])[0])

def seed(cur):
    owner = register(cur, "254702000001", "owner", DEFAULT_SITE)
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [owner])
    p1 = str(q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [owner, SYS, "p1", "P1"])[0])
    p2 = str(q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [owner, SYS, "p2", "P2"])[0])
    for p in (p1, p2):
        q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [owner, SYS, p, "enterprise"])
        q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [owner, SYS, p, "active", "test"])
    mk = lambda slug: str(q1(cur, "select fn_platform_create_site(%s,%s,%s,%s,%s,%s)", [owner, SYS, slug, slug.upper(), "KES", f"{slug}.test"])[0])
    a1, a2, b1 = mk("a1"), mk("a2"), mk("b1")
    for s_, p in ((a1, p1), (a2, p1), (b1, p2)):
        q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [owner, SYS, s_, p])
    def admin(phone, name, site, role="admin", status="active"):
        u = register(cur, phone, name, site)
        cur.execute("update profiles set role=%s, status=%s where id=%s", [role, status, u]); return u
    u = dict(
        owner=owner,
        genuineA1=admin("254702000010", "genA1", a1),
        movedToB1=admin("254702000011", "moved", b1),           # subscribed while on a1
        claimlessA2=admin("254702000012", "claimless", a2),     # subscribed with stored site NULL
        demoted=admin("254702000013", "demoted", a1, role="player"),
        suspended=admin("254702000014", "susp", a1, status="suspended"),
        marketer=admin("254702000015", "mkt", a1, role="marketer"),
    )
    pa1 = register(cur, "254702000020", "pa1", b1)              # home brand on the OTHER platform
    q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [owner, SYS, pa1, p1])
    pa2 = register(cur, "254702000021", "pa2", a1)
    q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [owner, SYS, pa2, p2])
    u.update(pa1=pa1, pa2=pa2)
    return dict(p1=p1, p2=p2, a1=a1, a2=a2, b1=b1, u=u)

def push_sql():
    src = open(PUSH_TS, encoding="utf-8").read()
    cls = src[src.index("export class PgPushSubscriptionRepository"):]
    m = re.search(r"async listForWithdrawalSite[\s\S]*?const sql = `([\s\S]*?)`;", cls)
    assert m, "could not extract the recipient SQL from push.ts"
    return m.group(1).replace("$1::uuid", "%(site)s::uuid")

def main():
    print("== Pre-0157: reproduce the defects ==")
    conn = build("0156"); cur = conn.cursor(); s = seed(cur)
    cols = [r[0] for r in (cur.execute("select column_name from information_schema.columns where table_name='support_conversations'") or cur.fetchall())]
    check("pre-fix: a conversation carries NO ownership material (id alone grants writes)", "access_hash" not in cols)
    cur.execute("select role from v_mfa_status"); roles = {r[0] for r in cur.fetchall()}
    check("pre-fix: v_mfa_status hides both platform tiers", "platform_admin" not in roles and "platform_superadmin" not in roles, str(roles))

    print("\n== Apply 0157 ==")
    cur.execute(open(MIG, encoding="utf-8").read())

    print("\n-- support ownership --")
    tok = secrets.token_urlsafe(32); h = hashlib.sha256(tok.encode()).hexdigest()
    cid = q1(cur, "select fn_support_start(%s,%s,%s,%s)", [s["a1"], "visitor-1", None, h])[0]
    check("4-arg start binds the SHA-256 of the capability token", q1(cur, "select access_hash from support_conversations where id=%s", [cid])[0] == h)
    check("4-arg start refuses a missing hash", outcome(cur, "select fn_support_start(%s,%s,%s,%s)", [s["a1"], "v", None, None]) == "ACCESS_HASH_REQUIRED")
    check("4-arg start refuses a malformed hash", outcome(cur, "select fn_support_start(%s,%s,%s,%s)", [s["a1"], "v", None, "zz"]) == "ACCESS_HASH_REQUIRED")
    check("4-arg start still validates the brand",
          outcome(cur, "select fn_support_start(%s,%s,%s,%s)", ["99999999-9999-9999-9999-999999999999", "v", None, h]) == "SITE_NOT_FOUND")
    legacy = q1(cur, "select fn_support_start(%s,%s,%s)", [s["a1"], "old-api", None])[0]
    check("3-arg start (previously deployed API) still works -> legacy row, no hash",
          q1(cur, "select access_hash is null from support_conversations where id=%s", [legacy])[0])
    check("format CHECK rejects a non-hash value written directly",
          outcome(cur, "update support_conversations set access_hash='plaintext-token' where id=%s", [legacy]).startswith("new row for relation"))
    for role in ("anon", "authenticated"):
        check(f"4-arg start NOT executable by {role}",
              not q1(cur, "select has_function_privilege(%s,'public.fn_support_start(uuid,text,uuid,text)','EXECUTE')", [role])[0])
    check("4-arg start executable by service_role",
          q1(cur, "select has_function_privilege('service_role','public.fn_support_start(uuid,text,uuid,text)','EXECUTE')")[0])

    print("\n-- v_mfa_status --")
    cur.execute("select role, count(*) from v_mfa_status group by 1"); got = dict(cur.fetchall())
    check("lists exactly the live operator tiers", set(got) == {"admin", "platform_admin", "platform_superadmin"}, str(got))
    check("every operator row present (4 site admins incl. suspended, 2 platform admins, 1 owner)",
          got.get("admin") == 4 and got.get("platform_admin") == 2 and got.get("platform_superadmin") == 1, str(got))
    check("no legacy 'superadmin' / player / marketer rows", not ({"superadmin", "player", "marketer"} & set(got)))
    check("security_invoker set", "security_invoker=true" in (q1(cur, "select array_to_string(reloptions, ',') from pg_class where relname='v_mfa_status'")[0] or ""))
    for role in ("anon", "authenticated"):
        check(f"{role} has NO privilege on the view (despite default grants)",
              not q1(cur, "select has_table_privilege(%s,'public.v_mfa_status','SELECT')", [role])[0])
    check("service_role can read it", q1(cur, "select has_table_privilege('service_role','public.v_mfa_status','SELECT')")[0])

    print("\n-- push recipients (SQL verbatim from push.ts) --")
    sql = push_sql(); u = s["u"]
    for name, site in (("genuineA1", s["a1"]), ("movedToB1", s["a1"]), ("claimlessA2", None), ("demoted", s["a1"]), ("suspended", s["a1"]),
                       ("marketer", s["a1"]), ("pa1", s["b1"]), ("pa2", None), ("owner", s["b1"])):
        cur.execute("insert into push_subscriptions(user_id, site_id, endpoint, p256dh, auth) values (%s,%s,%s,'k','a')",
                    [u[name], site, f"https://push.test/{name}"])
    def who(site):
        cur.execute(sql, {"site": site}); return sorted(r[3].rsplit("/", 1)[1] for r in cur.fetchall())
    check("withdrawal on a1 -> genuine a1 admin, platform admin of P1, owner",
          who(s["a1"]) == ["genuineA1", "owner", "pa1"], str(who(s["a1"])))
    check("withdrawal on a2 -> the claimless a2 admin (by LIVE profile), pa1, owner — not a1's admins",
          who(s["a2"]) == ["claimlessA2", "owner", "pa1"], str(who(s["a2"])))
    check("withdrawal on b1 (P2) -> moved admin (now b1), pa2, owner — never P1's platform admin",
          who(s["b1"]) == ["movedToB1", "owner", "pa2"], str(who(s["b1"])))
    check("unknown brand -> system owner ONLY (was: every admin device)", who(None) == ["owner"], str(who(None)))
    check("demoted / suspended / marketer never alerted",
          not ({"demoted", "suspended", "marketer"} & set(who(s["a1"]) + who(s["a2"]) + who(s["b1"]) + who(None))))

    print("\n-- idempotency --")
    try:
        cur.execute(open(MIG, encoding="utf-8").read()); check("0157 re-applies cleanly", True)
    except Exception as e:
        check("0157 re-applies cleanly", False, str(e)[:160])
    check("view still closed after re-apply", not q1(cur, "select has_table_privilege('anon','public.v_mfa_status','SELECT')")[0])
    bad = q1(cur, """select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
                      and p.prosecdef and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))""")[0]
    check("no SECURITY DEFINER function is executable by anon/authenticated", bad == 0, str(bad))

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
