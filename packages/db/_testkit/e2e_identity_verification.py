#!/usr/bin/env python3
"""E2E: ACCT-1 (migration 0168) — player identity verification.

BEFORE (0001..0167): no kyc tables, no profiles.kyc_status.
AFTER (0168): uploads are type/size/rate limited; one pending submission per player; 18+ date of birth;
files belong to the uploader and are single use; the selfie must be a photo; review is scoped to the
reviewer's brands/platform, a rejection needs a note, every decision is audited; profiles.kyc_status
mirrors the decision; service_role only.
Run: python3 packages/db/_testkit/e2e_identity_verification.py   (needs local PG on /tmp:5433)
"""
import os, glob, datetime
import psycopg2

HERE = os.path.dirname(__file__)
MIG = os.path.join(HERE, "..", "migrations")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
DB = "kyc1_test"
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

JPG = psycopg2.Binary(b"\xff\xd8\xff" + b"\0" * 1024)
PDF = psycopg2.Binary(b"%PDF-1.4" + b"\0" * 512)
ADULT = datetime.date.today().replace(year=datetime.date.today().year - 30)
MINOR = datetime.date.today().replace(year=datetime.date.today().year - 17)

def up(cur, user, mime="image/jpeg", data=JPG):
    return q1(cur, "select fn_kyc_upload(%s,%s,%s)", [user, mime, data])[0]

def submit_sql():
    return "select fn_kyc_submit(%s,%s,%s,%s,%s,%s,%s,%s,%s)"

