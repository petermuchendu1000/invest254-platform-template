#!/usr/bin/env python3
"""Aggressive e2e for fn_marketer_transfer (migration 0203, docs/63, BUGLOG #140).

Resets a local Postgres, applies the shim + ALL migrations, then attacks the one function that can
move funny money between two live wallets:

  CONSERVATION  every success and every refusal leaves the two balances summing to what they started
                at — the only property that matters for a transfer.
  ATOMIC        a refusal writes NO ledger row on either side and moves neither balance.
  IDEMPOTENT    the same ref replayed (including concurrently) sends exactly once.
  CONCURRENCY   N parallel sends from one wallet never overdraw it; opposing simultaneous transfers
                between the same two wallets do not deadlock.
  FENCE         another brand's marketer, a suspended one and a nonexistent one are indistinguishable.
  FULIZA        an overdraft limit is NOT spendable on a transfer (it is on a withdrawal).
  CAP           the rolling 24h per-sender cap holds, and counts only this sender's own transfers.

Run: PGCLIENTENCODING=UTF8 python3 packages/db/_testkit/e2e_marketer_transfer.py  (needs local PG on /tmp:5433)
"""
import os, glob, uuid, threading, re
import datetime as dt
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_transfer_test")
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

_n = [700000000]
def new_marketer(cur, name, site=SITE_A, balance=None):
    """A marketer whose wallet holds EXACTLY `balance` cents.

    fn_marketer_create (0158) seeds every new wallet with a random social-proof float
    (KES 1,000-5,000 balance, KES 2,500-7,500 Fuliza), so nothing here can assume an opening value.
    The wallet is flattened to a known figure instead, and Fuliza is zeroed unless a test sets it —
    otherwise the random grant would silently fund transfers the test meant to be unaffordable.
    """
    _n[0] += 1
    phone = "0" + str(_n[0])
    cur.execute("select id from public.fn_marketer_create(%s, %s, %s)", (name, phone, site))
    mid = cur.fetchone()[0]
    cur.execute("select public.fn_marketer_set_fuliza(%s, 0)", (mid,))
    if balance is not None:
        cur.execute("update public.marketer_wallets set balance_cents=%s where marketer_id=%s", (balance, mid))
        cur.execute("""update public.marketer_ledger set amount_cents=%s, balance_after_cents=%s
                        where marketer_id=%s and entry_type='adjustment'""", (balance, balance, mid))
    return mid

def bal(cur, mid):
    cur.execute("select balance_cents from public.marketer_wallets where marketer_id=%s", (mid,))
    return cur.fetchone()[0]

def ledger_count(cur, mid):
    cur.execute("select count(*) from public.marketer_ledger where marketer_id=%s", (mid,))
    return cur.fetchone()[0]

def transfer(cur, a, b, cents, ref=None, cap=None):
    if cap is None:
        cur.execute("select public.fn_marketer_transfer(%s,%s,%s,%s)", (a, b, cents, ref))
    else:
        cur.execute("select public.fn_marketer_transfer(%s,%s,%s,%s,%s,%s)", (a, b, cents, ref, '{}', cap))
    return cur.fetchone()[0]

def refuses(cur, code, fn):
    """Run fn and assert it raised `code`. The connection is autocommit, so a failed statement is
    its own already-rolled-back transaction and nothing is left poisoned."""
    try:
        fn()
        return False, "no error raised"
    except Exception as e:
        return (code in str(e)), str(e).split("\n")[0][:140]

conn = reset_and_migrate()
conn.autocommit = True
cur = conn.cursor()
print("\nfn_marketer_transfer — real Postgres 16, all migrations applied\n")

# ── happy path + conservation ──────────────────────────────────────────────────────────────────
a = new_marketer(cur, "Tony Angwa", balance=50_000)
b = new_marketer(cur, "Peter Muchendu", balance=10_000)
before = bal(cur, a) + bal(cur, b)
r = transfer(cur, a, b, 10_000, "tx-1")
check("sends: sender debited exactly", bal(cur, a) == 40_000, f"{bal(cur,a)}")
check("sends: recipient credited exactly", bal(cur, b) == 20_000, f"{bal(cur,b)}")
check("sends: nothing created or destroyed", bal(cur, a) + bal(cur, b) == before)
check("sends: returns the recipient's registered name", r["recipient_name"] == "Peter Muchendu", str(r))
check("sends: reports both new balances", r["from_balance_cents"] == 40_000 and r["to_balance_cents"] == 20_000, str(r))

