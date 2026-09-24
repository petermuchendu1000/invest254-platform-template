#!/usr/bin/env python3
"""E2E: ADDON-1 (docs/48, migration 0166) — the add-ons marketplace.

BEFORE (0001..0165): deciding a request overwrote the requester's note; a request could not be withdrawn; a brand
could not switch between systems it owns; a price change between request and approval changed what the brand was
charged; the catalog had no description and its pricing model could not be edited; removing an add-on before it
was invoiced still billed it.
AFTER (0166): all of the above fixed, scoped and audited.
Run: python3 packages/db/_testkit/e2e_addon_marketplace.py   (needs local PG on /tmp:5433)
"""
import os, glob, json
import psycopg2

HERE = os.path.dirname(__file__)
MIG = os.path.join(HERE, "..", "migrations")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
DB = "addon1_test"
SYS, PA, ADM = "platform_superadmin", "platform_admin", "admin"
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
    OWNER = reg(cur, "254700000001", "owner", DEFAULT_SITE)
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [OWNER])
    alpha = q1(cur, "select fn_platform_create_platform(%s,%s,'alpha','Alpha')", [OWNER, SYS])[0]
    beta = q1(cur, "select fn_platform_create_platform(%s,%s,'beta','Beta')", [OWNER, SYS])[0]
    def site(slug, p):
        s = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [OWNER, SYS, slug, slug.upper()])[0]
        q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [OWNER, SYS, s, p]); return s
    a1, b1 = site("a1site", alpha), site("b1site", beta)
    pa = reg(cur, "254700000011", "pa_alpha", a1); q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [OWNER, SYS, pa, alpha])
    adm = reg(cur, "254700000012", "adm_a1", a1); cur.execute("update profiles set role='admin' where id=%s", [adm])
    adm_b = reg(cur, "254700000013", "adm_b1", b1); cur.execute("update profiles set role='admin' where id=%s", [adm_b])
    cur.execute("select fn_subscription_set_plan(%s,%s,%s,'business')", [OWNER, SYS, alpha])
    cur.execute("update addon_catalog set price_cents=5000000, billing_type='one_off' where category='chart' and key='area'")

    rid = q1(cur, "select (fn_addon_request(%s,%s,%s,'chart','area','We want a premium look')->>'id')::bigint", [adm, ADM, a1])[0]
    if not fixed:
        cur.execute("select fn_addon_decide_request(%s,%s,%s,'approve','Approved for Q4')", [OWNER, SYS, rid])
        check("BUG REPRODUCED: approving overwrites the brand's reason with the owner's note",
              q1(cur, "select note from addon_requests where id=%s", [rid])[0] == "Approved for Q4")
        check("BUG REPRODUCED: a request cannot be withdrawn", "does not exist" in err(cur, "select fn_addon_cancel_request(%s,%s,1)", [adm, ADM]))
        check("BUG REPRODUCED: a brand cannot switch to a system it owns", "does not exist" in err(cur, "select fn_addon_activate(%s,%s,%s,'chart','line')", [adm, ADM, a1]))
        check("BUG REPRODUCED: the catalog has no description", "does not exist" in err(cur, "select description from addon_catalog"))
        conn.close(); return

    print("  -- catalog")
    cat = q1(cur, "select fn_addon_catalog_list(%s)", [SYS])[0]
    area = next(x for x in cat if x["key"] == "area")
    check("items have a description and a pricing model", area["description"] and area["billing_type"] == "one_off", str(area))
    check("the owner sees adoption numbers", area["brands"] == 0 and area["pending"] == 1, str(area))
    check("operators do not see adoption numbers", next(x for x in q1(cur, "select fn_addon_catalog_list(%s)", [ADM])[0] if x["key"] == "area")["brands"] is None)
    upd = lambda patch, k="candlestick", cat_="chart", role=SYS: err(cur, "select fn_addon_update(%s,%s,%s,%s,%s::jsonb)", [OWNER, role, cat_, k, json.dumps(patch)])
    check("only the owner edits the catalog", "NOT_AUTHORIZED" in upd({"priceCents": 1}, role=PA))
    check("free means no price", "FREE_HAS_PRICE" in upd({"billingType": "free", "priceCents": 100}))
    check("a paid model needs a price", "PRICE_REQUIRED" in upd({"billingType": "monthly", "priceCents": 0}))
    check("a category's free default stays free and offered", "DEFAULT_MUST_BE_FREE" in upd({"active": False}, k="line"))
    check("the owner switches candlesticks to monthly with a setup fee",
          upd({"billingType": "monthly", "priceCents": 800000, "setupFeeCents": 300000, "description": "Pro terminal", "displayName": "Candlesticks Pro"}) == "ok")
    c = q1(cur, "select billing_type, price_cents, setup_fee_cents, description, display_name from addon_catalog where key='candlestick'")
    check("...and it is saved", c == ("monthly", 800000, 300000, "Pro terminal", "Candlesticks Pro"), str(c))
    check("...and audited", q1(cur, "select count(*) from admin_actions where action='addon.update'")[0] == 1)
    check("the legacy price setter keeps the model coherent (0 = free)", err(cur, "select fn_addon_set_price(%s,%s,'chart','bars',0)", [OWNER, SYS]) == "ok"
          and q1(cur, "select billing_type, setup_fee_cents from addon_catalog where key='bars'") == ("free", 0))
    upd({"active": False}, k="binance", cat_="payment_gateway")
    check("a hidden add-on is not offered to brands", not any(x["key"] == "binance" for x in q1(cur, "select fn_addon_catalog_list(%s)", [ADM])[0]))
    check("...and cannot be requested", "ADDON_NOT_FOUND" in err(cur, "select fn_addon_request(%s,%s,%s,'payment_gateway','binance',null)", [adm, ADM, a1]))

    print("  -- requests")
    r = q1(cur, "select note, billing_type, price_cents from addon_requests where id=%s", [rid])
    check("a request snapshots the quote (pricing model + price) and keeps the reason", r == ("We want a premium look", "one_off", 5000000), str(r))
    check("another brand's admin cannot request for this brand", "SITE_SCOPE_FORBIDDEN" in err(cur, "select fn_addon_request(%s,%s,%s,'chart','baseline',null)", [adm_b, ADM, a1]))
    check("the owner was notified with the product and brand name", q1(cur, "select count(*) from user_notifications where user_id=%s and title='Add-on request: Area graph' and body like 'A1SITE (Alpha)%%'", [OWNER])[0] == 1)
    cur.execute("update addon_catalog set price_cents=9900000 where key='area'")   # the owner changes the price before deciding
    cur.execute("select fn_addon_decide_request(%s,%s,%s,'approve','Enjoy')", [OWNER, SYS, rid])
    r = q1(cur, "select status, note, decision_note from addon_requests where id=%s", [rid])
    check("approving keeps the brand's reason and stores the owner's note separately", r == ("approved", "We want a premium look", "Enjoy"), str(r))
    ch = q1(cur, "select amount_cents from billing_charges where site_id=%s and kind='addon_one_off'", [a1])
    check("the brand is charged the price it was QUOTED, not the new one", ch == (5000000,), str(ch))
    n = q1(cur, "select body from user_notifications where user_id=%s and title='Area graph approved'", [adm])
    check("the approval tells the requester what is billed", n and "KES 50,000 is added to your next invoice" in n[0] and "Note: Enjoy" in n[0], str(n))
    r2 = q1(cur, "select (fn_addon_request(%s,%s,%s,'payment_gateway','stripe',null)->>'id')::bigint", [pa, PA, a1])[0]
    check("a platform admin can withdraw its own request", err(cur, "select fn_addon_cancel_request(%s,%s,%s)", [pa, PA, r2]) == "ok"
          and q1(cur, "select status from addon_requests where id=%s", [r2])[0] == "cancelled")
    check("...once", "REQUEST_NOT_OPEN" in err(cur, "select fn_addon_cancel_request(%s,%s,%s)", [pa, PA, r2]))
    r3 = q1(cur, "select (fn_addon_request(%s,%s,%s,'chart','baseline',null)->>'id')::bigint", [adm_b, ADM, b1])[0]
    check("another brand cannot withdraw it", "SITE_SCOPE_FORBIDDEN" in err(cur, "select fn_addon_cancel_request(%s,%s,%s)", [adm, ADM, r3]))
    check("a decline answers 'rejected' (was 'rejectd')", q1(cur, "select fn_addon_decide_request(%s,%s,%s,'reject','Not on your plan')->>'status'", [OWNER, SYS, r3])[0] == "rejected")
    n = q1(cur, "select body from user_notifications where user_id=%s and title='Baseline request declined'", [adm_b])
    check("a decline gives the reason by product name", n and "Reason: Not on your plan" in n[0], str(n))
    reqs = q1(cur, "select fn_addon_list_requests(%s,%s,null)", [OWNER, SYS])[0]
    x = next(r for r in reqs if r["id"] == rid)
    check("the request list has product, platform, requester and both notes",
          (x["display_name"], x["platform_name"], x["requested_by_name"], x["note"], x["decision_note"]) == ("Area graph", "Alpha", "adm_a1", "We want a premium look", "Enjoy"), str(x))
    check("a platform admin lists only its platform's requests", {r["platform_name"] for r in q1(cur, "select fn_addon_list_requests(%s,%s,null)", [pa, PA])[0]} == {"Alpha"})

    print("  -- switching and removing")
    check("the brand's active chart is now Area", q1(cur, "select chart_style from sites where id=%s", [a1])[0] == "area")
    check("a brand admin switches back to the free line chart it owns", err(cur, "select fn_addon_activate(%s,%s,%s,'chart','line')", [adm, ADM, a1]) == "ok"
          and q1(cur, "select chart_style from sites where id=%s", [a1])[0] == "line")
    check("...and back to Area", err(cur, "select fn_addon_activate(%s,%s,%s,'chart','area')", [adm, ADM, a1]) == "ok")
    check("it cannot switch to a system it does not own", "NOT_ENTITLED" in err(cur, "select fn_addon_activate(%s,%s,%s,'chart','candlestick')", [adm, ADM, a1]))
    check("nor for another brand", "SITE_SCOPE_FORBIDDEN" in err(cur, "select fn_addon_activate(%s,%s,%s,'chart','line')", [adm_b, ADM, a1]))
    check("gateways are not switched this way", "NOT_SWITCHABLE" in err(cur, "select fn_addon_activate(%s,%s,%s,'payment_gateway','mpesa')", [adm, ADM, a1]))
    check("switching is audited", q1(cur, "select count(*) from admin_actions where action='addon.activate'")[0] == 2)
    cur.execute("select fn_addon_grant(%s,%s,%s,'chart','candlestick')", [OWNER, SYS, a1])
    pend = q1(cur, "select count(*) from billing_charges where site_id=%s and source_ref='chart:candlestick' and voided_at is null", [a1])[0]
    check("a monthly add-on with a setup fee queues only the setup fee", pend == 1 and q1(cur, "select amount_cents from billing_charges where source_ref='chart:candlestick'")[0] == 300000)
    cur.execute("select fn_addon_revoke(%s,%s,%s,'chart','candlestick')", [OWNER, SYS, a1])
    check("removing it before it is invoiced cancels the pending charge",
          q1(cur, "select count(*) from billing_charges where source_ref='chart:candlestick' and voided_at is null")[0] == 0)
    check("removing the active system falls back to the free default", q1(cur, "select chart_style from sites where id=%s", [a1])[0] == "line")
    cur.execute("select fn_addon_activate(%s,%s,%s,'chart','area')", [adm, ADM, a1])
    view = q1(cur, "select fn_addon_brand_view(%s,%s,%s)", [adm, ADM, a1])[0]
    ar = next(x for x in view if x["key"] == "area")
    check("the brand view has description, pricing model and ownership", ar["entitled"] and ar["active"] and ar["billing_type"] == "one_off" and ar["description"], str(ar))
    cur.execute("update addon_catalog set active=false where key='area'")
    check("a hidden add-on still shows for a brand that owns it", any(x["key"] == "area" for x in q1(cur, "select fn_addon_brand_view(%s,%s,%s)", [adm, ADM, a1])[0]))
    brands = q1(cur, "select fn_addon_brands(%s,%s)", [OWNER, SYS])[0]
    check("the owner's brand matrix lists what each brand owns and uses",
          any(b["slug"] == "a1site" and "chart:area" in b["owned"] and b["chart_style"] == "area" for b in brands), json.dumps(brands)[:300])
    check("a platform admin's matrix is its platform only", {b["platform_name"] for b in q1(cur, "select fn_addon_brands(%s,%s)", [pa, PA])[0]} == {"Alpha"})
    check("a brand admin gets no matrix", q1(cur, "select fn_addon_brands(%s,%s)", [adm, ADM])[0] == [])
    cur.execute("""select string_agg(proname, ',') from pg_proc where proname in ('fn_addon_update','fn_addon_cancel_request','fn_addon_activate','fn_addon_brands','trg_billing_addon_uncharge')
                   and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute'))""")
    check("no new function is executable by anon/authenticated", cur.fetchone()[0] is None)
    conn.close()

print("BEFORE (0001..0165):"); scenario("0165", False)
print("AFTER (0001..0166):"); scenario("9999", True)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
raise SystemExit(1 if FAIL else 0)
