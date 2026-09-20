#!/usr/bin/env python3
"""Issue 2 — add-on catalog / entitlements / requests isolation + workflow e2e (migrations 0144-0147).

Proves:
  * every brand is backfilled with the free defaults (line / classic / mpesa);
  * the catalog lists prices to operators; only the SYSTEM admin edits a price;
  * requests are scoped (site admin: own brand; platform admin: its platform; cross-brand refused);
  * a request cannot duplicate an owned entitlement (ALREADY_ENTITLED);
  * only the SYSTEM admin decides; approve => entitlement granted, chart set ACTIVE, charge recorded;
  * gateway entitlement helper always includes mpesa; grant/revoke are system-only; default un-revokable;
  * revoking an active chart resets it to the default.

Run: python3 packages/db/_testkit/e2e_addon_entitlements.py   (needs local PG on /tmp:5433)
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
    print("\n== Setup ==")
    p1 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "alpha", "Alpha"])[0]
    p2 = q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [ACTOR, SYS, "beta",  "Beta"])[0]
    for pid in (p1, p2):
        q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [ACTOR, SYS, pid, "enterprise"])
        q1(cur, "select fn_subscription_set_status(%s,%s,%s,%s,%s)", [ACTOR, SYS, pid, "active", "t"])
    a1 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "a1site", "A1"])[0]
    a2 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "a2site", "A2"])[0]
    b1 = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [ACTOR, SYS, "b1site", "B1"])[0]
    for s in (a1, a2): q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, s, p1])
    q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [ACTOR, SYS, b1, p2])
    # backfill only auto-runs at migrate time (before these sites existed) -> seed defaults for new sites
    cur.execute("""insert into brand_entitlements(site_id, category, key)
                   select s.id, c.category, c.key from sites s cross join addon_catalog c where c.is_default
                   on conflict do nothing""")
    pa1  = register(cur, "254700000021", "pa1", a1); q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [ACTOR, SYS, pa1, p1])
    saA1 = register(cur, "254700000031", "saA1", a1); q1(cur, "select * from fn_admin_set_user_role(%s,%s,%s,%s)", [ACTOR, SYS, saA1, "admin"])
    plA1 = register(cur, "254700000041", "plA1", a1)
    sysu = register(cur, "254700000051", "sysu", a1); cur.execute("update profiles set role='platform_superadmin' where id=%s", [sysu])

    print("\n== Backfill + catalog ==")
    n = q1(cur, "select count(*) from brand_entitlements where site_id=%s", [a1])[0]
    check("brand a1 backfilled with 3 defaults (line/classic/mpesa)", n == 3, str(n))
    cat = q1(cur, "select fn_addon_catalog_list(%s)", ["platform_admin"])[0]
    keys = {(c["category"], c["key"]): c["price_cents"] for c in cat}
    check("catalog has paystack @ 1,000,000 and stripe @ 1,500,000",
          keys.get(("payment_gateway","paystack"))==1000000 and keys.get(("payment_gateway","stripe"))==1500000, str(keys))
    check("player sees NO catalog", q1(cur, "select fn_addon_catalog_list(%s)", ["player"])[0] == [])

    print("\n== Pricing (system only) ==")
    q1(cur, "select fn_addon_set_price(%s,%s,%s,%s,%s)", [sysu, SYS, "chart", "candlestick", 500000])
    check("system set candlestick price", q1(cur,"select price_cents from addon_catalog where category='chart' and key='candlestick'")[0]==500000)
    expect_error(cur, "select fn_addon_set_price(%s,%s,%s,%s,%s)", [pa1,"platform_admin","chart","candlestick",1], "NOT_AUTHORIZED", "platform admin CANNOT set price")

    print("\n== Requests (scoped) ==")
    q1(cur, "select fn_addon_request(%s,%s,%s,%s,%s,%s)", [saA1,"admin",a1,"chart","candlestick",None])
    check("site admin requested candlestick for own brand", q1(cur,"select count(*) from addon_requests where site_id=%s and key='candlestick' and status='requested'",[a1])[0]==1)
    expect_error(cur, "select fn_addon_request(%s,%s,%s,%s,%s,%s)", [saA1,"admin",a2,"chart","area",None], "SITE_SCOPE_FORBIDDEN", "site admin CANNOT request for a sibling brand")
    expect_error(cur, "select fn_addon_request(%s,%s,%s,%s,%s,%s)", [saA1,"admin",a1,"chart","line",None], "ALREADY_ENTITLED", "cannot request an owned default")
    q1(cur, "select fn_addon_request(%s,%s,%s,%s,%s,%s)", [pa1,"platform_admin",a2,"payment_gateway","paystack",None])
    check("platform admin requested for a brand in its platform", q1(cur,"select count(*) from addon_requests where site_id=%s and key='paystack'",[a2])[0]==1)
    expect_error(cur, "select fn_addon_request(%s,%s,%s,%s,%s,%s)", [pa1,"platform_admin",b1,"payment_gateway","paystack",None], "SITE_SCOPE_FORBIDDEN", "platform admin CANNOT request for another platform")

    print("\n== Brand view ==")
    view = {(r["category"], r["key"]): r for r in q1(cur, "select fn_addon_brand_view(%s,%s,%s)", [saA1,"admin",a1])[0]}
    check("line entitled+active in view", view[("chart","line")]["entitled"] and view[("chart","line")]["active"])
    check("candlestick locked but pending", (not view[("chart","candlestick")]["entitled"]) and view[("chart","candlestick")]["pending"] and view[("chart","candlestick")]["price_cents"]==500000)

    print("\n== List requests (scoped) ==")
    check("site admin sees only its brand's requests", all(r["site_id"]==str(a1) for r in q1(cur,"select fn_addon_list_requests(%s,%s,%s)",[saA1,"admin",None])[0]))
    pa_ids = {r["site_id"] for r in q1(cur,"select fn_addon_list_requests(%s,%s,%s)",[pa1,"platform_admin",None])[0]}
    check("platform admin sees its platform's (a1,a2) not b1", pa_ids <= {str(a1),str(a2)} and str(b1) not in pa_ids)
    check("system sees all (>=2 incl b-platform if any)", len(q1(cur,"select fn_addon_list_requests(%s,%s,%s)",[sysu,SYS,None])[0]) >= 2)

    print("\n== Decide (system only) => grant + active + charge ==")
    req = q1(cur, "select id from addon_requests where site_id=%s and key='candlestick' and status='requested'", [a1])[0]
    expect_error(cur, "select fn_addon_decide_request(%s,%s,%s,%s,%s)", [pa1,"platform_admin",req,"approve",None], "NOT_AUTHORIZED", "platform admin CANNOT decide")
    q1(cur, "select fn_addon_decide_request(%s,%s,%s,%s,%s)", [sysu, SYS, req, "approve", None])
    check("approve entitled candlestick", q1(cur,"select count(*) from brand_entitlements where site_id=%s and key='candlestick'",[a1])[0]==1)
    check("approve set chart_style ACTIVE = candlestick", q1(cur,"select chart_style from sites where id=%s",[a1])[0]=="candlestick")
    check("charge recorded in admin_actions", q1(cur,"select count(*) from admin_actions where action='addon.charge' and target_id=%s",[str(a1)])[0]>=1)
    check("request marked approved", q1(cur,"select status from addon_requests where id=%s",[req])[0]=="approved")

    print("\n== Gateways + grant/revoke ==")
    q1(cur, "select fn_addon_grant(%s,%s,%s,%s,%s)", [sysu, SYS, a1, "payment_gateway", "paystack"])
    gws = q1(cur, "select fn_site_entitled_gateways(%s)", [a1])[0]
    check("entitled gateways include mpesa + paystack", set(["mpesa","paystack"]).issubset(set(gws)), str(gws))
    check("brand with NO gateway rows still gets mpesa", "mpesa" in q1(cur,"select fn_site_entitled_gateways(%s)",[b1])[0])
    expect_error(cur, "select fn_addon_grant(%s,%s,%s,%s,%s)", [pa1,"platform_admin",a1,"payment_gateway","binance"], "NOT_AUTHORIZED", "platform admin CANNOT grant")
    expect_error(cur, "select fn_addon_revoke(%s,%s,%s,%s,%s)", [sysu,SYS,a1,"payment_gateway","mpesa"], "CANNOT_REVOKE_DEFAULT", "cannot revoke the mpesa default")
    q1(cur, "select fn_addon_revoke(%s,%s,%s,%s,%s)", [sysu, SYS, a1, "chart", "candlestick"])
    check("revoke active chart resets to line", q1(cur,"select chart_style from sites where id=%s",[a1])[0]=="line" and q1(cur,"select count(*) from brand_entitlements where site_id=%s and key='candlestick'",[a1])[0]==0)

    print("\n== Grandfather: existing brands keep currently-enabled gateways (0149) ==")
    cur.execute("update payment_providers set enabled_global = true where code='megapay'")
    cur.execute("""insert into brand_entitlements (site_id, category, key)
                   select s.id, 'payment_gateway', p.code from sites s
                   cross join lateral fn_list_effective_providers(s.id) p where p.enabled=true
                   on conflict (site_id, category, key) do nothing""")
    check("grandfather entitles a1 to the globally-enabled megapay",
          q1(cur,"select count(*) from brand_entitlements where site_id=%s and category='payment_gateway' and key='megapay'",[a1])[0]==1)

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL: print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL ADDON-ENTITLEMENT E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
