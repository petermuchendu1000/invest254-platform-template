#!/usr/bin/env python3
"""E2E: CHAT-1 (migration 0167) — human live chat + brand WhatsApp number.

BEFORE (0001..0166): no live chat tables or functions; brands had no WhatsApp support number.
AFTER (0167): one open thread per player, brand-stamped messages and attachments, type/size limits,
unread counters, resolve/reopen with a system line, retention, service_role-only functions, and a
WhatsApp number editable through the audited site patch.
Run: python3 packages/db/_testkit/e2e_live_chat.py   (needs local PG on /tmp:5433)
"""
import os, glob
import psycopg2

HERE = os.path.dirname(__file__)
MIG = os.path.join(HERE, "..", "migrations")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
DB = "chat1_test"
SYS = "platform_superadmin"
DEFAULT_SITE = "00000000-0000-0000-0000-000000000001"
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

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def err(cur, sql, args=None):
    try:
        cur.execute(sql, args or []); return "ok"
    except psycopg2.Error as e:
        return str(e).split("\n")[0]

def reg(cur, phone, user, site):
    cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, user, "x" * 32, site]); return cur.fetchone()[0]

def scenario(upto, fixed):
    conn = build(upto); cur = conn.cursor()
    exists = q1(cur, "select to_regclass('public.chat_threads') is not null")[0]
    check("live chat tables exist" if fixed else "no live chat tables yet", exists == fixed)
    wa_col = q1(cur, "select count(*) from information_schema.columns where table_name='sites' and column_name='support_whatsapp'")[0] == 1
    check("sites.support_whatsapp exists" if fixed else "no WhatsApp column yet", wa_col == fixed)
    if not fixed:
        conn.close(); return

    OWNER = reg(cur, "254700000001", "owner", DEFAULT_SITE)
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [OWNER])
    b = q1(cur, "select fn_platform_create_site(%s,%s,'bravo','Bravo')", [OWNER, SYS])[0]
    p1 = reg(cur, "254711111111", "alice", DEFAULT_SITE)
    p2 = reg(cur, "254722222222", "bob", b)
    agent = reg(cur, "254733333333", "agent", DEFAULT_SITE)

    t1 = q1(cur, "select fn_chat_open_thread(%s,%s)", [p1, DEFAULT_SITE])[0]
    check("opening again returns the same open thread", q1(cur, "select fn_chat_open_thread(%s,%s)", [p1, DEFAULT_SITE])[0] == t1)
    check("a player cannot open a thread on another brand", "NOT_YOUR_BRAND" in err(cur, "select fn_chat_open_thread(%s,%s)", [p1, b]))
    check("a second open thread per player is impossible", "unique" in err(cur, "insert into chat_threads(site_id,user_id) values (%s,%s)", [DEFAULT_SITE, p1]).lower())

    check("an empty message is refused", "EMPTY_MESSAGE" in err(cur, "select fn_chat_post(%s,'player',%s,'  ',null)", [t1, p1]))
    m1 = q1(cur, "select fn_chat_post(%s,'player',%s,'Deposit missing',null)", [t1, p1])[0]
    check("the message carries the thread's brand", q1(cur, "select site_id from chat_messages where id=%s", [m1])[0] == DEFAULT_SITE)
    check("a player message bumps agent_unread", q1(cur, "select agent_unread, player_unread, last_preview from chat_threads where id=%s", [t1]) == (1, 0, "Deposit missing"))

    check("unsupported files are refused", "UNSUPPORTED_FILE" in err(cur, "select fn_chat_attach(%s,%s,'application/pdf',%s)", [t1, p1, psycopg2.Binary(b"x")]))
    check("photos over 5 MB are refused", "FILE_TOO_LARGE" in err(cur, "select fn_chat_attach(%s,%s,'image/jpeg',%s)", [t1, p1, psycopg2.Binary(b"\0" * (5 * 1024 * 1024 + 1))]))
    check("voice notes over 3 MB are refused", "FILE_TOO_LARGE" in err(cur, "select fn_chat_attach(%s,%s,'audio/webm',%s)", [t1, p1, psycopg2.Binary(b"\0" * (3 * 1024 * 1024 + 1))]))
    a1 = q1(cur, "select fn_chat_attach(%s,%s,'video/mp4',%s)", [t1, p1, psycopg2.Binary(b"\0" * 2048)])[0]
    check("a short video is stored with its kind and brand", q1(cur, "select kind, size_bytes, site_id from chat_attachments where id=%s", [a1]) == ("video", 2048, DEFAULT_SITE))
    cur.execute("select fn_chat_post(%s,'player',%s,'',%s)", [t1, p1, a1])
    check("an attachment-only message previews its kind", q1(cur, "select last_preview, agent_unread from chat_threads where id=%s", [t1]) == ("[video]", 2))
    t2 = q1(cur, "select fn_chat_open_thread(%s,%s)", [p2, b])[0]
    check("an attachment from another thread cannot be posted", "ATTACHMENT_NOT_FOUND" in err(cur, "select fn_chat_post(%s,'player',%s,'',%s)", [t2, p2, a1]))

    cur.execute("select fn_chat_mark_read(%s,'agent')", [t1])
    cur.execute("select fn_chat_post(%s,'agent',%s,'Checking now',null)", [t1, agent])
    check("an agent reply clears nothing for the player and bumps player_unread", q1(cur, "select agent_unread, player_unread from chat_threads where id=%s", [t1]) == (0, 1))
    cur.execute("select fn_chat_mark_read(%s,'player')", [t1])
    check("mark read zeroes the reader's counter", q1(cur, "select player_unread from chat_threads where id=%s", [t1])[0] == 0)

    cur.execute("select fn_chat_set_status(%s,%s,'resolved')", [t1, agent])
    check("resolving records who and when, and a system line", q1(cur, "select status, resolved_by is not null from chat_threads where id=%s", [t1]) == ("resolved", True)
          and q1(cur, "select count(*) from chat_messages where thread_id=%s and author_role='system'", [t1])[0] == 1)
    check("a player cannot write into a resolved thread", "THREAD_CLOSED" in err(cur, "select fn_chat_post(%s,'player',%s,'hi',null)", [t1, p1]))
    t3 = q1(cur, "select fn_chat_open_thread(%s,%s)", [p1, DEFAULT_SITE])[0]
    check("the player's next message opens a fresh thread", t3 != t1)
    cur.execute("select fn_chat_post(%s,'player',%s,'new question',null)", [t3, p1])
    check("reopening the old thread is refused while another is open", "PLAYER_HAS_OPEN_THREAD" in err(cur, "select fn_chat_set_status(%s,%s,'open')", [t1, agent]))
    check("an agent reply to the old thread is refused while another is open", "PLAYER_HAS_OPEN_THREAD" in err(cur, "select fn_chat_post(%s,'agent',%s,'late reply',null)", [t1, agent]))
    cur.execute("select fn_chat_set_status(%s,%s,'resolved')", [t3, agent])
    cur.execute("select fn_chat_post(%s,'agent',%s,'Following up',null)", [t1, agent])
    check("with no other open thread, an agent reply reopens the conversation", q1(cur, "select status from chat_threads where id=%s", [t1])[0] == "open")

    cur.execute("update chat_attachments set created_at = now() - interval '120 days' where id=%s", [a1])
    check("retention removes old attachments", q1(cur, "select fn_chat_prune_attachments(90)")[0] == 1
          and q1(cur, "select attachment_id from chat_messages where body='' and thread_id=%s", [t1])[0] is None)

    cur.execute("select fn_platform_update_site(%s,%s,%s,%s::jsonb)", [OWNER, SYS, b, '{"support_whatsapp":"+254 (712) 345-678"}'])
    check("the WhatsApp number is saved normalised", q1(cur, "select support_whatsapp from sites where id=%s", [b])[0] == "+254712345678")
    check("an invalid WhatsApp number is refused", "check" in err(cur, "select fn_platform_update_site(%s,%s,%s,%s::jsonb)", [OWNER, SYS, b, '{"support_whatsapp":"call me"}']).lower())
    check("the change is audited", q1(cur, "select count(*) from admin_actions where action='platform.site.update' and detail->'patch' ? 'support_whatsapp'")[0] >= 1)

    cur.execute("""select string_agg(proname, ',') from pg_proc where proname like 'fn_chat_%'
                   and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute'))""")
    check("no chat function is executable by anon/authenticated", cur.fetchone()[0] is None)
    check("RLS is on for every chat table", q1(cur, "select bool_and(relrowsecurity) from pg_class where relname in ('chat_threads','chat_messages','chat_attachments')")[0])
    conn.close()

print("BEFORE (0001..0166):"); scenario("0166", False)
print("AFTER (0001..0167):"); scenario("9999", True)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
raise SystemExit(1 if FAIL else 0)
