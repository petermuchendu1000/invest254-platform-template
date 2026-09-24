#!/usr/bin/env python3
"""E2E: BILL-1 (docs/47, migration 0165) — invoices, payments (M-Pesa STK + manual), charges, dunning, revenue.

BEFORE (0001..0164) there were no invoices: a "payment" was the owner pressing Mark paid, add-on prices were never
billed, and the lifecycle moved platforms to past_due/grace/suspended purely on dates.
AFTER (0165): renewals are invoiced in advance (plan + monthly add-ons per brand + pending charges), dunning follows
the oldest unpaid invoice, M-Pesa settlement is idempotent, money records are System-owner only, a platform admin
reads/pays only its own platform, and the System's default platform is never invoiced.
Run: python3 packages/db/_testkit/e2e_billing.py   (needs local PG on /tmp:5433)
"""
import os, glob, uuid, json
import psycopg2

HERE = os.path.dirname(__file__)
MIG = os.path.join(HERE, "..", "migrations")
SHIM = os.path.join(HERE, "00_supabase_shim.sql")
DB = "bill1_test"
SYS = "platform_superadmin"
PA = "platform_admin"
DEFAULT_SITE = "00000000-0000-0000-0000-000000000001"
DEFAULT_PLATFORM = "10000000-0000-0000-0000-000000000001"
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