# The two ledger halves, and the counterparty name on each (what the app's SMS text reads).
cur.execute("select entry_type, amount_cents, meta->>'name', meta->>'source' from public.marketer_ledger where ref='tx-1:out'")
out = cur.fetchone()
cur.execute("select entry_type, amount_cents, meta->>'name', meta->>'source' from public.marketer_ledger where ref='tx-1:in'")
inn = cur.fetchone()
check("ledger: sender row is a signed transfer_out naming the recipient",
      out == ("transfer_out", -10_000, "Peter Muchendu", "marketer_transfer"), str(out))
check("ledger: recipient row is a signed transfer_in naming the sender",
      inn == ("transfer_in", 10_000, "Tony Angwa", "marketer_transfer"), str(inn))
# docs/58: the app is never handed anyone's number but its own, so neither half of a transfer may
# carry one. Asked per KEY/VALUE, not as a substring of the whole meta blob: the blob contains
# counterparty_marketer_id, and a random UUID's text contains the digits "07" 9.4% of the time
# (measured over 200,000 uuid4s), which made the substring form of this check fail 17.9% of runs
# for a reason that had nothing to do with phone numbers. A guard that cries wolf one run in six is
# a guard people re-run until it is quiet — the failure mode BUGLOG #144 was about. The value test
# is anchored on a WORD boundary (\m0), not a string start, so a number quoted mid-sentence is still
# caught while a UUID's interior digits are not; the residual false-positive rate is ~1 in 5,000
# runs (a 12-hex segment would have to open with 0, then 1 or 7, then eight more digits).
cur.execute("""
  select count(*) from public.marketer_ledger l, jsonb_each_text(l.meta) kv
   where l.ref in ('tx-1:out','tx-1:in')
     and (kv.key ~* '(phone|msisdn|mobile|number)'
          or kv.value ~ '(\\+?254|\\m0)[17][0-9]{8}')""")
check("ledger: no phone number is stored in meta (docs/58)", cur.fetchone()[0] == 0)

# ── idempotency ────────────────────────────────────────────────────────────────────────────────
again = transfer(cur, a, b, 10_000, "tx-1")
check("replay: the same ref sends exactly once", bal(cur, a) == 40_000 and bal(cur, b) == 20_000,
      f"{bal(cur,a)}/{bal(cur,b)}")
check("replay: says so", again["idempotent"] is True, str(again))
check("replay: no extra ledger row", ledger_count(cur, a) == 2, ledger_count(cur, a))

# ── the receipt (0205) ─────────────────────────────────────────────────────────────────────────
# The app prints a confirmation screen and a downloadable M-PESA receipt from this function's
# answer. Both carry a time and an ID, and both must come from HERE: the handset clock is not
# evidence of when money moved, and on a replay it would be evidence of the wrong moment entirely.
check("receipt: a fresh send returns the out-row's commit time",
      re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", r.get("out_created_at") or "") is not None,
      str(r.get("out_created_at")))
cur.execute("select created_at, id from public.marketer_ledger where ref='tx-1:out'")
out_at, out_id = cur.fetchone()
# To the millisecond: to_char(...'MS') deliberately truncates the stored microseconds, because the
# consumer is JavaScript's Date.parse, which has no finer resolution. Equality to the microsecond
# would be asserting a precision the receipt cannot carry.
returned = dt.datetime.strptime(r["out_created_at"], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=dt.timezone.utc)
check("receipt: that time IS the stored row's created_at, to the millisecond",
      abs((out_at - returned).total_seconds()) < 0.001 and returned <= out_at,
      f'{out_at} vs {r["out_created_at"]}')
check("receipt: the returned out_ledger_id is the stored row's id", r["out_ledger_id"] == out_id, str(r))

