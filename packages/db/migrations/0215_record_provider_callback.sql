-- 0215_record_provider_callback.sql — record WHY a deposit failed, without trusting the body to credit.
--
-- THE GAP. Every PayHero failure in production is stored identically. Measured on 2026-10-24:
--
--   select result_desc, result_code, count(*) from transactions
--    where kind='deposit' and provider='payhero' and status='failed'
--      and checkout_request_id is not null and created_at > now() - interval '7 days'
--   -> 180 rows, all  result_code=1, result_desc='reconciled:payhero:1'
--
-- and the provider's own payload is nowhere:
--
--   select coalesce(raw_callback->>'ResultCode','(absent)'), count(*) ... -> 203 rows '(absent)'
--
-- Two places threw the reason away. `mapPayHeroStatus` collapses FAILED/CANCELLED/REVERSED/DECLINED
-- to resultCode 1, discarding the status string; and `handlePayHeroCallback` ignores the callback
-- body entirely before re-querying. So a 2028 ("The request is not permitted according to product
-- assignment" — our channel, fixable) is indistinguishable from a 1032 (customer pressed cancel, not
-- fixable). That matters because PayHero limits us on a FAILURE RATE: without attribution we cannot
-- tell which half of the rate is ours to fix, cannot tell PayHero which half is theirs, and cannot
-- tell whether a fix worked.
--
-- WHY A SEPARATE COLUMN rather than writing raw_callback. fn_complete_deposit sets
-- `raw_callback = p_raw` wholesale on settle (verified against the LIVE definition via
-- pg_get_functiondef, not the migration file). A callback that arrived BEFORE the sweep settled
-- would therefore be overwritten the moment the deposit reached a terminal state — exactly the rows
-- we most want to explain. A column the settle path never touches cannot be clobbered.
--
--   raw_callback      = what we SETTLED on   (unchanged, still written by fn_complete_deposit)
--   provider_callback = what the provider SAID, verbatim, for diagnosis only
--
-- MONEY-NEUTRAL BY CONSTRUCTION. fn_record_provider_callback writes ONE jsonb column on ONE
-- transaction row. It cannot change status, result_code, amount, mpesa_receipt or raw_callback, and
-- it touches no wallet and no ledger_entries row. Storing the body is NOT trusting it: the credit
-- decision still comes only from the authoritative server-to-server re-query, exactly as before.
--
-- Additive and idempotent.
begin;

-- ── The column ───────────────────────────────────────────────────────────────────────────────────
alter table public.transactions add column if not exists provider_callback jsonb;

comment on column public.transactions.provider_callback is
  'Verbatim provider callback payload, for diagnosis only. NEVER read to decide a credit — the '
  'credit decision comes from the authoritative server-to-server re-query. Written only by '
  'fn_record_provider_callback; the settle path (fn_complete_deposit) never touches it.';

-- ── The writer ───────────────────────────────────────────────────────────────────────────────────
-- Resolves a deposit by any reference the provider might echo back, because the PayHero rail splits
-- them across two columns: attachStk stores PayHero's `reference` in checkout_request_id and the
-- Safaricom ws_CO id in merchant_request_id, and the callback carries the ws_CO id as
-- "CheckoutRequestID". Matching only one column would miss every STK callback.
--
-- Accepts a row in ANY status, including already-terminal: a callback that lands after the sweep has
-- settled still explains why, and that is the whole point.
--
-- Returns true when a row was annotated. A reference we do not own simply returns false — a forged
-- POST can at worst write a jsonb blob onto a row it already knew the id of, and still cannot move a
-- cent or change a status.
create or replace function public.fn_record_provider_callback(p_ref text, p_raw jsonb)
returns boolean language plpgsql security definer set search_path = public as $fn$
declare v_ok boolean;
begin
  if p_ref is null or btrim(p_ref) = '' then return false; end if;
  update public.transactions t
     set provider_callback = p_raw
   where t.kind = 'deposit'
     and (t.checkout_request_id = p_ref or t.merchant_request_id = p_ref or t.id::text = p_ref)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_record_provider_callback(text, jsonb) from public, anon, authenticated;
  grant execute on function public.fn_record_provider_callback(text, jsonb) to service_role;
end
$g$;

commit;

-- REVERT (manual, if ever needed):
--   drop function if exists public.fn_record_provider_callback(text, jsonb);
--   alter table public.transactions drop column if exists provider_callback;
--   The column is additive and nullable and nothing reads it to make a decision, so leaving it in
--   place is harmless; dropping it only discards diagnostic history.
