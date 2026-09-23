#!/usr/bin/env python3
"""E2E: PAY-2 (docs/45, migration 0163) — C2B (Pay Bill) configuration + URL registration record.

BEFORE (0001..0162) there was no way to set C2B Confirmation/Validation URLs or edit the Pay Bill players
are told to pay (paybill_config was seed-only). AFTER (0163): owner-only read/update (validated, audited),
Safaricom's URL rules enforced, registration outcomes recorded, health counters, service-role only.
Run: python3 packages/db/_testkit/e2e_c2b_config.py   (needs local PG on /tmp:5433)
"""
import os, glob, json
import psycopg2

HERE = os.path.dirname(__file__)
MIG = os.path.join(HERE, "..", "migrations")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
SITE = "00000000-0000-0000-0000-000000000001"
DB = "pay2_c2b_test"
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
    cur.execute("select user_id from fn_register_user('254711400001','pay2owner',%s,null,%s)", ["x" * 32, SITE])
    owner = cur.fetchone()[0]; cur.execute("update profiles set role='platform_superadmin' where id=%s", [owner])
    cur.execute("select user_id from fn_register_user('254711400002','pay2admin',%s,null,%s)", ["x" * 32, SITE])
    admin = cur.fetchone()[0]; cur.execute("update profiles set role='admin' where id=%s", [admin])
    patch = {"shortcode": "600999", "accountNumber": "TRIO", "businessName": "TrioCodes Ltd", "instructions": "Use your phone number as the account.",
             "confirmationUrl": "https://api.triocodes.com/api/v1/deposits/c2b/confirmation", "validationUrl": "https://api.triocodes.com/api/v1/deposits/c2b/validation",
             "responseType": "Completed"}
    r = err(cur, "select fn_admin_update_c2b_config(%s,'platform_superadmin',%s::jsonb)", [owner, json.dumps(patch)])
    if not fixed:
        check("BUG REPRODUCED: no C2B configuration can be saved", r != "ok", r)
        conn.close(); return
    check("the owner saves the Pay Bill + C2B URLs", r == "ok", r)
    cur.execute("select shortcode, account_number, business_name, confirmation_url, response_type from fn_admin_get_c2b_config(%s,'platform_superadmin')", [owner])
    check("...and reads them back", cur.fetchone() == ("600999", "TRIO", "TrioCodes Ltd", patch["confirmationUrl"], "Completed"))
    cur.execute("select shortcode, account_number from paybill_config where id=1")
    check("the Pay Bill players are shown is the saved one (paybill_config)", cur.fetchone() == ("600999", "TRIO"))
    check("a brand admin cannot read it", "NOT_AUTHORIZED" in err(cur, "select * from fn_admin_get_c2b_config(%s,'admin')", [admin]))
    check("a brand admin cannot change it", "NOT_AUTHORIZED" in err(cur, "select fn_admin_update_c2b_config(%s,'admin','{\"shortcode\":\"600111\"}'::jsonb)", [admin]))
    for bad, why in [({"confirmationUrl": "http://api.x.com/c"}, "plain http"), ({"confirmationUrl": "https://api.x.com/mpesa/confirm"}, "the word mpesa"),
                     ({"validationUrl": "https://x.com/safaricom/v"}, "the word safaricom"), ({"confirmationUrl": "https://x.com/api?query=1"}, "the word query")]:
        check(f"a C2B URL with {why} is refused (Daraja rule)", "INVALID_C2B_URL" in err(cur, "select fn_admin_update_c2b_config(%s,'platform_superadmin',%s::jsonb)", [owner, json.dumps(bad)]))
    check("a malformed shortcode is refused", "INVALID_SHORTCODE" in err(cur, "select fn_admin_update_c2b_config(%s,'platform_superadmin','{\"shortcode\":\"12ab\"}'::jsonb)", [owner]))
    check("an unknown response type is refused", "INVALID_CONFIG" in err(cur, "select fn_admin_update_c2b_config(%s,'platform_superadmin','{\"responseType\":\"Maybe\"}'::jsonb)", [owner]))
    check("clearing the validation URL is allowed (empty)", err(cur, "select fn_admin_update_c2b_config(%s,'platform_superadmin','{\"validationUrl\":\"\"}'::jsonb)", [owner]) == "ok")
    cur.execute("select count(*) from admin_actions where action='c2b.config'")
    check("every change is audited", cur.fetchone()[0] == 2)
    # registration outcomes
    check("a failed registration is recorded", err(cur, "select fn_admin_record_c2b_registration(%s,'platform_superadmin','600999',%s,false,'Invalid Access Token')", [owner, patch["confirmationUrl"]]) == "ok")
    cur.execute("select registered_at, last_register_ok, last_register_message from fn_admin_get_c2b_config(%s,'platform_superadmin')", [owner])
    r = cur.fetchone(); check("...without marking the Pay Bill registered", r[0] is None and r[1] is False and r[2] == "Invalid Access Token", str(r))
    err(cur, "select fn_admin_record_c2b_registration(%s,'platform_superadmin','600999',%s,true,'Success')", [owner, patch["confirmationUrl"]])
    cur.execute("select registered_shortcode, registered_confirmation_url, last_register_ok from fn_admin_get_c2b_config(%s,'platform_superadmin')", [owner])
    check("a successful registration records what was registered", cur.fetchone() == ("600999", patch["confirmationUrl"], True))
    # health counters
    cur.execute("select fn_ingest_c2b('QWE123ABC', 50000, '254711400009', 'TRIO', '600999', '{}'::jsonb)")
    cur.execute("select received_7d, unclaimed, last_received_at is not null from fn_admin_get_c2b_config(%s,'platform_superadmin')", [owner])
    check("health shows payments received and unclaimed", cur.fetchone() == (1, 1, True))
    cur.execute("""select bool_or(has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
                   from pg_proc p where proname in ('fn_admin_get_c2b_config','fn_admin_update_c2b_config','fn_admin_record_c2b_registration','fn_c2b_url_ok')""")
    check("none of the C2B functions is executable by anon/authenticated", cur.fetchone()[0] is False)
    conn.close()

print("BEFORE (0001..0162):"); scenario("0162", False)
print("AFTER (0001..0163):"); scenario("9999", True)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
raise SystemExit(1 if FAIL else 0)