# Both halves share one timestamp because created_at defaults to now(), which in Postgres is
# transaction start. The app relies on it: the two sides must not disagree about when it happened.
cur.execute("select count(distinct created_at) from public.marketer_ledger where ref in ('tx-1:out','tx-1:in')")
check("receipt: both halves of one transfer share one timestamp", cur.fetchone()[0] == 1)

# pair_ledger_id is what makes the payer and the payee see ONE confirmation code. It belongs on the
# credited row only: on the debited row it would point at itself, which is the fallback already.
cur.execute("select (meta->>'pair_ledger_id')::bigint from public.marketer_ledger where ref='tx-1:in'")
check("receipt: the credited row points at the debited row", cur.fetchone()[0] == out_id)
cur.execute("select meta ? 'pair_ledger_id' from public.marketer_ledger where ref='tx-1:out'")
check("receipt: the debited row carries no self-referential pair", cur.fetchone()[0] is False)

# A replay must reprint the ORIGINAL receipt. A second code or today's date for a transfer that
# completed minutes ago is how a sender is talked into sending again.
check("receipt: a replay returns the original time, not now",
      again.get("out_created_at") == r["out_created_at"], f'{again.get("out_created_at")} vs {r["out_created_at"]}')
check("receipt: a replay returns the original ledger id", again["out_ledger_id"] == out_id, str(again))

# ── refusals: each one atomic ──────────────────────────────────────────────────────────────────
snap = (bal(cur, a), bal(cur, b), ledger_count(cur, a), ledger_count(cur, b))

ok, det = refuses(cur, "TRANSFER_TO_SELF", lambda: transfer(cur, a, a, 100, "self-1"))
check("refuses: sending to yourself", ok, det)
ok, det = refuses(cur, "INSUFFICIENT_FUNDS", lambda: transfer(cur, a, b, 999_999, "over-1"))
check("refuses: more than the balance", ok, det)
ok, det = refuses(cur, "AMOUNT_MUST_BE_POSITIVE", lambda: transfer(cur, a, b, 0, "zero-1"))
check("refuses: zero", ok, det)
ok, det = refuses(cur, "AMOUNT_MUST_BE_POSITIVE", lambda: transfer(cur, a, b, -500, "neg-1"))
check("refuses: a negative amount (no reverse-direction steal)", ok, det)
ok, det = refuses(cur, "AMOUNT_BELOW_MINIMUM", lambda: transfer(cur, a, b, 1, "dust-1"))
check("refuses: sub-shilling dust", ok, det)
ok, det = refuses(cur, "MARKETER_NOT_FOUND", lambda: transfer(cur, str(uuid.uuid4()), b, 100, "ghost-1"))
check("refuses: a sender who does not exist", ok, det)

check("refusals changed nothing", (bal(cur, a), bal(cur, b), ledger_count(cur, a), ledger_count(cur, b)) == snap)

# ── the brand fence, and its opacity ───────────────────────────────────────────────────────────
cur.execute("insert into public.sites(id,name,slug) values (gen_random_uuid(),'Madolar','madolar-transfer-test') returning id")
site_b = cur.fetchone()[0]
other = new_marketer(cur, "Other Brand Rep", site=site_b, balance=5_000)
ok, cross = refuses(cur, "RECIPIENT_NOT_FOUND", lambda: transfer(cur, a, other, 100, "cross-1"))
check("refuses: a sibling brand's marketer", ok, cross)
ok, ghost = refuses(cur, "RECIPIENT_NOT_FOUND", lambda: transfer(cur, a, str(uuid.uuid4()), 100, "ghost-2"))
check("refuses: a recipient who does not exist", ok, ghost)
check("the two refusals are indistinguishable (no brand mapping)",
      cross.split(":")[0].strip() == ghost.split(":")[0].strip(), f"{cross!r} vs {ghost!r}")
check("cross-brand attempt moved nothing", bal(cur, other) == 5_000)

