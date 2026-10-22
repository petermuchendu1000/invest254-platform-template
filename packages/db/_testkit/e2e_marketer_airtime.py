#!/usr/bin/env python3
"""Aggressive e2e for fn_marketer_buy_airtime and fn_marketer_set_email (migration 0207, docs/66).

Resets a local Postgres, applies the shim + ALL migrations, then attacks the two functions:

  CONSERVATION  a purchase moves money BETWEEN the two buckets of one wallet. balance + airtime is
                unchanged by every success and by every refusal — the property that makes the
                statement's arithmetic work.
  CASH ONLY     Fuliza cannot buy airtime, although it still funds a withdrawal.
  ATOMIC        every refusal moves neither bucket and writes no ledger row.
  IDEMPOTENT    the same ref replayed (including concurrently) buys exactly once.
  LEDGER        one signed debit row against the CASH balance, typed 'airtime'.
  STATEMENT     that row lands in OTHERS, which is where a real statement counts airtime.
  EMAIL         normalised on the way in; junk refused; null clears; the view exposes it.
  GRANTS        neither function is reachable with the Supabase anon key (BUGLOG #143).

Run: PGCLIENTENCODING=UTF8 python3 packages/db/_testkit/e2e_marketer_airtime.py  (needs local PG on /tmp:5433)
"""
import os, glob, threading
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_airtime_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
SITE_A = "00000000-0000-0000-0000-000000000001"

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def reset_and_migrate():
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname=%s and pid<>pg_backend_pid()", (DSN["dbname"],))
        c.execute(f'drop database if exists {DSN["dbname"]}'); c.execute(f'create database {DSN["dbname"]}')
    admin.close()
    conn = psycopg2.connect(**DSN); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "[0-9][0-9][0-9][0-9]_*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

_n = [730000000]
def new_marketer(cur, name, balance=0, fuliza=0):
    """A marketer whose wallet holds EXACTLY these figures.

    fn_marketer_create (0158) seeds a random social-proof float and an 'adjustment' row, so nothing
    here can assume an opening value — the wallet is flattened and the ledger wiped instead.
    """
    _n[0] += 1
    cur.execute("select id from public.fn_marketer_create(%s, %s, %s)", (name, "0" + str(_n[0]), SITE_A))
    mid = cur.fetchone()[0]
    cur.execute("delete from public.marketer_ledger where marketer_id=%s", (mid,))
    cur.execute("""update public.marketer_wallets
                      set balance_cents=%s, available_fuliza_cents=%s, airtime_balance_cents=0
                    where marketer_id=%s""", (balance, fuliza, mid))
    # An OPENING ROW for the balance just set, so wallet == sum(ledger) holds from the start. The
    # first version of this helper wiped the ledger and set the wallet directly, which made the
    # whole-system invariant at the bottom fail on the fixture rather than on the code.
    if balance:
        cur.execute("""insert into public.marketer_ledger(marketer_id, entry_type, amount_cents,
                         balance_after_cents, ref, meta)
                       values (%s,'adjustment',%s,%s,%s,'{"source":"e2e_opening"}'::jsonb)""",
                    (mid, balance, balance, f"open-{mid}"))
    return mid

def wallet(cur, mid):
    cur.execute("""select balance_cents, airtime_balance_cents, available_fuliza_cents
                     from public.marketer_wallets where marketer_id=%s""", (mid,))
    return cur.fetchone()

def rows(cur, mid):
    cur.execute("select count(*) from public.marketer_ledger where marketer_id=%s", (mid,))
    return cur.fetchone()[0]

def buy(cur, mid, cents, ref=None, meta="{}", minc=500):
    cur.execute("select public.fn_marketer_buy_airtime(%s,%s,%s,%s::jsonb,%s)", (mid, cents, ref, meta, minc))
    return cur.fetchone()[0]

def refuses(cur, code, fn):
    try:
        fn()
        return False, "no error raised"
    except Exception as e:
        return (code in str(e)), str(e).split("\n")[0][:140]

conn = reset_and_migrate()
conn.autocommit = True
cur = conn.cursor()
print("\nfn_marketer_buy_airtime / fn_marketer_set_email — real Postgres 16, all migrations applied\n")

# ── the purchase ───────────────────────────────────────────────────────────────────────────────
m = new_marketer(cur, "Faith Mutiso", balance=100_000)
before = sum(wallet(cur, m)[:2])
r = buy(cur, m, 10_000, "air-1", '{"for_self": true}')
bal, air, ful = wallet(cur, m)
check("buys: the cash balance falls by exactly the amount", bal == 90_000, str(bal))
check("buys: the airtime balance rises by exactly the amount", air == 10_000, str(air))
check("buys: nothing is created or destroyed across the two buckets", bal + air == before, f"{bal}+{air} vs {before}")
check("buys: reports both new figures", r["balance_cents"] == 90_000 and r["airtime_balance_cents"] == 10_000, str(r))
check("buys: Fuliza is untouched", ful == 0, str(ful))

