#!/usr/bin/env python3
"""Aggressive e2e for the statement functions (migration 0206, docs/65).

Resets a local Postgres, applies the shim + ALL migrations, then attacks the two functions the
marketer statement is built from:

  MAPPING      every ledger entry_type lands in the bucket docs/65 says it does — in particular a
               game-winnings credit is OTHERS and NOT an agent deposit.
  COMPLETE     every bucket is reported even at zero, so a missing key never has to be guessed at.
  BOUNDARIES   the range is [from, to) to the microsecond: a row exactly at `from` is in, a row
               exactly at `to` is out.
  TRUNCATION   the detail cap keeps the NEWEST rows and prints them oldest-first, while the SUMMARY
               still counts and totals every row in the range. This is the one that matters: a
               summary computed from capped detail would under-report silently.
  GRANTS       neither function is reachable with the Supabase anon key (BUGLOG #143).

Rows are INSERTed directly with controlled created_at, because every boundary and cap assertion
here needs timestamps the API cannot produce on demand.

Run: PGCLIENTENCODING=UTF8 python3 packages/db/_testkit/e2e_marketer_statement.py  (needs local PG on /tmp:5433)
"""
import os, glob, uuid
import psycopg2

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_statement_test")
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

_n = [720000000]
def new_marketer(cur, name, balance=0):
    _n[0] += 1
    cur.execute("select id from public.fn_marketer_create(%s, %s, %s)", (name, "0" + str(_n[0]), SITE_A))
    mid = cur.fetchone()[0]
    # fn_marketer_create (0158) seeds a random social-proof float and an 'adjustment' ledger row.
    # Both would pollute every total below, so the slate is wiped rather than worked around.
    cur.execute("delete from public.marketer_ledger where marketer_id=%s", (mid,))
    cur.execute("""update public.marketer_wallets
                      set balance_cents=%s, available_fuliza_cents=0 where marketer_id=%s""", (balance, mid))
    return mid

def put(cur, mid, entry_type, cents, at, meta="{}", bal=0):
    """One ledger row at an exact instant. `at` is any timestamptz literal."""
    cur.execute("""insert into public.marketer_ledger(marketer_id, entry_type, amount_cents,
                     balance_after_cents, ref, meta, created_at)
                   values (%s,%s,%s,%s,%s,%s::jsonb,%s) returning id""",
                (mid, entry_type, cents, bal, f"e2e-{uuid.uuid4()}", meta, at))
    return cur.fetchone()[0]

def summary(cur, mid, a, b):
    cur.execute("select public.fn_marketer_statement_summary(%s,%s::timestamptz,%s::timestamptz)", (mid, a, b))
    return cur.fetchone()[0]

def detail(cur, mid, a, b, cap=2000):
    cur.execute("select id, entry_type, amount_cents from public.fn_marketer_statement_range(%s,%s::timestamptz,%s::timestamptz,%s)",
                (mid, a, b, cap))
    return cur.fetchall()

conn = reset_and_migrate()
conn.autocommit = True
cur = conn.cursor()
print("\nfn_marketer_statement_summary / _range — real Postgres 16, all migrations applied\n")

WIDE = ("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")

# ── the mapping ────────────────────────────────────────────────────────────────────────────────
m = new_marketer(cur, "Faith Mutiso")
put(cur, m, "transfer_out", -1000,  "2026-06-01T09:00:00Z", '{"source":"marketer_transfer","name":"Peter Muchendu"}')
put(cur, m, "transfer_in",   2000,  "2026-06-02T09:00:00Z", '{"source":"marketer_transfer","name":"Tony Angwa"}')
put(cur, m, "withdrawal",   -3000,  "2026-06-03T09:00:00Z")
put(cur, m, "credit",        4000,  "2026-06-04T09:00:00Z")                                   # agent deposit
put(cur, m, "credit",        5000,  "2026-06-05T09:00:00Z", '{"source":"self_service_demo"}') # still a deposit
put(cur, m, "credit",        6000,  "2026-06-06T09:00:00Z", '{"source":"game_withdrawal"}')   # NOT a deposit
put(cur, m, "adjustment",    7000,  "2026-06-07T09:00:00Z")
put(cur, m, "reversal",     -8000,  "2026-06-08T09:00:00Z")

