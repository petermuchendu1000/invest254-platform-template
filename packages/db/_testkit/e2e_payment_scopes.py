#!/usr/bin/env python3
"""E2E: payment scopes — per-platform / per-brand gateway accounts (PAY-1, docs/43, migration 0160).

Proves the storage + authorization layer the engine's money routing relies on:
  * a platform admin reads/writes gateway configs for ITS platform and ITS brands only;
  * owner-only settings (sandbox env, API base / callback URLs, CIDRs) are refused for platform admins;
  * secrets are write-only (masked read; NULL keeps, '' clears) and never mixed across scopes;
  * the legacy GLOBAL/site RPCs never see platform rows (no silent change to live global behaviour);
  * the brand's payment owner = active site scope > active platform scope > global;
  * per-brand gateway switches: platform admins for their own brands, entitled gateways only;
  * transactions.payment_scope is format-checked; every write is audited to a brand of that scope;
  * nothing is executable by anon/authenticated; 0160 re-applies cleanly.
Run: python3 packages/db/_testkit/e2e_payment_scopes.py   (needs local PG on /tmp:5433)
"""
import os, sys, glob, json
import psycopg2

HERE = os.path.dirname(__file__)
MIG = os.path.join(HERE, "..", "migrations")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
M0160 = os.path.join(MIG, "0160_payment_scopes.sql")
DB = "pay1_test"
DEFAULT_SITE = "00000000-0000-0000-0000-000000000001"
SYS = "platform_superadmin"
PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def err(cur, sql, args):
    try:
        cur.execute(sql, args); return "ok"
    except psycopg2.Error as e:
        return str(e).split("\n")[0]

