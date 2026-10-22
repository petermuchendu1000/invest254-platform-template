-- 0209_statement_newest_first.sql — print the detail newest-first, as the reference statement does.
--
-- 0208 fixed the ordering COLUMN (created_at, not id — BUGLOG #149) and settled on ascending, so a
-- reader could follow the Balance column downward as a running total. That reasoning was sound and
-- it was still the wrong answer, because it was reasoning rather than measurement: a real operator
-- statement, supplied as the artifact to reproduce, runs DESCENDING. Its first page opens on
-- 2026-10-14 21:24:50 and walks backwards, and every page after it continues down.
--
-- WHY DESCENDING IS RIGHT HERE. The statement is read to answer "what happened lately?", not "how
-- did this balance come to be?". Putting the newest row under the reader's eye on page 1 answers
-- that without paging to the end, which on a 255-page statement is the whole difference between
-- useful and not. The running-balance reading survives: it simply runs upward, and the Balance
-- column is still correct per row because balance_after_cents is written per row.
--
-- THE CAP IS UNAFFECTED. The inner query still selects the NEWEST p_cap rows; only the order they
-- are handed back in changes. Reversing those two would silently return the OLDEST rows, which is
-- the failure this comment exists to prevent.
--
-- `id` stays as the tie-breaker, for the reason 0208 gave: the two halves of a transfer (0203) are
-- written in one transaction and share a timestamp to the microsecond, so without it their order is
-- whatever the plan produces. Descending now, so the pair reads the same way round as before
-- relative to its neighbours.
--
-- A NOTE ON 0206'S HEADER. Its comment still writes the summary bucket as "LIPA NA M-PESA
-- (PAY BILL)"; the reference prints "(PAYBILL)", one word, and the code was corrected to match.
-- The comment is NOT corrected, because the migration ledger checksums the whole file and an
-- already-applied migration is immutable down to its comments — editing one aborts the deploy with
-- "ledger checksum != file". Recorded here instead, which is where a reader of 0206 will be sent.
--
-- ix_marketer_ledger_mkt_created (marketer_id, created_at) from 0206 serves this unchanged.
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
  order by t.created_at desc, t.id desc;
$func$;

revoke all on function public.fn_marketer_statement_range(uuid, timestamptz, timestamptz, int) from public;
revoke all on function public.fn_marketer_statement_range(uuid, timestamptz, timestamptz, int) from anon;
revoke all on function public.fn_marketer_statement_range(uuid, timestamptz, timestamptz, int) from authenticated;

commit;