s = summary(cur, m, *WIDE)
b = s["buckets"]
check("maps transfer_out to SEND MONEY (out)",      b["SEND MONEY"] == {"in": 0, "out": 1000}, str(b["SEND MONEY"]))
check("maps transfer_in to RECEIVED MONEY (in)",    b["RECEIVED MONEY"] == {"in": 2000, "out": 0}, str(b["RECEIVED MONEY"]))
check("maps withdrawal to AGENT WITHDRAWAL (out)",  b["AGENT WITHDRAWAL"] == {"in": 0, "out": 3000}, str(b["AGENT WITHDRAWAL"]))
check("maps a plain credit AND a demo top-up to AGENT DEPOSIT",
      b["AGENT DEPOSIT"] == {"in": 9000, "out": 0}, str(b["AGENT DEPOSIT"]))
# The reading docs/65 argues for: an agent did not deposit the game's winnings.
check("game winnings are OTHERS, not AGENT DEPOSIT",
      b["OTHERS"] == {"in": 13000, "out": 8000}, str(b["OTHERS"]))
check("counts every row in the range", s["txn_count"] == 8, str(s["txn_count"]))
# Asserted as an INVARIANT rather than a number typed here: the first version of this line
# hardcoded 22000, which was simply wrong arithmetic on my part, and a hardcoded expectation that
# disagrees with the code tells you nothing about which of the two is broken.
bucket_in  = sum(v["in"]  for v in b.values())
bucket_out = sum(v["out"] for v in b.values())
check("the reported totals are exactly the sum of the reported buckets",
      s["paid_in_cents"] == bucket_in and s["paid_out_cents"] == bucket_out,
      f'{s["paid_in_cents"]}/{s["paid_out_cents"]} vs {bucket_in}/{bucket_out}')
# …and one absolute figure, so a bug that corrupted buckets and totals together is still caught.
check("the absolute totals are right for the eight rows inserted",
      s["paid_in_cents"] == 24000 and s["paid_out_cents"] == 12000, str(s))

# ── completeness ───────────────────────────────────────────────────────────────────────────────
empty = new_marketer(cur, "Nobody At All")
e = summary(cur, empty, *WIDE)
check("an empty range still reports all five buckets",
      sorted(e["buckets"].keys()) == ["AGENT DEPOSIT", "AGENT WITHDRAWAL", "OTHERS", "RECEIVED MONEY", "SEND MONEY"],
      str(sorted(e["buckets"].keys())))
check("an empty range reports zeros, not nulls",
      all(v == {"in": 0, "out": 0} for v in e["buckets"].values()) and e["txn_count"] == 0, str(e))
check("an empty range returns no detail rows", detail(cur, empty, *WIDE) == [])