# suspended recipient -> the same opaque refusal
susp = new_marketer(cur, "Suspended Rep", balance=1_000)
cur.execute("select public.fn_marketer_set_status(%s,'suspended')", (susp,))
ok, det = refuses(cur, "RECIPIENT_NOT_FOUND", lambda: transfer(cur, a, susp, 100, "susp-1"))
check("refuses: a suspended recipient, with the same words", ok, det)
# suspended SENDER -> their own, distinct error (they are authenticated; it is not an enumeration risk)
ok, det = refuses(cur, "MARKETER_NOT_ACTIVE", lambda: transfer(cur, susp, a, 100, "susp-2"))
check("refuses: a suspended sender", ok, det)

# ── Fuliza is not spendable on a transfer (but IS on a withdrawal) ─────────────────────────────
f = new_marketer(cur, "Fuliza Rep", balance=1_000)
cur.execute("select public.fn_marketer_set_fuliza(%s, %s)", (f, 30_000))
ok, det = refuses(cur, "INSUFFICIENT_FUNDS", lambda: transfer(cur, f, b, 5_000, "ful-1"))
check("refuses: a transfer funded by the Fuliza overdraft", ok, det)
cur.execute("select public.fn_marketer_withdraw(%s, %s, %s)", (f, 5_000, "ful-w"))
check("…while a WITHDRAWAL still spends Fuliza, unchanged by 0203", bal(cur, f) == 0,
      f"balance {bal(cur,f)}")

# ── the rolling daily cap ──────────────────────────────────────────────────────────────────────
c1 = new_marketer(cur, "Capped Rep", balance=100_000)
c2 = new_marketer(cur, "Cap Target", balance=0)
transfer(cur, c1, c2, 6_000, "cap-1", cap=10_000)
ok, det = refuses(cur, "TRANSFER_DAILY_CAP", lambda: transfer(cur, c1, c2, 5_000, "cap-2", cap=10_000))
check("cap: the 24h ceiling holds across several sends", ok, det)
r = transfer(cur, c1, c2, 4_000, "cap-3", cap=10_000)
check("cap: exactly up to the ceiling is allowed", r["idempotent"] is False)
# A different sender has their own budget.
c3 = new_marketer(cur, "Other Sender", balance=50_000)
r = transfer(cur, c3, c2, 9_000, "cap-4", cap=10_000)
check("cap: it is per-sender, not global", r["idempotent"] is False)

# ── concurrency: N parallel sends from one wallet ──────────────────────────────────────────────
s = new_marketer(cur, "Race Sender", balance=10_000)
t = new_marketer(cur, "Race Target", balance=0)
errors, oks = [], []
def worker(i):
    cn = psycopg2.connect(**DSN); cn.autocommit = True
    try:
        with cn.cursor() as cc:
            cc.execute("select public.fn_marketer_transfer(%s,%s,%s,%s)", (s, t, 2_000, f"race-{i}"))
            oks.append(i)
    except Exception as e:
        errors.append(str(e).split("\n")[0])
    finally:
        cn.close()
threads = [threading.Thread(target=worker, args=(i,)) for i in range(12)]
for th in threads: th.start()
for th in threads: th.join()
check("race: a wallet with 10,000 funds exactly 5 sends of 2,000", len(oks) == 5, f"ok={len(oks)} err={len(errors)}")
check("race: it is never overdrawn", bal(cur, s) == 0, f"{bal(cur,s)}")
check("race: every cent that left arrived", bal(cur, t) == 10_000, f"{bal(cur,t)}")
check("race: the rest were refused for funds", all("INSUFFICIENT_FUNDS" in e for e in errors), errors[:2])

# ── concurrency: the same ref from many phones at once ─────────────────────────────────────────
s2 = new_marketer(cur, "Retry Sender", balance=10_000)
t2 = new_marketer(cur, "Retry Target", balance=0)
dup_err = []
def dup(i):
    cn = psycopg2.connect(**DSN); cn.autocommit = True
    try:
        with cn.cursor() as cc:
            cc.execute("select public.fn_marketer_transfer(%s,%s,%s,%s)", (s2, t2, 3_000, "same-ref"))
    except Exception as e:
        dup_err.append(str(e).split("\n")[0])
    finally:
        cn.close()