cur.execute("""select entry_type, amount_cents, balance_after_cents, meta->>'source', meta->>'for_self'
                 from public.marketer_ledger where ref='air-1'""")
row = cur.fetchone()
check("ledger: ONE signed debit typed 'airtime', against the CASH balance",
      row == ("airtime", -10_000, 90_000, "airtime_purchase", "true"), str(row))
check("ledger: exactly one row was written for the purchase", rows(cur, m) == 2, rows(cur, m))  # + the opening row

# ── idempotency ────────────────────────────────────────────────────────────────────────────────
again = buy(cur, m, 10_000, "air-1")
check("replay: the same ref buys exactly once", wallet(cur, m)[:2] == (90_000, 10_000), str(wallet(cur, m)))
check("replay: says so", again["idempotent"] is True, str(again))
check("replay: returns the ORIGINAL row and time",
      again["ledger_id"] == r["ledger_id"] and again["created_at"] == r["created_at"], str(again))
check("replay: no extra ledger row", rows(cur, m) == 2, rows(cur, m))

# ── refusals, each atomic ──────────────────────────────────────────────────────────────────────
snap = (wallet(cur, m), rows(cur, m))
for name, code, amount in [
    ("refuses: more than the cash balance", "INSUFFICIENT_FUNDS", 500_000),
    ("refuses: zero", "AMOUNT_MUST_BE_POSITIVE", 0),
    ("refuses: a negative amount", "AMOUNT_MUST_BE_POSITIVE", -5_000),
    ("refuses: below the policy minimum", "AMOUNT_BELOW_MINIMUM", 100),
]:
    ok, detail = refuses(cur, code, lambda a=amount: buy(cur, m, a, None))
    check(name, ok, detail)
check("refusals moved nothing and wrote nothing", (wallet(cur, m), rows(cur, m)) == snap, str((wallet(cur, m), rows(cur, m))))

ok, detail = refuses(cur, "MARKETER_NOT_FOUND", lambda: buy(cur, "00000000-0000-0000-0000-0000000000ff", 5_000, None))
check("refuses: a marketer who does not exist", ok, detail)

susp = new_marketer(cur, "Suspended Sam", balance=100_000)
cur.execute("select public.fn_marketer_set_status(%s,'suspended')", (susp,))
ok, detail = refuses(cur, "MARKETER_NOT_ACTIVE", lambda: buy(cur, susp, 5_000, None))
check("refuses: a suspended marketer", ok, detail)

# ── cash only ──────────────────────────────────────────────────────────────────────────────────
f = new_marketer(cur, "Fuliza Fred", balance=1_000, fuliza=30_000)
ok, detail = refuses(cur, "INSUFFICIENT_FUNDS", lambda: buy(cur, f, 10_000, "air-ful"))
check("refuses: a purchase funded by the Fuliza overdraft", ok, detail)
check("…and the overdraft was not touched by the attempt", wallet(cur, f) == (1_000, 0, 30_000), str(wallet(cur, f)))
# The contrast that makes the rule a decision rather than an oversight.
cur.execute("select public.fn_marketer_withdraw(%s,%s,%s)", (f, 10_000, "ful-w"))
check("…while a WITHDRAWAL still spends Fuliza, unchanged by 0207",
      wallet(cur, f)[0] == 0 and wallet(cur, f)[2] == 21_000, str(wallet(cur, f)))

# ── concurrency: one wallet, many phones ───────────────────────────────────────────────────────
race = new_marketer(cur, "Busy Buyer", balance=10_000)
results = []
def worker(i):
    c = psycopg2.connect(**DSN); c.autocommit = True
    try:
        with c.cursor() as cc:
            cc.execute("select public.fn_marketer_buy_airtime(%s,%s,%s)", (race, 2_000, f"race-{i}"))
            results.append(("ok", cc.fetchone()[0]))
    except Exception as e:
        results.append(("err", str(e).split("\n")[0][:60]))
    finally:
        c.close()
ts = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
[t.start() for t in ts]; [t.join() for t in ts]
oks = [r for r in results if r[0] == "ok"]
bal, air, _ = wallet(cur, race)
check("race: 10,000 funds exactly 5 purchases of 2,000", len(oks) == 5, f"{len(oks)} succeeded")
check("race: the wallet is never overdrawn", bal == 0, str(bal))
check("race: every cent that left the balance arrived as airtime", air == 10_000, str(air))
check("race: the rest were refused for funds", all("INSUFFICIENT_FUNDS" in r[1] for r in results if r[0] == "err"),
      str([r[1] for r in results if r[0] == "err"][:2]))