# ── boundaries ─────────────────────────────────────────────────────────────────────────────────
bnd = new_marketer(cur, "Edge Case")
put(cur, bnd, "credit", 100, "2026-06-01T00:00:00Z")           # exactly at `from`
put(cur, bnd, "credit", 200, "2026-06-01T00:00:00.000001Z")    # one microsecond inside
put(cur, bnd, "credit", 400, "2026-06-30T23:59:59.999999Z")    # last instant before `to`
put(cur, bnd, "credit", 800, "2026-07-01T00:00:00Z")           # exactly at `to`
sb = summary(cur, bnd, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z")
check("a row exactly at `from` is INSIDE the range (>=)",
      sb["buckets"]["AGENT DEPOSIT"]["in"] == 700, str(sb["buckets"]["AGENT DEPOSIT"]))
check("a row exactly at `to` is OUTSIDE the range (<)", sb["txn_count"] == 3, str(sb["txn_count"]))
check("the detail agrees with the summary about the boundaries", len(detail(cur, bnd, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z")) == 3)

# ── truncation: the invariant the whole design exists for ──────────────────────────────────────
big = new_marketer(cur, "Busy Marketer")
ids = [put(cur, big, "credit", 100, f"2026-06-{d:02d}T09:00:00Z") for d in range(1, 11)]
rows = detail(cur, big, *WIDE, cap=3)
check("the cap keeps the NEWEST rows", [r[0] for r in rows] == ids[-3:], f"{[r[0] for r in rows]} vs {ids[-3:]}")
check("the capped detail is printed oldest-first", [r[0] for r in rows] == sorted(r[0] for r in rows))
sbig = summary(cur, big, *WIDE)
check("the SUMMARY still counts every row the cap dropped", sbig["txn_count"] == 10, str(sbig["txn_count"]))
check("the SUMMARY still totals every row the cap dropped",
      sbig["paid_in_cents"] == 1000, str(sbig["paid_in_cents"]))
check("an uncapped read returns everything, oldest-first",
      [r[0] for r in detail(cur, big, *WIDE)] == ids)
# A cap of 0 or a negative cap must not mean "no rows" by accident — greatest(...,1) floors it.
check("a nonsense cap still returns one row rather than silently none", len(detail(cur, big, *WIDE, cap=0)) == 1)

# ── ordering: by the column the statement PRINTS (0208, BUGLOG #149) ───────────────────────────
# `id` is drawn at INSERT; `created_at` defaults to now(), which is TRANSACTION START. A transaction
# that begins early and inserts late takes a higher id with an earlier timestamp, so the two orders
# can disagree — and 0206 ordered by id while the statement prints created_at. Rows are inserted
# here in deliberately the wrong order to reproduce exactly that.
ord_m = new_marketer(cur, "Out Of Order")
ids = []
for day, in_order in [(5, 3), (1, 1), (9, 5), (3, 2), (7, 4)]:
    ids.append((in_order, put(cur, ord_m, "credit", 100 * in_order, f"2026-06-{day:02d}T09:00:00Z")))
cur.execute("""select created_at from public.fn_marketer_statement_range(%s,%s::timestamptz,%s::timestamptz,2000)""",
            (ord_m, *WIDE))
stamps = [r[0] for r in cur.fetchall()]
check("ordering: the detail is chronological, not insertion order",
      stamps == sorted(stamps), str(stamps))
# Insertion order was 5th, 1st, 9th, 3rd, 7th; printed order must be 1st, 3rd, 5th, 7th, 9th.
check("ordering: specifically, the days come out ascending",
      [s.day for s in stamps] == [1, 3, 5, 7, 9], str([s.day for s in stamps]))
# The cap keeps the LATEST BY TIME, not the last inserted.
cur.execute("""select created_at from public.fn_marketer_statement_range(%s,%s::timestamptz,%s::timestamptz,2)""",
            (ord_m, *WIDE))
capped = [r[0].day for r in cur.fetchall()]
check("ordering: a capped read keeps the latest BY TIME", capped == [7, 9], str(capped))

# Two rows sharing a timestamp to the microsecond — the two halves of a transfer do — keep a stable
# order, with the debit before the credit it produced.
pair_a = new_marketer(cur, "Pair A", balance=50_000)
pair_b = new_marketer(cur, "Pair B", balance=0)
cur.execute("select public.fn_marketer_transfer(%s,%s,%s,%s)", (pair_a, pair_b, 10_000, "ord-pair"))
cur.execute("""select l.entry_type from public.marketer_ledger l
                where l.ref like 'ord-pair:%' order by l.created_at asc, l.id asc""")
check("ordering: the two halves of a transfer keep the debit first",
      [r[0] for r in cur.fetchall()] == ["transfer_out", "transfer_in"])

# ── a statement is one marketer's, and only theirs ─────────────────────────────────────────────
check("one marketer's range never includes another's rows",
      summary(cur, bnd, *WIDE)["txn_count"] == 4 and summary(cur, big, *WIDE)["txn_count"] == 10)

# ── grants (BUGLOG #143) ───────────────────────────────────────────────────────────────────────
for fn in ("fn_marketer_statement_summary", "fn_marketer_statement_range"):
    cur.execute("""
      select count(*) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname=%s
         and (has_function_privilege('anon', p.oid, 'EXECUTE')
              or has_function_privilege('authenticated', p.oid, 'EXECUTE')
              or has_function_privilege('public', p.oid, 'EXECUTE'))""", (fn,))
    check(f"{fn} is closed to anon / authenticated / public", cur.fetchone()[0] == 0)

print(f"\n{len(PASS)}/{len(PASS)+len(FAIL)} passed")
if FAIL:
    print("FAILED:")
    for f in FAIL: print("  -", f)
    raise SystemExit(1)
