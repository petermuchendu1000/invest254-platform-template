#!/usr/bin/env python3
"""Issue 1 #3 — per-platform registrar (Namecheap) config isolation + at-rest secrecy (migration 0142).

Proves the config RPCs:
  * a platform_admin may read/write ONLY its own platform's registrar config; cross-platform => 403;
  * the system owner may act on any platform; a site admin/player is NOT_AUTHORIZED;
  * the API KEY is stored ONLY as opaque ciphertext (engine-encrypted) — never in plaintext settings;
  * the masked console read (fn_platform_get_registrar_config) NEVER returns the ciphertext;
  * the service-role resolve (fn_registrar_config_resolve) returns settings + ciphertext;
  * secret update semantics: null=keep, ''=clear, '<blob>'=replace.

Run: python3 packages/db/_testkit/e2e_registrar_config.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SYS  = "platform_superadmin"
PASS, FAIL = [], []
def check(n, c, d=""):
    (PASS if c else FAIL).append(n); print(f"  [{'PASS' if c else 'FAIL'}] {n}" + (f"  -- {d}" if d and not c else ""))
def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()
def expect_error(cur, sql, args, sub, name):
    try:
        cur.execute(sql, args); cur.connection.rollback(); check(name, False, "no error raised")
    except Exception as e:
        cur.connection.rollback(); check(name, sub.lower() in str(e).lower(), f"got: {str(e).strip()[:90]}")
def reset_and_migrate():
    a = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); a.set_client_encoding("UTF8"); a.autocommit = True
    with a.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='invest254_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists invest254_test"); c.execute("create database invest254_test")
    a.close()
    conn = psycopg2.connect(**DSN); conn.set_client_encoding("UTF8"); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9][0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn
def register(cur, phone, username, site):
    cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, username, "x"*32, site])
    return q1(cur, "select id from profiles where site_id=%s and phone=%s", [site, phone])[0]

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()
    ACTOR = str(uuid.uuid4())
    print("\n== Setup: two platforms + a platform admin each + a site admin ==")
    p1 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "alpha", "Alpha"])[0]
    p2 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "beta",  "Beta"])[0]
    for pid in (p1, p2):
        q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [ACTOR, SYS, pid, "enterprise"])
        q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [ACTOR, SYS, pid, "active", "t"])
    a1 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "a1site", "A1"])[0]
    b1 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "b1site", "B1"])[0]
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, a1, p1])
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, b1, p2])
    pa1 = register(cur, "254700000021", "pa1", a1); q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [ACTOR, SYS, pa1, p1])
    pa2 = register(cur, "254700000022", "pa2", b1); q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [ACTOR, SYS, pa2, p2])
    saA1 = register(cur, "254700000031", "saA1", a1); q1(cur, "select * from fn_admin_set_user_role(%s,%s,%s,%s)", [ACTOR, SYS, saA1, "admin"])
    plA1 = register(cur, "254700000041", "plA1", a1)
    # A REAL platform_superadmin profile for the system-owner path (updated_by FKs to profiles).
    sysu = register(cur, "254700000051", "sysu", a1); cur.execute("update profiles set role='platform_superadmin' where id=%s", [sysu])

    CT = "BASE64_CIPHERTEXT_BLOB_FROM_ENGINE=="   # opaque; the RPC never decrypts it
    META = '{"api_key":{"set":true,"last4":"cb60"}}'
    SETTINGS = '{"api_user":"muchendu","username":"muchendu","client_ip":"1.2.3.4"}'

    print("\n== Empty read ==")
    r = q1(cur, "select fn_platform_get_registrar_config(%s,%s,%s)", [pa1, "platform_admin", p1])[0]
    check("initial read: exists=false, no secret", r["exists"] is False and r["has_secret"] is False, str(r))

    print("\n== Platform admin writes ONLY its own platform ==")
    w = q1(cur, "select fn_platform_set_registrar_config(%s,%s,%s,%s,%s::jsonb,%s,%s::jsonb,%s)",
           [pa1, "platform_admin", p1, "namecheap", SETTINGS, CT, META, 1])[0]
    check("pa1 saved config for p1 (has_secret)", w["exists"] and w["has_secret"], str(w))
    expect_error(cur, "select fn_platform_set_registrar_config(%s,%s,%s,%s,%s::jsonb,%s,%s::jsonb,%s)",
                 [pa1, "platform_admin", p2, "namecheap", SETTINGS, CT, META, 1], "PLATFORM_SCOPE_FORBIDDEN", "pa1 CANNOT write p2")
    expect_error(cur, "select fn_platform_get_registrar_config(%s,%s,%s)", [pa1, "platform_admin", p2], "PLATFORM_SCOPE_FORBIDDEN", "pa1 CANNOT read p2")
    expect_error(cur, "select fn_platform_get_registrar_config(%s,%s,%s)", [pa2, "platform_admin", p1], "PLATFORM_SCOPE_FORBIDDEN", "pa2 CANNOT read p1")

    print("\n== Masked read never leaks ciphertext; secrecy at rest ==")
    r = q1(cur, "select fn_platform_get_registrar_config(%s,%s,%s)", [pa1, "platform_admin", p1])[0]
    check("masked read has meta + has_secret, NO ciphertext key", ("secret_ciphertext" not in r) and r["has_secret"] and r["secret_meta"].get("api_key",{}).get("last4")=="cb60", str(r))
    row = q1(cur, "select secret_ciphertext, settings from platform_registrar_config where platform_id=%s and provider_code='namecheap'", [p1])
    check("api_key stored ONLY as ciphertext (never in settings)", row[0]==CT and ("api_key" not in row[1]), f"ct={row[0]!r} settings={row[1]}")

    print("\n== Authorization matrix ==")
    expect_error(cur, "select fn_platform_get_registrar_config(%s,%s,%s)", [saA1, "admin", p1], "NOT_AUTHORIZED", "site admin NOT_AUTHORIZED")
    expect_error(cur, "select fn_platform_get_registrar_config(%s,%s,%s)", [plA1, "player", p1], "NOT_AUTHORIZED", "player NOT_AUTHORIZED")
    rs = q1(cur, "select fn_platform_get_registrar_config(%s,%s,%s)", [sysu, SYS, p1])[0]
    check("system owner may read any platform", rs["exists"] and rs["has_secret"])
    ws = q1(cur, "select fn_platform_set_registrar_config(%s,%s,%s,%s,%s::jsonb,%s,%s::jsonb,%s)",
            [sysu, SYS, p2, "namecheap", SETTINGS, CT, META, 1])[0]
    check("system owner may write any platform", ws["exists"] and ws["has_secret"])

    print("\n== Service-role resolve returns ciphertext for decryption ==")
    res = q1(cur, "select fn_registrar_config_resolve(%s)", [p1])[0]
    check("resolve returns settings + ciphertext", res["secret_ciphertext"]==CT and res["settings"]["api_user"]=="muchendu", str(res))
    check("resolve is null for an unconfigured platform", q1(cur, "select fn_registrar_config_resolve(%s)", [str(uuid.uuid4())])[0] is None)

    print("\n== Secret update semantics: null=keep, ''=clear ==")
    q1(cur, "select fn_platform_set_registrar_config(%s,%s,%s,%s,%s::jsonb,%s,%s::jsonb,%s)",
       [pa1, "platform_admin", p1, "namecheap", '{"api_user":"muchendu2","username":"muchendu","client_ip":"1.2.3.4"}', None, None, None])[0]
    row = q1(cur, "select secret_ciphertext, settings->>'api_user' from platform_registrar_config where platform_id=%s and provider_code='namecheap'", [p1])
    check("null ciphertext KEEPS the secret + updates settings", row[0]==CT and row[1]=="muchendu2", str(row))
    q1(cur, "select fn_platform_set_registrar_config(%s,%s,%s,%s,%s::jsonb,%s,%s::jsonb,%s)",
       [pa1, "platform_admin", p1, "namecheap", None, "", None, None])[0]
    row = q1(cur, "select secret_ciphertext from platform_registrar_config where platform_id=%s and provider_code='namecheap'", [p1])
    check("empty ciphertext CLEARS the secret", row[0] is None, str(row))

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL: print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL REGISTRAR-CONFIG E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
