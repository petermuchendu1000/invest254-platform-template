#!/usr/bin/env python3
"""Marketer-RPC brand fence e2e (Issue 3 / A1 — migration 0199).

Proves, against REAL Postgres with the full migration set applied through 0199:
  * FENCE: the six marketer mutating RPCs (fn_marketer_credit / _withdraw / _set_pin / _set_status /
    _set_fuliza / _set_airtime) now refuse a site-tier actor acting on ANOTHER brand's marketer
    (SITE_SCOPE_FORBIDDEN), via the existing fn_assert_actor_site_scope helper (0156).
  * SAME-BRAND / PLATFORM / OWNER / NULL actor all pass (platform tiers keep their own checks; the
    internal + self-service paths pass no actor, so the fence is a deliberate no-op).
  * SYSTEM PATH INTACT: the internal 4-arg fn_marketer_credit call shape (used by
    fn_marketer_game_withdraw, 0109) still resolves and credits — the whole reason the actor is
    OPTIONAL, not required. The full fn_marketer_game_withdraw demo→wallet settlement still works.
  * NO BEHAVIOUR DRIFT: each fenced body differs from its pre-0199 definition by EXACTLY the injected
    guard line + the two appended optional params (verified by normalising both and diffing), and the
    ordinary credit/withdraw/idempotency/validation semantics are unchanged.

Run: python3 packages/db/_testkit/e2e_marketer_rpc_tenant_fence.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, uuid, re
import psycopg2

DB = "invest254_marketer_fence"
DSN = dict(host="/tmp", port=5433, user="postgres", dbname=DB)
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
DEFAULT_SITE = "00000000-0000-0000-0000-000000000001"
SYS = "platform_superadmin"
FENCED = ["fn_marketer_credit", "fn_marketer_withdraw", "fn_marketer_set_pin",
          "fn_marketer_set_status", "fn_marketer_set_fuliza", "fn_marketer_set_airtime"]
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
        # fn_marketer_set_pin hashes with extensions.crypt / extensions.gen_salt (Supabase ships pgcrypto
        # in the `extensions` schema). The shim installs pgcrypto in public, so expose thin wrappers in
        # `extensions` for this throwaway — test-only, so the set_pin allowed-path exercises end-to-end.
        c.execute("""
          create schema if not exists extensions;
          create or replace function extensions.gen_salt(text) returns text language sql as $w$ select public.gen_salt($1) $w$;
          create or replace function extensions.gen_salt(text, integer) returns text language sql as $w$ select public.gen_salt($1,$2) $w$;
          create or replace function extensions.crypt(text, text) returns text language sql as $w$ select public.crypt($1,$2) $w$;
        """)
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9][0-9][0-9][0-9]_*.sql"))):
            if os.path.basename(f)[:4] <= upto:
                c.execute(open(f, encoding="utf-8").read())
    return conn

def register(cur, phone, username, site):
    cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, username, "x" * 32, site])
    return str(q1(cur, "select id from profiles where site_id=%s and phone=%s", [site, phone])[0])

def seed(cur):
    """Same two-platform topology as e2e_actor_scope_impersonation: P1={a1,a2}, P2={b1}; saA1 = a genuine
    site admin of a1. Marketers are created on a1 (saA1's OWN brand), a2 (same platform, other brand)
    and b1 (other platform) so every leak is unmistakable."""
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
    pa1 = register(cur, "254701000100", "pa1", b1)                 # platform admin of P1, HOME brand b1
    q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [owner, SYS, pa1, p1])
    saA1 = register(cur, "254701000200", "saA1", a1)
    cur.execute("update profiles set role='admin' where id=%s", [saA1])
    # One marketer per brand (fn_marketer_create stamps the brand + provisions the wallet).
    m_a1 = str(q1(cur, "select id from fn_marketer_create(%s,%s,%s)", ["M A1", "0722000011", a1])[0])
    m_a2 = str(q1(cur, "select id from fn_marketer_create(%s,%s,%s)", ["M A2", "0722000012", a2])[0])
    m_b1 = str(q1(cur, "select id from fn_marketer_create(%s,%s,%s)", ["M B1", "0722000013", b1])[0])
    return dict(owner=owner, a1=a1, a2=a2, b1=b1, pa1=pa1, saA1=saA1, m_a1=m_a1, m_a2=m_a2, m_b1=m_b1)

# One call per fenced RPC, with a given actor+role, against a given marketer.
def call(cur, fn, mid, actor, role):
    if fn == "fn_marketer_credit":
        return outcome(cur, "select fn_marketer_credit(%s,%s,%s,%s::jsonb,%s,%s)", [mid, 1000, str(uuid.uuid4()), "{}", actor, role])
    if fn == "fn_marketer_withdraw":
        return outcome(cur, "select fn_marketer_withdraw(%s,%s,%s,%s::jsonb,%s,%s,%s)", [mid, 1, str(uuid.uuid4()), "{}", "internal", actor, role])
    if fn == "fn_marketer_set_pin":
        return outcome(cur, "select fn_marketer_set_pin(%s,%s,%s,%s)", [mid, "4321", actor, role])
    if fn == "fn_marketer_set_status":
        return outcome(cur, "select fn_marketer_set_status(%s,%s,%s,%s)", [mid, "active", actor, role])
    if fn == "fn_marketer_set_fuliza":
        return outcome(cur, "select fn_marketer_set_fuliza(%s,%s,%s,%s)", [mid, 100, actor, role])
    if fn == "fn_marketer_set_airtime":
        return outcome(cur, "select fn_marketer_set_airtime(%s,%s,%s,%s)", [mid, 100, actor, role])
    raise AssertionError(fn)

def defs_of(cur):
    out = {}
    for fn in FENCED:
        cur.execute("select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace "
                    "where n.nspname='public' and p.proname=%s", [fn])
        rows = cur.fetchall()
        out[fn] = rows[0][0] if rows else None
    return out

def normalise(body):
    """Drop the injected fence line, the two appended actor params, and whitespace, so a pre/post diff
    is empty iff nothing else changed."""
    if body is None: return None
    body = re.sub(r"(?i)\n?[^\n]*fn_assert_actor_site_scope[^\n]*\n", "\n", body)
    body = body.replace(", p_actor uuid DEFAULT NULL, p_actor_role text DEFAULT NULL", "")
    body = body.replace(",\n  p_actor uuid DEFAULT NULL, p_actor_role text DEFAULT NULL", "")
    # pg_get_functiondef echoes defaults as DEFAULT NULL::uuid / ::text — normalise those forms too.
    body = re.sub(r",\s*p_actor uuid DEFAULT NULL::uuid,\s*p_actor_role text DEFAULT NULL::text", "", body)
    return re.sub(r"\s+", " ", body).strip().lower()

def main():
    print("== Build through 0199 (full migration set) ==")
    conn = build("0199"); cur = conn.cursor(); s = seed(cur)

    print("\n-- FENCE: site admin saA1 (brand a1) on another brand's marketer --")
    for fn in FENCED:
        check(f"{fn}: cross-brand same-platform (a2) REFUSED", call(cur, fn, s["m_a2"], s["saA1"], "admin") == "SITE_SCOPE_FORBIDDEN")
        check(f"{fn}: cross-platform (b1) REFUSED", call(cur, fn, s["m_b1"], s["saA1"], "admin") == "SITE_SCOPE_FORBIDDEN")
        check(f"{fn}: own brand (a1) OK", call(cur, fn, s["m_a1"], s["saA1"], "admin") == "OK")

    print("\n-- PASS-THROUGH: platform tier, owner, and NULL actor (system/self-service) --")
    for fn in FENCED:
        check(f"{fn}: platform_admin (not site-tier) OK", call(cur, fn, s["m_b1"], s["pa1"], "platform_admin") == "OK")
        check(f"{fn}: owner impersonating any brand OK", call(cur, fn, s["m_b1"], s["owner"], "admin") == "OK")
        check(f"{fn}: NULL actor (internal/self-service) OK", call(cur, fn, s["m_b1"], None, None) == "OK")

    print("\n-- SYSTEM PATH: the internal 4-arg fn_marketer_credit call shape still resolves --")
    bal0 = q1(cur, "select balance_cents from marketer_wallets where marketer_id=%s", [s["m_a1"]])[0]
    r = outcome(cur, "select fn_marketer_credit(%s,%s,%s,%s::jsonb)", [s["m_a1"], 2500, "game:" + str(uuid.uuid4()), "{}"])
    bal1 = q1(cur, "select balance_cents from marketer_wallets where marketer_id=%s", [s["m_a1"]])[0]
    check("internal 4-arg credit (no actor) succeeds", r == "OK")
    check("internal 4-arg credit actually credited the wallet", bal1 == bal0 + 2500, f"{bal0}->{bal1}")

    print("\n-- SYSTEM PATH: full fn_marketer_game_withdraw demo->wallet settlement still works --")
    # A player on b1 whose phone matches marketer m_b1's (fn_phone_sig9 cohort), with a demo balance.
    player = register(cur, "0722000013", "demoplayer", s["b1"])
    cur.execute("update wallets set demo_balance = 5000 where user_id=%s", [player])
    gw = outcome(cur, "select * from fn_marketer_game_withdraw(%s,%s)", [player, 1500])
    check("fn_marketer_game_withdraw settles instantly (internal credit path intact)", gw == "OK", gw)

    print("\n-- BEHAVIOUR: ordinary semantics unchanged --")
    # idempotent credit replay on a fixed ref returns the same balance (not double-credited).
    ref = "idem:" + str(uuid.uuid4())
    b_a = q1(cur, "select fn_marketer_credit(%s,%s,%s,%s::jsonb)", [s["m_a2"], 700, ref, "{}"])[0]
    b_b = q1(cur, "select fn_marketer_credit(%s,%s,%s,%s::jsonb)", [s["m_a2"], 700, ref, "{}"])[0]
    check("credit idempotency by ref preserved", b_a == b_b, f"{b_a} vs {b_b}")
    check("credit still rejects non-positive amount", outcome(cur, "select fn_marketer_credit(%s,%s)", [s["m_a1"], 0]) == "AMOUNT_MUST_BE_POSITIVE")
    check("set_status still validates the status value", outcome(cur, "select fn_marketer_set_status(%s,%s)", [s["m_a1"], "bogus"]) == "INVALID_STATUS")
    check("unknown marketer still reaches MARKETER_NOT_FOUND (fence no-ops on null site)",
          outcome(cur, "select fn_marketer_set_fuliza(%s,%s,%s,%s)", [str(uuid.uuid4()), 1, s["saA1"], "admin"]) == "MARKETER_NOT_FOUND")

    print("\n-- NO DRIFT: each fenced body == its pre-0199 definition apart from the fence line + params --")
    post = defs_of(cur)
    conn2 = build("0198"); cur2 = conn2.cursor(); seed(cur2)   # 0198 = last migration before this one
    pre = defs_of(cur2)
    for fn in FENCED:
        check(f"{fn}: body unchanged except the injected guard", normalise(pre[fn]) == normalise(post[fn]),
              f"\n    PRE : {normalise(pre[fn])}\n    POST: {normalise(post[fn])}")
        check(f"{fn}: now carries the fence call", "fn_assert_actor_site_scope" in (post[fn] or ""))
        check(f"{fn}: did NOT carry it before", "fn_assert_actor_site_scope" not in (pre[fn] or ""))

    print(f"\n== {len(PASS)} passed, {len(FAIL)} failed ==")
    if FAIL:
        print("FAILED:"); [print("  - " + n) for n in FAIL]; sys.exit(1)

if __name__ == "__main__":
    main()