def qa(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchall()

def err(cur, sql, args=None):
    try:
        cur.execute(sql, args or []); return "ok"
    except psycopg2.Error as e:
        return str(e).split("\n")[0]

def reg(cur, phone, user, site):
    cur.execute("select user_id from fn_register_user(%s,%s,%s,null,%s)", [phone, user, "x" * 32, site]); return cur.fetchone()[0]

def status(cur, p):
    return q1(cur, "select status from platform_subscriptions where platform_id=%s", [p])[0]

def scenario(upto, fixed):
    conn = build(upto); cur = conn.cursor()
    OWNER = reg(cur, "254700000001", "owner", DEFAULT_SITE)
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [OWNER])
    mk = lambda slug: q1(cur, "select fn_platform_create_platform(%s,%s,%s,%s)", [OWNER, SYS, slug, slug.title()])[0]
    alpha, beta, gamma, delta = mk("alpha"), mk("beta"), mk("gamma"), mk("delta")
    def site(slug, p):
        s = q1(cur, "select fn_platform_create_site(%s,%s,%s,%s)", [OWNER, SYS, slug, slug.upper()])[0]
        q1(cur, "select fn_platform_assign_site(%s,%s,%s,%s)", [OWNER, SYS, s, p]); return s
    a1, a2, b1 = site("a1site", alpha), site("a2site", alpha), site("b1site", beta)
    pa_a = reg(cur, "254700000011", "pa_alpha", a1); q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [OWNER, SYS, pa_a, alpha])
    pa_b = reg(cur, "254700000012", "pa_beta", b1); q1(cur, "select * from fn_platform_appoint_platform_admin(%s,%s,%s,%s)", [OWNER, SYS, pa_b, beta])
    for p, plan in ((alpha, "business"), (beta, "starter"), (delta, "enterprise")):
        q1(cur, "select fn_subscription_set_plan(%s,%s,%s,%s)", [OWNER, SYS, p, plan])
        q1(cur, "select fn_subscription_set_status(%s,%s,%s,'active','t')", [OWNER, SYS, p])
    # alpha renews yesterday; beta missed ~3 renewals; gamma's trial ended; delta (enterprise, no price) renews.
    cur.execute("update platform_subscriptions set current_period_end=now()-interval '1 day' where platform_id=%s", [alpha])
    cur.execute("update platform_subscriptions set current_period_end=now()-interval '65 days' where platform_id=%s", [beta])
    cur.execute("update platform_subscriptions set trial_ends_at=now()-interval '2 hours' where platform_id=%s", [gamma])
    cur.execute("update platform_subscriptions set current_period_end=now()-interval '1 day' where platform_id=%s", [delta])

    if not fixed:
        check("BUG REPRODUCED: there are no invoices at all", err(cur, "select 1 from invoices") != "ok")
        q1(cur, "select fn_subscription_auto_advance()")
        check("BUG REPRODUCED: a platform whose renewal date passed goes straight to past_due with nothing to pay",
              status(cur, alpha) == "past_due")
        check("BUG REPRODUCED: add-on prices have no pricing model", err(cur, "select billing_type from addon_catalog") != "ok")
        conn.close(); return

    print("  -- setup / exemption")
    check("the System's default platform is billing-exempt", q1(cur, "select billing_exempt from platform_subscriptions where platform_id=%s", [DEFAULT_PLATFORM])[0] is True)
    check("free add-ons are typed 'free', paid ones 'one_off' by default",
          qa(cur, "select distinct billing_type from addon_catalog where price_cents=0") == [("free",)]
          and qa(cur, "select distinct billing_type from addon_catalog where price_cents>0") == [("one_off",)])

    print("  -- add-on charges (trigger)")
    cur.execute("update addon_catalog set billing_type='monthly', price_cents=500000 where category='chart' and key='area'")
    cur.execute("update addon_catalog set billing_type='one_off', price_cents=1500000, setup_fee_cents=200000 where category='payment_gateway' and key='stripe'")
    q1(cur, "select fn_addon_grant(%s,%s,%s,'payment_gateway','stripe')", [OWNER, SYS, a1])
    rows = qa(cur, "select kind, amount_cents, description from billing_charges where platform_id=%s and invoice_id is null order by kind", [alpha])
    check("granting a one-off add-on with a setup fee queues both charges, naming the brand",
          [(r[0], r[1]) for r in rows] == [("addon_one_off", 1500000), ("addon_setup", 200000)] and "A1SITE" in rows[0][2], str(rows))
    q1(cur, "select fn_addon_revoke(%s,%s,%s,'payment_gateway','stripe')", [OWNER, SYS, a1])
    q1(cur, "select fn_addon_grant(%s,%s,%s,'payment_gateway','stripe')", [OWNER, SYS, a1])
    check("revoking and re-granting does not charge twice (0166: the removed grant's charges are voided)",
          q1(cur, "select count(*) filter (where voided_at is null), count(*) filter (where voided_at is not null) from billing_charges where platform_id=%s", [alpha]) == (2, 2))
    q1(cur, "select fn_addon_grant(%s,%s,%s,'chart','area')", [OWNER, SYS, a2])
    check("a monthly add-on is not a one-off charge", q1(cur, "select count(*) from billing_charges where platform_id=%s and voided_at is null", [alpha])[0] == 2)
    q1(cur, "select fn_addon_grant(%s,%s,%s,'payment_gateway','stripe')", [OWNER, SYS, DEFAULT_SITE])
    check("the exempt default platform is never charged", q1(cur, "select count(*) from billing_charges where platform_id=%s", [DEFAULT_PLATFORM])[0] == 0)

    print("  -- the billing run: renewals")
    r = q1(cur, "select fn_billing_run(now())")[0]
    check("the run reports what it did", isinstance(r, dict) and r.get("issued", 0) >= 5, str(r))
    inv = qa(cur, "select id, number, status, total_cents, kind, due_at > now() + interval '6 days' from invoices where platform_id=%s", [alpha])
    check("alpha: one renewal invoice, open, due in ~7 days", len(inv) == 1 and inv[0][2] == "open" and inv[0][4] == "renewal" and inv[0][5], str(inv))
    A_INV = inv[0][0]
    lines = qa(cur, "select kind, amount_cents, description from invoice_lines where invoice_id=%s order by sort", [A_INV])
    check("...with the plan, the monthly add-on per brand and the pending charges",
          [(l[0], l[1]) for l in lines] == [("plan", 4000000), ("addon_monthly", 500000), ("addon_one_off", 1500000), ("addon_setup", 200000)], str(lines))
    check("...the monthly add-on line names the brand", "A2SITE" in lines[1][2], lines[1][2])
    check("...total is the sum (no tax by default)", inv[0][3] == 6200000, str(inv[0][3]))
    check("...numbered PREFIX-YEAR-00001", inv[0][1].startswith("TRIO-") and inv[0][1].endswith("-00001"), inv[0][1])
    check("...and the charges are now attached to it", q1(cur, "select count(*) from billing_charges where invoice_id=%s", [A_INV])[0] == 2)
    check("alpha's service period moved forward", q1(cur, "select current_period_end > now() + interval '25 days' from platform_subscriptions where platform_id=%s", [alpha])[0])
    check("alpha's platform admin was notified", q1(cur, "select count(*) from user_notifications where user_id=%s and category='billing' and title like 'New invoice%%'", [pa_a])[0] == 1)
    check("beta: missed renewals are caught up one invoice per period", q1(cur, "select count(*) from invoices where platform_id=%s and kind='renewal'", [beta])[0] == 3)
    check("...and its period now runs ahead", q1(cur, "select current_period_end > now() from platform_subscriptions where platform_id=%s", [beta])[0])
    g = q1(cur, "select ps.status, (select count(*) from invoices i where i.platform_id=ps.platform_id), (select total_cents from invoices i where i.platform_id=ps.platform_id limit 1) from platform_subscriptions ps where platform_id=%s", [gamma])
    check("gamma: an ended trial is invoiced (Starter KES 1,000) and becomes active", g == ("active", 1, 100000), str(g))
    check("...logged as trial_converted", q1(cur, "select count(*) from subscription_events where platform_id=%s and reason='trial_converted'", [gamma])[0] == 1)
    d = q1(cur, "select (select count(*) from invoices where platform_id=%s), current_period_end > now() from platform_subscriptions where platform_id=%s", [delta, delta])
    check("delta: a custom plan with no price and nothing to bill rolls forward without a KES 0 invoice", d == (0, True), str(d))
    check("the default platform is never invoiced", q1(cur, "select count(*) from invoices where platform_id=%s", [DEFAULT_PLATFORM])[0] == 0)
    r2 = q1(cur, "select fn_billing_run(now())")[0]
    check("running again the same day issues nothing (idempotent)", r2.get("issued") == 0, str(r2))
    check("the renewal of a period can never be invoiced twice",
          "duplicate key" in err(cur, "insert into invoices(platform_id,kind,period_start,due_at) select platform_id,'renewal',period_start,now() from invoices where id=%s", [A_INV]))

    print("  -- scope")
    check("a platform admin reads its own invoice", err(cur, "select fn_billing_invoice(%s,%s,%s)", [pa_a, PA, A_INV]) == "ok")
    check("...not another platform's", "PLATFORM_SCOPE_FORBIDDEN" in err(cur, "select fn_billing_invoice(%s,%s,%s)", [pa_b, PA, A_INV]))
    check("a brand admin is refused", "NOT_AUTHORIZED" in err(cur, "select fn_billing_invoice(%s,'admin',%s)", [pa_a, A_INV]))
    cur.execute("select count(*), bool_and((j->>'platformId')::uuid=%s) from fn_billing_invoices(%s,%s,null,null,null,50) j", [alpha, pa_a, PA])
    check("the invoice list is pinned to the platform admin's platform even if it asks for all", cur.fetchone() == (1, True))
    cur.execute("select count(*) from fn_billing_invoices(%s,%s,%s,null,null,50)", [pa_a, PA, beta])
    check("...and even if it names another platform", cur.fetchone()[0] == 1)
    cur.execute("select count(*) from fn_billing_accounts(%s,%s)", [pa_b, PA])
    check("accounts: a platform admin sees only its own", cur.fetchone()[0] == 1)
    cur.execute("select count(*) from fn_billing_accounts(%s,%s)", [OWNER, SYS])
    check("accounts: the owner sees every platform", cur.fetchone()[0] >= 5)
    for fn, args in (("fn_billing_record_payment(%s,%s,%s,'bank',100,'x',null)", [pa_a, PA, A_INV]),
                     ("fn_billing_add_charge(%s,%s,%s,null,'x',100)", [pa_a, PA, alpha]),
                     ("fn_billing_set_invoice_status(%s,%s,%s,'void','x')", [pa_a, PA, A_INV]),
                     ("fn_billing_create_invoice(%s,%s,%s,'[]'::jsonb)", [pa_a, PA, alpha]),
                     ("fn_billing_overview(%s,%s)", [pa_a, PA]),
                     ("fn_billing_settings_set(%s,%s,'{}'::jsonb)", [pa_a, PA]),
                     ("fn_billing_run_now(%s,%s)", [pa_a, PA])):
        check(f"a platform admin cannot call {fn.split('(')[0]}", "NOT_AUTHORIZED" in err(cur, "select " + fn, args))

    print("  -- manual invoices, charges, tax, credits")
    check("an empty manual invoice is refused", "NOTHING_TO_INVOICE" in err(cur, "select fn_billing_create_invoice(%s,%s,%s,'[]'::jsonb)", [OWNER, SYS, gamma]))
    check("a line without a price is refused", "INVALID_LINES" in err(cur, """select fn_billing_create_invoice(%s,%s,%s,'[{"description":"x"}]'::jsonb)""", [OWNER, SYS, gamma]))
    check("a line for another platform's brand is refused", "PLATFORM_SCOPE_FORBIDDEN" in err(cur,
          "select fn_billing_create_invoice(%s,%s,%s,%s::jsonb)", [OWNER, SYS, gamma, json.dumps([{"description": "x", "unitCents": 100, "siteId": a1}])]))
    cur.execute("select fn_billing_settings_set(%s,%s,%s::jsonb)", [OWNER, SYS, json.dumps({"taxRateBp": 1600, "taxLabel": "VAT"})])
    M1 = q1(cur, "select fn_billing_create_invoice(%s,%s,%s,%s::jsonb,true,14,'Custom work')", [OWNER, SYS, gamma,
            json.dumps([{"description": "Custom domain setup", "unitCents": 250000, "quantity": 2}])])[0]
    m = q1(cur, "select subtotal_cents, tax_cents, total_cents, kind, notes, due_at > now() + interval '13 days' from invoices where id=%s", [M1])
    check("a manual invoice: qty x unit, 16% VAT in whole shillings, custom terms and notes", m == (500000, 80000, 580000, "manual", "Custom work", True), str(m))
    check("an invalid tax rate is refused", "INVALID_TAX" in err(cur, "select fn_billing_settings_set(%s,%s,%s::jsonb)", [OWNER, SYS, json.dumps({"taxRateBp": 9000})]))
    cur.execute("select fn_billing_settings_set(%s,%s,%s::jsonb)", [OWNER, SYS, json.dumps({"taxRateBp": 0})])
    check("a zero charge is refused", "INVALID_AMOUNT" in err(cur, "select fn_billing_add_charge(%s,%s,%s,null,'x',0)", [OWNER, SYS, gamma]))
    c1 = q1(cur, "select fn_billing_add_charge(%s,%s,%s,null,'Goodwill credit',-500000)", [OWNER, SYS, gamma])[0]
    check("a negative charge is a credit", q1(cur, "select kind from billing_charges where id=%s", [c1])[0] == "credit")
    M2 = q1(cur, "select fn_billing_create_invoice(%s,%s,%s,%s::jsonb,true)", [OWNER, SYS, gamma, json.dumps([{"description": "Extra", "unitCents": 100000}])])[0]
    m2 = q1(cur, "select total_cents, status from invoices where id=%s", [M2])
    check("an invoice where credits exceed charges totals 0 and is paid automatically", m2 == (0, "paid"), str(m2))
    check("...and the unused credit is carried forward, not lost",
          q1(cur, "select amount_cents from billing_charges where platform_id=%s and invoice_id is null and voided_at is null", [gamma])[0] == -400000)
    c2 = q1(cur, "select fn_billing_add_charge(%s,%s,%s,null,'Oops',1000)", [OWNER, SYS, gamma])[0]
    cur.execute("select fn_billing_void_charge(%s,%s,%s)", [OWNER, SYS, c2])
    check("a pending charge can be voided", q1(cur, "select voided_at is not null from billing_charges where id=%s", [c2])[0])
    check("...but not twice, and never once invoiced", "CHARGE_NOT_PENDING" in err(cur, "select fn_billing_void_charge(%s,%s,%s)", [OWNER, SYS, c2]))
    cur.execute("select count(*) from fn_billing_pending_charges(%s,%s,%s)", [OWNER, SYS, gamma])
    check("pending charges are listed", cur.fetchone()[0] == 1)

    print("  -- dunning on the oldest unpaid invoice")
    cur.execute("update invoices set due_at=now()-interval '1 hour' where id=%s", [A_INV])
    cur.execute("select fn_billing_run(now())")
    check("overdue invoice -> past_due", status(cur, alpha) == "past_due")
    check("...with an overdue reminder, once", q1(cur, "select count(*) from user_notifications where user_id=%s and title like '%%overdue'", [pa_a])[0] == 1)
    cur.execute("select fn_billing_run(now())")
    check("...not repeated on the next run", q1(cur, "select count(*) from user_notifications where user_id=%s and title like '%%overdue'", [pa_a])[0] == 1)
    cur.execute("select count(*) from fn_billing_invoices(%s,%s,null,'overdue',null,50)", [OWNER, SYS])
    check("the 'overdue' filter finds it", cur.fetchone()[0] == 1)
    past = q1(cur, "select sub_past_due_days from ops_config")[0]
    cur.execute("update invoices set due_at=now()-make_interval(days => %s) - interval '1 hour' where id=%s", [past, A_INV])
    cur.execute("select fn_billing_run(now())")
    g = q1(cur, "select status, grace_ends_at > now() from platform_subscriptions where platform_id=%s", [alpha])
    check("past the past-due window -> grace_period with a suspension date", g == ("grace_period", True), str(g))
    check("...the final notice reaches the platform admin and the owner",
          q1(cur, "select count(*) from user_notifications where title like 'Final notice%%' and user_id in (%s,%s)", [pa_a, OWNER])[0] == 2)
    cur.execute("update platform_subscriptions set grace_ends_at=now()-interval '1 minute' where platform_id=%s", [alpha])
    cur.execute("select fn_billing_run(now())")
    check("grace over -> suspended", status(cur, alpha) == "suspended")
    check("...and the brands are offline", q1(cur, "select fn_platform_serviceable(%s)", [alpha])[0] is False)
    check("an invoice due in the future does not move a platform", status(cur, gamma) == "active")

    print("  -- manual payments")
    due = q1(cur, "select total_cents - amount_paid_cents from invoices where id=%s", [A_INV])[0]
    check("more than the balance is refused", "AMOUNT_EXCEEDS_BALANCE" in err(cur, "select fn_billing_record_payment(%s,%s,%s,'bank',%s,'BANK1',null)", [OWNER, SYS, A_INV, due + 1]))
    check("an unknown method is refused", "INVALID_METHOD" in err(cur, "select fn_billing_record_payment(%s,%s,%s,'cheque',100,'x',null)", [OWNER, SYS, A_INV]))
    cur.execute("select fn_billing_record_payment(%s,%s,%s,'bank',%s,'BANK1','part')", [OWNER, SYS, A_INV, 1000000])
    p = q1(cur, "select status, amount_paid_cents from invoices where id=%s", [A_INV])
    check("a part payment is recorded, the invoice stays open", p == ("open", 1000000), str(p))
    check("...and the platform stays suspended", status(cur, alpha) == "suspended")
    cur.execute("select fn_billing_record_payment(%s,%s,%s,'bank',%s,'BANK2',null)", [OWNER, SYS, A_INV, due - 1000000])
    p = q1(cur, "select status, amount_paid_cents = total_cents, paid_at is not null from invoices where id=%s", [A_INV])
    check("the rest pays the invoice in full", p == ("paid", True, True), str(p))
    g = q1(cur, "select status, grace_ends_at, last_payment_at is not null from platform_subscriptions where platform_id=%s", [alpha])
    check("paid up -> the platform is active again and its brands online", g == ("active", None, True) and q1(cur, "select fn_platform_serviceable(%s)", [alpha])[0], str(g))
    check("the reactivation is logged", q1(cur, "select count(*) from subscription_events where platform_id=%s and to_status='active' and reason='payment' and from_status='suspended'", [alpha])[0] == 1)
    check("a paid invoice takes no more payments", "INVOICE_NOT_OPEN" in err(cur, "select fn_billing_record_payment(%s,%s,%s,'bank',100,'x',null)", [OWNER, SYS, A_INV]))
    check("every payment is audited", q1(cur, "select count(*) from admin_actions where action='billing.payment.record'")[0] == 2)

    print("  -- M-Pesa Pay now")
    B_INV = q1(cur, "select id from invoices where platform_id=%s order by period_start limit 1", [beta])[0]
    check("a platform admin cannot pay another platform's invoice", "PLATFORM_SCOPE_FORBIDDEN" in err(cur, "select * from fn_billing_start_mpesa(%s,%s,%s,'0712345678')", [pa_a, PA, B_INV]))
    check("a bad phone is refused", "INVALID_PHONE" in err(cur, "select * from fn_billing_start_mpesa(%s,%s,%s,'12345')", [pa_b, PA, B_INV]))
    pid, amt, num = q1(cur, "select * from fn_billing_start_mpesa(%s,%s,%s,'0712345678')", [pa_b, PA, B_INV])
    check("the platform admin starts a payment for the full balance", amt == 100000 and num.startswith("TRIO-"), f"{amt} {num}")
    check("a second prompt while one is open is refused", "PAYMENT_IN_PROGRESS" in err(cur, "select * from fn_billing_start_mpesa(%s,%s,%s,'0712345678')", [pa_b, PA, B_INV]))
    check("the invoice cannot be voided while a payment is in progress", "PAYMENT_IN_PROGRESS" in err(cur, "select fn_billing_set_invoice_status(%s,%s,%s,'void','x')", [OWNER, SYS, B_INV]))
    cur.execute("select fn_billing_attach_checkout(%s,'ws_CO_1')", [pid])
    check("the shared callback can tell a billing checkout from a deposit",
          q1(cur, "select fn_billing_is_checkout('ws_CO_1'), fn_billing_is_checkout('ws_dep_9')") == (True, False))
    cur.execute("select count(*) from fn_billing_pending_mpesa(0, 10)")
    check("the reconcile sweep sees the pending payment", cur.fetchone()[0] == 1)
    check("an unknown checkout is not billing's", q1(cur, "select fn_billing_settle_mpesa('ws_CO_nope',true,'R0',null,'{}')")[0] == {"known": False})
    r = q1(cur, "select fn_billing_settle_mpesa('ws_CO_1',true,'QK12345',null,'{}')")[0]
    check("a verified success pays the invoice", r.get("applied") is True and r.get("invoiceStatus") == "paid", str(r))
    r = q1(cur, "select fn_billing_settle_mpesa('ws_CO_1',true,'QK12345',null,'{}')")[0]
    check("settling the same checkout again changes nothing", r.get("applied") is False and q1(cur, "select amount_paid_cents from invoices where id=%s", [B_INV])[0] == 100000, str(r))
    check("...the receipt is stored", q1(cur, "select reference from invoice_payments where id=%s", [pid])[0] == "QK12345")
    check("...and both the platform admin and the owner are told", q1(cur, "select count(*) from user_notifications where title like 'Payment received%%' and user_id in (%s,%s)", [pa_b, OWNER])[0] >= 2)
    B2 = q1(cur, "select id from invoices where platform_id=%s and status='open' order by period_start limit 1", [beta])[0]
    pid2, _, _ = q1(cur, "select * from fn_billing_start_mpesa(%s,%s,%s,'254712345678')", [pa_b, PA, B2])
    cur.execute("select fn_billing_attach_checkout(%s,'ws_CO_2')", [pid2])
    r = q1(cur, "select fn_billing_settle_mpesa('ws_CO_2',false,null,'Request cancelled by user','{}')")[0]
    check("a cancelled prompt marks the attempt failed, the invoice stays open",
          r.get("status") == "failed" and q1(cur, "select status from invoices where id=%s", [B2])[0] == "open", str(r))
    check("...and a late success for it can no longer apply", q1(cur, "select fn_billing_settle_mpesa('ws_CO_2',true,'LATE',null,'{}')")[0].get("applied") is False)
    # odd-cent balance: rounds UP to whole KES, the extra becomes a credit
    O = q1(cur, "select fn_billing_create_invoice(%s,%s,%s,%s::jsonb,false)", [OWNER, SYS, beta, json.dumps([{"description": "Odd", "unitCents": 100050}])])[0]
    pid3, amt3, _ = q1(cur, "select * from fn_billing_start_mpesa(%s,%s,%s,'0712345678')", [OWNER, SYS, O])
    check("the M-Pesa amount is rounded up to whole shillings", amt3 == 100100, str(amt3))
    cur.execute("select fn_billing_attach_checkout(%s,'ws_CO_3')", [pid3]); cur.execute("select fn_billing_settle_mpesa('ws_CO_3',true,'R3',null,'{}')")
    check("the 50 cents overpaid is kept as a credit for the next invoice",
          q1(cur, "select amount_cents from billing_charges where source_ref=%s", ["overpay:" + str(pid3)])[0] == -50)
    cur.execute("select fn_billing_settings_set(%s,%s,'{\"mpesaPayEnabled\":false}'::jsonb)", [OWNER, SYS])
    check("with Pay now switched off, no prompt can start", "MPESA_PAY_DISABLED" in err(cur, "select * from fn_billing_start_mpesa(%s,%s,%s,'0712345678')", [pa_b, PA, B2]))
    cur.execute("select fn_billing_settings_set(%s,%s,'{\"mpesaPayEnabled\":true}'::jsonb)", [OWNER, SYS])

    print("  -- void / uncollectible")
    check("a reason is required", "REASON_REQUIRED" in err(cur, "select fn_billing_set_invoice_status(%s,%s,%s,'void','  ')", [OWNER, SYS, M1]))
    check("a paid invoice cannot be voided", "INVOICE_NOT_OPEN" in err(cur, "select fn_billing_set_invoice_status(%s,%s,%s,'void','x')", [OWNER, SYS, A_INV]))
    P = q1(cur, "select fn_billing_create_invoice(%s,%s,%s,%s::jsonb,false)", [OWNER, SYS, gamma, json.dumps([{"description": "Part", "unitCents": 100000}])])[0]
    cur.execute("select fn_billing_record_payment(%s,%s,%s,'cash',100,'c',null)", [OWNER, SYS, P])
    check("an invoice with payments cannot be voided", "INVOICE_HAS_PAYMENTS" in err(cur, "select fn_billing_set_invoice_status(%s,%s,%s,'void','x')", [OWNER, SYS, P]))
    check("...but can be written off", err(cur, "select fn_billing_set_invoice_status(%s,%s,%s,'uncollectible','Client closed')", [OWNER, SYS, P]) == "ok")
    # voiding releases charges: invoice gamma's pending credit onto a fresh invoice, then void it
    cur.execute("select fn_billing_add_charge(%s,%s,%s,null,'Late fee',900000)", [OWNER, SYS, gamma])
    V = q1(cur, "select fn_billing_create_invoice(%s,%s,%s,'[]'::jsonb,true)", [OWNER, SYS, gamma])[0]
    check("pending charges alone can make an invoice", q1(cur, "select total_cents from invoices where id=%s", [V])[0] == 500000)
    cur.execute("select fn_billing_set_invoice_status(%s,%s,%s,'void','Sent in error')", [OWNER, SYS, V])
    check("voiding an invoice puts its charges back in the queue", q1(cur, "select count(*) from billing_charges where platform_id=%s and invoice_id is null and voided_at is null", [gamma])[0] == 2)
    # a write-off clears dunning
    G = q1(cur, "select id from invoices where platform_id=%s and kind='renewal'", [gamma])[0]
    cur.execute("update invoices set due_at=now()-interval '1 day' where id=%s", [G]); cur.execute("select fn_billing_run(now())")
    check("gamma overdue -> past_due", status(cur, gamma) == "past_due")
    cur.execute("select fn_billing_set_invoice_status(%s,%s,%s,'uncollectible','Waived')", [OWNER, SYS, G])
    check("writing off the only overdue invoice returns the platform to active", status(cur, gamma) == "active")

    print("  -- exemption, plans, settings, reads")
    cur.execute("select fn_billing_set_exempt(%s,%s,%s,true)", [OWNER, SYS, beta])
    cur.execute("update platform_subscriptions set current_period_end=now()-interval '1 day' where platform_id=%s", [beta])
    n0 = q1(cur, "select count(*) from invoices where platform_id=%s", [beta])[0]; cur.execute("select fn_billing_run(now())")
    check("an exempt platform is not invoiced", q1(cur, "select count(*) from invoices where platform_id=%s", [beta])[0] == n0)
    check("a bad plan key is refused", "INVALID_PLAN_KEY" in err(cur, "select fn_billing_upsert_plan(%s,%s,'Bad Key','x',100,1,1,true)", [OWNER, SYS]))
    cur.execute("select fn_billing_upsert_plan(%s,%s,'growth','Growth',2000000,3,500,true)", [OWNER, SYS])
    check("the owner adds a plan", q1(cur, "select name, price_cents, max_sites from subscription_plans where key='growth'") == ("Growth", 2000000, 3))
    cur.execute("select fn_billing_upsert_plan(%s,%s,'growth','Growth+',2500000,4,500,true)", [OWNER, SYS])
    check("...and edits it", q1(cur, "select name, price_cents from subscription_plans where key='growth'") == ("Growth+", 2500000))
    check("a bad invoice prefix is refused", "INVALID_PREFIX" in err(cur, "select fn_billing_settings_set(%s,%s,'{\"invoicePrefix\":\"x-1\"}'::jsonb)", [OWNER, SYS]))
    cur.execute("select fn_billing_settings_set(%s,%s,%s::jsonb)", [OWNER, SYS, json.dumps({"invoicePrefix": "INV", "businessName": "TrioCodes Ltd", "graceDays": 10, "pastDueDays": 4})])
    s = q1(cur, "select fn_billing_settings_get(%s,%s)", [pa_a, PA])[0]
    check("settings round-trip (incl. dunning days on ops_config)", (s["invoicePrefix"], s["businessName"], s["graceDays"], s["pastDueDays"]) == ("INV", "TrioCodes Ltd", 10, 4), str(s))
    N = q1(cur, "select fn_billing_create_invoice(%s,%s,%s,%s::jsonb,false)", [OWNER, SYS, alpha, json.dumps([{"description": "x", "unitCents": 100}])])[0]
    check("the next invoice uses the new prefix and keeps counting", q1(cur, "select number from invoices where id=%s", [N])[0].startswith("INV-"))
    full = q1(cur, "select fn_billing_invoice(%s,%s,%s)", [pa_a, PA, A_INV])[0]
    check("the invoice read has seller, lines with brand names, and payments",
          full["seller"]["name"] == "TrioCodes Ltd" and len(full["lines"]) == 4 and full["lines"][1]["siteName"] == "A2SITE" and len(full["payments"]) == 2, json.dumps(full)[:300])
    ov = q1(cur, "select fn_billing_overview(%s,%s)", [OWNER, SYS])[0]
    check("the overview: MRR counts paying plans + monthly add-ons (alpha 40,000 + 5,000 + gamma 1,000)", ov["mrrCents"] == 4600000, str(ov["mrrCents"]))
    check("...ARR = 12 x MRR", ov["arrCents"] == ov["mrrCents"] * 12)
    check("...collected this month counts every settled payment", ov["collectedThisMonthCents"] == 6200000 + 100000 + 100100 + 100, str(ov["collectedThisMonthCents"]))
    check("...aging buckets add up to the outstanding total", sum(ov["aging"].values()) == ov["outstandingCents"], str(ov["aging"]))
    check("...recent payments are listed", len(ov["recentPayments"]) >= 4)
    acct = q1(cur, "select j from fn_billing_accounts(%s,%s) j where j->>'platformId'=%s", [OWNER, SYS, alpha])[0]
    check("an account shows its plan, status, monthly add-ons and balance",
          (acct["planKey"], acct["status"], acct["monthlyAddonsCents"], acct["balanceDueCents"]) == ("business", "active", 500000, 100), str(acct))
    check("fn_subscription_auto_advance still works (delegates to the billing run)", err(cur, "select fn_subscription_auto_advance()") == "ok")
    cur.execute("""select string_agg(proname, ',') from pg_proc where proname like any(array['fn_billing_%%','trg_billing_%%'])
                   and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute'))""")
    leak = cur.fetchone()[0]
    check("no billing function is executable by anon/authenticated", leak is None, str(leak))
    check("every run-now is audited", err(cur, "select fn_billing_run_now(%s,%s)", [OWNER, SYS]) == "ok"
          and q1(cur, "select count(*) from admin_actions where action='billing.run'")[0] == 1)
    conn.close()

print("BEFORE (0001..0164):"); scenario("0164", False)
print("AFTER (0001..0165):"); scenario("9999", True)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
raise SystemExit(1 if FAIL else 0)
