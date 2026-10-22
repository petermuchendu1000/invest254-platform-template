-- 0206_marketer_statement_range.sql — a marketer's wallet statement over a date range (docs/65).
--
-- WHY. fn_marketer_statement (0033) answers "the last N entries", which is what a transaction FEED
-- needs. A statement is a different question: "everything that happened between these two dates",
-- asked for accountability — the owner wants to see how a marketer has been using the funny money,
-- and a feed truncated at 50 cannot answer that.
--
-- TWO FUNCTIONS, NOT ONE, AND THAT IS THE POINT.
--
--   fn_marketer_statement_summary  scans the WHOLE range and returns the totals.
--   fn_marketer_statement_range    returns the detail rows, CAPPED.
--
-- A statement over a year could be thousands of rows. Capping the detail is unavoidable; computing
-- the SUMMARY from the capped detail would not be — it would silently under-report every total the
-- moment the cap bit, and a statement whose totals do not match its own purpose is worse than no
-- statement. So the totals are aggregated in the database over every qualifying row, and the detail
-- is a separate, bounded read. The route reports whether the detail truncated.
--
-- THE CAPPED DETAIL KEEPS THE NEWEST ROWS, PRINTED OLDEST-FIRST. `order by id desc limit N` inside,
-- `order by id asc` outside. Truncating the newest end instead — which a plain ascending LIMIT would
-- do — hides exactly the activity the reader opened the statement to see.
--
-- THE BUCKETS ARE THE REFERENCE'S, AND THE MAPPING IS A DELIBERATE READING:
--
--   SEND MONEY        transfer_out                                      (paid out)
--   RECEIVED MONEY    transfer_in                                       (paid in)
--   AGENT DEPOSIT     credit, EXCEPT game winnings                      (paid in)
--   AGENT WITHDRAWAL  withdrawal                                        (paid out)
--   OTHERS            adjustment, reversal, and credits from the game   (either)
--
-- Game winnings (meta.source = game_withdrawal*) are credits, but they are not a deposit made at an
-- agent — they are the platform paying out. Filing them under AGENT DEPOSIT would make that row
-- mean two different things. OTHERS is the honest bucket, and the detail rows say which is which.
--
-- LIPA NA M-PESA (PAY BILL) and (BUY GOODS) are returned as ZERO by the route, not by this
-- function, because NOTHING IN THE SYSTEM RECORDS SUCH A SPEND YET: the app's airtime, bundle,
-- paybill and buy-goods screens are local-only and never reach the server (see docs/65 §4). The
-- rows are printed so the table matches the reference, and they will stay zero until those flows
-- debit the wallet through an RPC. Do not read a zero there as "the marketer bought nothing".
--
-- Idempotent, additive, and read-only: it creates no table, changes no row and takes no lock.

begin;

-- The range scan. marketer_ledger_mkt_idx is (marketer_id, id DESC), which serves the feed; a
-- statement filters on created_at, so it gets its own. Both columns are monotonic in practice
-- (identity + default now()) but "in practice" is not a plan the planner can use.
create index if not exists ix_marketer_ledger_mkt_created
  on public.marketer_ledger(marketer_id, created_at);

-- ── Totals over the whole range ────────────────────────────────────────────────────────────────
-- Returns:
--   { "buckets": { "<BUCKET>": { "in": <cents>, "out": <cents> }, … },
--     "txn_count": <int>, "paid_in_cents": <cents>, "paid_out_cents": <cents> }
-- Every bucket the mapping can produce is present even at zero, so the caller never has to guess
-- whether a missing key means "nothing" or "not computed".
create or replace function public.fn_marketer_statement_summary(
  p_marketer_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns jsonb
language sql
stable
as $func$
  with scoped as (
    select
      case
        when l.entry_type = 'transfer_out' then 'SEND MONEY'
        when l.entry_type = 'transfer_in'  then 'RECEIVED MONEY'
        when l.entry_type = 'withdrawal'   then 'AGENT WITHDRAWAL'
        when l.entry_type = 'credit'
         and coalesce(l.meta->>'source','') not in ('game_withdrawal','game_withdrawal_approved')
                                           then 'AGENT DEPOSIT'
        else 'OTHERS'
      end                                                         as bucket,
      greatest(l.amount_cents, 0)                                 as paid_in,
      greatest(-l.amount_cents, 0)                                as paid_out
    from public.marketer_ledger l
    where l.marketer_id = p_marketer_id
      and l.created_at >= p_from
      and l.created_at <  p_to
  ),
  -- Left-joined onto the full bucket list so a bucket with no activity still reports 0/0.
  totals as (
    select b.bucket,
           coalesce(sum(s.paid_in), 0)::bigint  as paid_in,
           coalesce(sum(s.paid_out), 0)::bigint as paid_out
      from (values ('SEND MONEY'), ('RECEIVED MONEY'), ('AGENT DEPOSIT'),
                   ('AGENT WITHDRAWAL'), ('OTHERS')) as b(bucket)
      left join scoped s on s.bucket = b.bucket
     group by b.bucket
  )
  select jsonb_build_object(
    'buckets', (select jsonb_object_agg(bucket, jsonb_build_object('in', paid_in, 'out', paid_out)) from totals),
    'txn_count', (select count(*) from scoped),
    'paid_in_cents', (select coalesce(sum(paid_in), 0) from totals),
    'paid_out_cents', (select coalesce(sum(paid_out), 0) from totals)
  );
$func$;

-- ── The detail rows ────────────────────────────────────────────────────────────────────────────
-- Newest p_cap rows of the range, returned oldest-first. See the header on why those two orderings
-- are not the same thing.
create or replace function public.fn_marketer_statement_range(
  p_marketer_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_cap         int default 2000
)
returns setof public.marketer_ledger
language sql
stable
as $func$
  select * from (
    select l.*
      from public.marketer_ledger l
     where l.marketer_id = p_marketer_id
       and l.created_at >= p_from
       and l.created_at <  p_to
     order by l.id desc
     limit greatest(coalesce(p_cap, 2000), 1)
  ) t
  order by t.id asc;
$func$;

-- PostgREST surface (0153 / BUGLOG #143). These read one marketer's entire financial history, so
-- being reachable with the public anon key would turn a statement into a data dump of every
-- marketer whose id could be guessed. The API calls them with its own service credentials.
revoke all on function public.fn_marketer_statement_summary(uuid, timestamptz, timestamptz) from public;
revoke all on function public.fn_marketer_statement_summary(uuid, timestamptz, timestamptz) from anon;
revoke all on function public.fn_marketer_statement_summary(uuid, timestamptz, timestamptz) from authenticated;
revoke all on function public.fn_marketer_statement_range(uuid, timestamptz, timestamptz, int) from public;
revoke all on function public.fn_marketer_statement_range(uuid, timestamptz, timestamptz, int) from anon;
revoke all on function public.fn_marketer_statement_range(uuid, timestamptz, timestamptz, int) from authenticated;

commit;
