-- 0217_promote_finoq_result.sql — keep failure attribution working on the Global (FinoQ) rail.
--
-- 0216 promotes Safaricom's reason into result_desc by reading the STK callback shape:
--   {"response": {"ResultCode": 2035, "ResultDesc": "The customer does not exist.", ...}}
-- and the flat variant the dashboard renders. That is the Kenya V1 shape.
--
-- The Global rail posts something different. Per docs.finoq.africa/guides/callbacks (read
-- 2026-10-24) the body carries no ResultCode at all:
--   {"success": true, "status": "success"|"failed", "message": "...", "reference": "...",
--    "external_reference": "...", "amount": ..., "currency": "...", "transaction_id": "...",
--    "provider_reference": "...", "transaction_type": "inbound_payment", ...}
--
-- So without this migration every Global deposit would settle with result_desc reading only
-- "reconciled:finoq:1" — re-creating, on the new rail, exactly the blind spot that cost a day of
-- investigation on the old one. The whole point of moving to Global is to reach Airtel and T-Kash;
-- arriving there with no way to tell a cancelled payment from a broken network would be a bad trade.
--
-- This REPLACES 0216's function in place rather than adding a second trigger. One trigger, one
-- place to read, and the existing '%saf=%' idempotence guard keeps doing its job for both shapes.
-- The Kenya V1 branches are unchanged and are still tried first.
--
-- Money-neutral by construction, exactly as 0216: it assigns to NEW.result_desc and nothing else,
-- and being BEFORE UPDATE it performs no write of its own.
begin;

create or replace function public.fn_tx_promote_provider_result()
returns trigger language plpgsql as $fn$
declare
  v_code text;
  v_desc text;
begin
  -- 1) Kenya V1 / Daraja shape: a numeric Safaricom code, nested or flat. Unchanged from 0216.
  v_code := coalesce(new.provider_callback->'response'->>'ResultCode', new.provider_callback->>'ResultCode');
  v_desc := coalesce(new.provider_callback->'response'->>'ResultDesc', new.provider_callback->>'ResultDesc');

  -- 2) Global / FinoQ shape: no numeric code, so the status word stands in for one and `message`
  --    carries the reason. Checked second so a body with both keeps the richer numeric code.
  if v_code is null or btrim(v_code) = '' then
    v_code := coalesce(new.provider_callback->>'status', new.provider_callback->'response'->>'status');
    v_desc := coalesce(new.provider_callback->>'message', new.provider_callback->'response'->>'message');
    -- "status": true is the envelope flag, not an outcome — it appears on the Kenya shape too and
    -- means nothing on its own. Only the documented outcome words are worth promoting.
    if v_code is not null and lower(btrim(v_code)) not in ('success', 'failed', 'pending', 'cancelled', 'canceled') then
      v_code := null; v_desc := null;
    end if;
  end if;

  if v_code is null or btrim(v_code) = '' then
    return new;                                  -- nothing to promote; leave the row exactly as it is
  end if;

  new.result_desc := left(
    coalesce(nullif(btrim(new.result_desc), ''), 'payment') || ' saf=' || btrim(v_code)
      || coalesce(' ' || nullif(btrim(v_desc), ''), ''),
    200);
  return new;
end;
$fn$;

-- Backfill anything already captured that 0216 could not read (Global-shaped bodies). Guarded by
-- the same '%saf=%' check, so it is a no-op for rows 0216 already annotated and safe to re-run.
update public.transactions t
   set result_desc = left(
         coalesce(nullif(btrim(t.result_desc), ''), 'payment')
           || ' saf=' || btrim(coalesce(t.provider_callback->>'status', t.provider_callback->'response'->>'status'))
           || coalesce(' ' || nullif(btrim(coalesce(t.provider_callback->>'message', t.provider_callback->'response'->>'message')), ''), ''),
         200)
 where t.kind = 'deposit'
   and t.provider_callback is not null
   and coalesce(t.provider_callback->'response'->>'ResultCode', t.provider_callback->>'ResultCode') is null
   and lower(btrim(coalesce(t.provider_callback->>'status', t.provider_callback->'response'->>'status', '')))
         in ('success', 'failed', 'pending', 'cancelled', 'canceled')
   and (t.result_desc is null or t.result_desc not like '%saf=%');

commit;

-- REVERT (manual, if ever needed):
--   Re-run 0216_promote_saf_result_code.sql, which restores the Kenya-only function body. The
--   trigger itself is untouched by this migration, and the backfilled text is a faithful copy of
--   what the provider said about that same row.
