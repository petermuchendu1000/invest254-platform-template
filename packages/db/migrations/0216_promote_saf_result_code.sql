-- 0216_promote_saf_result_code.sql — put Safaricom's real reason where a human will actually read it.
--
-- 0215 captured the provider callback into transactions.provider_callback and proved itself in
-- production the same day: nine callbacks landed, carrying the attribution that had never existed in
-- this database before.
--
--   3x  code=2035  The customer does not exist.
--   3x  code=1032  Request Cancelled by user.
--   2x  code=0     The service request is processed successfully.
--   1x  code=1     The balance is insufficient for the transaction.
--
-- But `result_desc` — the column the admin deposits list actually shows — still reads only
-- "reconciled:payhero:1 FAILED". The numeric code sits one JSON path down, at
-- provider_callback->'response'->>'ResultCode', where nobody triaging a payment will look. Verified
-- live: the real payload nests everything under "response", NOT at the top level.
--
-- WHY A TRIGGER, AND NOT THE TWO OBVIOUS PLACES.
--   * Not at callback time. fn_record_provider_callback may run BEFORE the sweep settles the row, and
--     fn_complete_deposit then overwrites result_desc wholesale — the promoted code would be lost on
--     exactly the rows we want explained. This is the same clobber that forced 0215 to use its own
--     column, confirmed against the LIVE fn_complete_deposit via pg_get_functiondef.
--   * Not inside fn_complete_deposit. That is the money RPC: it moves balances, writes ledger_entries
--     and pays referral commissions. Editing it to improve a text column is not a trade worth making.
--
-- A BEFORE UPDATE trigger on the row itself is correct under BOTH orderings, because it fires on
-- whichever of the two writes happens second:
--   callback then settle -> fires on the settle update, provider_callback already present
--   settle then callback -> fires on the provider_callback update, result_desc already present
--
-- MONEY-NEUTRAL BY CONSTRUCTION. It assigns to NEW.result_desc and nothing else. It cannot change a
-- status, an amount, a result_code, a receipt, a wallet or a ledger row, and being BEFORE UPDATE it
-- performs no write of its own at all — it only edits the row the caller was already writing.
--
-- Additive and idempotent, in both senses: re-running the migration is safe, and the trigger refuses
-- to append twice (the '%saf=%' guard), so a row cannot accumulate repeated codes however many times
-- it is updated.
begin;

create or replace function public.fn_tx_promote_provider_result()
returns trigger language plpgsql as $fn$
declare
  v_code text;
  v_desc text;
begin
  -- Liberal in what it reads: the live PayHero/FinoQ STK callback nests these under "response",
  -- while the shape shown in their dashboard carries them at the top level. Take whichever exists.
  v_code := coalesce(new.provider_callback->'response'->>'ResultCode', new.provider_callback->>'ResultCode');
  v_desc := coalesce(new.provider_callback->'response'->>'ResultDesc', new.provider_callback->>'ResultDesc');

  if v_code is null or btrim(v_code) = '' then
    return new;                                  -- nothing to promote; leave the row exactly as it is
  end if;

  new.result_desc := left(
    coalesce(nullif(btrim(new.result_desc), ''), 'payhero') || ' saf=' || btrim(v_code)
      || coalesce(' ' || nullif(btrim(v_desc), ''), ''),
    200);                                        -- result_desc is unbounded text; the cap belongs here
  return new;
end;
$fn$;

-- The WHEN clause does the filtering so the function body is never entered for the overwhelming
-- majority of updates to this table (withdrawals, holds, approvals, every status change without a
-- captured callback). `not like '%saf=%'` is what makes repeated updates idempotent.
drop trigger if exists trg_tx_promote_provider_result on public.transactions;
create trigger trg_tx_promote_provider_result
  before update on public.transactions
  for each row
  when (new.kind = 'deposit'
        and new.provider_callback is not null
        and (new.result_desc is null or new.result_desc not like '%saf=%'))
  execute function public.fn_tx_promote_provider_result();

-- ── Backfill the rows already captured ───────────────────────────────────────────────────────────
-- Purely descriptive: this rewrites one text column on deposits that already hold a provider
-- callback, and touches nothing else. It is a no-op for any row whose result_desc already carries a
-- code. The same '%saf=%' guard makes re-running it harmless.
update public.transactions t
   set result_desc = left(
         coalesce(nullif(btrim(t.result_desc), ''), 'payhero')
           || ' saf=' || btrim(coalesce(t.provider_callback->'response'->>'ResultCode', t.provider_callback->>'ResultCode'))
           || coalesce(' ' || nullif(btrim(coalesce(t.provider_callback->'response'->>'ResultDesc', t.provider_callback->>'ResultDesc')), ''), ''),
         200)
 where t.kind = 'deposit'
   and t.provider_callback is not null
   and coalesce(t.provider_callback->'response'->>'ResultCode', t.provider_callback->>'ResultCode') is not null
   and (t.result_desc is null or t.result_desc not like '%saf=%');

commit;

-- REVERT (manual, if ever needed):
--   drop trigger if exists trg_tx_promote_provider_result on public.transactions;
--   drop function if exists public.fn_tx_promote_provider_result();
--   The backfill is not reversed: the promoted text is a faithful copy of what the provider said
--   about that same row, and provider_callback still holds the original payload verbatim.
