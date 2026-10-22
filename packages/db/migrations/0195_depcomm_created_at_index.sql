-- 0195_depcomm_created_at_index.sql — index the column the marketer money table ranges on.
--
-- WHY: the marketer dashboard's money statement filters a marketer's commissions by date —
--
--     where dc.beneficiary_user = $1
--       and ($2::date is null or (dc.created_at at time zone 'Africa/Nairobi')::date >= $2::date)
--       and ($3::date is null or (dc.created_at at time zone 'Africa/Nairobi')::date <= $3::date)
--
-- and 0078 gave this table only `(beneficiary_user, status)` and `(site_id)`. The first prefix
-- narrows to one marketer, which is most of the work, but the range column itself was uncovered, so
-- every "what did I earn today" read scanned all of that marketer's history and filtered it in
-- memory. The sibling tables were already right — `marketer_expenses` and
-- `marketer_advance_requests` are both `(marketer_user_id, created_at desc)` — so the commission
-- read was the one exposed arm of the three.
--
-- `created_at desc` matches the ORDER BY the line-item page uses, so the same index serves the
-- totals and the page.
--
-- Note on what this index can and cannot do: the predicate wraps the column in
-- `(created_at at time zone 'Africa/Nairobi')::date`, which is not sargable, so Postgres cannot use
-- the index to satisfy the DATE comparison itself. What it does give is an ordered, covering walk of
-- exactly one marketer's rows — the planner reads only that marketer's slice, newest first, and
-- evaluates the EAT date expression on those rows rather than on a wider scan. An expression index
-- on `(beneficiary_user, ((created_at at time zone 'Africa/Nairobi')::date))` would make the
-- comparison itself indexable, and is deliberately NOT what this does: `at time zone` with a literal
-- zone is IMMUTABLE so it would be legal, but it bakes one brand's calendar into an index, and the
-- per-brand timezone this codebase does not yet have (there is no `sites.timezone` column; the zone
-- is hardcoded in 39 places) is the thing that would invalidate it. Ordering by the raw timestamp
-- survives that change; an index keyed on Nairobi dates would not.
--
-- Built non-CONCURRENTLY, which takes a brief SHARE lock blocking writes to this table. That is
-- deliberate: the migration runner wraps each file in a transaction and CREATE INDEX CONCURRENTLY
-- cannot run inside one, and the table is small (2,571 rows at the time of writing), so the build is
-- milliseconds. If this table ever grows to the point where that lock matters, the right move is a
-- separate out-of-transaction concurrent build, not a change here.
--
-- Money-neutral and idempotent: an index only. No row is read, written or moved, no money figure
-- changes, and the statement is `if not exists`.
begin;

create index if not exists ix_depcomm_beneficiary_created
  on public.deposit_commissions(beneficiary_user, created_at desc);

commit;
