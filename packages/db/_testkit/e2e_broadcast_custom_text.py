#!/usr/bin/env python3
"""E2E: UI-C (docs/44, migration 0162) — an announcement's title and body can be edited before sending.

BEFORE (0001..0161) the "Announcement" template said "Edit the title and body before sending", but
fn_broadcast_notification could only send the template text verbatim ("We have an update to share…").
AFTER (0162) optional p_title / p_body override the template text (trimmed, bounded, audited); omitting
them keeps the template text, so existing 4-argument callers are unchanged. Scope rules are unchanged.
Run: python3 packages/db/_testkit/e2e_broadcast_custom_text.py   (needs local PG on /tmp:5433)
"""
import os, glob
import psycopg2

HERE = os.path.dirname(__file__)
MIG = os.path.join(HERE, "..", "migrations")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
SITE = "00000000-0000-0000-0000-000000000001"
DB = "uic_broadcast_test"
PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def build(upto):
    a = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); a.autocommit = True
    with a.cursor() as c:
        c.execute(f"select pg_terminate_backend(pid) from pg_stat_activity where datname='{DB}' and pid<>pg_backend_pid()")
        c.execute(f"drop database if exists {DB}"); c.execute(f"create database {DB}")
    a.close()
    conn = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname=DB); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(MIG, "[0-9][0-9][0-9][0-9]_*.sql"))):
            if os.path.basename(f)[:4] <= upto:
                c.execute(open(f, encoding="utf-8").read())
    return conn

def err(cur, sql, args):
    try:
        cur.execute(sql, args); return "ok"
    except psycopg2.Error as e:
        return str(e).split("\n")[0]

def scenario(upto, fixed):
    conn = build(upto); cur = conn.cursor()
    reg = lambda p, u: (cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [p, u, "x" * 32, SITE]), cur.fetchone()[0])[1]
    admin = reg("254711300001", "uicadmin"); cur.execute("update profiles set role='admin' where id=%s", [admin])
    p1 = reg("254711300002", "uicp1"); reg("254711300003", "uicp2")
    title, body = "  Weekend bonus  ", "Deposit this weekend and get 10% extra."
    r = err(cur, "select fn_broadcast_notification(%s,'admin','announcement','{}'::jsonb,%s,%s)", [admin, title, body])
    if not fixed:
        check("BUG REPRODUCED: the announcement text cannot be edited (no title/body parameters)", r != "ok", r)
        conn.close(); return
    check("a custom title and body are accepted", r == "ok", r)
    cur.execute("select title, body from user_notifications where user_id=%s and category=(select category from notification_templates where key='announcement')", [p1])
    got = cur.fetchone()
    check("players receive the edited text (title trimmed)", got == ("Weekend bonus", body), str(got))
    cur.execute("select detail from admin_actions where action='notification.broadcast' order by created_at desc limit 1")
    d = cur.fetchone()[0]
    check("the audit trail records that the text was edited, and the title", d.get("custom_text") is True and d.get("title") == "Weekend bonus", str(d))
    # the 4-argument form still sends the template text
    cur.execute("update user_notifications set resolved_at=now()")
    check("omitting the text keeps the template text (old callers unchanged)",
          err(cur, "select fn_broadcast_notification(%s,'admin','security_notice','{}'::jsonb)", [admin]) == "ok")
    cur.execute("select title from user_notifications where user_id=%s and category=(select category from notification_templates where key='security_notice')", [p1])
    check("...and the template title is used", cur.fetchone()[0] == "Protect your account and your money")
    check("a blank title falls back to the template title",
          err(cur, "select fn_broadcast_notification(%s,'admin','announcement','{}'::jsonb,'   ',%s)", [admin, "x"]) == "ok")
    check("an over-long title is refused", "TITLE_TOO_LONG" in err(cur, "select fn_broadcast_notification(%s,'admin','announcement','{}'::jsonb,%s,null)", [admin, "t" * 121]))
    check("an over-long body is refused", "BODY_TOO_LONG" in err(cur, "select fn_broadcast_notification(%s,'admin','announcement','{}'::jsonb,null,%s)", [admin, "b" * 2001]))
    check("a player still cannot broadcast", "NOT_AUTHORIZED" in err(cur, "select fn_broadcast_notification(%s,'player','announcement','{}'::jsonb,'x','y')", [p1]))
    cur.execute("select count(*) from pg_proc where proname='fn_broadcast_notification'")
    check("exactly one fn_broadcast_notification (no ambiguous overload)", cur.fetchone()[0] == 1)
    cur.execute("select has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') from pg_proc p where proname='fn_broadcast_notification'")
    check("not executable by anon/authenticated", cur.fetchone()[0] is False)
    conn.close()

print("BEFORE (0001..0161):"); scenario("0161", False)
print("AFTER (0001..0162):"); scenario("9999", True)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
raise SystemExit(1 if FAIL else 0)
