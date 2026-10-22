-- 0208_statement_order_by_time.sql — order the statement by the column it prints (BUGLOG #149).
--
-- fn_marketer_statement_range (0206) ordered by `id`. The statement PRINTS `created_at`. Those are
-- not the same ordering, and 0206's own header asserted they were ("both columns are monotonic in
-- practice") — which is the sort of claim that is true until it is not.
--
-- WHY THEY DIVERGE. `id` is drawn from the identity sequence at INSERT time. `created_at` defaults
-- to now(), which in PostgreSQL is TRANSACTION START time. So a transaction that begins at 10:00
-- and inserts at 10:05 takes a HIGHER id than one that began at 10:02 and inserted at 10:03, while
-- carrying the EARLIER timestamp. This system runs exactly that shape of concurrency — the transfer
-- and airtime RPCs take row locks and are proven against eight simultaneous connections — so a
-- transaction waiting on a lock is the ordinary case, not a contrived one.
--
-- WHAT IT LOOKED LIKE. A statement whose Completion Time column ran 17 Sep, 21 Sep, 28 Sep, 23 Sep,
-- 25 Sep … and whose Balance column therefore stepped up and down for no visible reason, because
-- balance_after_cents is correct PER ROW and only reads as a running balance when the rows are in
-- time order. Found by rendering a statement and looking at it, not from the code.
--
-- THE FIX. Order by (created_at, id) at both ends. `id` stays as the tie-breaker rather than being
-- dropped: the two halves of a transfer (0203) are written in one transaction and therefore share a
-- timestamp to the microsecond, so without it their order is whatever the plan happens to produce,
-- and a statement that shows the credit before the debit it came from is its own small lie.
--
-- The cap still keeps the NEWEST rows and still prints them oldest-first; it is the definition of
-- "newest" that changes, from "last inserted" to "last to happen".
--
-- ix_marketer_ledger_mkt_created (marketer_id, created_at) from 0206 already serves this.
-- Idempotent, read-only, and safe in any deploy order: it changes a sort, not a result set.

begin;

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
     order by l.created_at desc, l.id desc
     limit greatest(coalesce(p_cap, 2000), 1)
  ) t
  order by t.created_at asc, t.id asc;
$func$;

revoke all on function public.fn_marketer_statement_range(uuid, timestamptz, timestamptz, int) from public;
revoke all on function public.fn_marketer_statement_range(uuid, timestamptz, timestamptz, int) from anon;
revoke all on function public.fn_marketer_statement_range(uuid, timestamptz, timestamptz, int) from authenticated;

commit;
