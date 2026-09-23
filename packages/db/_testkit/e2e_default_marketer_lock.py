#!/usr/bin/env python3
"""Aggressive e2e for the default-marketer REMOVE + role-demotion LOCK (migration 0124, BUGLOG #26).

Resets a local Postgres, applies the shim + ALL migrations (0001..0124), then exercises the two
guarded RPCs against every real-life scenario:

  ASSIGN      make-default requires an ACTIVE MARKETER on the actor's own brand (unchanged).
  LOCK        a brand DEFAULT marketer cannot be demoted out of 'marketer' (DEFAULT_MARKETER_LOCKED).
  REMOVE      clear-default ALWAYS works — even when the current owner's role drifted to 'player'
              (the exact live corruption: 1000wins/claudia, cpfmarket/marketer001, muchwins/sheila).
  RE-ENABLE   once removed, the same user can be demoted normally.
  SCOPE       a site-scoped admin can only clear its OWN brand; platform_superadmin is unrestricted.
  IDEMPOTENT  clearing a non-default is a harmless no-op; assigning stays active-marketer-only.
  AUTH        non-admin roles are rejected by both RPCs.

Run: python3 packages/db/_testkit/e2e_default_marketer_lock.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_dmlock_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"
SITE_B = "00000000-0000-0000-0000-0000000000b2"

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
        cur.connection.rollback(); check(name, code_substr.lower() in str(e).lower(), f"got: {str(e).strip()[:110]}")

def expect_ok(cur, sql, args, name):
    try:
        cur.execute(sql, args); check(name, True)
    except Exception as e:
        cur.connection.rollback(); check(name, False, f"raised: {str(e).strip()[:110]}")

def reset_and_migrate():
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname=%s and pid<>pg_backend_pid()", [DSN["dbname"]])
        c.execute(f"drop database if exists {DSN['dbname']}"); c.execute(f"create database {DSN['dbname']}")
    admin.close()
    conn = psycopg2.connect(**DSN); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        # ALL migrations (correct glob — NOT '00*.sql', which silently stops at 0099).
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9]*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

def register(cur, phone, user, site, code=None):
    return q1(cur, "select user_id from fn_register_user(%s,%s,%s,%s,%s)",
              [phone, user, "hash_" + "x" * 24, code, site])[0]

def enroll(cur, uid):
    return q1(cur, "select referral_code from fn_affiliate_enroll(%s)", [uid])[0]

def owner_of(cur, site):
    return q1(cur, "select owner_user_id from sites where id=%s", [site])[0]

def role_of(cur, uid):
    return q1(cur, "select role from profiles where id=%s", [uid])[0]

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()

    # ── Fixtures ──────────────────────────────────────────────────────────────────────────────────
    cur.execute("insert into sites(id,slug,name,currency,status) values (%s,'brandB','Brand B','KES','active') on conflict do nothing", [SITE_B])
    cur.execute("insert into site_game_config(site_id,min_stake,max_stake,house_edge,target_win_rate) values (%s,50000,5000000,0.75,0.125) on conflict (site_id) do nothing", [SITE_B])

    adminA = register(cur, "254790000001", "adminA", SITE_A)   # actor on brand A (role passed as param)
    # Issue 1 / F-46: site-tier RPCs now verify the actor's REAL profile (a stale/demoted token is
    # fenced), so the fixture's site admin must genuinely be one.
    cur.execute("update profiles set role='admin' where id=%s", [adminA]); conn.commit()
    adminB = register(cur, "254790000002", "adminB", SITE_B)   # actor on brand B
    M      = register(cur, "254790000010", "mktM",   SITE_A); enroll(cur, M)     # active marketer on A
    P      = register(cur, "254790000011", "plyrP",  SITE_A)                     # plain player on A
    print(f"\n== Fixtures: adminA/adminB actors, marketer M ({role_of(cur,M)}), player P ({role_of(cur,P)}) ==")
    check("marketer M enrolled as 'marketer'", role_of(cur, M) == "marketer")

    print("\n== AUTH: both RPCs reject non-admin roles ==")
    expect_error(cur, "select fn_admin_set_site_owner(%s,%s,%s,true)", [adminA, "player", M], "NOT_AUTHORIZED", "set_site_owner rejects player")
    expect_error(cur, "select fn_admin_set_site_owner(%s,%s,%s,true)", [adminA, "marketer", M], "NOT_AUTHORIZED", "set_site_owner rejects marketer")
    expect_error(cur, "select fn_admin_set_user_role(%s,%s,%s,'player')", [adminA, "player", M], "NOT_AUTHORIZED", "set_user_role rejects player")

    print("\n== ASSIGN: make an ACTIVE marketer the brand default (brand-scoped admin) ==")
    expect_ok(cur, "select fn_admin_set_site_owner(%s,%s,%s,true)", [adminA, "admin", M], "adminA assigns M as A's default")
    check("A.owner == M", str(owner_of(cur, SITE_A)) == str(M))

    print("\n== ASSIGN guards still hold ==")
    expect_error(cur, "select fn_admin_set_site_owner(%s,%s,%s,true)", [adminA, "admin", P], "OWNER_NOT_MARKETER", "cannot assign a PLAYER as default")
    # a suspended marketer cannot be assigned
    Msusp = register(cur, "254790000012", "mktSusp", SITE_A); enroll(cur, Msusp)
    cur.execute("update profiles set status='suspended' where id=%s", [Msusp])
    expect_error(cur, "select fn_admin_set_site_owner(%s,%s,%s,true)", [adminA, "admin", Msusp], "OWNER_NOT_ACTIVE", "cannot assign a SUSPENDED marketer as default")

    print("\n== LOCK: a brand default cannot be demoted out of 'marketer' (the root-cause gap) ==")
    expect_error(cur, "select fn_admin_set_user_role(%s,%s,%s,'player')", [adminA, "admin", M], "DEFAULT_MARKETER_LOCKED", "admin cannot demote the default M -> player")
    expect_error(cur, "select fn_admin_set_user_role(%s,%s,%s,'admin')", [adminA, "superadmin", M], "DEFAULT_MARKETER_LOCKED", "superadmin cannot move default M -> admin")
    check("M still 'marketer' after blocked demotions", role_of(cur, M) == "marketer")
    # keeping/setting 'marketer' is always allowed (idempotent re-enroll)
    expect_ok(cur, "select fn_admin_set_user_role(%s,%s,%s,'marketer')", [adminA, "admin", M], "setting default M -> 'marketer' is allowed (no-op)")

    print("\n== SCOPE: a site-admin on brand B cannot clear brand A's default; platform can ==")
    expect_error(cur, "select fn_admin_set_site_owner(%s,%s,%s,false)", [adminB, "admin", M], "SITE_SCOPE_FORBIDDEN", "brand-B admin cannot clear brand-A default")
    check("A.owner still M after forbidden cross-brand clear", str(owner_of(cur, SITE_A)) == str(M))

    print("\n== REMOVE: brand-scoped admin removes the default (core Issue-1 capability) ==")
    expect_ok(cur, "select fn_admin_set_site_owner(%s,%s,%s,false)", [adminA, "admin", M], "adminA removes M as A's default")
    check("A.owner == NULL after remove", owner_of(cur, SITE_A) is None)

    print("\n== RE-ENABLE: once removed, the ex-default can be demoted normally ==")
    expect_ok(cur, "select fn_admin_set_user_role(%s,%s,%s,'player')", [adminA, "admin", M], "M -> player now allowed (not a default)")
    check("M is now 'player'", role_of(cur, M) == "player")

    print("\n== REPAIR: a legacy CORRUPT default (owner is now a 'player') is still removable ==")
    # Reproduce the exact production corruption: a marketer was made default, then demoted to player
    # by the OLD (pre-0124) code path — bypass the RPC with a direct UPDATE to forge that artifact.
    M2 = register(cur, "254790000013", "mktM2", SITE_A); enroll(cur, M2)
    expect_ok(cur, "select fn_admin_set_site_owner(%s,%s,%s,true)", [adminA, "admin", M2], "assign M2 as A's default")
    cur.execute("update profiles set role='player' where id=%s", [M2])          # forge the corruption
    check("forged corrupt state: A.owner is a 'player'", role_of(cur, M2) == "player" and str(owner_of(cur, SITE_A)) == str(M2))
    expect_ok(cur, "select fn_admin_set_site_owner(%s,%s,%s,false)", [adminA, "admin", M2], "admin removes the player-owner default (was OWNER_NOT_MARKETER before)")
    check("A.owner == NULL after repairing corrupt default", owner_of(cur, SITE_A) is None)

    print("\n== IDEMPOTENT: clearing a user who is not a default anywhere is a harmless no-op ==")
    expect_ok(cur, "select fn_admin_set_site_owner(%s,%s,%s,false)", [adminA, "admin", P], "clear on a non-default player is a no-op")
    check("A.owner still NULL after no-op clear", owner_of(cur, SITE_A) is None)

    print("\n== ASSIGN: a demoted (now-player) ex-marketer cannot be re-assigned as default ==")
    expect_error(cur, "select fn_admin_set_site_owner(%s,%s,%s,true)", [adminA, "admin", M2], "OWNER_NOT_MARKETER", "cannot assign the now-player M2 as default")

    print("\n== PLATFORM: platform_superadmin can clear cross-brand ==")
    ps_actor = str(uuid.uuid4())
    # set a real active-marketer default, then clear it as platform_superadmin (no site scope)
    M3 = register(cur, "254790000014", "mktM3", SITE_A); enroll(cur, M3)
    expect_ok(cur, "select fn_admin_set_site_owner(%s,%s,%s,true)", [adminA, "admin", M3], "assign M3 as A's default")
    expect_ok(cur, "select fn_admin_set_site_owner(%s,%s,%s,false)", [ps_actor, "platform_superadmin", M3], "platform_superadmin clears cross-brand default")
    check("A.owner == NULL after platform clear", owner_of(cur, SITE_A) is None)

    print("\n== CROSS-BRAND (Issue 1/F1): the system owner is unrestricted; a real site admin is home-fenced ==")
    # Issue 1 / F1 (Option B): the legacy site-fenced `superadmin` impersonation role is gone.
    # The system owner acts across brands via their OWN platform_superadmin authority (unrestricted);
    # impersonation now mints only a day-to-day `admin` for brand CONTEXT, not cross-brand power.
    owner = register(cur, "254790000020", "plat_owner", SITE_A)
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [owner])
    Mb = register(cur, "254790000021", "mktB", SITE_B); enroll(cur, Mb)
    expect_ok(cur, "select fn_admin_set_site_owner(%s,'platform_superadmin',%s,true)", [owner, Mb],
              "system owner can MAKE a SITE_B marketer the default (unrestricted)")
    check("B.owner == Mb after owner make-default", str(owner_of(cur, SITE_B)) == str(Mb))
    expect_ok(cur, "select fn_admin_set_site_owner(%s,'platform_superadmin',%s,false)", [owner, Mb],
              "system owner can CLEAR the SITE_B default")
    check("B.owner == NULL after owner clear", owner_of(cur, SITE_B) is None)

    # Defence in depth: a REAL per-brand admin (home SITE_A) still cannot reach SITE_B.
    real_admin = register(cur, "254790000022", "real_admin_a", SITE_A)
    cur.execute("update profiles set role='admin' where id=%s", [real_admin])
    Mb2 = register(cur, "254790000023", "mktB2", SITE_B); enroll(cur, Mb2)
    expect_error(cur, "select fn_admin_set_site_owner(%s,'admin',%s,true)", [real_admin, Mb2],
                 "SITE_SCOPE_FORBIDDEN", "a REAL SITE_A admin cannot make a SITE_B default (home-fenced)")
    # And a SITE_A admin acting on their OWN brand still works.
    Ma = register(cur, "254790000024", "mktA2", SITE_A); enroll(cur, Ma)
    expect_ok(cur, "select fn_admin_set_site_owner(%s,'admin',%s,true)", [real_admin, Ma],
              "a SITE_A admin can make a SITE_A marketer the default")
    check("A.owner == Ma", str(owner_of(cur, SITE_A)) == str(Ma))

    # ── Result ──────────────────────────────────────────────────────────────────────────────────
    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL DEFAULT-MARKETER LOCK/REMOVE DB E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