def scenario(upto, fixed):
    conn = build(upto); cur = conn.cursor()
    exists = q1(cur, "select to_regclass('public.kyc_submissions') is not null")[0]
    check("identity tables exist" if fixed else "no identity tables yet", exists == fixed)
    col = q1(cur, "select count(*) from information_schema.columns where table_name='profiles' and column_name='kyc_status'")[0] == 1
    check("profiles.kyc_status exists" if fixed else "no kyc_status yet", col == fixed)
    if not fixed:
        conn.close(); return

    OWNER = reg(cur, "254700000001", "owner", DEFAULT_SITE)
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [OWNER])
    b = q1(cur, "select fn_platform_create_site(%s,%s,'bravo','Bravo')", [OWNER, SYS])[0]
    p1 = reg(cur, "254711111111", "alice", DEFAULT_SITE)
    p2 = reg(cur, "254722222222", "bob", b)
    adminA = reg(cur, "254733333333", "adminA", DEFAULT_SITE)
    cur.execute("update profiles set role='admin' where id=%s", [adminA])
    adminB = reg(cur, "254744444444", "adminB", b)
    cur.execute("update profiles set role='admin' where id=%s", [adminB])

    check("a new player starts unverified", q1(cur, "select kyc_status from profiles where id=%s", [p1])[0] == "none")

    # uploads
    check("unsupported file types are refused", "UNSUPPORTED_FILE" in err(cur, "select fn_kyc_upload(%s,'image/gif',%s)", [p1, JPG]))
    check("empty files are refused", "EMPTY_FILE" in err(cur, "select fn_kyc_upload(%s,'image/jpeg',%s)", [p1, psycopg2.Binary(b"")]))
    check("files over 6 MB are refused", "FILE_TOO_LARGE" in err(cur, "select fn_kyc_upload(%s,'image/jpeg',%s)", [p1, psycopg2.Binary(b"\0" * (6 * 1024 * 1024 + 1))]))
    front, back, selfie = up(cur, p1), up(cur, p1), up(cur, p1)
    pdf = up(cur, p1, "application/pdf", PDF)
    other = up(cur, p2)

    S = submit_sql()
    base = lambda **k: [k.get("user", p1), k.get("site", DEFAULT_SITE), k.get("doc", "national_id"), k.get("name", "Alice Wanjiru"),
                        k.get("num", " ab12345 "), k.get("dob", ADULT), k.get("front", front), k.get("back", back), k.get("selfie", selfie)]
    check("a player cannot submit on another brand", "NOT_YOUR_BRAND" in err(cur, S, base(site=b)))
    check("under-18 dates of birth are refused", "INVALID_DOB" in err(cur, S, base(dob=MINOR)))
    check("another player's file cannot be used", "FILE_NOT_FOUND" in err(cur, S, base(back=other)))
    check("the selfie must be a photo", "SELFIE_MUST_BE_PHOTO" in err(cur, S, base(selfie=pdf)))
    check("one file cannot fill two slots", "FILE_REUSED" in err(cur, S, base(back=front)))
    check("a bad document type is refused", "check" in err(cur, S, base(doc="library_card")).lower())
    check("nothing changed after refused submissions", q1(cur, "select count(*) from kyc_submissions")[0] == 0
          and q1(cur, "select kyc_status from profiles where id=%s", [p1])[0] == "none")

    s1 = q1(cur, S, base(front=pdf))[0]
    check("a valid submission (PDF front) is accepted and the player is pending",
          q1(cur, "select status, id_number from kyc_submissions where id=%s", [s1]) == ("pending", "AB12345")
          and q1(cur, "select kyc_status from profiles where id=%s", [p1])[0] == "pending")
    check("its files are marked used", q1(cur, "select bool_and(used) from kyc_files where id in (%s,%s,%s)", [pdf, back, selfie])[0])
    f2, f3 = up(cur, p1), up(cur, p1)
    check("a second pending submission is refused", "ALREADY_PENDING" in err(cur, S, base(front=f2, back=None, selfie=f3)))
    check("used files cannot be reused", "FILE_NOT_FOUND" in err(cur, "update kyc_submissions set status='rejected' where id=%s; " + S,
          [s1] + base(front=pdf, back=None, selfie=f3)))
    cur.execute("update kyc_submissions set status='pending' where id=%s", [s1])

    # review
    R = "select fn_kyc_review(%s,%s,%s,%s,%s)"
    check("a player cannot review", "NOT_AUTHORIZED" in err(cur, R, [p2, "player", s1, "approved", None]))
    check("another brand's admin cannot review", "SITE_SCOPE_FORBIDDEN" in err(cur, R, [adminB, "admin", s1, "approved", None]))
    check("a rejection needs a note", "NOTE_REQUIRED" in err(cur, R, [adminA, "admin", s1, "rejected", "  "]))
    check("a bad decision is refused", "INVALID_DECISION" in err(cur, R, [adminA, "admin", s1, "maybe", None]))
    check("the brand admin can reject with a note", q1(cur, R, [adminA, "admin", s1, "rejected", "Photo is blurry"])[0] == "rejected")
    check("the player's status mirrors the rejection", q1(cur, "select kyc_status from profiles where id=%s", [p1])[0] == "rejected")
    check("a reviewed submission cannot be reviewed again", "ALREADY_REVIEWED" in err(cur, R, [adminA, "admin", s1, "approved", None]))
    check("the decision is audited with the brand", q1(cur, "select count(*) from admin_actions where action='kyc.review' and site_id=%s and detail->>'decision'='rejected'", [DEFAULT_SITE])[0] == 1)

    s2 = q1(cur, S, base(front=f2, back=None, selfie=f3))[0]
    check("after a rejection the player can submit again", s2 is not None)
    check("the System owner can approve any brand", q1(cur, R, [OWNER, SYS, s2, "approved", None])[0] == "approved"
          and q1(cur, "select kyc_status from profiles where id=%s", [p1])[0] == "approved")
    f4, f5 = up(cur, p1), up(cur, p1)
    check("a verified player cannot submit again", "ALREADY_VERIFIED" in err(cur, S, base(front=f4, back=None, selfie=f5)))

    # abuse limit + prune
    cur.execute("delete from kyc_files where user_id=%s and not used", [p2])
    for _ in range(12):
        up(cur, p2)
    check("more than 12 unused uploads a day are refused", "TOO_MANY_UPLOADS" in err(cur, "select fn_kyc_upload(%s,'image/jpeg',%s)", [p2, JPG]))
    cur.execute("update kyc_files set created_at = now() - interval '3 days' where user_id=%s", [p2])
    check("unused uploads older than two days are pruned, used ones kept",
          q1(cur, "select fn_kyc_prune_uploads()")[0] == 12 and q1(cur, "select count(*) from kyc_files where used")[0] >= 5)

    cur.execute("""select string_agg(proname, ',') from pg_proc where proname like 'fn_kyc_%'
                   and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute'))""")
    check("no kyc function is executable by anon/authenticated", cur.fetchone()[0] is None)
    check("RLS is on for both kyc tables", q1(cur, "select bool_and(relrowsecurity) from pg_class where relname in ('kyc_files','kyc_submissions')")[0])
    conn.close()

print("BEFORE (0001..0167):"); scenario("0167", False)
print("AFTER (0001..0168):"); scenario("9999", True)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
raise SystemExit(1 if FAIL else 0)
