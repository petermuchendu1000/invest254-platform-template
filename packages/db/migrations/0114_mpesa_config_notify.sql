-- 0114_mpesa_config_notify.sql — Push M-Pesa config changes to the running API instantly.
--
-- WHY: `mpesa_config` (migration 0024) is admin-managed, but the API built the Daraja client ONCE
-- at boot (`loadDarajaConfigFromDb` in apps/api/src/server.ts). So after a superadmin rotated the
-- shortcode / consumer keys / passkey, the live process kept using the OLD in-memory credentials
-- until someone manually redeployed — silently breaking real deposits. This mirrors the game_config
-- hot-reload (migration 0028): a trigger fires `pg_notify` on every write so the API's
-- `DarajaConfigStore` re-reads the row and hot-swaps its client within milliseconds. The store also
-- polls as a fallback, so a dropped notification is self-healing.
--
-- The payload is the row id (always 1 for this singleton) — the store re-reads unconditionally on any
-- notification, so no secret ever travels through the NOTIFY channel.
--
-- Idempotent: safe to re-apply.

create or replace function public.fn_mpesa_config_notify()
returns trigger language plpgsql as $fn$
begin
  perform pg_notify('mpesa_config_changed', coalesce(new.id, 1)::text);
  return null;
end;
$fn$;

do $mig$
begin
  drop trigger if exists trg_mpesa_config_notify on public.mpesa_config;
  create trigger trg_mpesa_config_notify after insert or update on public.mpesa_config
    for each row execute function public.fn_mpesa_config_notify();
end
$mig$;
