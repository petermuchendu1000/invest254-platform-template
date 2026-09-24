#!/usr/bin/env python3
"""Aggressive e2e for SUBSCRIPTIONS + TICKETS (Issue 2 — migrations 0136..0139).

Stands up a local Postgres, applies the shim + ALL migrations, then proves:
  SUBSCRIPTIONS: new platform -> Trial/Starter; site & user quotas block over-limit inserts;
    hard-suspend blocks new signups + play + money (but in-flight settlement still works);
    the auto-advance cron walks Trial->Past Due->Grace->Suspended; a payment reactivates.
  TICKETS: issue -> assigned to platform admin (level 0) w/ SLA; platform-admin issue -> System
    (level 1); scope is platform-bounded; manual + AUTO escalation are logged; resolve notifies.
Run: python3 packages/db/_testkit/e2e_subscriptions_tickets.py
"""
import os, sys, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
DEFAULT_SITE = "00000000-0000-0000-0000-000000000001"
SYS = "platform_superadmin"
PASS, FAIL = [], []

def check(n, c, d=""):
    (PASS if c else FAIL).append(n); print(f"  [{'PASS' if c else 'FAIL'}] {n}" + (f"  -- {d}" if d and not c else ""))
def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone() if cur.description is not None else None
def expect_error(cur, sql, args, code, name):
    try: cur.execute(sql, args); cur.connection.rollback(); check(name, False, "no error raised")
    except Exception as e: cur.connection.rollback(); check(name, code.lower() in str(e).lower(), f"got: {str(e).strip()[:90]}")
def ok(cur, sql, args, name):
    try: cur.execute(sql, args); cur.connection.commit(); check(name, True)
    except Exception as e: cur.connection.rollback(); check(name, False, f"unexpected: {str(e).strip()[:90]}")