threads = [threading.Thread(target=dup, args=(i,)) for i in range(8)]
for th in threads: th.start()
for th in threads: th.join()
check("retry storm: one ref moves money exactly once", bal(cur, t2) == 3_000, f"{bal(cur,t2)} err={dup_err[:2]}")
check("retry storm: sender debited exactly once", bal(cur, s2) == 7_000, f"{bal(cur,s2)}")

# ── concurrency: opposing transfers must not deadlock ──────────────────────────────────────────
x = new_marketer(cur, "Dead X", balance=50_000)
y = new_marketer(cur, "Dead Y", balance=50_000)
dead = []
def swap(i):
    cn = psycopg2.connect(**DSN); cn.autocommit = True
    try:
        with cn.cursor() as cc:
            a_, b_ = (x, y) if i % 2 == 0 else (y, x)
            cc.execute("select public.fn_marketer_transfer(%s,%s,%s,%s)", (a_, b_, 100, f"swap-{i}"))
    except Exception as e:
        dead.append(str(e).split("\n")[0])
    finally:
        cn.close()
threads = [threading.Thread(target=swap, args=(i,)) for i in range(20)]
for th in threads: th.start()
for th in threads: th.join()
check("opposing transfers never deadlock", not any("deadlock" in e.lower() for e in dead), dead[:2])
check("opposing transfers conserve the pair's total", bal(cur, x) + bal(cur, y) == 100_000,
      f"{bal(cur,x)}+{bal(cur,y)}")

# ── the whole-system invariant ─────────────────────────────────────────────────────────────────
# A wallet equals the sum of its own ledger — EXCEPT where Fuliza paid part of a withdrawal.
# That exception is pre-existing and not this migration's: fn_marketer_withdraw (0033) records the
# FULL amount in the ledger but debits only the cash part from balance_cents, taking the rest out of
# available_fuliza_cents, so the ledger stops being a complete record of that wallet the moment the
# overdraft is used. (Observed here, logged as BUGLOG #141 — it is why a transfer must not be able
# to spend Fuliza: the hole would then open on a path where the money is still inside the system.)
cur.execute("""
  select count(*) from public.marketer_wallets w
   where w.balance_cents <> coalesce((
           select sum(l.amount_cents) from public.marketer_ledger l where l.marketer_id = w.marketer_id), 0)
     and not exists (
           select 1 from public.marketer_ledger l
            where l.marketer_id = w.marketer_id
              and l.entry_type = 'withdrawal'
              and coalesce((l.meta->>'fuliza_used_cents')::bigint, 0) > 0)""")
check("every wallet equals the sum of its own ledger (Fuliza withdrawals aside)", cur.fetchone()[0] == 0)

# And the exception really is confined to Fuliza withdrawals: no TRANSFER ever opened one.
cur.execute("""
  select count(*) from public.marketer_wallets w
   where w.balance_cents <> coalesce((
           select sum(l.amount_cents) from public.marketer_ledger l where l.marketer_id = w.marketer_id), 0)
     and exists (select 1 from public.marketer_ledger l
                  where l.marketer_id = w.marketer_id and l.entry_type in ('transfer_in','transfer_out'))
     and not exists (
           select 1 from public.marketer_ledger l
            where l.marketer_id = w.marketer_id
              and l.entry_type = 'withdrawal'
              and coalesce((l.meta->>'fuliza_used_cents')::bigint, 0) > 0)""")
check("no wallet that transferred has drifted from its ledger", cur.fetchone()[0] == 0)
cur.execute("""
  select count(*) from public.marketer_ledger o
    join public.marketer_ledger i on i.ref = replace(o.ref, ':out', ':in')
   where o.entry_type='transfer_out' and o.amount_cents <> -i.amount_cents""")
check("every transfer's two halves are equal and opposite", cur.fetchone()[0] == 0)

print(f"\n{len(PASS)}/{len(PASS)+len(FAIL)} passed")
if FAIL:
    print("FAILED:")
    for f in FAIL: print("  -", f)
    raise SystemExit(1)