# ── the same ref from many phones at once ──────────────────────────────────────────────────────
dup = new_marketer(cur, "Retry Storm", balance=100_000)
dres = []
def dupworker(_i):
    c = psycopg2.connect(**DSN); c.autocommit = True
    try:
        with c.cursor() as cc:
            cc.execute("select public.fn_marketer_buy_airtime(%s,%s,%s)", (dup, 5_000, "dup-ref"))
            dres.append(("ok", cc.fetchone()[0]))
    except Exception as e:
        dres.append(("err", str(e).split("\n")[0][:60]))
    finally:
        c.close()
ts = [threading.Thread(target=dupworker, args=(i,)) for i in range(8)]
[t.start() for t in ts]; [t.join() for t in ts]
check("retry storm: one ref buys exactly once", wallet(cur, dup)[:2] == (95_000, 5_000), str(wallet(cur, dup)))
check("retry storm: exactly one ledger row carries that ref",
      (cur.execute("select count(*) from public.marketer_ledger where ref='dup-ref'"), cur.fetchone()[0])[1] == 1)

# ── the statement ──────────────────────────────────────────────────────────────────────────────
s = conn.cursor()
s.execute("select public.fn_marketer_statement_summary(%s,'2000-01-01'::timestamptz,'2100-01-01'::timestamptz)", (m,))
summary = s.fetchone()[0]
# The `in` side is the fixture's own opening adjustment, which is also an OTHERS row; the airtime
# purchase is the `out` side, and that is what this asserts.
check("statement: an airtime purchase is counted in OTHERS, on the paid-OUT side",
      summary["buckets"]["OTHERS"]["out"] == 10_000, str(summary["buckets"]["OTHERS"]))
check("statement: it is NOT an agent withdrawal",
      summary["buckets"]["AGENT WITHDRAWAL"] == {"in": 0, "out": 0}, str(summary["buckets"]["AGENT WITHDRAWAL"]))
check("statement: the paid-out total includes it", summary["paid_out_cents"] == 10_000, str(summary))

# ── the email ──────────────────────────────────────────────────────────────────────────────────
e = new_marketer(cur, "Email Eve", balance=0)
cur.execute("select public.fn_marketer_set_email(%s, %s)", (e, "  Faith@Example.COM  "))
check("email: trimmed and lower-cased on the way in", cur.fetchone()[0] == "faith@example.com")
cur.execute("select email from public.marketer_profiles where id=%s", (e,))
check("email: the profile view exposes it", cur.fetchone()[0] == "faith@example.com")
for bad in ("faith", "faith@", "@example.com", "a@b"):
    ok, detail = refuses(cur, "INVALID_EMAIL", lambda b=bad: cur.execute("select public.fn_marketer_set_email(%s,%s)", (e, b)))
    check(f"email: refuses {bad!r}", ok, detail)
cur.execute("select email from public.marketers where id=%s", (e,))
check("email: a refused address did not overwrite the stored one", cur.fetchone()[0] == "faith@example.com")
cur.execute("select public.fn_marketer_set_email(%s, NULL)", (e,))
check("email: null clears it", cur.fetchone()[0] is None)
# The CHECK is the backstop for a direct UPDATE that bypasses the function entirely.
ok, detail = refuses(cur, "marketers_email_shape_check",
                     lambda: cur.execute("update public.marketers set email='nonsense' where id=%s", (e,)))
check("email: a direct UPDATE of junk is refused by the column CHECK", ok, detail)

# ── grants (BUGLOG #143) ───────────────────────────────────────────────────────────────────────
for fn in ("fn_marketer_buy_airtime", "fn_marketer_set_email"):
    cur.execute("""
      select count(*) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname=%s
         and (has_function_privilege('anon', p.oid, 'EXECUTE')
              or has_function_privilege('authenticated', p.oid, 'EXECUTE')
              or has_function_privilege('public', p.oid, 'EXECUTE'))""", (fn,))
    check(f"{fn} is closed to anon / authenticated / public", cur.fetchone()[0] == 0)

# ── the whole-system invariant ─────────────────────────────────────────────────────────────────
cur.execute("""
  select count(*) from public.marketer_wallets w
   where exists (select 1 from public.marketer_ledger l
                  where l.marketer_id = w.marketer_id and l.entry_type = 'airtime')
     and w.balance_cents <> coalesce((
           select sum(l.amount_cents) from public.marketer_ledger l where l.marketer_id = w.marketer_id), 0)""")
check("every wallet that bought airtime still equals the sum of its own ledger", cur.fetchone()[0] == 0)

print(f"\n{len(PASS)}/{len(PASS)+len(FAIL)} passed")
if FAIL:
    print("FAILED:")
    for f in FAIL: print("  -", f)
    raise SystemExit(1)
