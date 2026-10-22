#!/usr/bin/env python3
"""fn_admin_reset_security_answers e2e (migration 0210, docs/68) — against REAL PostgreSQL.

The in-memory mirror in apps/engine/src/admin.ts restates this ladder in TypeScript, and the route
tests drive that mirror. This file exists because the mirror is a copy: only the SQL actually guards
production, so each refusal is proven here by the exception the RPC itself raises.

Topology:
  platform P1 = {A1}      platform P2 = {B1}
  owner : platform_superadmin
  pa1   : platform_admin of P1
  pa2   : platform_admin of P2
  saA1  : site admin of A1 (the role this feature exists to rescue — knowledge is its step-up factor)
  saB1  : site admin of B1 (inside pa2's platform, outside pa1's)

Proves: the happy path clears every answer, stamps the force-logout epoch and writes one audit row;
and that self-reset, a site-admin actor, a peer platform_admin, a superadmin target, a cross-platform
reach and an unknown target are each refused with their own distinct code.

Run: python3 packages/db/_testkit/e2e_admin_reset_security_answers.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob
import psycopg2

DB = "invest254_reset_security"
DSN = dict(host="/tmp", port=5433, user="postgres", dbname=DB)
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
DEFAULT_SITE = "00000000-0000-0000-0000-000000000001"
SYS = "platform_superadmin"
PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))


def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()


def outcome(cur, sql, args):
    """'OK' or the raised exception text (autocommit connection)."""
    try:
        cur.execute(sql, args); return "OK"
    except psycopg2.Error as e:
        return (e.diag.message_primary or str(e)).strip()


def build():
    a = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); a.autocommit = True
    with a.cursor() as c:
        c.execute(f"select pg_terminate_backend(pid) from pg_stat_activity where datname='{DB}' and pid<>pg_backend_pid()")
        c.execute(f"drop database if exists {DB}"); c.execute(f"create database {DB}")
    a.close()
    conn = psycopg2.connect(**DSN); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9][0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn


def register(cur, phone, username, site):
    cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, username, "x" * 32, site])
    return str(q1(cur, "select id from profiles where site_id=%s and phone=%s", [site, phone])[0])


def enrol(cur, uid, n=3):
    """Store `n` answers directly — the hashes are written by AuthService in production, and their
    VALUES are irrelevant here: this RPC only ever deletes rows."""
    for i in range(n):
        cur.execute("insert into user_security_answers(user_id, question_key, answer_hash) values (%s,%s,%s)",
                    [uid, f"q{i}", f"scrypt$fake${i}"])


def answers(cur, uid):
    return q1(cur, "select count(*)::int from user_security_answers where user_id=%s", [uid])[0]


def reset(cur, actor, role, target):
    return outcome(cur, "select * from fn_admin_reset_security_answers(%s,%s,%s)", [actor, role, target])


def seed(cur):
    owner = register(cur, "254702000001", "rsowner", DEFAULT_SITE)
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [owner])
    p1 = str(q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [owner, SYS, "rsp1", "RSP1"])[0])
    p2 = str(q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [owner, SYS, "rsp2", "RSP2"])[0])
    for p in (p1, p2):
        q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [owner, SYS, p, "enterprise"])
        q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [owner, SYS, p, "active", "test"])
    mk = lambda slug: str(q1(cur, "select fn_platform_create_site(%s,%s,%s,%s,%s,%s)",
                             [owner, SYS, slug, slug.upper(), "KES", f"{slug}.test"])[0])
    a1, b1 = mk("rsa1"), mk("rsb1")
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [owner, SYS, a1, p1])
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [owner, SYS, b1, p2])

    pa1 = register(cur, "254702000100", "rspa1", a1)
    q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [owner, SYS, pa1, p1])
    pa2 = register(cur, "254702000101", "rspa2", b1)
    q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [owner, SYS, pa2, p2])

    saA1 = register(cur, "254702000200", "rssaa1", a1)
    cur.execute("update profiles set role='admin' where id=%s", [saA1])
    saB1 = register(cur, "254702000201", "rssab1", b1)
    cur.execute("update profiles set role='admin' where id=%s", [saB1])
    # A SECOND admin inside A1. Needed to test the TIER rule on its own: a cross-brand pair is
    # stopped by fn_assert_actor_site_scope first, so it proves the fence and says nothing about
    # whether a site admin may reset a peer it CAN legitimately see.
    saA1b = register(cur, "254702000202", "rssaa1b", a1)
    cur.execute("update profiles set role='admin' where id=%s", [saA1b])

    owner2 = register(cur, "254702000002", "rsowner2", DEFAULT_SITE)
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [owner2])

    for u in (owner, owner2, pa1, pa2, saA1, saB1, saA1b):
        enrol(cur, u)
    return dict(owner=owner, owner2=owner2, p1=p1, p2=p2, a1=a1, b1=b1,
                pa1=pa1, pa2=pa2, saA1=saA1, saB1=saB1, saA1b=saA1b)


def main():
    conn = build()
    cur = conn.cursor()
    f = seed(cur)
    print("fn_admin_reset_security_answers (0210)")

    # ── The happy path, which is the whole point: a site admin gets a way back in ───────────────
    before = answers(cur, f["saA1"])
    cur.execute("select cleared from fn_admin_reset_security_answers(%s,%s,%s)", [f["owner"], SYS, f["saA1"]])
    cleared = cur.fetchone()[0]
    check("owner resets a site admin: reports the number discarded", cleared == before == 3, f"cleared={cleared} before={before}")
    check("owner resets a site admin: no answers remain", answers(cur, f["saA1"]) == 0)
    stamped = q1(cur, "select sessions_valid_after is not null from profiles where id=%s", [f["saA1"]])[0]
    check("the target's live sessions are ended in the same step", stamped is True)
    n_audit = q1(cur, """select count(*)::int from admin_actions
                          where action='user.reset_security_answers' and target_id=%s and actor_id=%s""",
                 [f["saA1"], f["owner"]])[0]
    check("exactly one audit row, naming actor and target", n_audit == 1, f"rows={n_audit}")
    detail = q1(cur, """select detail->>'cleared', detail->>'target_role' from admin_actions
                         where action='user.reset_security_answers' and target_id=%s""", [f["saA1"]])
    check("the audit row records what was discarded and the target's role", detail == ("3", "admin"), str(detail))

    # ── Refusals, each by its OWN code ─────────────────────────────────────────────────────────
    check("self-reset is refused", reset(cur, f["owner"], SYS, f["owner"]) == "NO_SELF_ACTION")
    check("…and the self-resetter keeps every answer", answers(cur, f["owner"]) == 3)

    # The TIER rule, isolated: same brand, so the fence cannot be what refuses it. The target is
    # re-enrolled first so "nothing was cleared" is an assertion that can actually fail — saA1 was
    # emptied by the happy path above, and `== 0` there would have passed no matter what.
    enrol(cur, f["saA1"])
    same_brand = reset(cur, f["saA1b"], "admin", f["saA1"])
    check("a SITE admin may not reset a peer in its OWN brand", same_brand == "NOT_AUTHORIZED", same_brand)
    check("…and that peer keeps every answer", answers(cur, f["saA1"]) == 3, f"left={answers(cur, f['saA1'])}")
    # The fence, asserted separately so the two refusals cannot be confused for one another.
    cross = reset(cur, f["saB1"], "admin", f["saA1"])
    check("a SITE admin reaching another brand is stopped by the fence first", cross == "SITE_SCOPE_FORBIDDEN", cross)
    check("a platform_admin may not reset a platform_admin", reset(cur, f["pa1"], "platform_admin", f["pa2"]) == "INSUFFICIENT_PRIVILEGE")
    check("the system owner is protected from another owner", reset(cur, f["owner"], SYS, f["owner2"]) == "SUPERADMIN_PROTECTED")
    check("…and that owner keeps every answer", answers(cur, f["owner2"]) == 3)
    check("an unknown target is USER_NOT_FOUND",
          reset(cur, f["owner"], SYS, "00000000-0000-0000-0000-0000000000ff") == "USER_NOT_FOUND")

    # ── Scope: a platform_admin reaches its own platform and no further ────────────────────────
    out_cross = reset(cur, f["pa1"], "platform_admin", f["saB1"])
    check("a platform_admin cannot reach another platform's admin", out_cross == "PLATFORM_SCOPE_FORBIDDEN", out_cross)
    check("…and that admin keeps every answer", answers(cur, f["saB1"]) == 3)

    out_own = reset(cur, f["pa1"], "platform_admin", f["saA1"])
    check("a platform_admin CAN reset a site admin inside its own platform", out_own == "OK", out_own)
    check("…and the answers are gone", answers(cur, f["saA1"]) == 0)

    # ── A half-finished enrolment is a no-op, not an error ────────────────────────────────────
    cur.execute("select cleared from fn_admin_reset_security_answers(%s,%s,%s)", [f["owner"], SYS, f["saA1"]])
    check("resetting an account with no answers clears 0 and does not raise", cur.fetchone()[0] == 0)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("FAILED: " + ", ".join(FAIL))
    conn.close()
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
