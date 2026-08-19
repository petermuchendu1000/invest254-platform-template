-- 0071_deposit_confirmed_notify.sql
-- Real-time deposit feed for the platform console (docs/24).
--
-- The cross-brand platform console needs to show deposits AS THEY CONFIRM, across every brand,
-- without polling. Deposits are confirmed in the REST API (M-Pesa STK callback flips a
-- `transactions` row to status='success'); the WebSocket engine never learned about them.
--
-- Fix (mirrors migration 0040's `wallet_changed` + 0028's `game_config_changed` design): an AFTER
-- trigger on `transactions` fires `pg_notify('deposit_confirmed', <json>)` the moment a DEPOSIT row
-- first reaches status='success'. The engine LISTENs on that channel and fans the event out to any
-- connected platform_superadmin socket (the `platform` live channel in multiengine.ts).
--
-- Payload is a compact JSON object (well under the 8000-byte NOTIFY limit):
--   { siteId, userId, username, amountCents, txId, atMs }
--
-- Idempotent + additive: safe to re-run; changes no existing data, columns, or RPCs. The guard
-- `old.status is distinct from 'success'` makes it fire exactly once per deposit (not on later
-- no-op touches of an already-successful row).

create or replace function fn_notify_deposit_confirmed() returns trigger
language plpgsql as $$
declare
  uname text;
begin
  if new.kind = 'deposit'
     and new.status = 'success'
     and (tg_op = 'INSERT' or old.status is distinct from 'success') then
    -- SAFETY: this runs INSIDE the deposit-confirming transaction. A notify is best-effort
    -- delivery, never a reason to fail a money write — so swallow any error here. Worst case a
    -- single live-feed event is missed; the deposit still commits and the console reconciles on
    -- its next snapshot / overview refresh.
    begin
      select username into uname from profiles where id = new.user_id;
      perform pg_notify(
        'deposit_confirmed',
        json_build_object(
          'siteId', new.site_id,
          'userId', new.user_id,
          'username', coalesce(uname, ''),
          'amountCents', new.amount,
          'txId', new.id,
          'atMs', (extract(epoch from coalesce(new.updated_at, new.created_at, now())) * 1000)::bigint
        )::text
      );
    exception when others then
      null;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_deposit_confirmed on transactions;
create trigger trg_deposit_confirmed
  after insert or update on transactions
  for each row execute function fn_notify_deposit_confirmed();