def build():
    a = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); a.autocommit = True
    with a.cursor() as c:
        c.execute(f"select pg_terminate_backend(pid) from pg_stat_activity where datname='{DB}' and pid<>pg_backend_pid()")
        c.execute(f"drop database if exists {DB}"); c.execute(f"create database {DB}")
    a.close()
    conn = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname=DB); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(MIG, "[0-9][0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

def reg(cur, phone, user, site):
    return q1(cur, "select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, user, "x" * 32, site])[0]

def main():
    conn = build(); cur = conn.cursor()
    owner = reg(cur, "254700100000", "owner", DEFAULT_SITE); cur.execute("update profiles set role=%s where id=%s", [SYS, owner])
    p1 = q1(cur, "select fn_platform_create_platform(%s,%s,'alpha','Alpha')", [owner, SYS])[0]
    p2 = q1(cur, "select fn_platform_create_platform(%s,%s,'beta','Beta')", [owner, SYS])[0]
    cur.execute("insert into platform_subscriptions(platform_id, plan_key, status) values (%s,'enterprise','active'),(%s,'enterprise','active') "
                "on conflict (platform_id) do update set plan_key='enterprise', status='active'", [p1, p2])
    def site(slug, plat):
        sid = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [owner, SYS, slug, slug])[0]
        q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [owner, SYS, sid, plat]); return sid
    s1, s2, s3 = site("a-one", p1), site("a-two", p1), site("b-one", p2)
    pa1 = reg(cur, "254700100001", "pa_one", DEFAULT_SITE); q1(cur, "select fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [owner, SYS, pa1, p1])
    pa2 = reg(cur, "254700100002", "pa_two", DEFAULT_SITE); q1(cur, "select fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [owner, SYS, pa2, p2])
    sadm = reg(cur, "254700100003", "site_adm", s1); cur.execute("update profiles set role='admin' where id=%s", [sadm])

    SET = "select fn_provider_config_set_scoped(%s,%s,%s,%s,%s,%s::jsonb,%s,%s::jsonb,1)"
    GET = "select fn_provider_config_get_scoped(%s,%s,%s,%s,%s)"
    print("== scope authorization ==")
    check("platform admin configures ITS platform", err(cur, SET, [pa1, "platform_admin", "mpesa", "platform", p1, json.dumps({"environment": "production", "shortcode": "600111"}), "CIPHER1", json.dumps({"passkey": {"set": True, "last4": "abcd"}})]) == "ok")
    check("platform admin configures ITS brand", err(cur, SET, [pa1, "platform_admin", "megapay", "site", s1, json.dumps({"env": "production", "email": "a@x.test"}), "CIPHER2", "{}"]) == "ok")
    check("another platform is refused", "PLATFORM_SCOPE_FORBIDDEN" in err(cur, SET, [pa1, "platform_admin", "mpesa", "platform", p2, "{}", None, None]))
    check("another platform's brand is refused", "PLATFORM_SCOPE_FORBIDDEN" in err(cur, SET, [pa1, "platform_admin", "mpesa", "site", s3, "{}", None, None]))
    check("reading another platform's config is refused", "PLATFORM_SCOPE_FORBIDDEN" in err(cur, GET, [pa2, "platform_admin", "mpesa", "platform", p1]))
    check("a site admin is refused", "NOT_AUTHORIZED" in err(cur, SET, [sadm, "admin", "mpesa", "site", s1, "{}", None, None]))
    check("a token claiming platform_admin for a non-platform-admin profile is refused", "NOT_AUTHORIZED" in err(cur, SET, [sadm, "platform_admin", "mpesa", "site", s1, "{}", None, None]))
    check("an unknown scope target is refused", "SCOPE_NOT_FOUND" in err(cur, SET, [owner, SYS, "mpesa", "site", "00000000-0000-0000-0000-00000000beef", "{}", None, None]))
    check("an unknown scope type is refused", "INVALID_SCOPE" in err(cur, SET, [owner, SYS, "mpesa", "world", s1, "{}", None, None]))

    print("\n== owner-only settings (docs/43 §3.4) ==")
    for field, settings in [("api_base", {"api_base": "https://evil.test"}), ("base_url", {"base_url": "https://evil.test"}),
                            ("callback_url", {"callback_url": "https://evil.test/cb"}), ("stk_callback_url", {"stk_callback_url": "https://evil.test"}),
                            ("env", {"environment": "sandbox"}), ("env", {"env": "sandbox"})]:
        r = err(cur, SET, [pa1, "platform_admin", "mpesa", "platform", p1, json.dumps(settings), None, None])
        check(f"platform admin cannot set {field}={list(settings.values())[0]}", f"OWNER_ONLY_FIELD: {field}" in r, r)
    check("an EMPTY owner-only field is fine (form round-trip)", err(cur, SET, [pa1, "platform_admin", "mpesa", "platform", p1, json.dumps({"api_base": ""}), None, None]) == "ok")
    check("the System owner may set them", err(cur, SET, [owner, SYS, "megapay", "platform", p2, json.dumps({"env": "sandbox", "api_base": "https://sandbox.megapay.test"}), None, None]) == "ok")

    print("\n== secrets are write-only, per scope ==")
    g = q1(cur, GET, [pa1, "platform_admin", "mpesa", "platform", p1])[0]
    check("read returns masked meta, never ciphertext", g["has_secret"] and "secret_ciphertext" not in g and g["secret_meta"]["passkey"]["last4"] == "abcd", json.dumps(g))
    check("settings are replaced as sent (the engine merges before saving)", g["settings"] == {"api_base": ""}, json.dumps(g["settings"]))
    q1(cur, SET, [pa1, "platform_admin", "mpesa", "platform", p1, json.dumps({"environment": "production", "shortcode": "600111"}), None, None])
    r = q1(cur, "select fn_provider_config_resolve_scoped('mpesa','platform',%s)", [p1])[0]
    check("NULL ciphertext keeps the stored secret", r["secret_ciphertext"] == "CIPHER1")
    q1(cur, SET, [pa1, "platform_admin", "mpesa", "platform", p1, "{}", "", None])
    check("'' clears the secret", q1(cur, "select fn_provider_config_resolve_scoped('mpesa','platform',%s)", [p1])[0]["secret_ciphertext"] is None)
    q1(cur, SET, [pa1, "platform_admin", "mpesa", "platform", p1, "{}", "CIPHER1", json.dumps({"passkey": {"set": True, "last4": "abcd"}})])
    check("resolve_scoped is EXACT (no fallback to platform for a brand without its own row)", q1(cur, "select fn_provider_config_resolve_scoped('mpesa','site',%s)", [s2])[0] is None)

    print("\n== legacy global RPCs never see platform/site-scoped rows ==")
    q1(cur, "select fn_platform_set_provider_config(%s,%s,'megapay',null,%s::jsonb,'GLOBALCIPHER','{}'::jsonb,1)", [owner, SYS, json.dumps({"env": "production", "email": "owner@x.test"})])
    gg = q1(cur, "select fn_admin_get_provider_config(%s,'megapay',null)", [SYS])[0]
    check("global read returns the GLOBAL row", gg["exists"] and gg["settings"]["email"] == "owner@x.test", json.dumps(gg))
    rr = q1(cur, "select fn_provider_config_resolve('megapay', null)")[0]
    check("legacy resolve(null) -> the global row, not a platform row", rr["scope"] == "global" and rr["secret_ciphertext"] == "GLOBALCIPHER")
    rs = q1(cur, "select fn_provider_config_resolve('megapay', %s)", [s2])[0]
    check("legacy resolve(brand without own row) -> global (platform rows ignored)", rs["scope"] == "global")
    n = q1(cur, "select count(*) from payment_provider_config where provider_code='megapay'")[0]
    check("global + platform + site rows coexist (unique per scope)", n == 3, f"rows={n}")
    check("a row can never be both site and platform", "ck_provider_config_one_scope" in err(cur,
        "insert into payment_provider_config(provider_code, site_id, platform_id) values ('paystack', %s, %s)", [s1, p1]))

    print("\n== the brand's payment owner (docs/43 §2) ==")
    OWN = "select scope, payouts_enabled from fn_payment_owner_scope(%s)"
    check("default: every brand is on the System accounts", all(q1(cur, OWN, [s])[0] == "global" for s in (s1, s2, s3)))
    q1(cur, "select fn_payment_scope_set_active(%s,%s,'platform',%s,true,true)", [pa1, "platform_admin", p1])
    check("platform activated -> its brands' owner is the platform", q1(cur, OWN, [s1])[0] == f"platform:{p1}" and q1(cur, OWN, [s2])[0] == f"platform:{p1}")
    check("another platform's brand is untouched", q1(cur, OWN, [s3])[0] == "global")
    q1(cur, "select fn_payment_scope_set_active(%s,%s,'site',%s,true,false)", [pa1, "platform_admin", s2])
    o = q1(cur, OWN, [s2])
    check("an active brand scope wins over its platform (and carries payouts_enabled)", o == (f"site:{s2}", False), str(o))
    check("activating another platform's scope is refused", "PLATFORM_SCOPE_FORBIDDEN" in err(cur, "select fn_payment_scope_set_active(%s,%s,'platform',%s,true,true)", [pa1, "platform_admin", p2]))
    q1(cur, "select fn_payment_scope_set_active(%s,%s,'platform',%s,false,true)", [pa1, "platform_admin", p1])
    check("deactivating returns the brands to the System accounts", q1(cur, OWN, [s1])[0] == "global")
    rows = cur.execute("select scope_type, name, active from fn_payment_scopes_list(%s,%s,%s)", [pa1, "platform_admin", p1]) or cur.fetchall()
    check("the console lists the platform + its brands only", sorted(r[1] for r in rows) == ["Alpha", "a-one", "a-two"], str(rows))
    acts = q1(cur, "select count(*) from admin_actions where action in ('payment.scope.activate','payment.scope.deactivate') and site_id in (%s,%s)", [s1, s2])[0]
    check("activation/deactivation audited to a brand of that platform", acts >= 3, f"rows={acts}")
    nt = q1(cur, "select count(*), string_agg(title, ' | ') from user_notifications where user_id=%s and category='payments'", [owner])
    check("the System owner is notified of every switch (docs/43 §3.5)", nt[0] >= 3 and "moved to own accounts: Alpha" in nt[1] and "back on System accounts: Alpha" in nt[1], str(nt))
    check("...but not about its own switches", q1(cur, "select count(*) from user_notifications where user_id=%s and category='payments'", [pa1])[0] == 0)

    print("\n== per-brand gateway switches for platform admins ==")
    cur.execute("insert into brand_entitlements(site_id, category, key) values (%s,'payment_gateway','megapay') on conflict do nothing", [s1])
    check("platform admin enables an ENTITLED gateway on its brand", err(cur, "select fn_platform_set_provider_site(%s,%s,%s,'megapay',true)", [pa1, "platform_admin", s1]) == "ok")
    check("...but not a gateway the brand has not bought", "GATEWAY_NOT_ENTITLED" in err(cur, "select fn_platform_set_provider_site(%s,%s,%s,'paystack',true)", [pa1, "platform_admin", s1]))
    check("switching OFF never needs an entitlement", err(cur, "select fn_platform_set_provider_site(%s,%s,%s,'paystack',false)", [pa1, "platform_admin", s1]) == "ok")
    check("another platform's brand is refused", "PLATFORM_SCOPE_FORBIDDEN" in err(cur, "select fn_platform_set_provider_site(%s,%s,%s,'megapay',false)", [pa1, "platform_admin", s3]))
    check("clear works for its own brand", err(cur, "select fn_platform_clear_provider_site(%s,%s,%s,'megapay')", [pa1, "platform_admin", s1]) == "ok")
    check("site admins still cannot switch gateways", "NOT_AUTHORIZED" in err(cur, "select fn_platform_set_provider_site(%s,%s,%s,'megapay',false)", [sadm, "admin", s1]))

    print("\n== transactions.payment_scope ==")
    uid = reg(cur, "254700100009", "payer", s1)
    tx = q1(cur, "select fn_create_deposit_provider(%s,1000,'254700100009',%s,'megapay')", [uid, s1])[0]
    cur.execute("select fn_set_transaction_payment_scope(%s,%s)", [tx, f"platform:{p1}"])
    check("a scope is stamped on the transaction", q1(cur, "select payment_scope from transactions where id=%s", [tx])[0] == f"platform:{p1}")
    check("a malformed scope is rejected", "ck_transactions_payment_scope" in err(cur, "select fn_set_transaction_payment_scope(%s,'platform:nope')", [tx]))

    print("\n== grants + idempotency ==")
    fns = ["fn_provider_config_get_scoped(uuid,text,text,text,uuid)", "fn_provider_config_set_scoped(uuid,text,text,text,uuid,jsonb,text,jsonb,integer)",
           "fn_provider_config_resolve_scoped(text,text,uuid)", "fn_payment_scope_set_active(uuid,text,text,uuid,boolean,boolean)",
           "fn_payment_owner_scope(uuid)", "fn_set_transaction_payment_scope(uuid,text)", "fn_provider_config_clear_scoped(uuid,text,text,text,uuid)"]
    for f in fns:
        for role in ("anon", "authenticated"):
            check(f"{f.split('(')[0]} not executable by {role}", not q1(cur, "select has_function_privilege(%s, %s::regprocedure, 'EXECUTE')", [role, f"public.{f}"])[0])
    check("payment_scopes not readable by anon", not q1(cur, "select has_table_privilege('anon','public.payment_scopes','SELECT')")[0])
    try:
        cur.execute(open(M0160, encoding="utf-8").read()); check("0160 re-applies cleanly", True)
    except psycopg2.Error as e:
        check("0160 re-applies cleanly", False, str(e)[:200])
    check("state survives re-apply", q1(cur, OWN, [s2])[0] == f"site:{s2}")
    check("clear removes a scoped row", q1(cur, "select fn_provider_config_clear_scoped(%s,%s,'megapay','site',%s)", [pa1, "platform_admin", s1])[0] is True)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