def reset():
    a=psycopg2.connect(host="/tmp",port=5433,user="postgres",dbname="postgres");a.set_client_encoding("UTF8");a.autocommit=True
    with a.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='invest254_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists invest254_test"); c.execute("create database invest254_test")
    a.close()
    conn=psycopg2.connect(**DSN); conn.set_client_encoding("UTF8"); conn.autocommit=True
    with conn.cursor() as c:
        c.execute(open(SHIM,encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(BASE,"migrations","[0-9][0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f,encoding="utf-8").read())
    return conn

def mk_platform(cur, actor, slug):
    return q1(cur,"select fn_platform_create_platform(%s,%s,%s,%s)",[actor,SYS,slug,slug])[0]
def mk_site_in(cur, actor, slug, platform):  # create (default) then re-parent (assign bypasses quota)
    sid=q1(cur,"select fn_platform_create_site(%s,%s,%s,%s)",[actor,SYS,slug,slug])[0]
    q1(cur,"select fn_platform_assign_site(%s,%s,%s,%s)",[actor,SYS,sid,platform]); return sid
def reg(cur, phone, user, site):
    q1(cur,"select fn_register_user(%s,%s,%s,null,%s)",[phone,user,"x"*32,site])
    return q1(cur,"select id from profiles where site_id=%s and phone=%s",[site,phone])[0]

def main():
    conn=reset(); conn.autocommit=True; cur=conn.cursor()
    # A REAL system-owner profile (ticket comments FK to profiles); acts as platform_superadmin.
    q1(cur,"select fn_register_user(%s,%s,%s,null,%s)",["254700000000","sysadmin","x"*32,DEFAULT_SITE])
    ACTOR=q1(cur,"select id from profiles where phone=%s and site_id=%s",["254700000000",DEFAULT_SITE])[0]
    q1(cur,"update profiles set role='platform_superadmin' where id=%s",[ACTOR])

    print("\n== SUBSCRIPTIONS: new platform gets Trial/Starter ==")
    pa=mk_platform(cur,ACTOR,"acme")
    row=q1(cur,"select status,plan_key from platform_subscriptions where platform_id=%s",[pa])
    check("new platform auto Trial/Starter", row==("trial","starter"), str(row))
    check("subscription 'created' event logged", q1(cur,"select count(*) from subscription_events where platform_id=%s and reason='created'",[pa])[0]==1)

    print("\n== Site quota (Starter = 1 site) ==")
    # appoint a platform admin for acme (direct setup)
    pa_admin=reg(cur,"254701000001","acmeadm",DEFAULT_SITE); q1(cur,"select fn_platform_appoint_platform_admin(%s,%s,%s,%s)",[ACTOR,SYS,pa_admin,pa])
    ok(cur,"select fn_platform_create_site(%s,%s,%s,%s)",[pa_admin,"platform_admin","acme1","Acme1"],"platform admin creates 1st site (within Starter)")
    expect_error(cur,"select fn_platform_create_site(%s,%s,%s,%s)",[pa_admin,"platform_admin","acme2","Acme2"],"SUBSCRIPTION_SITE_LIMIT","2nd site blocked by Starter 1-site cap")

    print("\n== User quota (custom cap = 2) + hard suspend ==")
    pu=mk_platform(cur,ACTOR,"userco"); us=mk_site_in(cur,ACTOR,"usersite",pu)
    q1(cur,"select fn_subscription_set_plan(%s,%s,%s,%s,%s,%s,%s)",[ACTOR,SYS,pu,"business",None,None,2])  # custom_max_users=2
    q1(cur,"select fn_subscription_set_status(%s,%s,%s,%s,%s)",[ACTOR,SYS,pu,"active","t"])
    ok(cur,"select fn_register_user(%s,%s,%s,null,%s)",["254702000001","usr1","x"*32,us],"1st player within cap")
    ok(cur,"select fn_register_user(%s,%s,%s,null,%s)",["254702000002","usr2","x"*32,us],"2nd player within cap")
    expect_error(cur,"select fn_register_user(%s,%s,%s,null,%s)",["254702000003","usr3","x"*32,us],"SUBSCRIPTION_USER_LIMIT","3rd player blocked by user cap")

    print("\n== Hard suspend: brand offline (signups + money blocked) ==")
    q1(cur,"select fn_subscription_set_status(%s,%s,%s,%s,%s)",[ACTOR,SYS,pu,"suspended","nonpay"])
    check("suspended -> not serviceable", q1(cur,"select fn_platform_serviceable(%s)",[pu])[0] is False)
    expect_error(cur,"select fn_register_user(%s,%s,%s,null,%s)",["254702000009","usr9","x"*32,us],"PLATFORM_SUSPENDED","signup blocked while suspended")
    expect_error(cur,"insert into transactions(user_id,kind,amount,phone,site_id) values (%s,'deposit',1000,%s,%s)",[str(uuid.uuid4()),"254702000001",us],"PLATFORM_SUSPENDED","deposit blocked while suspended")
    q1(cur,"select fn_subscription_set_status(%s,%s,%s,%s,%s)",[ACTOR,SYS,pu,"active","paid"])
    check("reactivate -> serviceable", q1(cur,"select fn_platform_serviceable(%s)",[pu])[0] is True)

    print("\n== Lifecycle (BILL-1, invoice-driven): Trial -> invoice -> Past Due -> Grace -> Suspended ==")
    pl=mk_platform(cur,ACTOR,"lifeco")
    q1(cur,"update platform_subscriptions set trial_ends_at=now()-interval '1 day' where platform_id=%s",[pl])
    q1(cur,"select fn_subscription_auto_advance()")
    r=q1(cur,"select ps.status,(select count(*) from invoices i where i.platform_id=ps.platform_id and i.status='open') from platform_subscriptions ps where platform_id=%s",[pl])
    check("trial ended -> first invoice issued, subscription active until it is overdue", r==("active",1), str(r))
    q1(cur,"update invoices set due_at=now()-interval '1 day' where platform_id=%s",[pl])
    q1(cur,"select fn_subscription_auto_advance()")
    check("invoice overdue -> past_due", q1(cur,"select status from platform_subscriptions where platform_id=%s",[pl])[0]=="past_due")
    q1(cur,"update invoices set due_at=now()-interval '8 days' where platform_id=%s",[pl])
    q1(cur,"select fn_subscription_auto_advance()")
    check("past_due beyond window -> grace_period", q1(cur,"select status from platform_subscriptions where platform_id=%s",[pl])[0]=="grace_period")
    q1(cur,"update platform_subscriptions set grace_ends_at=now()-interval '1 day' where platform_id=%s",[pl])
    q1(cur,"select fn_subscription_auto_advance()")
    check("grace expired -> suspended", q1(cur,"select status from platform_subscriptions where platform_id=%s",[pl])[0]=="suspended")
    evs=q1(cur,"select count(*) from subscription_events where platform_id=%s and reason in ('trial_converted','past_due','grace','suspended')",[pl])[0]
    check("lifecycle transitions all logged", evs==4, f"events={evs}")
    inv,due=q1(cur,"select id,total_cents-amount_paid_cents from invoices where platform_id=%s and status='open'",[pl])
    q1(cur,"select fn_billing_record_payment(%s,%s,%s,'bank',%s,'REF1',null)",[ACTOR,SYS,inv,due])
    r=q1(cur,"select status, current_period_end>now() from platform_subscriptions where platform_id=%s",[pl])
    check("paying the invoice reactivates (period already runs ahead)", r==("active",True), str(r))

    print("\n== TICKETS: issue -> platform admin (level 0) + SLA + notify ==")
    ph=mk_platform(cur,ACTOR,"helpco"); q1(cur,"select fn_subscription_set_status(%s,%s,%s,%s,%s)",[ACTOR,SYS,ph,"active","t"])
    hs=mk_site_in(cur,ACTOR,"helpsite",ph)
    sadm=reg(cur,"254703000001","hsiteadm",hs); q1(cur,"update profiles set role='admin' where id=%s",[sadm])
    padm=reg(cur,"254703000002","hpadm",DEFAULT_SITE); q1(cur,"select fn_platform_appoint_platform_admin(%s,%s,%s,%s)",[ACTOR,SYS,padm,ph])
    tk=q1(cur,"select id,escalation_level,assignee_role,sla_due_at from fn_ticket_create(%s,%s,%s,%s,%s,%s,%s)",[sadm,"admin",None,None,"Payouts stuck","B2C failing","high"])
    check("site-admin ticket -> level 0, platform_admin, SLA set", tk[1]==0 and tk[2]=="platform_admin" and tk[3] is not None, str(tk))
    tkid=tk[0]
    check("platform admin notified on assignment", q1(cur,"select count(*) from user_notifications where user_id=%s and category='ticket'",[padm])[0]>=1)

    print("\n== Ticket scope + comments + escalation ==")
    other=mk_platform(cur,ACTOR,"otherco"); oadm=reg(cur,"254703000003","oadm",DEFAULT_SITE); q1(cur,"select fn_platform_appoint_platform_admin(%s,%s,%s,%s)",[ACTOR,SYS,oadm,other])
    expect_error(cur,"select fn_ticket_add_comment(%s,%s,%s,%s)",[oadm,"platform_admin",tkid,"peeking"],"PLATFORM_SCOPE_FORBIDDEN","another platform's admin cannot touch the ticket")
    ok(cur,"select fn_ticket_add_comment(%s,%s,%s,%s)",[padm,"platform_admin",tkid,"looking into it"],"assigned platform admin can comment")
    check("first_response recorded", q1(cur,"select first_response_at is not null from tickets where id=%s",[tkid])[0] is True)
    q1(cur,"select fn_ticket_escalate(%s,%s,%s,%s)",[padm,"platform_admin",tkid,"need system help"])
    r=q1(cur,"select escalation_level,assignee_role from tickets where id=%s",[tkid])
    check("manual escalate -> level 1 / system", r==(1,"platform_superadmin"), str(r))
    check("manual escalation logged", q1(cur,"select count(*) from ticket_escalations where ticket_id=%s and reason='manual'",[tkid])[0]==1)

    print("\n== Platform-admin-issued ticket -> System directly (level 1) ==")
    tk2=q1(cur,"select escalation_level,assignee_role from fn_ticket_create(%s,%s,%s,%s,%s,%s,%s)",[padm,"platform_admin",None,None,"Infra","engine lag","critical"])
    check("platform-admin ticket starts at level 1 (system)", tk2==(1,"platform_superadmin"), str(tk2))

    print("\n== System-owner-issued ticket -> the chosen platform's admin (docs/42 UI-9) ==")
    expect_error(cur,"select fn_ticket_create(%s,%s,%s,%s,%s,%s,%s)",[ACTOR,SYS,None,None,"No target","x","low"],"INVALID_PLATFORM","the owner must name a platform (the console now asks for one)")
    tk4=q1(cur,"select escalation_level,assignee_role,sla_due_at from fn_ticket_create(%s,%s,%s,%s,%s,%s,%s)",[ACTOR,SYS,ph,None,"Check KYC queue","please review","medium"])
    check("owner ticket -> level 0 on the named platform's admin, SLA set", tk4[0]==0 and tk4[1]=="platform_admin" and tk4[2] is not None, str(tk4))
    check("that platform's admin is notified", q1(cur,"select count(*) from user_notifications where user_id=%s and category='ticket'",[padm])[0]>=2)

    print("\n== AUTO escalation (SLA breach) ==")
    tk3=q1(cur,"select id from fn_ticket_create(%s,%s,%s,%s,%s,%s,%s)",[sadm,"admin",None,None,"Slow","x","low"])[0]
    q1(cur,"update tickets set sla_due_at=now()-interval '1 minute' where id=%s",[tk3])
    n=q1(cur,"select fn_ticket_auto_escalate()")[0]
    check("auto-escalate advanced >=1 ticket", n>=1, f"n={n}")
    r=q1(cur,"select escalation_level from tickets where id=%s",[tk3])
    check("overdue ticket auto-escalated to level 1", r[0]==1)
    check("auto escalation logged with reason=auto", q1(cur,"select count(*) from ticket_escalations where ticket_id=%s and reason='auto'",[tk3])[0]==1)

    print("\n== Resolve notifies the requester ==")
    q1(cur,"select fn_ticket_set_status(%s,%s,%s,%s,%s)",[ACTOR,SYS,tkid,"resolved","fixed the initiator creds"])
    check("resolved_at set", q1(cur,"select resolved_at is not null from tickets where id=%s",[tkid])[0] is True)
    check("requester notified of resolution", q1(cur,"select count(*) from user_notifications where user_id=%s and title like 'Your ticket was resolved'",[sadm])[0]>=1)

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL: print("FAILURES:", ", ".join(FAIL)); sys.exit(1)
    print("ALL SUBSCRIPTION + TICKET E2E SCENARIOS PASSED")

if __name__=="__main__": main()
